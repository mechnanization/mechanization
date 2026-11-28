import { citizenDisplayName } from '@mechanization/shared-schemas';
import { Injectable } from '@nestjs/common';
import { OWNER_RECORD_RESIDENCE, isNonPersonRecord, isOwnerRecord } from '@mechanization/shared-schemas';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  formatUnitCode,
  isDwellingUnitType,
  isStructuralUnitType,
  isUnoccupied,
  feeBearerClass,
  canSpanLevels,
  floorsOfUnit,
  layoutBuildingFloors,
  levelSpanOverlap,
  MAX_UNIT_COLUMN,
  MAX_UNIT_LEVELS,
  type UnitBlueprint,
  type ResizeUnitSpanInput,
  type SaveBuildingMatrixInput,
  type UpdateUnitInput,
  type UpsertUnitInput,
} from '@mechanization/shared-schemas';
import { assertNoFeeExemptionHistory } from './fee-exemption';
import { loadUnitTypes } from './unit-types';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { houseOnFile, promoteHouseCards, type HouseOnFile, type PromotedCard } from './house-growth';
import type { BuildingRow, UnitRow } from './building.types';
import { activeVacancy } from './unit-vacancy';
import { APP_CONFIG } from '../../common/app.config';
import { BuildingsService, MatrixSaveResult, changedUnitFields, nonResidentUnitConflict, personName, structuralLabel, toUnitRow } from './buildings.service';
import { StaffActor } from '../../common/actor';

/**
 * The census's write side: structures, their unit matrices, and who is in them.
 *
 * Reads the tenant client directly rather than through a repository port, for
 * the reason set out in `building.types.ts` — the suffix allocation below is a
 * read-then-write under a lock, which is not something a port can hand out
 * without handing out the transaction with it.
 */

/** How many units one blueprint may generate in a single call. */
const MAX_GENERATED_UNITS = 400;

/** Thrown at the end of a dry run so the transaction rolls back with the answer in hand. */
class MatrixDryRun extends Error {
  constructor(readonly building: BuildingRow) {
    super('dry run');
  }
}

/**
 * «هذا المنزل مسجَّل على ملف…» — the question the matrix asks before a house
 * on somebody's file gets a second unit (D28). The holders are named so the
 * officer knows whose file the answer changes.
 */
function houseGrowthUnanswered(house: HouseOnFile): ConflictError {
  return new ConflictError({
    code: 'HOUSE_GROWTH_UNANSWERED',
    message: 'Say whether the new floor is another level of this house or a separate unit.',
    params: { unitCode: house.unit.unitCode },
    details: {
      unitId: house.unit.id,
      unitCode: house.unit.unitCode,
      unitType: house.unit.unitType,
      levels: house.unit.levels,
      // Where «طابق إضافي» would put the new level.
      nextLevelFloor: house.unit.floor + house.unit.levels,
      holders: house.cards.map((card) => ({ name: card.citizenName, capacity: card.occupancyType })),
    },
  });
}

/**
 * A building's units, written: generated from a blueprint (`generateUnits`),
 * added one at a time (`addUnit`, with a house that grows), edited (`updateUnit`,
 * `resizeUnitSpan`), deleted (`deleteUnit`), and the census matrix saved whole
 * (`saveMatrix`, which runs the others in one transaction). The building itself
 * stays with `BuildingsService`. Out of `BuildingsService` (audit GOD-07).
 */
@Injectable()
export class UnitsService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
    private readonly buildings: BuildingsService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /**
   * A whole building edit — the shell and the matrix difference — in one
   * transaction. See `saveBuildingMatrixSchema`.
   *
   * It used to be one request for the building and one per unit, each free to
   * fail on its own, so a save could leave «حُفظ المبنى، لكن رُفض…»: a building
   * half in the state the officer meant and half in the old one. Now the first
   * refusal — a flat somebody lived in, a floor count that strands a unit —
   * names what refused and nothing is written.
   *
   * The same checks run as they always did, because the same methods do the
   * work: `deleteUnit`, `updateUnit`, `addUnit` and `update` all join the
   * transaction (`atomic`, `runInTenantTransaction`). In this order:
   * removals, so a freed position can be taken; changes; additions, lowest
   * floor and leftmost column first so each floor's sequences read like the
   * grid; the shell last, so its floor counts are judged against the matrix
   * this save leaves — which is what made the old two-step shrink necessary.
   *
   * `dryRun` does all of it and rolls back. Audit rows wait for a commit
   * (`AuditService.record`), so a rehearsal leaves no trace.
   */
  async saveMatrix(
    id: string,
    input: SaveBuildingMatrixInput,
    actor: StaffActor,
  ): Promise<MatrixSaveResult> {
    const before = await this.db.building.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('المبنى غير موجود');
    await this.buildings.assertFresh(before, input.expectedUpdatedAt, actor);

    const summary = { removed: [] as string[], updated: [] as string[], added: [] as string[] };
    try {
      const building = await runInTenantTransaction(this.tenantContext, async () => {
        /*
          The freshness check again, under the building's row lock. Two officers
          saving the same stale screen a moment apart both pass the check above,
          and the second would write over the first. Locked, the second waits for
          the first to commit and then reads its `updatedAt`, which refuses it.
        */
        const S = tenantSchemaRef(this.tenantContext.schemaName);
        await this.db.$queryRaw`SELECT "id" FROM ${S}"buildings" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const locked = await this.db.building.findUnique({ where: { id } });
        if (!locked) throw new NotFoundError('المبنى غير موجود');
        await this.buildings.assertFresh(locked, input.expectedUpdatedAt, actor);

        // Every unit named must still be this building's — a stale screen could name another's.
        const named = [...input.remove, ...input.update.map((row) => row.id)];
        if (named.length > 0) {
          const own = await this.db.unit.findMany({
            where: { id: { in: named }, buildingId: id },
            select: { id: true, unitCode: true },
          });
          if (own.length !== named.length) {
            throw new ConflictError('إحدى الوحدات لم تعد في هذا المبنى — أعد فتحه لترى المصفوفة الحالية');
          }
          const codeOf = new Map(own.map((unit) => [unit.id, unit.unitCode]));
          for (const unitId of input.remove) {
            await this.deleteUnit(unitId, actor);
            summary.removed.push(codeOf.get(unitId)!);
          }
        }

        for (const cell of input.update) {
          const row = await this.updateUnit(
            cell.id,
            {
              floor: cell.floor,
              startCol: cell.startCol,
              endCol: cell.endCol,
              unitType: cell.unitType,
              unitTypeId: cell.unitTypeId,
            },
            actor,
          );
          summary.updated.push(row.unitCode);
        }

        const additions = [...input.add].sort(
          (a, b) => a.floor - b.floor || (a.startCol ?? 0) - (b.startCol ?? 0),
        );
        for (const cell of additions) {
          // The grid drew every unit already on the floor, so there is no duplicate left to ask about.
          const row = await this.addUnit(
            id,
            { ...cell, acknowledgedDuplicates: true, houseGrowth: input.houseGrowth },
            actor,
          );
          summary.added.push(row.unitCode);
        }

        const updated = await this.buildings.update(id, input.building, actor);
        if (input.dryRun) throw new MatrixDryRun(updated);
        return updated;
      });
      return { dryRun: false, building, ...summary };
    } catch (caught) {
      if (caught instanceof MatrixDryRun) return { dryRun: true, building: caught.building, ...summary };
      throw caught;
    }
  }

  // ───────────────────────────  The unit matrix  ───────────────────────────

  /**
   * Fills a building's matrix from a blueprint.
   *
   * Every generated unit is `NOT_SURVEYED`, and that is the entire point:
   * generating the matrix asserts that the flats exist, not that anyone has
   * been inside them. A building of twelve flats where three have been
   * surveyed is now three rows of data and nine rows of work — which is a
   * dispatch list. Before this table it was one building with three flats on it
   * and no way to say the other nine were missing.
   *
   * Additive. Positions already taken on a floor are skipped rather than
   * overwritten, so running a blueprint twice, or running a wider one over a
   * partly-filled matrix, tops it up instead of destroying what is there.
   */
  async generateUnits(
    buildingId: string,
    blueprint: UnitBlueprint,
    actor: StaffActor,
  ): Promise<{ created: number; skipped: number; units: UnitRow[] }> {
    const building = await this.db.building.findUnique({ where: { id: buildingId } });
    if (!building) throw new NotFoundError('المبنى غير موجود');

    const plan =
      blueprint.kind === 'uniform'
        ? Array.from(
            { length: blueprint.toFloor - blueprint.fromFloor + 1 },
            (_, index) => ({
              floor: blueprint.fromFloor + index,
              unitCount: blueprint.unitsPerFloor,
              unitType: blueprint.unitType,
              unitTypeId: blueprint.unitTypeId,
            }),
          )
        : blueprint.floors;

    const requested = plan.reduce((sum, entry) => sum + entry.unitCount, 0);
    if (requested > MAX_GENERATED_UNITS) {
      throw new ValidationError(
        `عدد الوحدات المطلوب توليدها (${requested}) يتجاوز الحد الأقصى ${MAX_GENERATED_UNITS}`,
      );
    }

    /*
      A blueprint may not reach above the building's own عدد الطوابق.

      The two numbers were unrelated on both sides until now: a building
      declared `floorsCount: 1` accepted `toFloor: 40` and quietly became a
      forty-storey block, and `floorsCount` was then *raised* to match — so the
      form's own field was overwritten by the range beside it, silently, in the
      same save.

      Refused here rather than reconciled, because this is the one path where
      the officer states both numbers in one form. Two contradicting statements
      are an error to show them, not a correction to apply. Where only one
      number is stated the other is still derived: `addUnit` raises `floorsCount`
      for a floor discovered one unit at a time, and `create` derives it from
      inline units on a registration card that never asks for it.

      Floors are 0-indexed — ground is 0 — so the top floor of an N-storey
      building is N-1. Basements are negative and counted separately, by
      `basementsCount`, so the bottom of the range is checked against that.
    */
    const topFloor = plan.reduce((max, entry) => Math.max(max, entry.floor), 0);
    if (topFloor > building.floorsCount - 1) {
      throw new ValidationError(
        `الطابق الأعلى في المخطط (${topFloor}) يتجاوز عدد طوابق المبنى (${building.floorsCount}). عدّل عدد الطوابق أو اخفض نطاق الطوابق`,
      );
    }

    /*
      Downward the rule is the opposite, and deliberately so.

      `floorsCount` is required and always stated in the same form as the
      range, so a blueprint above it is two contradicting statements. Depth is
      not: `basementsCount` is optional and defaults to zero, so a caller that
      reached B1 without mentioning it has contradicted nothing — it has told
      us something the register did not know. That is the `addUnit` case, and
      it is reconciled the same way, downward only.

      A قبو never has to be made room for before it can be recorded.
    */
    const bottomFloor = plan.reduce((min, entry) => Math.min(min, entry.floor), 0);
    const deepened = bottomFloor < -building.basementsCount ? -bottomFloor : null;

    const existing = await this.db.unit.findMany({
      where: { buildingId },
      select: { floor: true, sequence: true },
    });
    const taken = new Map<number, Set<number>>();
    for (const unit of existing) {
      const set = taken.get(unit.floor) ?? new Set<number>();
      set.add(unit.sequence);
      taken.set(unit.floor, set);
    }

    const data: Prisma.UnitCreateManyInput[] = [];
    let skipped = 0;
    // «نوع الوحدة» (0109): a floor's type decides the `unitType` of every unit generated on it.
    const unitTypes = await loadUnitTypes(this.db);

    for (const entry of plan) {
      const entryType = unitTypes.resolve(entry, null)!;
      const used = taken.get(entry.floor) ?? new Set<number>();
      taken.set(entry.floor, used);

      /*
        Top up to the requested count, do not add to it.

        "Four flats on floor 3" means the floor ends up with four, whether it
        had none or had two an officer entered by hand — so re-running a
        blueprint, or widening one over a partly-filled matrix, converges
        instead of doubling. Adding four more each time is the behaviour that
        turns a re-tap on a slow connection into an eight-flat floor.
      */
      const missing = Math.max(0, entry.unitCount - used.size);
      skipped += entry.unitCount - missing;

      for (let n = 0; n < missing; n += 1) {
        let sequence = 1;
        while (used.has(sequence)) sequence += 1;
        used.add(sequence);

        data.push({
          buildingId,
          floor: entry.floor,
          sequence,
          unitCode: formatUnitCode(entry.floor, sequence),
          unitType: entryType.unitType as never,
          unitTypeId: entryType.unitTypeId,
        });
      }
    }

    this.buildings.assertUnitFits(building, existing.length, data.length);

    /*
      «هذا المنزل يصبح مبنى» (D28): a blueprint only ever adds units, so the one
      answer it can take is «وحدة مستقلة». A level of the same home is added
      from the matrix, one floor directly above it.
    */
    const house = data.length > 0 ? await houseOnFile(this.db, building) : null;
    if (house && blueprint.houseGrowth !== 'SEPARATE_UNIT') {
      if (blueprint.houseGrowth === 'EXTRA_LEVEL') {
        const above = house.unit.floor + house.unit.levels;
        throw new ValidationError({
          code: 'HOUSE_GROWTH_NOT_ABOVE',
          message: 'A level of the same home is added from the matrix, directly above it.',
          params: { unitCode: house.unit.unitCode, floor: above },
        });
      }
      throw houseGrowthUnanswered(house);
    }

    let promoted: PromotedCard[] = [];
    if (data.length > 0) {
      promoted = await this.atomic(async (tx) => {
        await tx.unit.createMany({ data, skipDuplicates: true });
        const growing = house ? await houseOnFile(tx, building) : null;
        return growing ? promoteHouseCards(tx, growing) : [];
      });
    }

    /*
      `floorsCount` is not touched here any more.

      It used to be raised to `topFloor + 1`, which is what made the two numbers
      able to disagree in the first place — the range silently rewrote the field
      the officer had just filled in. The guard above now refuses that case
      instead, so by this point the blueprint is known to fit inside the
      building the officer described. Raising it belongs on `addUnit`, where
      there is no second number to contradict.

      `basementsCount` *is* touched, for exactly that reason: it is optional and
      defaults to zero, so a blueprint reaching B1 in a building that never
      declared a depth has contradicted nothing. Deepened only, never raised
      back — a blueprint confined to the ground floor is not evidence that the
      basement was filled in.
    */
    if (deepened !== null) {
      await this.db.building.update({
        where: { id: buildingId },
        data: { basementsCount: deepened },
      });
    }

    const units = await this.db.unit.findMany({
      where: { buildingId },
      orderBy: [{ floor: 'asc' }, { sequence: 'asc' }],
    });

    this.buildings.record({
      action: 'BUILDING_UNITS_GENERATED',
      buildingId,
      after: { created: data.length, skipped, total: units.length },
      actor,
    });
    this.announcePromotions(buildingId, promoted, null, actor);

    return { created: data.length, skipped, units: units.map(toUnitRow) };
  }

  /** One unit added by hand, at the next free position on its floor. */
  async addUnit(
    buildingId: string,
    asked: UpsertUnitInput,
    actor: StaffActor,
  ): Promise<UnitRow> {
    const building = await this.db.building.findUnique({ where: { id: buildingId } });
    if (!building) throw new NotFoundError('المبنى غير موجود');

    /*
      «نوع الوحدة» (0109): the type decides `unitType`, so every guard below —
      the sibling check, the house question, the structural rules — reads the
      base the unit will be billed as, whichever custom type it was filed under.
      Refused here, before anything is written, if the type is switched off.
    */
    const typed = (await loadUnitTypes(this.db)).resolve(asked, null)!;
    const input: UpsertUnitInput = { ...asked, unitType: typed.unitType as UpsertUnitInput['unitType'] };

    /*
      «هذا المنزل يصبح مبنى» (decision D28) — see `house-growth.ts`. Asked before
      `assertUnitFits`, which refuses a «منزل مستقل» any second unit: a storey
      added to a house is usually more of the same home, and that answer creates
      no unit at all.
    */
    const house = await houseOnFile(this.db, building);
    if (house) {
      if (!input.houseGrowth) throw houseGrowthUnanswered(house);
      if (input.houseGrowth === 'EXTRA_LEVEL') return this.growHouseByLevel(house, input.floor, actor);
    }

    this.buildings.assertUnitFits(
      building,
      await this.db.unit.count({ where: { buildingId } }),
      1,
    );

    // Never on the upper level of a home rising through this floor (0095).
    if (input.startCol != null && input.endCol != null) {
      await this.assertNotOnUpperLevel(buildingId, input.floor, { startCol: input.startCol, endCol: input.endCol });
    }

    /*
      The same shape of hole D18 closed for buildings, one level down.

      `sequence` is allocated below as the next free position, so a second محل
      on a ground floor that already has one is always created and the unique
      `(buildingId, floor, sequence)` never fires — it is satisfied by
      construction. The constraint only catches an explicitly supplied
      `sequence`, which the registration form never sends.

      So the matrix could only grow, silently, and the officer standing in front
      of the one shop on the ground floor had no way to tell whether the `0001`
      chip on their screen *was* that shop. Pressing «إضافة وحدة» is the
      rational move when the chip shows nothing but a number, and it produced a
      second row for one physical unit.

      Matched on floor **and** unit type, not floor alone. Four apartments on
      one floor is the ordinary shape of a building and refusing it would make
      the guard noise; a second محل beside an existing محل is the shape of the
      mistake. Where it fires the answer is still allowed to be yes — what is
      not allowed is never being asked.

      Refused before the transaction, like the building guard, so an
      acknowledgement never arrives after a row it was meant to prevent.
    */
    if (!input.acknowledgedDuplicates) {
      const siblings = await this.db.unit.findMany({
        where: { buildingId, floor: input.floor, unitType: input.unitType as never },
        orderBy: { sequence: 'asc' },
        select: {
          id: true,
          unitCode: true,
          unitType: true,
          floor: true,
          side: true,
          unitArea: true,
          postedNumber: true,
          unitStatus: true,
          surveyStatus: true,
          /*
            Who is in them travels with the refusal, because it is the fact that
            settles the question. «0001 — محل تجاري، يمين، ٤٠م²، مستأجر: فلان»
            is answerable from the doorway; «0001» is not, and the dialog cannot
            fetch it — the phone that most needs this guard is the one with no
            signal.
          */
          occupancies: {
            where: { toDate: null },
            select: {
              role: true,
              citizen: { select: { firstName: true, lastName: true, residence: true } },
            },
          },
        },
      });

      if (siblings.length > 0) {
        throw new ConflictError(
          `يوجد على هذا الطابق ${
            siblings.length === 1 ? 'وحدة مسجَّلة' : `${siblings.length} وحدات مسجَّلة`
          } من النوع نفسه (${siblings.map((row) => row.unitCode).join('، ')}). تأكَّد أن هذه وحدة مختلفة قبل المتابعة.`,
          {
            buildingId,
            floor: input.floor,
            unitType: input.unitType,
            candidates: siblings.map(({ occupancies, ...row }) => ({
              ...row,
              unitArea: row.unitArea != null ? Number(row.unitArea) : null,
              occupants: occupancies.map((row) => ({
                role: row.role,
                citizenName: row.citizen ? citizenDisplayName(row.citizen, { middleName: false }) : null,
              })),
            })),
          },
        );
      }
    }

    // `atomic` joins the transaction a whole-matrix save (`saveMatrix`) runs this inside.
    const added = await this.atomic(async (tx) => {
      /*
        The schema is a literal here for the same reason it is in `create` —
        `current_schema()` reads the connection's `search_path`, which this app
        does not own behind the transaction pooler. A drifted connection returns
        `public`, so two officers adding a unit to one building take *different*
        lock keys, both read the same `used` set, both compute the same
        `sequence`, and the second one hits the unique constraint as a 500
        instead of being serialised behind the first.
      */
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${this.tenantContext.schemaName}:unit-sequence:${buildingId}`}))`;

      /*
        Asked again under the lock: the question was answered about the
        structure as it was, and another officer may have filed a «منزل» on it
        since. An answer of «وحدة مستقلة» converts whatever cards stand now.
      */
      const growing = await houseOnFile(tx, building);
      if (growing && input.houseGrowth !== 'SEPARATE_UNIT') throw houseGrowthUnanswered(growing);

      const used = new Set(
        (
          await tx.unit.findMany({
            where: { buildingId, floor: input.floor },
            select: { sequence: true },
          })
        ).map((u) => u.sequence),
      );

      if (input.sequence !== undefined && used.has(input.sequence)) {
        throw new ConflictError(`الوحدة رقم ${input.sequence} موجودة على هذا الطابق`);
      }

      let sequence = input.sequence ?? 1;
      while (input.sequence === undefined && used.has(sequence)) sequence += 1;

      const unit = await tx.unit.create({
        data: {
          buildingId,
          floor: input.floor,
          sequence,
          startCol: input.startCol ?? null,
          endCol: input.endCol ?? null,
          unitCode: formatUnitCode(input.floor, sequence),
          unitType: input.unitType as never,
          unitTypeId: typed.unitTypeId,
          postedNumber: input.postedNumber?.trim() || null,
          side: input.side?.trim() || null,
          unitArea: input.unitArea ?? null,
          unitStatus: (input.unitStatus ?? null) as never,
          surveyStatus: (input.surveyStatus ?? 'NOT_SURVEYED') as never,
          notes: input.notes?.trim() || null,
        },
      });

      /*
        A floor discovered one unit at a time raises عدد الطوابق to cover it.

        The opposite of `generateUnits`, deliberately. There the officer states
        the floor range and the floor count in one form, so a range above the
        count is a contradiction and is refused. Here there is no second number
        to contradict: an officer standing on a fourth floor of a building the
        register calls three-storey is *correcting* the register, and refusing
        them would mean going to a different form to raise a number before they
        can record what they are looking at.

        Only ever upward — recording a ground-floor محل in a six-storey block is
        not evidence the block got shorter.
      */
      if (input.floor + 1 > building.floorsCount) {
        await tx.building.update({
          where: { id: buildingId },
          data: { floorsCount: input.floor + 1 },
        });
      }

      /*
        The same correction downward, since basements now have a column of
        their own to be wrong in.

        A unit filed on floor −2 in a building declaring one basement is an
        officer standing in a second basement the register does not know about,
        and it is the same event as finding a fourth floor on a three-storey
        block. Only ever deeper, for the same reason the other only rises: a
        محل on B1 is not evidence that B2 was filled in.
      */
      if (input.floor < 0 && -input.floor > building.basementsCount) {
        await tx.building.update({
          where: { id: buildingId },
          data: { basementsCount: -input.floor },
        });
      }

      // After the unit exists: each card's row names the house's unit, never the new one.
      const promoted = growing ? await promoteHouseCards(tx, growing) : [];
      return { unit, promoted };
    });
    const created = added.unit;

    this.buildings.record({
      action: 'UNIT_UPDATED',
      buildingId,
      after: { unitCode: created.unitCode, created: true },
      actor,
    });
    this.announcePromotions(buildingId, added.promoted, created.unitCode, actor);

    return toUnitRow(created);
  }

  /**
   * «طابق إضافي من المسكن نفسه» — the house's one unit rises a level instead of
   * a unit being added (decision D28). Only directly above its top level: a
   * home is one column of levels, not a scatter. Written by `updateUnit`, so
   * the floor count, the dwelling rule and the trail are the ones every level
   * change goes through.
   */
  private async growHouseByLevel(
    house: HouseOnFile,
    floor: number,
    actor: StaffActor,
  ): Promise<UnitRow> {
    const above = house.unit.floor + house.unit.levels;
    if (floor !== above) {
      throw new ValidationError({
        code: 'HOUSE_GROWTH_NOT_ABOVE',
        message: 'A level of the same home is added directly above it.',
        params: { unitCode: house.unit.unitCode, floor: above },
        details: { unitCode: house.unit.unitCode, floor: above, asked: floor },
      });
    }
    if (house.unit.levels >= MAX_UNIT_LEVELS) {
      throw new ValidationError({
        code: 'UNIT_LEVELS_MAX',
        message: 'A home spans at most the maximum number of levels.',
        params: { unitCode: house.unit.unitCode, max: MAX_UNIT_LEVELS },
      });
    }
    return this.updateUnit(house.unit.id, { levels: house.unit.levels + 1 }, actor);
  }

  /**
   * The trail of a house growing into a building: one row on the building, and
   * on each holder's own file the card that changed shape — what it said of the
   * house moved onto its row, nothing about it rewritten.
   */
  private announcePromotions(
    buildingId: string,
    promoted: readonly PromotedCard[],
    /** The unit that made it a building — null when a blueprint added several. */
    addedUnitCode: string | null,
    actor: StaffActor,
  ): void {
    if (promoted.length === 0) return;
    this.buildings.record({
      action: 'HOUSE_CARDS_PROMOTED',
      buildingId,
      after: {
        unitCode: promoted[0]!.unitCode,
        addedUnitCode,
        cards: promoted.map((card) => ({ propertyEntryId: card.propertyEntryId, citizenId: card.citizenId })),
      },
      actor,
    });
    for (const card of promoted) {
      this.events.emit('citizen.changed', {
        tenantSlug: this.tenantContext.tenantSlug,
        citizenId: card.citizenId,
        action: 'CITIZEN_UPDATED',
        before: { propertyType: 'HOUSE', ...card.moved },
        after: {
          cards: [{ kind: 'changed', propertyEntryId: card.propertyEntryId, fields: ['propertyType', 'units'] }],
          propertyType: 'BUILDING',
          unitCode: card.unitCode,
          addedUnitCode,
          ...(card.flagsMoved ? { flagsMoved: true } : {}),
          via: 'HOUSE_GREW',
        },
        actorId: actor.id,
        actorRole: actor.role,
      });
    }
  }

  /**
   * A unit placed on the columns another home's upper level occupies on this
   * floor (0095) — refused, naming the home, since the officer is looking at
   * the floor that home rises through, not at an empty space.
   */
  private async assertNotOnUpperLevel(
    buildingId: string,
    floor: number,
    span: { startCol: number; endCol: number },
    unitId?: string,
  ): Promise<void> {
    const units = await this.db.unit.findMany({ where: { buildingId } });
    if (!units.some((unit) => unit.levels > 1)) return;
    const layout = layoutBuildingFloors(units).get(floor);
    const clash = layout?.blocks.find(
      (block) =>
        block.continuation &&
        block.unit.id !== unitId &&
        block.startCol <= span.endCol &&
        span.startCol <= block.endCol,
    );
    if (clash) {
      throw new ConflictError({
        code: 'UNIT_ON_UPPER_LEVEL',
        message: 'These columns are the upper level of a home on the floor below.',
        params: { unitCode: clash.unit.unitCode, floor },
        details: { unitCode: clash.unit.unitCode, floor },
      });
    }
  }

  /**
   * A unit about to span the floors `next` describes — refused where another
   * unit is drawn on its columns there (0095).
   *
   * On the unit's own entrance floor only the upper levels of other homes are
   * asked about: neighbours on the same floor were never refused by an edit
   * here (a matrix save moves several at once and may pass through an overlap),
   * and this does not start now. Above it, anything drawn in those columns is
   * in the way — a flat there is either another household, or the upper half
   * of this one recorded as a second flat, which «دمج كدوبلكس» corrects.
   */
  private async assertLevelsFree(
    unit: { id: string; buildingId: string; unitCode: string; floor: number },
    next: { floor: number; levels: number; startCol: number | null; endCol: number | null },
  ): Promise<void> {
    const units = await this.db.unit.findMany({ where: { buildingId: unit.buildingId } });
    if (next.levels === 1 && !units.some((other) => other.levels > 1)) return;
    const layouts = layoutBuildingFloors(units);
    const self = units.find((other) => other.id === unit.id);
    if (!self) return;

    let span = next.startCol != null && next.endCol != null ? { startCol: next.startCol, endCol: next.endCol } : null;
    if (!span) {
      // Unpositioned and staying on its floor: where the drawing puts it now.
      // Unpositioned and moved: it is appended after whatever is there.
      if (next.floor !== unit.floor) return;
      const block = layouts.get(self.floor)?.blocks.find((candidate) => candidate.unit === self && !candidate.continuation);
      if (!block) return;
      span = { startCol: block.startCol, endCol: block.endCol };
    }

    for (let level = 0; level < next.levels; level += 1) {
      const floor = next.floor + level;
      const clash = layouts.get(floor)?.blocks.find(
        (block) =>
          block.unit !== self &&
          (level > 0 || block.continuation) &&
          block.startCol <= span!.endCol &&
          span!.startCol <= block.endCol,
      );
      if (!clash) continue;
      if (level === 0) {
        throw new ConflictError({
          code: 'UNIT_ON_UPPER_LEVEL',
          message: 'These columns are the upper level of a home on the floor below.',
          params: { unitCode: clash.unit.unitCode, floor },
          details: { unitCode: clash.unit.unitCode, floor },
        });
      }
      throw new ConflictError({
        code: 'UNIT_LEVELS_BLOCKED',
        message: 'Another unit is drawn on the floor this home would rise into.',
        params: { unitCode: unit.unitCode, blockedBy: clash.unit.unitCode, floor },
        details: { unitCode: unit.unitCode, blockedBy: clash.unit.unitCode, floor },
      });
    }
  }

  async updateUnit(
    unitId: string,
    asked: UpdateUnitInput,
    actor: StaffActor,
  ): Promise<UnitRow> {
    const before = await this.db.unit.findUnique({ where: { id: unitId } });
    if (!before) throw new NotFoundError('الوحدة غير موجودة');

    /*
      «نوع الوحدة» (0109): when a type or a base is sent it decides `unitType`,
      and every guard below reads that base. A unit that has no type yet is
      given its base's system type the first time it is saved, whatever else
      changed — the fill the migration promised. A custom type survives a save
      that re-sends its own base (`resolve` keeps it).
    */
    const typeChosen = asked.unitType !== undefined || asked.unitTypeId !== undefined;
    const typed =
      typeChosen || before.unitTypeId === null
        ? (await loadUnitTypes(this.db)).resolve(asked, { unitTypeId: before.unitTypeId, unitType: before.unitType })
        : null;
    const input: UpdateUnitInput =
      typed && typeChosen ? { ...asked, unitType: typed.unitType as UpdateUnitInput['unitType'] } : asked;

    /*
      Confirming a vacancy is not a field edit, and this is no longer the door
      onto it.

      `{ unitStatus: 'VACANT', surveyStatus: 'VACANT_CONFIRMED' }` is exactly
      what «تأكيد الشغور» used to send, and it wrote a finding that exempts the
      owner from the occupancy fee with nothing recorded about who decided it or
      what it rested on — and nothing to undo. `confirmVacancy` asks for both.
      Refused here rather than quietly redirected: a PATCH that silently created
      a confirmation record would be a second door onto the same fact, which is
      how the two drift.
    */
    if (input.surveyStatus === 'VACANT_CONFIRMED') {
      throw new ValidationError(
        `لتأكيد شغور الوحدة ${before.unitCode} استخدم «تأكيد الشغور» — يُسجَّل مستنده ويمكن إلغاؤه لاحقاً`,
        { surveyStatus: input.surveyStatus },
      );
    }

    /*
      …and while one is standing, the two columns it wrote are its to hold.

      Editing حالة الوحدة or حالة المسح out from under an open confirmation
      leaves the register saying two things at once: a row asserting the flat is
      empty, and a unit saying it is «مؤجرة». The remedy is the undo, which
      exists precisely so this never has to be done by hand — and which records
      why the vacancy no longer holds.
    */
    const standing = await activeVacancy(this.db, unitId);
    if (
      standing &&
      ((input.unitStatus !== undefined && input.unitStatus !== before.unitStatus) ||
        (input.surveyStatus !== undefined && input.surveyStatus !== before.surveyStatus))
    ) {
      throw new ConflictError(
        `الوحدة ${before.unitCode} مؤكَّد شغورها. ألغِ تأكيد الشغور أولاً ثم عدّل حالتها`,
      );
    }

    /*
      Moving a unit re-derives its code, because the code *is* its position —
      `floor × 100 + sequence`. A unit corrected from floor 2 to floor 3 whose
      code still read `0201` would be the one thing D9 forbids: a code that
      contradicts the row it names.
    */
    const floor = input.floor ?? before.floor;
    const sequence = input.sequence ?? before.sequence;
    const moved = floor !== before.floor || sequence !== before.sequence;

    if (moved) {
      const clash = await this.db.unit.findFirst({
        where: { buildingId: before.buildingId, floor, sequence, NOT: { id: unitId } },
      });
      if (clash) {
        throw new ConflictError(`الموقع ${formatUnitCode(floor, sequence)} مشغول بوحدة أخرى`);
      }
    }

    /*
      Calling a flat empty is refused the same way wherever it is done — see
      `assertMayBeCalledEmpty`. Reached from here for a status edit that sets
      «شاغرة» or «قيد الإنجاز» directly, and from `confirmVacancy` for the
      finding itself.
    */
    if (input.unitStatus !== undefined && isUnoccupied(input.unitStatus)) {
      await this.buildings.assertMayBeCalledEmpty(before);
    }

    /*
      …and calling it the owner's is refused over the same people.

      «مشغولة من المالك» or «مسكن موسمي» on a flat a مستأجر or شاغل بتسامح is
      registered in says the owner bears the occupancy fee there — and the tenant
      bears it too, on their own card. Nothing refused this, and the matrix tile
      went on showing «مؤجرة» from the spell, so nobody saw the double charge.
      The tenant is ended first, with the day they left, or the flat is left as
      it is.
    */
    if (input.unitStatus != null && feeBearerClass(input.unitStatus) === 'OWNER') {
      await this.buildings.assertNoOccupantBesidesOwner(before, input.unitStatus);
    }

    /*
      Retyping a real unit into «طابق أعمدة».

      The correction this exists to allow is the common one: a block painted
      مستودع before this type existed, which is what the grid offered for a
      column floor. The correction it must refuse is the same edit made on a
      flat somebody is recorded in — that would leave `unit_occupancies` rows
      hanging off a unit the two occupancy doors would now refuse to create,
      and nothing would ever revisit them. Billing would go on reading the
      cards those rows produced.

      Refused rather than cascaded into ending the spells, for the reason
      `assertMayBeCalledEmpty` gives about the same choice: «this level is
      columns» and «these people live here» are opposite statements about
      people, and only the officer knows which is true.

      Historical spells are left alone and counted as no obstacle — a flat that
      was let until it was demolished into a car park is exactly the history D2
      keeps, and refusing on it would make the correction impossible rather than
      careful.
    */
    const becomingStructural =
      input.unitType !== undefined &&
      isStructuralUnitType(input.unitType) &&
      !isStructuralUnitType(before.unitType);

    if (becomingStructural) {
      /*
        Two tables, not one.

        `unit_occupancies` is the obvious one, and counting it alone was the
        original guard. But a citizen's property card links to this same unit
        through `building_units.unitId`, and that link is what *billing* reads:
        `billableUnits` flattens the card's rows and `preferLinked` takes the
        census unit's type over the card's. So the row this guard is meant to
        protect against can exist with no occupancy at all.

        The census sync creates exactly that state on purpose — it skips a
        structural unit with a warning and deliberately leaves the card link in
        place — so the state the old guard was blind to is one the system
        produces itself.

        An ended link (`endedAt`) is history and no obstacle, for the same
        reason a closed occupancy spell is not: a flat that was let until it was
        demolished into a car park is exactly what migration 0046 keeps.
      */
      const [liveOccupancies, liveCardLinks] = await Promise.all([
        this.db.unitOccupancy.count({ where: { unitId, toDate: null } }),
        this.db.buildingUnit.count({ where: { unitId, endedAt: null } }),
      ]);

      if (liveOccupancies > 0 || liveCardLinks > 0) {
        // Named separately because they are undone differently: one is ended
        // from the occupancy panel, the other unlinked from the citizen's card.
        const reasons = [
          liveOccupancies > 0 ? `مسجَّل عليها ${liveOccupancies} شاغل حالي` : null,
          liveCardLinks > 0 ? `مرتبطة بـ ${liveCardLinks} بطاقة عقارية` : null,
        ].filter(Boolean);

        throw new ConflictError(
          `لا يمكن تحويل الوحدة ${before.unitCode} إلى ${structuralLabel(input.unitType!)}: ` +
            `${reasons.join(' و')}. ` +
            `${liveOccupancies > 0 ? 'أنهِ الإشغال' : 'أزل الربط'} أولاً`,
        );
      }
    }

    /*
      حالة الوحدة on a structural row has no meaning — «مشغولة» and «شاغرة» are
      both answers to a question about a space that can be occupied. Cleared on
      the way in rather than left to the form, so a unit retyped from مستودع
      carries none of «مؤجرة» forward, and refused rather than ignored when one
      is sent alongside the type: silently dropping a value the officer chose is
      how a form comes to disagree with the row it just wrote.
    */
    const structuralAfter = isStructuralUnitType(input.unitType ?? before.unitType);
    if (structuralAfter && input.unitStatus) {
      throw new ValidationError(
        `${structuralLabel(input.unitType ?? before.unitType)} ليس مسكناً ولا محلاً — لا تُسجَّل له حالة إشغال`,
        { unitStatus: input.unitStatus, unitType: input.unitType ?? before.unitType },
      );
    }

    /*
      A محل retyped into a شقة under somebody who lives elsewhere.

      The non-resident record may rent or occupy only what nobody lives in, and
      an owner who lives elsewhere cannot be «مشغولة من المالك» on a dwelling
      (`assertNonResidentOccupancy`). Both doors that record a person on a unit
      refuse those states; this is the third door, which reaches them by
      changing the unit under a person already recorded. Nothing refused it, so
      the linked card copied the new type and the next save of that person's
      file failed on a unit the officer had not touched.

      Checked only when the edit makes the unit a dwelling or says the owner
      lives in it. Refused rather than cascaded: whether the shop really became
      a flat, or the person really moved into town, is for the officer to say.
    */
    const typeAfter = input.unitType ?? before.unitType;

    /*
      «عدد طوابق المسكن» (0095, decision D28): one home on several levels is one
      unit, drawn across them. Only a dwelling spans levels — the database says
      so too (CHECK units_levels_dwelling_only), and is told here first so the
      officer reads why. A retype to a shop on a «دوبلكس» is the same refusal:
      bring it back to one level first.
    */
    const levelsAfter = input.levels ?? before.levels;
    if (levelsAfter > 1 && !canSpanLevels(typeAfter)) {
      throw new ValidationError({
        code: 'UNIT_LEVELS_NOT_DWELLING',
        message: 'Only a flat or a house may span more than one level.',
        params: { unitCode: before.unitCode },
        details: { unitCode: before.unitCode, unitType: typeAfter, levels: levelsAfter },
      });
    }
    const spanChanged = input.startCol !== undefined || input.endCol !== undefined;
    if (levelsAfter !== before.levels || moved || spanChanged) {
      await this.assertLevelsFree(before, {
        floor,
        levels: levelsAfter,
        startCol: input.startCol !== undefined ? input.startCol : before.startCol,
        endCol: input.endCol !== undefined ? input.endCol : before.endCol,
      });
    }

    const statusAfter = becomingStructural
      ? null
      : input.unitStatus !== undefined
        ? input.unitStatus
        : before.unitStatus;
    const becomingDwelling = isDwellingUnitType(typeAfter) && !isDwellingUnitType(before.unitType);
    const sayingOwnerLivesThere =
      isDwellingUnitType(typeAfter) &&
      statusAfter === 'OWNER_OCCUPIED' &&
      (becomingDwelling || before.unitStatus !== 'OWNER_OCCUPIED');
    /*
      «مسكن موسمي» is the owner's own seasonal absence, billed to the owner: on
      a home of an estate or an institution it would bill the heirs or the body
      the occupancy fee. Refused as the card schema and the matrix refuse it
      (`ownerSaidToLiveThere`).
    */
    const sayingSeasonal =
      isDwellingUnitType(typeAfter) &&
      statusAfter === 'SEASONAL' &&
      (becomingDwelling || before.unitStatus !== 'SEASONAL');

    if (becomingDwelling || sayingOwnerLivesThere || sayingSeasonal) {
      const names = { select: { firstName: true, middleName: true, lastName: true, residence: true } } as const;
      const nonOwner = { in: ['TENANT', 'FREE_OCCUPANT'] as never };
      const [spells, rows, owners] = await Promise.all([
        becomingDwelling
          ? this.db.unitOccupancy.findMany({
              where: {
                unitId,
                toDate: null,
                role: nonOwner,
                citizen: { residence: { in: [...OWNER_RECORD_RESIDENCE] as never } },
              },
              select: { citizen: names },
            })
          : Promise.resolve([]),
        becomingDwelling
          ? this.db.buildingUnit.findMany({
              where: {
                unitId,
                endedAt: null,
                propertyEntry: {
                  endedAt: null,
                  occupancyType: nonOwner,
                  registration: { citizen: { residence: { in: [...OWNER_RECORD_RESIDENCE] as never } } },
                },
              },
              select: { propertyEntry: { select: { registration: { select: { citizen: names } } } } },
            })
          : Promise.resolve([]),
        sayingOwnerLivesThere || sayingSeasonal
          ? this.db.unitOccupancy.findMany({
              where: { unitId, toDate: null, role: 'OWNER' as never },
              select: { citizen: { select: { residence: true } } },
            })
          : Promise.resolve([]),
      ]);

      const conflict = nonResidentUnitConflict({
        unitCode: before.unitCode,
        nonResidentOccupants: [
          ...spells.map((spell) => personName(spell.citizen)),
          ...rows.map((row) => personName(row.propertyEntry.registration.citizen)),
        ],
        ownerOccupiedByNonResident:
          sayingOwnerLivesThere &&
          owners.length > 0 &&
          owners.every((owner) => isOwnerRecord(owner.citizen.residence)),
        seasonalOwner:
          sayingSeasonal && owners.length > 0 && owners.every((owner) => isNonPersonRecord(owner.citizen.residence))
            ? owners[0]!.citizen.residence
            : null,
      });
      if (conflict) {
        throw new ConflictError(conflict, { unitCode: before.unitCode, unitType: typeAfter });
      }
    }

    /*
      Moving a unit past the building's floors grows the building, as adding a
      unit there does (`addUnit`): an officer placing a flat on a fourth floor
      of a building the register calls three storeys is correcting the
      register. Without this the unit would sit on no row of the matrix.
    */
    const building = moved || levelsAfter !== before.levels
      ? await this.db.building.findUnique({
          where: { id: before.buildingId },
          select: { floorsCount: true, basementsCount: true },
        })
      : null;
    // A home's top level is a floor the building has too (0095).
    const topFloor = floor + levelsAfter - 1;
    const growFloors = building && topFloor + 1 > building.floorsCount ? topFloor + 1 : null;
    const growBasements = building && floor < 0 && -floor > building.basementsCount ? -floor : null;

    // One transaction: a moved unit and the floors that make room for it.
    const updated = await this.atomic(async (tx) => {
      const row = await tx.unit.update({
        where: { id: unitId },
        data: {
          ...(moved ? { floor, sequence, unitCode: formatUnitCode(floor, sequence) } : {}),
          ...(input.startCol !== undefined ? { startCol: input.startCol } : {}),
          ...(input.endCol !== undefined ? { endCol: input.endCol } : {}),
          ...(input.unitType !== undefined ? { unitType: input.unitType as never } : {}),
          ...(typed ? { unitTypeId: typed.unitTypeId } : {}),
          ...(input.levels !== undefined ? { levels: input.levels } : {}),
          ...(input.postedNumber !== undefined
            ? { postedNumber: input.postedNumber?.trim() || null }
            : {}),
          ...(input.side !== undefined ? { side: input.side?.trim() || null } : {}),
          ...(input.unitArea !== undefined ? { unitArea: input.unitArea ?? null } : {}),
          /* Becoming structural clears it — see `becomingStructural` above. The
             refusal there covers an officer *sending* one; this covers the value
             already sitting on the row being retyped. */
          ...(becomingStructural
            ? { unitStatus: null }
            : input.unitStatus !== undefined
              ? { unitStatus: input.unitStatus as never }
              : {}),
          ...(input.surveyStatus !== undefined
            ? { surveyStatus: input.surveyStatus as never }
            : {}),
          ...(input.presenceMonths !== undefined ? { presenceMonths: input.presenceMonths } : {}),
          ...(input.ownerLastStayAt !== undefined ? { ownerLastStayAt: input.ownerLastStayAt } : {}),
          ...(input.vacancyDeclaredAt !== undefined
            ? { vacancyDeclaredAt: input.vacancyDeclaredAt }
            : {}),
          ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
        },
      });

      if (growFloors !== null || growBasements !== null) {
        await tx.building.update({
          where: { id: before.buildingId },
          data: {
            ...(growFloors !== null ? { floorsCount: growFloors } : {}),
            ...(growBasements !== null ? { basementsCount: growBasements } : {}),
          },
        });
      }
      return row;
    });

    /*
      Every field this save changed, and only those — the rule the building's
      own audit row follows (`changedBuildingFields`). This used to record the
      code and the two statuses whatever moved, so a flat retyped from محل to
      شقة, or re-measured from 40 m² to 140 m², left no trail, though both
      change what its occupant is billed. `unitCode` is always on both sides:
      it is how a reader finds the unit.
    */
    const changes = changedUnitFields(before, updated);
    this.buildings.record({
      action: 'UNIT_UPDATED',
      buildingId: before.buildingId,
      before: { ...changes.before, unitCode: before.unitCode },
      after: {
        ...changes.after,
        unitCode: updated.unitCode,
        changedFields: Object.keys(changes.after),
        ...(growFloors !== null || growBasements !== null
          ? { buildingGrown: { floorsCount: growFloors, basementsCount: growBasements } }
          : {}),
      },
      actor,
    });

    if (input.unitStatus !== undefined || becomingStructural) {
      const { statusChanged } = await this.buildings.settle(unitId, actor, 'UNIT_EDITOR');
      if (statusChanged) {
        const settled = await this.db.unit.findUnique({ where: { id: unitId } });
        if (settled) return toUnitRow(settled);
      }
    }

    return toUnitRow(updated);
  }

  // ─────────────────────────  «تعديل عرض الوحدة»  ─────────────────────────

  /**
   * Moves a unit's two edges on its floor's grid — the matrix's resize.
   *
   * Geometry only: the code, the floor and the sequence stay, so nothing that
   * names the unit changes. What it may not do is draw over a neighbour, and
   * that is checked against the floor as the matrix *draws* it
   * (`layoutFloorSpans`), not only against the spans stored on rows. A unit
   * with no stored span is drawn after the positioned ones; once its neighbour
   * holds a stored span it would be redrawn somewhere else. So every
   * unpositioned unit on the floor is pinned where it was drawn, in the same
   * transaction, and the flat the officer did not touch stays where they saw
   * it.
   *
   * Under the building's row lock, as `saveMatrix` is: two officers widening
   * the two flats either side of one gap would each pass the check alone.
   */
  async resizeUnitSpan(
    unitId: string,
    input: ResizeUnitSpanInput,
    actor: StaffActor,
  ): Promise<UnitRow> {
    const target = await this.db.unit.findUnique({
      where: { id: unitId },
      select: { id: true, buildingId: true },
    });
    if (!target) throw new NotFoundError('الوحدة غير موجودة');

    const { updated, changes } = await runInTenantTransaction(this.tenantContext, async () => {
      const S = tenantSchemaRef(this.tenantContext.schemaName);
      await this.db.$queryRaw`SELECT "id" FROM ${S}"buildings" WHERE "id" = ${target.buildingId}::uuid FOR UPDATE`;

      // Re-read under the lock: the unit may have moved floor since.
      const before = await this.db.unit.findUnique({ where: { id: unitId } });
      if (!before) throw new NotFoundError('الوحدة غير موجودة');

      /*
        The whole building, not the unit's floor: a «دوبلكس» widened on the
        ground floor is widened on the floor above too, and may not be drawn
        over what stands there (0095). A one-level unit asks exactly what it
        always did — its floor's neighbours, and the upper levels of any home
        rising through it.
      */
      const buildingUnits = await this.db.unit.findMany({
        where: { buildingId: before.buildingId },
        orderBy: [{ floor: 'asc' }, { sequence: 'asc' }],
      });
      const layouts = layoutBuildingFloors(buildingUnits);
      const self = buildingUnits.find((unit) => unit.id === unitId)!;
      const blocks = floorsOfUnit(self).flatMap((level) => layouts.get(level)?.blocks ?? []);

      const clash = levelSpanOverlap(layouts, self, input);
      if (clash) {
        throw new ConflictError(
          `لا يمكن توسيع الوحدة ${before.unitCode} فوق الوحدة ${clash.unit.unitCode} — الأعمدة ${input.startCol}–${input.endCol} ليست فارغة`,
          { unitCode: before.unitCode, blockedBy: clash.unit.unitCode },
        );
      }

      const pins = blocks.filter(
        (block) =>
          // Another home's upper level is placed by its own floor, not pinned here.
          !block.continuation &&
          block.unit.id !== unitId &&
          (block.unit.startCol == null || block.unit.endCol == null) &&
          // Drawn past the grid's last column, it has no column to be pinned to;
          // it stays unpositioned rather than stored where no schema allows.
          block.endCol <= MAX_UNIT_COLUMN,
      );
      const changes: Array<{ before: typeof before; after: typeof before }> = [];
      for (const pin of pins) {
        const after = await this.db.unit.update({
          where: { id: pin.unit.id },
          data: { startCol: pin.startCol, endCol: pin.endCol },
        });
        changes.push({ before: pin.unit, after });
      }

      const updated = await this.db.unit.update({
        where: { id: unitId },
        data: { startCol: input.startCol, endCol: input.endCol },
      });
      changes.push({ before, after: updated });

      /*
        A resize is a change to the building's drawing, so it moves the
        building's version like every other matrix write. Without this, an
        editor or matrix opened before the resize passes `assertFresh` and
        writes the old spans back — or draws a flat over the one just widened.
      */
      await this.db.building.update({
        where: { id: before.buildingId },
        data: { updatedAt: new Date() },
      });
      return { updated, changes };
    });

    for (const change of changes) {
      const diff = changedUnitFields(change.before, change.after);
      if (Object.keys(diff.after).length === 0) continue;
      this.buildings.record({
        action: 'UNIT_UPDATED',
        buildingId: change.before.buildingId,
        before: { ...diff.before, unitCode: change.before.unitCode },
        after: {
          ...diff.after,
          unitCode: change.after.unitCode,
          changedFields: Object.keys(diff.after),
          // A neighbour pinned in place, not resized — said so in its trail.
          ...(change.after.id !== unitId ? { pinnedBy: updated.unitCode } : {}),
        },
        actor,
      });
    }

    return toUnitRow(updated);
  }

  // ─────────────────────────  «تأكيد الشغور»  ─────────────────────────

  /**
   * One transaction — or the caller's, when there already is one: `runInTenantTransaction`
   * with this service's bounds (`APP_CONFIG.transactions.buildingWrite`), the work handed the
   * transaction client the scope now holds (audit ARCH-03).
   *
   * «إنهاء الإيجار» confirms the vacancy it leaves behind inside its own transaction, so the
   * tenancy and the vacancy commit together; a whole-matrix save (`saveMatrix`) runs `addUnit`
   * inside its own. The helper joins an enclosing transaction rather than opening a second,
   * and since it swaps the scope, the services and audit listeners called inside the work write
   * through it too — which the bare `$transaction` this replaced, joined by duck-typing, did not.
   */
  private atomic<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return runInTenantTransaction(
      this.tenantContext,
      () => work(this.db as Prisma.TransactionClient),
      APP_CONFIG.transactions.buildingWrite,
    );
  }

  /**
   * Removes a unit that turned out not to exist — and refuses whenever removing
   * it would take a record of something that did.
   *
   * The counterpart to `addUnit`, for the mistake that one makes possible: a
   * blueprint of four flats a floor on a floor that has three, or a محل counted
   * twice from the street. Until now the matrix could only grow, so an officer
   * who overshot had a permanently wrong denominator — `unitsTotal` feeds the
   * survey-coverage figures on the dashboard, so a phantom flat is a building
   * that can never read «مكتملة».
   *
   * ## Four refusals, because deleting a unit is quietly destructive
   *
   * `Unit` is the parent of more history than its size suggests, and Prisma
   * cascades most of it without a word:
   *
   *   • `UnitOccupancy` — **Cascade**. Who has ever lived here. D2 keeps ended
   *     spells precisely so the municipality outlives the card; a delete would
   *     erase them with no audit row naming what went.
   *   • `UnitVisit` — **Cascade**. The «٣ محاولات» behind a dispatch decision.
   *   • `DamageAssessment` — **Cascade**. War-damage findings, which are the
   *     evidentiary basis for compensation. This is the one that would hurt
   *     most and complain least.
   *   • `BuildingUnit.unitId` — **SetNull**. A citizen's own card silently
   *     stops naming a canonical flat, so their file and the census quietly
   *     disagree about a property that is still theirs.
   *
   * So the rule is the same one `delete` applies to a whole building: a unit
   * may be removed only while it is still nothing but an assertion that a flat
   * exists. The moment anybody has recorded anything against it, the correction
   * is `updateUnit` — or «مهدوم» on the building — not deletion.
   *
   * Each refusal names its own remedy rather than sharing one message. The
   * building delete used to answer a historical occupancy with «أنهِ الإشغالات
   * أولاً», an instruction that changes nothing because ending a spell keeps
   * the row; officers followed it, retried, and got the identical error for
   * ever.
   */
  async deleteUnit(unitId: string, actor: StaffActor): Promise<void> {
    const unit = await this.db.unit.findUnique({
      where: { id: unitId },
      select: { id: true, buildingId: true, unitCode: true, floor: true, sequence: true },
    });
    if (!unit) throw new NotFoundError('الوحدة غير موجودة');

    const [current, historical, visits, damage, cards, vacancies] = await Promise.all([
      this.db.unitOccupancy.count({ where: { unitId, toDate: null } }),
      this.db.unitOccupancy.count({ where: { unitId } }),
      this.db.unitVisit.count({ where: { unitId } }),
      this.db.damageAssessment.count({ where: { unitId } }),
      this.db.buildingUnit.count({ where: { unitId } }),
      /*
        Confirmations the municipality stands behind — a standing one, or one
        closed as «لم تعد شاغرة». Both say the flat was found empty on a date,
        which is what an exemption was granted on, and `onDelete: Cascade` would
        take them with the unit.

        Ones closed as «سُجِّل بالخطأ» are excluded on purpose: they assert
        nothing about the flat, so they must not be the reason a phantom unit
        can never be removed.
      */
      this.db.unitVacancyConfirmation.count({
        where: { unitId, NOT: { endReason: 'RECORDED_IN_ERROR' as never } },
      }),
    ]);

    if (current > 0) {
      throw new ConflictError(
        `لا يمكن حذف الوحدة ${unit.unitCode}: يوجد ${current} إشغال قائم عليها. أنهِ الإشغال أولاً`,
      );
    }

    if (historical > 0) {
      throw new ConflictError(
        `لا يمكن حذف الوحدة ${unit.unitCode}: سُجِّل فيها ${historical} إشغال سابق، وحذفها يمحو سجل من سكنها. صحّح بيانات الوحدة بدلاً من حذفها`,
      );
    }

    if (cards > 0) {
      throw new ConflictError(
        `لا يمكن حذف الوحدة ${unit.unitCode}: ${cards} بطاقة عقار في سجل المواطنين تشير إليها. أزل الربط من ملف المواطن أولاً`,
      );
    }

    if (damage > 0) {
      throw new ConflictError(
        `لا يمكن حذف الوحدة ${unit.unitCode}: عليها ${damage} كشف ضرر. كشوف الضرر مستند تعويض ولا تُحذف مع الوحدة`,
      );
    }

    if (visits > 0) {
      throw new ConflictError(
        `لا يمكن حذف الوحدة ${unit.unitCode}: سُجِّلت عليها ${visits} زيارة ميدانية. صحّح بيانات الوحدة بدلاً من حذفها`,
      );
    }

    if (vacancies > 0) {
      throw new ConflictError(
        `لا يمكن حذف الوحدة ${unit.unitCode}: سُجِّل عليها ${vacancies} تأكيد شغور، وعليه تُعفى من رسوم الإشغال. ألغِ تأكيد الشغور بسبب «سُجِّل بالخطأ» إن لم تكن الوحدة موجودة أصلاً`,
      );
    }

    // Its fee exemption history, granted or lifted, keys onto it with RESTRICT (0104).
    await assertNoFeeExemptionHistory(this.db, { unitIds: [unitId] });

    /*
      `unitsTotal` and `unitsSurveyed` are corrected by the database, not here.

      Migration 0030 puts a row trigger — `units_sync_building_counts` — on
      INSERT, DELETE and UPDATE of `units`, which recomputes both counters for
      the affected building. Decrementing them here as well would take the
      denominator two below the truth on every deletion, and the drift would
      only show up as a survey-coverage percentage that crept past 100%.

      This is also why `addUnit` and `generateUnits` never touch them either.
    */
    await this.db.unit.delete({ where: { id: unitId } });

    this.buildings.record({
      action: 'UNIT_DELETED',
      buildingId: unit.buildingId,
      before: { unitCode: unit.unitCode, floor: unit.floor, sequence: unit.sequence },
      actor,
    });
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  formatBuildingCode,
  formatUnitCode,
  nextBuildingSuffix,
  STRUCTURE_TYPE_MAP,
  SURVEYED_STATUS,
  type CreateBuildingInput,
  type StructureType,
  type UnitBlueprint,
  type UpdateBuildingInput,
  type UpdateUnitInput,
  type UpsertOccupancyInput,
  type UpsertUnitInput,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { withConnectionRetry } from '../../../infrastructure/prisma/with-connection-retry';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { CasesService } from '../cases/cases.service';
import type {
  BuildingListFilter,
  BuildingMapPin,
  BuildingRow,
  OccupancyRow,
  UnitRow,
} from './building.types';

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

/**
 * A building with its units, as the matrix drawer reads it.
 */
export interface BuildingDetail extends BuildingRow {
  /** The zone this building's parcel belongs to, resolved at read time (D13). */
  zoneCode: string | null;
  zoneName: string | null;
  units: Array<UnitRow & { occupants: OccupancyRow[] }>;
}

@Injectable()
export class BuildingsService {
  private readonly logger = new Logger(BuildingsService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly cases: CasesService,
    private readonly events: EventEmitter2,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private record(input: {
    action:
      | 'BUILDING_CREATED'
      | 'BUILDING_UPDATED'
      | 'BUILDING_DELETED'
      | 'BUILDING_UNITS_GENERATED'
      | 'BUILDING_CODE_RECOMPUTED'
      | 'UNIT_UPDATED'
      | 'OCCUPANCY_RECORDED'
      | 'OCCUPANCY_ENDED';
    buildingId: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    actor: { id: string; role: string };
  }): void {
    this.events.emit('building.changed', {
      tenantSlug: this.tenantContext.tenantSlug,
      action: input.action,
      buildingId: input.buildingId,
      before: input.before,
      after: input.after,
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });
  }

  // ───────────────────────────────  Reads  ───────────────────────────────

  /**
   * The census ledger.
   *
   * `damageLevel` filters on the *current* level — the latest assessment — not
   * on any assessment ever recorded, which is what makes "show me the unsafe
   * buildings" mean the buildings that are unsafe now rather than the ones that
   * were unsafe in 2024 and have since been repaired.
   */
  async list(filter: BuildingListFilter): Promise<{ buildings: BuildingRow[]; total: number }> {
    const where = await this.buildWhere(filter);

    const [rows, total] = await withConnectionRetry(() =>
      Promise.all([
        this.db.building.findMany({
          where,
          orderBy: [{ parcelNumber: 'asc' }, { codeSuffix: 'asc' }],
          take: filter.limit ?? 100,
          skip: filter.offset ?? 0,
        }),
        this.db.building.count({ where }),
      ]),
    );

    let buildings = rows.map(toBuildingRow);

    if (filter.damageLevel) {
      const current = await this.currentDamageLevels(buildings.map((b) => b.id));
      buildings = buildings.filter((b) => current.get(b.id) === filter.damageLevel);
    }

    return { buildings, total };
  }

  private async buildWhere(filter: BuildingListFilter): Promise<Prisma.BuildingWhereInput> {
    const where: Prisma.BuildingWhereInput = {};

    if (filter.parcelNumber) where.parcelNumber = filter.parcelNumber.trim();
    if (filter.parcelNumbers) where.parcelNumber = { in: [...filter.parcelNumbers] };
    if (filter.structureType) where.structureType = filter.structureType as never;

    /*
      A survey-status filter asks about the *building*, and a building has no
      status of its own — it has a rollup, which takes the worst of its units
      (D11). "Show me the buildings that are not surveyed" therefore means
      "buildings with at least one unit in that state", not "buildings whose
      units are all in it": one unsurveyed flat is what sends an officer back,
      and it must not hide behind eleven surveyed ones.

      A building with no units at all matches `NOT_SURVEYED`, because that is
      exactly what an empty shell is — see `rollupOf`.
    */
    if (filter.surveyStatus) {
      where.OR =
        filter.surveyStatus === 'NOT_SURVEYED'
          ? [{ units: { some: { surveyStatus: 'NOT_SURVEYED' } } }, { units: { none: {} } }]
          : [{ units: { some: { surveyStatus: filter.surveyStatus as never } } }];
    }

    if (filter.search) {
      const term = filter.search.trim();
      const match = { contains: term, mode: 'insensitive' as const };
      const search: Prisma.BuildingWhereInput[] = [
        { code: match },
        { name: match },
        { postedNumber: match },
        { parcelNumber: match },
      ];
      // ANDed with the survey filter above rather than merged into one OR,
      // which would have a search term widening the status filter instead of
      // narrowing within it.
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { OR: search }];
    }

    return where;
  }

  async get(id: string): Promise<BuildingDetail> {
    const row = await withConnectionRetry(() =>
      this.db.building.findUnique({
        where: { id },
        include: {
          units: {
            orderBy: [{ floor: 'asc' }, { sequence: 'asc' }],
            include: {
              occupancies: {
                // Current occupants first, then history newest-first: the
                // matrix cell shows who is in the flat now, and the drawer
                // below it shows who was.
                orderBy: [{ toDate: 'asc' }, { fromDate: 'desc' }],
                include: { citizen: { select: { firstName: true, lastName: true } } },
              },
            },
          },
        },
      }),
    );

    if (!row) throw new NotFoundError('المبنى غير موجود');

    const zone = await this.zoneOfParcel(row.parcelNumber);

    return {
      ...toBuildingRow(row),
      zoneCode: zone?.code ?? null,
      zoneName: zone?.name ?? null,
      units: row.units.map((unit) => ({
        ...toUnitRow(unit),
        occupants: unit.occupancies.map(toOccupancyRow),
      })),
    };
  }

  // ──────────────────────────────  Creation  ──────────────────────────────

  /**
   * Creates the shell, allocating its per-parcel suffix under a lock.
   *
   * The lock is the whole of §4.4. Two field officers standing on the same
   * parcel with no signal will both mint a provisional `A`; when their phones
   * sync, the second one has to become `B` — and "read the taken suffixes, pick
   * the next, insert" is a read-then-write that two concurrent syncs interleave
   * into the same answer. The unique index on `(parcelNumber, codeSuffix)`
   * would catch the collision, but as a 500 on a record the officer was
   * promised had been sent.
   *
   * A transaction-scoped advisory lock keyed on the parcel serialises them
   * instead, so the second sync waits, reads `A` as taken, and gets `B`.
   *
   * The key is namespaced by schema. Tenant schemas share one database, so
   * `hashtext('28')` alone would make Albazourieh's parcel 28 serialise against
   * every other municipality's — correct, but needlessly, and on a lock that is
   * held for the length of a write.
   */
  async create(
    input: CreateBuildingInput,
    actor: { id: string; role: string },
  ): Promise<{ building: BuildingRow; reconciled: boolean; deduplicated: boolean }> {
    const parcelNumber = input.parcelNumber.trim();

    /*
      A re-delivered offline creation is recognised by primary key.

      The id the phone minted before it had signal *is* the row's id, so the
      second delivery of the same creation finds the building it already made
      rather than putting a second structure on the parcel. That is the same
      trick `clientSubmissionId` plays for a registration, one step simpler:
      here the client's id can be the row's id, because nothing else assigns it.
    */
    const existing = input.clientSubmissionId
      ? await this.db.building.findUnique({ where: { id: input.clientSubmissionId } })
      : null;
    if (existing) {
      return { building: toBuildingRow(existing), reconciled: false, deduplicated: true };
    }

    const created = await this.db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext(current_schema() || $1))',
        `:building-suffix:${parcelNumber}`,
      );

      const taken = await tx.building.findMany({
        where: { parcelNumber },
        select: { codeSuffix: true },
      });
      const codeSuffix = nextBuildingSuffix(taken.map((b) => b.codeSuffix));
      const zone = await this.zoneOfParcel(parcelNumber, tx);

      return tx.building.create({
        data: {
          ...(input.clientSubmissionId ? { id: input.clientSubmissionId } : {}),
          parcelNumber,
          codeSuffix,
          code: formatBuildingCode({ zoneCode: zone?.code, parcelNumber, codeSuffix }),
          name: input.name?.trim() || null,
          postedNumber: input.postedNumber?.trim() || null,
          structureType: input.structureType as never,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          floorsCount: input.floorsCount,
          notes: input.notes?.trim() || null,
          createdById: actor.id,
        },
      });
    });

    /*
      Whether the officer has been quoting a code that is no longer the answer.

      Reported rather than silently corrected: an officer who wrote «A-1042-A»
      on a form in someone's stairwell needs to be told it became «A-1042-B», or
      they will keep quoting the old one — and the resident will be looking for
      a building that does not exist under that name.
    */
    const reconciled = Boolean(
      input.provisionalSuffix &&
        input.provisionalSuffix.trim().toUpperCase() !== created.codeSuffix,
    );

    this.record({
      action: 'BUILDING_CREATED',
      buildingId: created.id,
      after: {
        code: created.code,
        parcelNumber: created.parcelNumber,
        structureType: created.structureType,
        ...(reconciled ? { provisionalSuffix: input.provisionalSuffix } : {}),
      },
      actor,
    });

    return { building: toBuildingRow(created), reconciled, deduplicated: false };
  }

  async update(
    id: string,
    input: UpdateBuildingInput,
    actor: { id: string; role: string },
  ): Promise<BuildingRow> {
    const before = await this.db.building.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('المبنى غير موجود');

    const updated = await this.db.building.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name?.trim() || null } : {}),
        ...(input.postedNumber !== undefined
          ? { postedNumber: input.postedNumber?.trim() || null }
          : {}),
        ...(input.structureType !== undefined
          ? { structureType: input.structureType as never }
          : {}),
        ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
        ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
        ...(input.floorsCount !== undefined ? { floorsCount: input.floorsCount } : {}),
        ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
      },
    });

    this.record({
      action: 'BUILDING_UPDATED',
      buildingId: id,
      before: { name: before.name, structureType: before.structureType },
      after: { name: updated.name, structureType: updated.structureType },
      actor,
    });

    return toBuildingRow(updated);
  }

  async remove(id: string, actor: { id: string; role: string }): Promise<void> {
    const before = await this.db.building.findUnique({
      where: { id },
      include: { _count: { select: { units: true } } },
    });
    if (!before) throw new NotFoundError('المبنى غير موجود');

    /*
      A building with occupancies on it is a building somebody has been
      surveyed in, and deleting it cascades those away.

      Refused rather than cascaded, because the census's whole purpose is that a
      unit outlives the card that described it — and `PropertyEntry.buildingId`
      is `SetNull`, so the citizen's own record would survive while the
      municipality's record of where they live would not.
    */
    const occupied = await this.db.unitOccupancy.count({ where: { unit: { buildingId: id } } });
    if (occupied > 0) {
      throw new ConflictError(
        `لا يمكن حذف المبنى: ${occupied} إشغال مسجّل على وحداته. أنهِ الإشغالات أولاً`,
      );
    }

    await this.db.building.delete({ where: { id } });

    this.record({
      action: 'BUILDING_DELETED',
      buildingId: id,
      before: { code: before.code, parcelNumber: before.parcelNumber, units: before._count.units },
      actor,
    });
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
    actor: { id: string; role: string },
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
            }),
          )
        : blueprint.floors;

    const requested = plan.reduce((sum, entry) => sum + entry.unitCount, 0);
    if (requested > MAX_GENERATED_UNITS) {
      throw new ValidationError(
        `عدد الوحدات المطلوب توليدها (${requested}) يتجاوز الحد الأقصى ${MAX_GENERATED_UNITS}`,
      );
    }

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

    for (const entry of plan) {
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
          unitType: entry.unitType as never,
        });
      }
    }

    if (data.length > 0) {
      await this.db.unit.createMany({ data, skipDuplicates: true });
    }

    // `floorsCount` only ever rises: a blueprint that names fewer floors than
    // the building already has is not evidence it got shorter.
    const topFloor = plan.reduce((max, entry) => Math.max(max, entry.floor), 0);
    if (topFloor + 1 > building.floorsCount) {
      await this.db.building.update({
        where: { id: buildingId },
        data: { floorsCount: topFloor + 1 },
      });
    }

    const units = await this.db.unit.findMany({
      where: { buildingId },
      orderBy: [{ floor: 'asc' }, { sequence: 'asc' }],
    });

    this.record({
      action: 'BUILDING_UNITS_GENERATED',
      buildingId,
      after: { created: data.length, skipped, total: units.length },
      actor,
    });

    return { created: data.length, skipped, units: units.map(toUnitRow) };
  }

  /** One unit added by hand, at the next free position on its floor. */
  async addUnit(
    buildingId: string,
    input: UpsertUnitInput,
    actor: { id: string; role: string },
  ): Promise<UnitRow> {
    const building = await this.db.building.findUnique({ where: { id: buildingId } });
    if (!building) throw new NotFoundError('المبنى غير موجود');

    const created = await this.db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext(current_schema() || $1))',
        `:unit-sequence:${buildingId}`,
      );

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

      return tx.unit.create({
        data: {
          buildingId,
          floor: input.floor,
          sequence,
          unitCode: formatUnitCode(input.floor, sequence),
          unitType: input.unitType as never,
          postedNumber: input.postedNumber?.trim() || null,
          side: input.side?.trim() || null,
          unitArea: input.unitArea ?? null,
          unitStatus: (input.unitStatus ?? null) as never,
          surveyStatus: (input.surveyStatus ?? 'NOT_SURVEYED') as never,
          notes: input.notes?.trim() || null,
        },
      });
    });

    this.record({
      action: 'UNIT_UPDATED',
      buildingId,
      after: { unitCode: created.unitCode, created: true },
      actor,
    });

    return toUnitRow(created);
  }

  async updateUnit(
    unitId: string,
    input: UpdateUnitInput,
    actor: { id: string; role: string },
  ): Promise<UnitRow> {
    const before = await this.db.unit.findUnique({ where: { id: unitId } });
    if (!before) throw new NotFoundError('الوحدة غير موجودة');

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

    const updated = await this.db.unit.update({
      where: { id: unitId },
      data: {
        ...(moved ? { floor, sequence, unitCode: formatUnitCode(floor, sequence) } : {}),
        ...(input.unitType !== undefined ? { unitType: input.unitType as never } : {}),
        ...(input.postedNumber !== undefined
          ? { postedNumber: input.postedNumber?.trim() || null }
          : {}),
        ...(input.side !== undefined ? { side: input.side?.trim() || null } : {}),
        ...(input.unitArea !== undefined ? { unitArea: input.unitArea ?? null } : {}),
        ...(input.unitStatus !== undefined ? { unitStatus: input.unitStatus as never } : {}),
        ...(input.surveyStatus !== undefined
          ? { surveyStatus: input.surveyStatus as never }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
      },
    });

    this.record({
      action: 'UNIT_UPDATED',
      buildingId: before.buildingId,
      before: { unitCode: before.unitCode, surveyStatus: before.surveyStatus },
      after: { unitCode: updated.unitCode, surveyStatus: updated.surveyStatus },
      actor,
    });

    return toUnitRow(updated);
  }

  // ────────────────────────────  Occupancy  ────────────────────────────

  /**
   * Records who is in a unit — and closes the case that was waiting to find out.
   *
   * The auto-resolve is P2-T5's half of this and it belongs here rather than in
   * the cases page, because this is the moment the thing the case was waiting
   * on actually happened. A حالة on a flat says "nobody answered"; an occupancy
   * on that flat says who lives there. Leaving the case open would send a second
   * officer to a door the municipality has already been through.
   */
  async recordOccupancy(
    input: UpsertOccupancyInput,
    actor: { id: string; role: string },
  ): Promise<{ occupancy: OccupancyRow; casesResolved: number }> {
    const unit = await this.db.unit.findUnique({
      where: { id: input.unitId },
      select: { id: true, buildingId: true, unitCode: true },
    });
    if (!unit) throw new NotFoundError('الوحدة غير موجودة');

    const citizen = await this.db.user.findUnique({ where: { id: input.citizenId } });
    if (!citizen || citizen.kind !== 'CITIZEN') {
      throw new ValidationError('المواطن غير موجود', { citizenId: input.citizenId });
    }

    /*
      A person is in a unit once, in one capacity, at a time.

      Re-recording the same pair is a correction — the officer picked the wrong
      role, or is re-syncing an offline entry — not a second tenancy, so the
      current row is updated rather than duplicated. A *closed* occupancy is
      left alone: someone who moved out and back in is two spells, which is
      exactly the history D2 exists to keep.
    */
    const current = await this.db.unitOccupancy.findFirst({
      where: { unitId: input.unitId, citizenId: input.citizenId, toDate: null },
    });

    const occupancy = current
      ? await this.db.unitOccupancy.update({
          where: { id: current.id },
          data: {
            role: input.role as never,
            shares: input.shares ?? null,
            ...(input.fromDate ? { fromDate: input.fromDate } : {}),
            ...(input.toDate !== undefined ? { toDate: input.toDate } : {}),
          },
          include: { citizen: { select: { firstName: true, lastName: true } } },
        })
      : await this.db.unitOccupancy.create({
          data: {
            unitId: input.unitId,
            citizenId: input.citizenId,
            role: input.role as never,
            shares: input.shares ?? null,
            ...(input.fromDate ? { fromDate: input.fromDate } : {}),
            ...(input.toDate ? { toDate: input.toDate } : {}),
          },
          include: { citizen: { select: { firstName: true, lastName: true } } },
        });

    /*
      A unit with somebody in it has been surveyed.

      Only lifted from the states that mean "we still do not know": an officer
      who has recorded an occupant has, by definition, been answered. A unit
      already marked `DEMOLISHED` or `VACANT_CONFIRMED` is left alone — those
      are findings that contradict this one, and a contradiction is for a person
      to resolve, not for a side effect to overwrite.
    */
    const OPEN_STATES = ['NOT_SURVEYED', 'VISITED_NO_ANSWER', 'PARTIAL'];
    await this.db.unit.updateMany({
      where: { id: input.unitId, surveyStatus: { in: OPEN_STATES as never } },
      data: { surveyStatus: 'COMPLETE' },
    });

    const casesResolved = await this.cases.resolveForUnit(input.unitId, input.citizenId, actor);

    this.record({
      action: 'OCCUPANCY_RECORDED',
      buildingId: unit.buildingId,
      after: {
        unitCode: unit.unitCode,
        citizenId: input.citizenId,
        role: input.role,
        casesResolved,
      },
      actor,
    });

    return { occupancy: toOccupancyRow(occupancy), casesResolved };
  }

  /** Ends a spell without deleting it — the history is the point (D2). */
  async endOccupancy(
    occupancyId: string,
    toDate: Date | undefined,
    actor: { id: string; role: string },
  ): Promise<OccupancyRow> {
    const existing = await this.db.unitOccupancy.findUnique({
      where: { id: occupancyId },
      include: { unit: { select: { buildingId: true, unitCode: true } } },
    });
    if (!existing) throw new NotFoundError('سجل الإشغال غير موجود');

    const updated = await this.db.unitOccupancy.update({
      where: { id: occupancyId },
      data: { toDate: toDate ?? new Date() },
      include: { citizen: { select: { firstName: true, lastName: true } } },
    });

    this.record({
      action: 'OCCUPANCY_ENDED',
      buildingId: existing.unit.buildingId,
      after: { unitCode: existing.unit.unitCode, toDate: updated.toDate },
      actor,
    });

    return toOccupancyRow(updated);
  }

  // ─────────────────────────────  Codes  ─────────────────────────────

  /**
   * Rewrites the derived half of every code a zone's membership touches.
   *
   * `code` is `ZONE-PARCEL-SUFFIX`, and the zone half is resolved from
   * `Zone.parcelNumbers` at render time rather than stored as an FK (D13) — so
   * renaming a sector, or moving parcels between sectors, silently invalidates
   * every stored `code` on those parcels. This is the job that fixes them, and
   * `ZonesService` calls it after every write.
   *
   * Two phases inside one transaction, and the first is not optional. `code` is
   * unique, so renaming A→B while another building already holds the B code
   * collides mid-update on a constraint that has nothing to do with the change
   * being made. Parking every affected row on a guaranteed-unique temporary
   * value first means the second phase can never collide with a row it is
   * about to rewrite anyway.
   */
  async recomputeCodesForParcels(
    parcelNumbers: readonly string[],
    actor?: { id: string; role: string },
  ): Promise<number> {
    const wanted = [...new Set(parcelNumbers.map((n) => n.trim()).filter(Boolean))];
    if (wanted.length === 0) return 0;

    const zones = await this.db.zone.findMany({ select: { code: true, parcelNumbers: true } });
    const zoneOf = new Map<string, string>();
    for (const zone of zones) {
      for (const parcelNumber of zone.parcelNumbers) zoneOf.set(parcelNumber, zone.code);
    }

    const buildings = await this.db.building.findMany({
      where: { parcelNumber: { in: wanted } },
      select: { id: true, parcelNumber: true, codeSuffix: true, code: true },
    });

    const changed = buildings
      .map((b) => ({
        ...b,
        next: formatBuildingCode({
          zoneCode: zoneOf.get(b.parcelNumber),
          parcelNumber: b.parcelNumber,
          codeSuffix: b.codeSuffix,
        }),
      }))
      .filter((b) => b.next !== b.code);

    if (changed.length === 0) return 0;

    await this.db.$transaction(async (tx) => {
      for (const building of changed) {
        await tx.building.update({
          where: { id: building.id },
          data: { code: `~pending:${building.id}` },
        });
      }
      for (const building of changed) {
        await tx.building.update({ where: { id: building.id }, data: { code: building.next } });
      }
    });

    this.logger.log(`Recomputed ${changed.length} building code(s) after a zone change`);

    if (actor) {
      for (const building of changed) {
        this.record({
          action: 'BUILDING_CODE_RECOMPUTED',
          buildingId: building.id,
          before: { code: building.code },
          after: { code: building.next },
          actor,
        });
      }
    }

    return changed.length;
  }

  // ─────────────────────────────  Helpers  ─────────────────────────────

  /**
   * The current damage level per building — the latest assessment on the
   * building itself or on any of its units, whichever was observed last.
   *
   * One query for the whole set rather than one per building: the ledger and
   * the map both need this for every row they draw, and a correlated subquery
   * per pin is the N+1 that makes a census map unusable.
   */
  async currentDamageLevels(buildingIds: readonly string[]): Promise<Map<string, string>> {
    if (buildingIds.length === 0) return new Map();

    /*
      Each id cast at the placeholder, not the column.

      Prisma binds a JS string as `text`, and Postgres has no `uuid = text`
      operator, so the bare parameter list fails outright. Casting the *column*
      to text instead would work and would also throw away the index on it,
      which is the one thing this query exists to use.
    */
    const ids = Prisma.join(buildingIds.map((id) => Prisma.sql`${id}::uuid`));

    const rows = await this.db.$queryRaw<Array<{ buildingId: string; level: string }>>`
      SELECT DISTINCT ON (t."buildingId") t."buildingId", t."level"
        FROM (
          SELECT d."buildingId", d."level", d."assessedAt"
            FROM "damage_assessments" d
           WHERE d."buildingId" IN (${ids})
          UNION ALL
          SELECT u."buildingId", d."level", d."assessedAt"
            FROM "damage_assessments" d
            JOIN "units" u ON u."id" = d."unitId"
           WHERE u."buildingId" IN (${ids})
        ) t
       ORDER BY t."buildingId", t."assessedAt" DESC
    `;

    return new Map(rows.map((row) => [row.buildingId, row.level]));
  }

  private async zoneOfParcel(
    parcelNumber: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ code: string; name: string } | null> {
    const client = tx ?? this.db;
    const zone = await client.zone.findFirst({
      where: { parcelNumbers: { has: parcelNumber } },
      select: { code: true, name: true },
    });
    return zone ?? null;
  }

  /** The default unit type for a structure, from the one map that owns it. */
  static defaultUnitTypeFor(structureType: string): string {
    return (
      STRUCTURE_TYPE_MAP[structureType as StructureType]?.defaultUnitType ?? 'APARTMENT'
    );
  }

  /**
   * Every building pin the map draws, in one payload.
   *
   * One query for the buildings, one for their unit statuses, one for their
   * damage — three, whatever the municipality's size, rather than the two
   * queries per pin a naive rollup costs. A census map is the one screen that
   * draws every structure at once, so an N+1 here is not a slow page, it is a
   * page nobody opens twice.
   *
   * Buildings with no coordinates are omitted rather than plotted at (0,0):
   * a pin in the Gulf of Guinea is worse than a building the map does not yet
   * show, and the ledger lists it either way.
   */
  async mapPins(): Promise<BuildingMapPin[]> {
    const buildings = await withConnectionRetry(() =>
      this.db.building.findMany({
        where: { latitude: { not: null }, longitude: { not: null } },
        select: {
          id: true,
          code: true,
          name: true,
          latitude: true,
          longitude: true,
          parcelNumber: true,
          structureType: true,
          unitsTotal: true,
          unitsSurveyed: true,
        },
        // A municipality with more structures than this has a data problem, and
        // a map with 10k pins is unusable regardless. Matches the ceiling
        // `getSpatialData` already applies to registration markers.
        take: 10_000,
      }),
    );

    if (buildings.length === 0) return [];

    const ids = buildings.map((b) => b.id);

    /*
      The statuses present in each building, as a set — not a count.

      The rollup takes the *worst* one (D11), so what it needs is membership,
      and grouping in the database beats pulling every unit row back to fold
      over them in JavaScript.
    */
    const grouped = await this.db.unit.groupBy({
      by: ['buildingId', 'surveyStatus'],
      where: { buildingId: { in: ids } },
      _count: { _all: true },
    });

    const statuses = new Map<string, string[]>();
    for (const row of grouped) {
      statuses.set(row.buildingId, [
        ...(statuses.get(row.buildingId) ?? []),
        row.surveyStatus as string,
      ]);
    }

    const damage = await this.currentDamageLevels(ids);

    return buildings.map((building) => ({
      id: building.id,
      code: building.code,
      name: building.name,
      latitude: building.latitude!,
      longitude: building.longitude!,
      parcelNumber: building.parcelNumber,
      structureType: building.structureType,
      unitsTotal: building.unitsTotal,
      unitsSurveyed: building.unitsSurveyed,
      surveyRollup: rollupOf(statuses.get(building.id) ?? []),
      worstDamageLevel: damage.get(building.id) ?? null,
    }));
  }

  /** Exposed for the map rollup — see `rollupOf`. */
  static readonly surveyedStatuses: readonly string[] = SURVEYED_STATUS;
}

/**
 * The survey severity ladder, worst first.
 *
 * This ordering is the whole of D11 and it is not the order the enum declares.
 * `NOT_SURVEYED` outranks everything because it is the only state that means
 * nobody has tried — it is the state an officer is dispatched against, and the
 * one a coloured map exists to make visible. `VISITED_NO_ANSWER` is next: a
 * door that has been knocked on and not opened is still work, just work that
 * has already cost somebody a trip.
 *
 * `REFUSED` and `INACCESSIBLE` rank *above* `PARTIAL` and below the two above
 * them: they are dead ends rather than gaps, so they need a person to decide
 * what happens next rather than another visit.
 *
 * `DEMOLISHED` and `VACANT_CONFIRMED` rank last with `COMPLETE` because all
 * three are findings — the census has its answer, and the answer happens not to
 * be a household.
 */
const SURVEY_SEVERITY: readonly string[] = [
  'NOT_SURVEYED',
  'VISITED_NO_ANSWER',
  'REFUSED',
  'INACCESSIBLE',
  'PARTIAL',
  'COMPLETE',
  'VACANT_CONFIRMED',
  'DEMOLISHED',
];

/**
 * A building's status: the worst among its units, never the majority (D11).
 *
 * The majority is the tempting choice and it is exactly wrong. A block of
 * twelve flats where eleven are surveyed and one was never answered is not a
 * surveyed building — it is a building with a flat nobody has been inside, and
 * that flat is the reason to send somebody. Colouring it "complete" hides the
 * one fact the map was drawn to show.
 *
 * A building with **no units at all** rolls up to `NOT_SURVEYED`, which is the
 * same judgement `isUnsurveyed` makes in billing: an empty shell is a structure
 * whose matrix nobody has filled in, not a structure with nothing in it.
 */
export function rollupOf(unitStatuses: readonly string[]): string {
  if (unitStatuses.length === 0) return 'NOT_SURVEYED';

  return unitStatuses.reduce((worst, status) => {
    const a = SURVEY_SEVERITY.indexOf(status);
    const b = SURVEY_SEVERITY.indexOf(worst);
    // An unrecognised label sorts last rather than throwing — a status added to
    // the enum and not to this ladder must not take a map down.
    return (a === -1 ? Number.MAX_SAFE_INTEGER : a) < (b === -1 ? Number.MAX_SAFE_INTEGER : b)
      ? status
      : worst;
  }, unitStatuses[0]!);
}

// ──────────────────────────────  Mappers  ──────────────────────────────

function toBuildingRow(row: {
  id: string;
  parcelNumber: string;
  codeSuffix: string;
  code: string;
  name: string | null;
  postedNumber: string | null;
  structureType: string;
  latitude: number | null;
  longitude: number | null;
  floorsCount: number;
  unitsTotal: number;
  unitsSurveyed: number;
  notes: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}): BuildingRow {
  return {
    id: row.id,
    parcelNumber: row.parcelNumber,
    codeSuffix: row.codeSuffix,
    code: row.code,
    name: row.name,
    postedNumber: row.postedNumber,
    structureType: row.structureType,
    latitude: row.latitude,
    longitude: row.longitude,
    floorsCount: row.floorsCount,
    unitsTotal: row.unitsTotal,
    unitsSurveyed: row.unitsSurveyed,
    notes: row.notes,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toUnitRow(row: {
  id: string;
  buildingId: string;
  floor: number;
  sequence: number;
  unitCode: string;
  postedNumber: string | null;
  unitType: string;
  side: string | null;
  unitArea: { toString(): string } | null;
  unitStatus: string | null;
  surveyStatus: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}): UnitRow {
  return {
    id: row.id,
    buildingId: row.buildingId,
    floor: row.floor,
    sequence: row.sequence,
    unitCode: row.unitCode,
    postedNumber: row.postedNumber,
    unitType: row.unitType,
    side: row.side,
    // Decimal → number at the edge; a `Decimal` serialises as an object, which
    // the client would render as "[object Object]".
    unitArea: row.unitArea == null ? null : Number(row.unitArea.toString()),
    unitStatus: row.unitStatus,
    surveyStatus: row.surveyStatus,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toOccupancyRow(row: {
  id: string;
  unitId: string;
  citizenId: string;
  citizen?: { firstName: string; lastName: string } | null;
  role: string;
  shares: number | null;
  fromDate: Date;
  toDate: Date | null;
  registrationId: string | null;
}): OccupancyRow {
  return {
    id: row.id,
    unitId: row.unitId,
    citizenId: row.citizenId,
    citizenName: row.citizen ? `${row.citizen.firstName} ${row.citizen.lastName}` : null,
    role: row.role,
    shares: row.shares,
    fromDate: row.fromDate,
    toDate: row.toDate,
    registrationId: row.registrationId,
  };
}

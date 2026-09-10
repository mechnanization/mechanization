import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  formatBuildingCode,
  formatUnitCode,
  isOccupiableLifecycle,
  nextBuildingSuffix,
  OCCUPIABLE_LIFECYCLE,
  STRUCTURE_TYPE_MAP,
  SURVEYED_STATUS,
  type CreateBuildingInput,
  type StructureType,
  type UnitBlueprint,
  type LogVisitInput,
  type UpdateBuildingInput,
  type UpdateUnitInput,
  type UpsertOccupancyInput,
  type UpsertUnitInput,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { withConnectionRetry } from '../../../infrastructure/prisma/with-connection-retry';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { CasesService } from '../cases/cases.service';
import type {
  BuildingLedgerRow,
  BuildingListFilter,
  BuildingMapPin,
  BuildingRow,
  CensusSummary,
  OccupancyRow,
  UnitRow,
  VisitRow,
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
 * What «متضرر» counts as on the census tiles.
 *
 * The three levels that mean the structure's use is impaired. `NOT_AFFECTED`
 * and `SAFE_MINOR_DAMAGE` are assessments that found no impairment — counting
 * them would make the damaged figure rise every time an officer confirmed a
 * building was fine — and `UNCLASSIFIED` is an absence of a finding, not one.
 */
/**
 * How many of a unit's attempts travel with the matrix.
 *
 * The cell shows a count, and the panel under it shows the recent ones. A unit
 * somebody has been to twenty times is real and its count says twenty; putting
 * all twenty rows into every read of a forty-flat building is not.
 */
const MAX_VISITS_RETURNED = 10;

const DAMAGED_LEVELS: readonly string[] = [
  'RESTRICTED_USE',
  'UNSAFE_EVACUATE',
  'TOTAL_COLLAPSE',
];

/**
 * A building with its units, as the matrix drawer reads it.
 */
export interface BuildingDetail extends BuildingRow {
  /** The zone this building's parcel belongs to, resolved at read time (D13). */
  zoneCode: string | null;
  zoneName: string | null;
  units: Array<
    UnitRow & {
      occupants: OccupancyRow[];
      /** The most recent attempts, newest first — capped at `MAX_VISITS_RETURNED`. */
      visits: VisitRow[];
      /** Every attempt ever made, uncapped. This is «٣ محاولات» on the cell. */
      visitCount: number;
    }
  >;
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
      | 'OCCUPANCY_ENDED'
      | 'UNIT_VISIT_LOGGED';
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
   *
   * The filter is resolved into the `WHERE` rather than applied to the page it
   * returns. Applied afterwards it would filter *within* the page — a page of a
   * hundred buildings of which four are unsafe would show four rows out of a
   * stated total in the thousands, and page two would show four different ones
   * out of the same total. `summary` is computed over the same predicate, so
   * the tiles and the rows can never describe different sets.
   */
  async list(
    filter: BuildingListFilter,
  ): Promise<{ buildings: BuildingLedgerRow[]; total: number; summary: CensusSummary }> {
    const where = await this.buildWhere(filter);

    /*
      The unit figures count only the structures that can hold households.

      A permitted plot, a shell going up, a demolished block and a permit
      nobody built against all have units in the matrix and no doors to knock
      on. Left in the denominator they are permanent unreachable work: the
      «غير ممسوحة» tile never falls, the coverage percentage never reaches
      100, and a dispatch list keeps proposing visits nobody can make.

      The building *count* deliberately stays over the whole filtered set —
      «٤٠ مبنى» must mean what the ledger below it lists — and the units the
      exclusion removed are reported separately rather than silently dropped,
      so a percentage that looks too good can be explained on the same screen.
    */
    const occupiableWhere: Prisma.BuildingWhereInput = {
      AND: [where, { lifecycleStatus: { in: [...OCCUPIABLE_LIFECYCLE] as never } }],
    };

    const [rows, total, totals, allTotals, damaged] = await withConnectionRetry(() =>
      Promise.all([
        this.db.building.findMany({
          where,
          orderBy: [{ parcelNumber: 'asc' }, { codeSuffix: 'asc' }],
          take: filter.limit ?? 100,
          skip: filter.offset ?? 0,
        }),
        this.db.building.count({ where }),
        this.db.building.aggregate({
          where: occupiableWhere,
          _sum: { unitsTotal: true, unitsSurveyed: true },
        }),
        this.db.building.aggregate({ where, _sum: { unitsTotal: true } }),
        this.countAtDamageLevels(where, DAMAGED_LEVELS),
      ]),
    );

    const ids = rows.map((row) => row.id);
    const [zoneOf, damageOf] = await Promise.all([
      this.zonesOfParcels(rows.map((row) => row.parcelNumber)),
      this.currentDamageLevels(ids),
    ]);

    const unitsTotal = totals._sum.unitsTotal ?? 0;
    const unitsSurveyed = totals._sum.unitsSurveyed ?? 0;

    return {
      buildings: rows.map((row) => {
        const zone = zoneOf.get(row.parcelNumber);
        return {
          ...toBuildingRow(row),
          zoneCode: zone?.code ?? null,
          zoneName: zone?.name ?? null,
          damageLevel: damageOf.get(row.id) ?? null,
        };
      }),
      total,
      summary: {
        buildings: total,
        unitsTotal,
        unitsSurveyed,
        unitsUnsurveyed: Math.max(0, unitsTotal - unitsSurveyed),
        unitsOutOfScope: Math.max(0, (allTotals._sum.unitsTotal ?? 0) - unitsTotal),
        damaged,
      },
    };
  }

  /**
   * How many of the filtered buildings currently sit at one of these levels.
   *
   * Two steps rather than a join, because "current" is the newest row of an
   * append-only log and the filter it has to compose with is a Prisma
   * predicate: the ids are resolved first, then counted *inside* the caller's
   * own `where`, so a zone or a search term still narrows the number.
   */
  private async countAtDamageLevels(
    where: Prisma.BuildingWhereInput,
    levels: readonly string[],
  ): Promise<number> {
    const ids = await this.buildingIdsAtCurrentLevel(levels);
    if (ids.length === 0) return 0;
    return this.db.building.count({ where: { AND: [where, { id: { in: ids } }] } });
  }

  /**
   * Every building whose *latest* assessment reads one of these levels.
   *
   * Built out of `currentDamageLevels` rather than as a query of its own, and
   * deliberately: "the current level" is a `DISTINCT ON` over an append-only log
   * unioned across two ways of pointing at a building, and that query already
   * exists and is already covered against a real Postgres. A second hand-written
   * copy of it here is the shape of a bug that no unit test would catch — the
   * two would agree until somebody changed one of them, and the one that then
   * lied is the one a damage figure is read off.
   *
   * The cost is one extra round trip to collect the candidates. It is bounded by
   * the number of buildings anyone has *assessed*, not by the census, and
   * `mapPins` already resolves current levels for up to ten thousand at once.
   */
  private async buildingIdsAtCurrentLevel(levels: readonly string[]): Promise<string[]> {
    if (levels.length === 0) return [];

    const [direct, viaUnit] = await Promise.all([
      this.db.damageAssessment.findMany({
        where: { buildingId: { not: null } },
        select: { buildingId: true },
        distinct: ['buildingId'],
      }),
      // A unit-level reading is an observation about the structure the unit is
      // in — "top three floors gone, ground floor shop still trading" is two
      // rows about one building — so those buildings are candidates too.
      this.db.damageAssessment.findMany({
        where: { unitId: { not: null } },
        select: { unit: { select: { buildingId: true } } },
        distinct: ['unitId'],
      }),
    ]);

    const candidates = [
      ...new Set([
        ...direct.map((row) => row.buildingId).filter((id): id is string => Boolean(id)),
        ...viaUnit.map((row) => row.unit?.buildingId).filter((id): id is string => Boolean(id)),
      ]),
    ];
    if (candidates.length === 0) return [];

    const wanted = new Set(levels);
    const current = await this.currentDamageLevels(candidates);
    return [...current.entries()]
      .filter(([, level]) => wanted.has(level))
      .map(([buildingId]) => buildingId);
  }

  private async buildWhere(filter: BuildingListFilter): Promise<Prisma.BuildingWhereInput> {
    const where: Prisma.BuildingWhereInput = {};

    if (filter.parcelNumber) where.parcelNumber = filter.parcelNumber.trim();
    if (filter.parcelNumbers) where.parcelNumber = { in: [...filter.parcelNumbers] };
    if (filter.structureType) where.structureType = filter.structureType as never;
    if (filter.lifecycleStatus) where.lifecycleStatus = filter.lifecycleStatus as never;

    /*
      A sector filter, expanded to the parcels the sector owns.

      There is no column to filter on — D13 keeps membership in
      `Zone.parcelNumbers` so it cannot drift — so the expansion happens here.
      A sector that owns no parcels resolves to an empty list and therefore
      matches nothing, which is the true answer: "buildings in a sector with no
      parcels" is none of them, not all of them.

      ANDed rather than assigned, so it narrows an explicit `parcelNumber`
      instead of replacing it — a parcel outside the chosen sector then yields
      nothing, which is what composing the two filters means.
    */
    if (filter.zoneId) {
      const zone = await this.db.zone.findUnique({
        where: { id: filter.zoneId },
        select: { parcelNumbers: true },
      });
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        { parcelNumber: { in: zone?.parcelNumbers ?? [] } },
      ];
    }

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

    /*
      The current damage level, resolved to a set of ids.

      In the `WHERE` rather than applied to the page that comes back, which is
      what it used to be. Applied afterwards it filtered *within* the page: a
      page of a hundred buildings of which four were unsafe showed four rows
      under a stated total in the thousands, and page two showed four different
      ones under the same number.

      "Current" means the newest row of an append-only log, so it cannot be a
      column predicate — see `buildingIdsAtCurrentLevel`. An empty result
      correctly matches nothing.
    */
    if (filter.damageLevel) {
      const ids = await this.buildingIdsAtCurrentLevel([filter.damageLevel]);
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { id: { in: ids } }];
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
              /*
                The attempts behind the status (D10).

                Newest first, and capped: a cell shows «٣ محاولات» and the panel
                under it shows the last few, so a unit somebody has been to
                twenty times must not put twenty rows into every matrix read.
                The count on the cell is `_count`, which is not capped and is
                the number that matters.
              */
              visits: {
                orderBy: [{ visitedAt: 'desc' }],
                take: MAX_VISITS_RETURNED,
                include: { officer: { select: { firstName: true, lastName: true } } },
              },
              _count: { select: { visits: true } },
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
        visits: unit.visits.map(toVisitRow),
        visitCount: unit._count.visits,
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

    /*
      Is this a second structure, or the same one surveyed from the other side?

      §4.4's advisory lock solves the *opposite* problem. It guarantees that two
      officers standing on one parcel receive different suffixes — quietly,
      correctly, and with nothing whatsoever to notice. Two people walking a
      block from the street and from the alley therefore produce «A-1042-A» and
      «A-1042-B» for one building, and every count, coverage figure and notice
      run downstream of that is wrong in a way no constraint can catch.

      Q5's clockwise sweep is the field convention that prevents it, and a
      convention in a handbook is not a check. This is the check: on a parcel
      that already carries a structure, the officer is shown what is there and
      has to say that this is not one of them.

      Refused rather than warned, and refused *before* the transaction, because
      a warning attached to a row that already exists is a row somebody has to
      go and delete. `acknowledgedDuplicates` is what a person ticks; an offline
      client that showed the same list from its cache sets it too, so the guard
      costs a phone with no signal nothing.
    */
    if (!input.acknowledgedDuplicates) {
      const neighbours = await this.db.building.findMany({
        where: { parcelNumber },
        orderBy: { codeSuffix: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          postedNumber: true,
          structureType: true,
          lifecycleStatus: true,
          unitsTotal: true,
          latitude: true,
          longitude: true,
        },
      });

      if (neighbours.length > 0) {
        throw new ConflictError(
          `يوجد ${neighbours.length === 1 ? 'مبنى مسجَّل' : `${neighbours.length} مبانٍ مسجَّلة`} على العقار ${parcelNumber}. تأكَّد أن هذه منشأة مختلفة قبل المتابعة.`,
          {
            /*
              The candidates travel with the refusal so the dialog can show
              them without a second round trip — an officer offline enough to
              have queued this creation may not get one.

              `distanceMetres` is null where either pin is missing rather than
              defaulted to zero: "we cannot tell how far apart these are" and
              "they are in the same place" are opposite findings, and the
              second is the one that would talk somebody out of a real building.
            */
            parcelNumber,
            candidates: neighbours.map((row) => ({
              ...row,
              distanceMetres:
                input.latitude != null &&
                input.longitude != null &&
                row.latitude != null &&
                row.longitude != null
                  ? Math.round(
                      metresBetween(
                        { latitude: input.latitude, longitude: input.longitude },
                        { latitude: row.latitude, longitude: row.longitude },
                      ),
                    )
                  : null,
            })),
          },
        );
      }
    }

    const created = await this.db.$transaction(async (tx) => {
      /*
        The lock key names the schema explicitly, for the same reason the query
        above does. `current_schema()` reads the connection's `search_path`, so
        on a pooled connection that had drifted it would return `public` — and
        every municipality's parcel 28 would serialise against every other's,
        or worse, two officers on one parcel would take *different* locks and
        the suffix race §4.4 exists to prevent would be back.
      */
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        `${this.tenantContext.schemaName}:building-suffix:${parcelNumber}`,
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
          lifecycleStatus: input.lifecycleStatus as never,
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
        ...(input.lifecycleStatus !== undefined
          ? { lifecycleStatus: input.lifecycleStatus as never }
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
      // The lifecycle is logged on both sides because it is the one field here
      // that moves a building in and out of the census denominator — a coverage
      // percentage that jumped needs a row explaining which building did it.
      before: {
        name: before.name,
        structureType: before.structureType,
        lifecycleStatus: before.lifecycleStatus,
      },
      after: {
        name: updated.name,
        structureType: updated.structureType,
        lifecycleStatus: updated.lifecycleStatus,
      },
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

  // ──────────────────────────────  Visits  ──────────────────────────────

  /**
   * Logs one attempt, and moves the unit to what the attempt found.
   *
   * Two facts recorded by one action, deliberately. An officer who has just
   * stood at a door knows both — that they went, and what happened — and asking
   * them to say it twice is how the two drift apart: a unit reading «مكتملة»
   * with no visit behind it, or three visits under a status nobody updated.
   *
   * The status is *set*, not merged, and that is the difference from
   * `recordOccupancy`'s narrow lift. This is not a side effect of some other
   * action — it is an officer stating a finding directly, and a finding
   * replaces the previous one. `NOT_SURVEYED` is refused by the schema, so the
   * one thing this cannot do is walk a unit backwards to "nobody has been".
   */
  async logVisit(
    input: LogVisitInput,
    actor: { id: string; role: string },
  ): Promise<{ visit: VisitRow; visitCount: number }> {
    const unit = await this.db.unit.findUnique({
      where: { id: input.unitId },
      select: { id: true, buildingId: true, unitCode: true, surveyStatus: true },
    });
    if (!unit) throw new NotFoundError('الوحدة غير موجودة');

    const [visit, visitCount] = await this.db.$transaction(async (tx) => {
      const created = await tx.unitVisit.create({
        data: {
          unitId: input.unitId,
          officerId: actor.id,
          outcome: input.outcome as never,
          ...(input.visitedAt ? { visitedAt: input.visitedAt } : {}),
          notes: input.notes?.trim() || null,
        },
        include: { officer: { select: { firstName: true, lastName: true } } },
      });

      await tx.unit.update({
        where: { id: input.unitId },
        data: { surveyStatus: input.outcome as never },
      });

      return [created, await tx.unitVisit.count({ where: { unitId: input.unitId } })] as const;
    });

    this.record({
      action: 'UNIT_VISIT_LOGGED',
      buildingId: unit.buildingId,
      before: { surveyStatus: unit.surveyStatus },
      after: { unitCode: unit.unitCode, outcome: input.outcome, attempts: visitCount },
      actor,
    });

    return { visit: toVisitRow(visit), visitCount };
  }

  /** Every attempt on one unit, newest first. The panel behind «٣ محاولات». */
  async visits(unitId: string): Promise<VisitRow[]> {
    const rows = await withConnectionRetry(() =>
      this.db.unitVisit.findMany({
        where: { unitId },
        orderBy: [{ visitedAt: 'desc' }, { createdAt: 'desc' }],
        include: { officer: { select: { firstName: true, lastName: true } } },
      }),
    );
    return rows.map(toVisitRow);
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

    /*
      Every table named with its schema — see `tenant-schema-ref.ts`.

      This exact query is the one that failed in production-like conditions with
      `relation "damage_assessments" does not exist`, on a table that exists,
      because raw SQL resolves through `search_path` and the transaction pooler
      does not promise to carry it.
    */
    const S = tenantSchemaRef(this.tenantContext.schemaName);

    const rows = await this.db.$queryRaw<Array<{ buildingId: string; level: string }>>`
      SELECT DISTINCT ON (t."buildingId") t."buildingId", t."level"
        FROM (
          SELECT d."buildingId", d."level", d."assessedAt"
            FROM ${S}"damage_assessments" d
           WHERE d."buildingId" IN (${ids})
          UNION ALL
          SELECT u."buildingId", d."level", d."assessedAt"
            FROM ${S}"damage_assessments" d
            JOIN ${S}"units" u ON u."id" = d."unitId"
           WHERE u."buildingId" IN (${ids})
        ) t
       ORDER BY t."buildingId", t."assessedAt" DESC
    `;

    return new Map(rows.map((row) => [row.buildingId, row.level]));
  }

  /**
   * Parcel → its sector, for a page of buildings at once.
   *
   * One read of the sector table rather than one per row: `Zone.parcelNumbers`
   * is an array column, so "which sector owns parcel N" cannot be joined and a
   * hundred-row ledger would otherwise be a hundred queries. There are a
   * handful of sectors in a municipality, so reading them whole is cheaper than
   * any of the alternatives.
   */
  private async zonesOfParcels(
    parcelNumbers: readonly string[],
  ): Promise<Map<string, { code: string; name: string }>> {
    const resolved = new Map<string, { code: string; name: string }>();
    if (parcelNumbers.length === 0) return resolved;

    const wanted = new Set(parcelNumbers);
    const zones = await this.db.zone.findMany({
      select: { code: true, name: true, parcelNumbers: true },
    });

    for (const zone of zones) {
      for (const parcelNumber of zone.parcelNumbers) {
        // First sector wins, matching `zoneOfParcel`'s `findFirst`. A parcel in
        // two sectors is a data error the zone editor already refuses; picking
        // one consistently beats reporting it differently per screen.
        if (wanted.has(parcelNumber) && !resolved.has(parcelNumber)) {
          resolved.set(parcelNumber, { code: zone.code, name: zone.name });
        }
      }
    }

    return resolved;
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
          lifecycleStatus: true,
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
      lifecycleStatus: building.lifecycleStatus,
      unitsTotal: building.unitsTotal,
      unitsSurveyed: building.unitsSurveyed,
      /*
        A structure nobody can be inside has no survey rollup to show.

        `rollupOf` would answer `NOT_SURVEYED` for a shell under construction —
        truthfully, since its generated units are — and paint it the same
        urgent grey as a finished block nobody has visited. That is the one
        colour on this map that means "send somebody", so it is withheld from
        the buildings where sending somebody is not the answer; the map draws
        those in the lifecycle's own muted channel instead.
      */
      surveyRollup: isOccupiableLifecycle(building.lifecycleStatus)
        ? rollupOf(statuses.get(building.id) ?? [])
        : null,
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

/**
 * Metres between two pins, on a sphere.
 *
 * Haversine and not an ellipsoidal formula, deliberately. The only consumer is
 * the duplicate-building prompt, where the question is "are these two entrances
 * eight metres apart or eighty" — and at the hundred-metre scale of one parcel
 * the two formulas differ by centimetres. What matters is that the number is
 * never confidently wrong, and Haversine at this range is not.
 */
function metresBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const EARTH_RADIUS_M = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLng = toRadians(b.longitude - a.longitude);
  const latA = toRadians(a.latitude);
  const latB = toRadians(b.latitude);

  const h =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
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
  lifecycleStatus: string;
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
    lifecycleStatus: row.lifecycleStatus,
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

function toVisitRow(row: {
  id: string;
  unitId: string;
  officerId: string | null;
  officer?: { firstName: string; lastName: string } | null;
  visitedAt: Date;
  outcome: string;
  notes: string | null;
  createdAt: Date;
}): VisitRow {
  return {
    id: row.id,
    unitId: row.unitId,
    officerId: row.officerId,
    officerName: row.officer ? `${row.officer.firstName} ${row.officer.lastName}` : null,
    visitedAt: row.visitedAt,
    outcome: row.outcome,
    notes: row.notes,
    createdAt: row.createdAt,
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

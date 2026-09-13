import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  formatBuildingCode,
  formatUnitCode,
  isOccupiableLifecycle,
  nextBuildingSuffix,
  OCCUPIABLE_LIFECYCLE,
  STRUCTURE_TYPE_MAP,
  isUnoccupied,
  SURVEYED_STATUS,
  unitStatusForRole,
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
  FileLinkResult,
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
      /**
       * حالة الوحدة as an owner's own property card states it, for a unit whose
       * canonical `unitStatus` nobody has set.
       *
       * An owner filed through the registration form answers «حالة الوحدة» on
       * their card, and nothing copies that answer onto the unit — so an owner
       * who said «شاغرة» showed on the matrix as an ordinary registered flat.
       * Derived here rather than copied, because billing already reads the
       * same two places in the same order (P2-T8: a linked unit's value wins
       * field by field, the card decides where the unit has none), and the
       * matrix must never describe a unit differently from how it is billed.
       * Among co-owners who disagree, the most recently updated card speaks.
       */
      ownerDeclaredStatus: string | null;
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
      | 'UNIT_DELETED'
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

    /*
      Sequential, not `Promise.all`. Against a pooler with `connection_limit=1`
      (e.g. serverless instances or remote poolers), firing six queries
      concurrently causes them to queue up and hit the pool timeout (P2024).
      Running sequentially ensures each query completes and returns its
      connection before the next begins.
    */
    const rows = await withConnectionRetry(() =>
      this.db.building.findMany({
        where,
        orderBy: [{ parcelNumber: 'asc' }, { codeSuffix: 'asc' }],
        take: filter.limit ?? 100,
        skip: filter.offset ?? 0,
      }),
    );
    const total = await withConnectionRetry(() => this.db.building.count({ where }));
    const totals = await withConnectionRetry(() =>
      this.db.building.aggregate({
        where: occupiableWhere,
        _sum: { unitsTotal: true, unitsSurveyed: true },
      }),
    );
    const allTotals = await withConnectionRetry(() =>
      this.db.building.aggregate({ where, _sum: { unitsTotal: true } }),
    );
    const damaged = await this.countAtDamageLevels(where, DAMAGED_LEVELS);
    /*
      Counted over the filtered predicate, like every other tile — never
      over the page. A tile that quietly described the first twenty-five
      rows would read as a statement about the municipality.
    */
    const withoutEntrance = await withConnectionRetry(() =>
      this.db.building.count({ where: { AND: [where, { latitude: null }] } }),
    );

    const ids = rows.map((row) => row.id);
    const zoneOf = await this.zonesOfParcels(rows.map((row) => row.parcelNumber));
    const damageOf = await this.currentDamageLevels(ids);

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
        withoutEntrance,
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

    const direct = await this.db.damageAssessment.findMany({
      where: { buildingId: { not: null } },
      select: { buildingId: true },
      distinct: ['buildingId'],
    });
    // A unit-level reading is an observation about the structure the unit is
    // in — "top three floors gone, ground floor shop still trading" is two
    // rows about one building — so those buildings are candidates too.
    const viaUnit = await this.db.damageAssessment.findMany({
      where: { unitId: { not: null } },
      select: { unit: { select: { buildingId: true } } },
      distinct: ['unitId'],
    });

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
      «بلا مدخل مُثبت», and its complement.

      `latitude` alone is the predicate: `coordinatePair` refuses half a pin at
      the schema, so the two columns are always both set or both null and there
      is no third state to account for.
    */
    if (filter.hasEntrance !== undefined) {
      where.latitude = filter.hasEntrance ? { not: null } : null;
    }

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

      /*
        And only structures that can hold a household, matching the tiles.

        `summary` excludes non-occupiable lifecycles from its unit figures and
        `mapPins` withholds a rollup for them, both because a permitted plot, a
        shell going up, a demolished block and a permit nobody built against are
        permanent unreachable work. This predicate did not, so «غير ممسوحة» —
        the filter an officer uses to *build the dispatch list* — still returned
        every demolished building in the municipality. The tile said they were
        out of scope and the list handed them over anyway.

        ANDed so it narrows the OR above rather than competing with it.
      */
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        { lifecycleStatus: { in: [...OCCUPIABLE_LIFECYCLE] as never } },
      ];
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
    const backing = await this.claimsBackingOccupancies(row.id, row.units);
    const declared = await this.ownerDeclaredStatuses(row.id, row.units);

    return {
      ...toBuildingRow(row),
      zoneCode: zone?.code ?? null,
      zoneName: zone?.name ?? null,
      units: row.units.map((unit) => ({
        ...toUnitRow(unit),
        occupants: unit.occupancies.map((occupancy) =>
          toOccupancyRow(occupancy, backing.has(`${occupancy.unitId}:${occupancy.citizenId}`)),
        ),
        visits: unit.visits.map(toVisitRow),
        visitCount: unit._count.visits,
        ownerDeclaredStatus: unit.unitStatus ? null : (declared.get(unit.id) ?? null),
      })),
    };
  }

  /**
   * The حالة الوحدة each unit's owner stated on their own card, for units that
   * have none of their own. See `BuildingDetail.units.ownerDeclaredStatus`.
   *
   * The two shapes a card reaches a unit by, mirroring
   * `claimsBackingOccupancies`: a مبنى card's ticked unit row, and a منزل card
   * on a structure with exactly one unit. Owner cards only — a مستأجر or شاغل
   * بتسامح card carries no حالة (their capacity is the answer, and the unit
   * already records it through `unitStatusForRole`).
   */
  private async ownerDeclaredStatuses(
    buildingId: string,
    units: ReadonlyArray<{ id: string; unitStatus: string | null }>,
  ): Promise<ReadonlyMap<string, string>> {
    const open = units.filter((unit) => !unit.unitStatus).map((unit) => unit.id);
    const declared = new Map<string, string>();
    if (open.length === 0) return declared;

    const [ticked, houses] = await Promise.all([
      this.db.buildingUnit.findMany({
        where: {
          unitId: { in: open },
          unitStatus: { not: null },
          propertyEntry: { occupancyType: 'OWNER' as never },
        },
        orderBy: { updatedAt: 'desc' },
        select: { unitId: true, unitStatus: true },
      }),
      units.length === 1
        ? this.db.propertyEntry.findMany({
            where: {
              buildingId,
              propertyType: 'HOUSE' as never,
              occupancyType: 'OWNER' as never,
              unitStatus: { not: null },
            },
            orderBy: { updatedAt: 'desc' },
            select: { unitStatus: true },
            take: 1,
          })
        : Promise.resolve([]),
    ]);

    for (const row of ticked) {
      if (row.unitId && row.unitStatus && !declared.has(row.unitId)) {
        declared.set(row.unitId, row.unitStatus);
      }
    }
    const house = houses[0];
    const only = units[0];
    if (house?.unitStatus && only && open.includes(only.id) && !declared.has(only.id)) {
      declared.set(only.id, house.unitStatus);
    }
    return declared;
  }

  /**
   * Which `(unit, citizen)` pairs in this building are claimed by the
   * citizen's own file — the other half of every occupancy row.
   *
   * Two queries for the whole building rather than one per occupancy: a
   * six-flat block with a history of tenants is a few dozen rows, and asking
   * per row would put the matrix back into the N+1 it was written to avoid.
   *
   * The two shapes mirror `CensusSyncService`'s, because this is the same
   * question it asks on the way in:
   *
   *   • **an itemised tick** — a `BuildingUnit` carrying `unitId`, which is how
   *     a مبنى card names flat 3 out of six;
   *   • **a منزل on a one-unit structure** — no tick to find, because the card
   *     has no units array to tick; the claim is `PropertyEntry.buildingId` and
   *     the unit is inferred. Applied only when the building really does have
   *     exactly one unit, which is the condition the inference itself is under.
   *   • **a مبنى card that itemises nothing** — the shape `heldThroughOccupancy`
   *     exists for. Such a card claims the structure and lets `attachOccupancies`
   *     read *which* flats from `UnitOccupancy`, so its holder's occupancies
   *     are billed and the card is the reason they are. This one was missing,
   *     and its absence is what put the warning on every owner
   *     `LandlordLinkService.declareOwnership` has ever declared — it mints
   *     precisely this card, on purpose, and the matrix then called it unbacked.
   *
   * Getting any of them wrong would be the visible failure: every منزل in the
   * census would report its own occupant as unbacked, and the warning this
   * feeds would fire on the commonest correct record in the register.
   */
  private async claimsBackingOccupancies(
    buildingId: string,
    units: ReadonlyArray<{ id: string; occupancies: ReadonlyArray<{ citizenId: string }> }>,
  ): Promise<ReadonlySet<string>> {
    const citizenIds = [
      ...new Set(units.flatMap((unit) => unit.occupancies.map((row) => row.citizenId))),
    ];
    if (citizenIds.length === 0) return new Set();

    const unitIds = units.map((unit) => unit.id);

    const [ticked, wholeBuilding, unitemised] = await Promise.all([
      this.db.buildingUnit.findMany({
        where: {
          unitId: { in: unitIds },
          propertyEntry: { registration: { citizenId: { in: citizenIds } } },
        },
        select: {
          unitId: true,
          propertyEntry: { select: { registration: { select: { citizenId: true } } } },
        },
      }),
      units.length === 1
        ? this.db.propertyEntry.findMany({
            where: {
              buildingId,
              propertyType: 'HOUSE' as never,
              registration: { citizenId: { in: citizenIds } },
            },
            select: { registration: { select: { citizenId: true } } },
          })
        : Promise.resolve([]),
      /*
        مبنى cards on this building that itemise no flats, and the other cards
        the same citizen filed on it.

        Both halves are needed because `attachOccupancies` suppresses the
        occupancy list for a citizen who also holds a non-مبنى card on the same
        structure — that card bills the single unit from its own columns, and
        handing it the list too would bill the flat twice. A backing claim this
        reports has to be one billing would actually consume, or the warning
        goes quiet on exactly the records it exists to catch.
      */
      this.db.propertyEntry.findMany({
        where: { buildingId, registration: { citizenId: { in: citizenIds } } },
        select: {
          propertyType: true,
          registration: { select: { citizenId: true } },
          _count: { select: { units: true } },
        },
      }),
    ]);

    const backed = new Set<string>();
    for (const link of ticked) {
      if (link.unitId) backed.add(`${link.unitId}:${link.propertyEntry.registration.citizenId}`);
    }
    for (const entry of wholeBuilding) {
      backed.add(`${unitIds[0]}:${entry.registration.citizenId}`);
    }

    const suppressed = new Set(
      unitemised
        .filter((entry) => entry.propertyType !== 'BUILDING')
        .map((entry) => entry.registration.citizenId),
    );
    for (const entry of unitemised) {
      const citizenId = entry.registration.citizenId;
      if (entry.propertyType !== 'BUILDING' || entry._count.units > 0) continue;
      if (suppressed.has(citizenId)) continue;
      // The card names no flat, so it backs every flat this citizen is
      // recorded in here — which is exactly the set billing will read off it.
      for (const unitId of unitIds) backed.add(`${unitId}:${citizenId}`);
    }

    return backed;
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
    if (existing && existing.parcelNumber !== parcelNumber) {
      /*
        The id matches but the parcel does not, so this is not a replay.

        Returning `existing` here would hand back a building on someone else's
        عقار as though the officer had just made it, and their actual creation
        would be dropped without a word. Falling through instead would collide
        on the primary key with a message naming neither problem. Said loudly,
        because a client reaching this is confused about which creation it is
        retrying and no answer this method can invent is the right one.
      */
      throw new ConflictError(
        `المعرّف المرسل يخص مبنى على العقار ${existing.parcelNumber}، لا العقار ${parcelNumber}.`,
      );
    }

    if (existing) {
      /*
        A replay still has to answer "is the code you are quoting the right one?"

        This returned `reconciled: false` unconditionally, and that lost the
        notice in the one case §4.4 built it for. An officer offline writes
        «A-1042-A» on a paper form in a stairwell; the drain delivers it; the
        server allocates `B`; the *response* is lost. The retry lands here, is
        recognised, and — under the old code — told the phone nothing had
        changed, so the queue entry was dropped and the officer kept quoting a
        code no building answers to.

        The comparison is against the row that exists, which is the same
        question the first delivery answered, so it gives the same answer.
      */
      return {
        building: toBuildingRow(existing),
        reconciled: Boolean(
          input.provisionalSuffix &&
            input.provisionalSuffix.trim().toUpperCase() !== existing.codeSuffix,
        ),
        deduplicated: true,
      };
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

      const building = await tx.building.create({
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
          basementsCount: input.basementsCount ?? 0,
          notes: input.notes?.trim() || null,
          createdById: actor.id,
        },
      });

      /*
        The matrix, in the same transaction as the shell.

        Inside it rather than after it because a half-built structure is not a
        state worth being able to reach: the registration that asked for this
        building is about to attach a household to one of these units, and a
        building that exists with only some of them is a card that links to a
        flat which is not there. Either both, or neither and the officer tries
        again.

        No advisory lock is taken for the sequences, and none is needed — this
        building did not exist a statement ago, so nothing else can be filling
        its matrix. `addUnit` locks because it adds to a matrix other people are
        already using.
      */
      if (input.units?.length) {
        // Nothing exists yet on a building being created, so the inline list is
        // the whole matrix.
        this.assertUnitFits(building, 0, input.units.length);

        const usedByFloor = new Map<number, number>();

        await tx.unit.createMany({
          data: input.units.map((unit) => {
            const next = unit.sequence ?? (usedByFloor.get(unit.floor) ?? 0) + 1;
            usedByFloor.set(unit.floor, Math.max(usedByFloor.get(unit.floor) ?? 0, next));

            return {
              ...(unit.id ? { id: unit.id } : {}),
              buildingId: building.id,
              floor: unit.floor,
              sequence: next,
              startCol: unit.startCol ?? null,
              endCol: unit.endCol ?? null,
              unitCode: formatUnitCode(unit.floor, next),
              unitType: unit.unitType as never,
              postedNumber: unit.postedNumber?.trim() || null,
              side: unit.side?.trim() || null,
              unitArea: unit.unitArea ?? null,
              unitStatus: (unit.unitStatus ?? null) as never,
              surveyStatus: (unit.surveyStatus ?? 'NOT_SURVEYED') as never,
              notes: unit.notes?.trim() || null,
            };
          }),
        });

        /*
          `floorsCount` only ever rises, matching `generateUnits`. A caller that
          sent one floor and three units on floor 2 meant the building is at
          least three storeys, whatever the field said.

          `basementsCount` is reconciled the same way and in the same direction:
          a unit on floor −2 means the building has at least two levels below
          the pavement, whatever the depth field said.
        */
        const highest = Math.max(...input.units.map((unit) => unit.floor));
        const deepest = Math.min(...input.units.map((unit) => unit.floor));
        const raisedFloors = highest + 1 > building.floorsCount ? highest + 1 : null;
        const deepenedBasements =
          deepest < 0 && -deepest > building.basementsCount ? -deepest : null;

        if (raisedFloors !== null || deepenedBasements !== null) {
          return tx.building.update({
            where: { id: building.id },
            data: {
              ...(raisedFloors !== null ? { floorsCount: raisedFloors } : {}),
              ...(deepenedBasements !== null
                ? { basementsCount: deepenedBasements }
                : {}),
            },
          });
        }
      }

      return building;
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

    /*
      The other direction of the same rule.

      `assertUnitFits` stops a house being given a second unit; this stops a
      block of eleven flats being *relabelled* a house, which arrives at the
      identical dead end from the opposite side — a structure whose type says
      one dwelling and whose matrix holds eleven, linkable from no card.

      Checked against the type being moved *to*, using the units that actually
      exist rather than the ones this request carries: an update never creates
      any.
    */
    if (input.structureType !== undefined && input.structureType !== before.structureType) {
      this.assertUnitFits(
        { structureType: input.structureType, code: before.code },
        await this.db.unit.count({ where: { buildingId: id } }),
        0,
      );
    }

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
        ...(input.basementsCount !== undefined
          ? { basementsCount: input.basementsCount }
          : {}),
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
    /*
      Two refusals, because they ask for two different things.

      This counted *every* occupancy row — ended ones included — under a message
      telling the officer to «أنهِ الإشغالات أولاً». Ending an occupancy sets
      `toDate` and keeps the row (D2: ended, never deleted), so the count never
      moved: they followed the instruction, retried, and got the identical error
      for ever, with the ledger surfacing it verbatim in a toast.

      A current occupancy is something a person can act on, so it keeps the
      actionable message. A building that only holds *history* is refused too —
      the cascade would erase the municipality's record of who lived there,
      which is the whole point of the census outliving the card — but it says
      so, instead of prescribing a step that changes nothing.
    */
    const current = await this.db.unitOccupancy.count({
      where: { unit: { buildingId: id }, toDate: null },
    });
    if (current > 0) {
      throw new ConflictError(
        `لا يمكن حذف المبنى: ${current} إشغال قائم على وحداته. أنهِ الإشغالات أولاً`,
      );
    }

    const historical = await this.db.unitOccupancy.count({ where: { unit: { buildingId: id } } });
    if (historical > 0) {
      throw new ConflictError(
        `لا يمكن حذف مبنى سُجّل فيه سكان: ${historical} إشغال سابق على وحداته. حذفه يمحو سجل من سكنها. عدّل بيانات المبنى أو غيّر حالته إلى «مهدوم» بدلاً من الحذف`,
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

    this.assertUnitFits(building, existing.length, data.length);

    if (data.length > 0) {
      await this.db.unit.createMany({ data, skipDuplicates: true });
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

    this.record({
      action: 'BUILDING_UNITS_GENERATED',
      buildingId,
      after: { created: data.length, skipped, total: units.length },
      actor,
    });

    return { created: data.length, skipped, units: units.map(toUnitRow) };
  }

  /**
   * Refuses to give a «منزل مستقل» a second unit.
   *
   * A house is one dwelling — that is what the type *means*, and the whole
   * system is built on it: `STRUCTURE_TYPE_MAP` maps it to a `HOUSE` card,
   * `PROPERTY_FIELD_MAP` gives a HOUSE card no `units` array because its one
   * dwelling is described inline, and the creation wizard paints exactly one
   * cell for it.
   *
   * Nothing enforced that. A house could be given eleven flats through the
   * editor's matrix or a blueprint, and the result was a structure no card
   * could ever link a unit to: the officer saw a matrix full of apartments, the
   * picker correctly offered no unit list, and the registration saved naming
   * the building and none of its flats. The census then held eleven units that
   * nobody could ever be recorded in.
   *
   * Refused rather than silently retyped. «هذا مبنى، لا منزل» is a correction
   * only the officer can make — the structure type decides which card shape
   * describes it, and changing it under them would rewrite what they said.
   */
  private assertUnitFits(
    building: { structureType: string; code: string },
    existingUnits: number,
    adding: number,
  ): void {
    if (building.structureType !== 'INDEPENDENT_HOUSE') return;

    const total = existingUnits + adding;
    if (total <= 1) return;

    /*
      Phrased as the contradiction rather than as the direction it was reached
      from. This fires both on a house being given a second unit and on a block
      of eleven being relabelled a house, and a message naming one of those
      reads as a non-sequitur on the other.
    */
    throw new ValidationError(
      `لا يمكن أن يكون المبنى ${building.code} «منزل مستقل» وفيه ${total} وحدة — المنزل مسكن واحد. اختر «بناية سكنية» لتسجيل عدة وحدات`,
    );
  }

  /** One unit added by hand, at the next free position on its floor. */
  async addUnit(
    buildingId: string,
    input: UpsertUnitInput,
    actor: { id: string; role: string },
  ): Promise<UnitRow> {
    const building = await this.db.building.findUnique({ where: { id: buildingId } });
    if (!building) throw new NotFoundError('المبنى غير موجود');

    this.assertUnitFits(
      building,
      await this.db.unit.count({ where: { buildingId } }),
      1,
    );

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
              citizen: { select: { firstName: true, lastName: true } },
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
                citizenName: row.citizen
                  ? `${row.citizen.firstName} ${row.citizen.lastName}`
                  : null,
              })),
            })),
          },
        );
      }
    }

    const created = await this.db.$transaction(async (tx) => {
      /*
        The schema is a literal here for the same reason it is in `create` —
        `current_schema()` reads the connection's `search_path`, which this app
        does not own behind the transaction pooler. A drifted connection returns
        `public`, so two officers adding a unit to one building take *different*
        lock keys, both read the same `used` set, both compute the same
        `sequence`, and the second one hits the unique constraint as a 500
        instead of being serialised behind the first.
      */
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        `${this.tenantContext.schemaName}:unit-sequence:${buildingId}`,
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

      const unit = await tx.unit.create({
        data: {
          buildingId,
          floor: input.floor,
          sequence,
          startCol: input.startCol ?? null,
          endCol: input.endCol ?? null,
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

      return unit;
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

    /*
      A flat cannot be empty and lived in at the same time.

      «تأكيد الشغور» sends `unitStatus: 'VACANT'` with `surveyStatus:
      'VACANT_CONFIRMED'`, and it used to write both over a unit holding live
      occupancies without a word — leaving a row that says nobody is there
      beside two rows naming who is. `isUnoccupied` then exempted the owner from
      the occupancy fee, so the contradiction was not merely untidy: it silently
      stopped a bill.

      Refused rather than cascaded into ending the spells, because those are
      opposite statements about people and only the officer knows which is true.
      «أنهِ الإشغال» is one click away in the same drawer and says who moved out
      and when; guessing that here would close somebody's tenancy as a side
      effect of a status change.
    */
    const goingEmpty =
      (input.unitStatus !== undefined && isUnoccupied(input.unitStatus)) ||
      input.surveyStatus === 'VACANT_CONFIRMED';

    /*
      …but an owner does not make a flat lived in.

      This refused on *any* live spell, the owner's included, and the drawer's
      tooltip said «أنهِ الإشغال أولاً». So to record that an owner's flat is
      empty, officers ended the owner — which erased the ownership and released
      the flat from their file, billing and all. The deed is not a statement of
      residence (D2): an owner recorded on a شاغرة unit is exactly what the
      join table exists to say. Only a مستأجر or شاغل بتسامح contradicts
      vacancy, because they *are* somebody living there.
    */
    if (goingEmpty) {
      const live = await this.db.unitOccupancy.count({
        where: { unitId, toDate: null, role: { in: ['TENANT', 'FREE_OCCUPANT'] as never } },
      });
      if (live > 0) {
        throw new ConflictError(
          `لا يمكن تسجيل الوحدة ${before.unitCode} كشاغرة: يسكنها ${live} مستأجر أو شاغل مسجَّل. أنهِ إشغاله أولاً`,
        );
      }
    }

    const updated = await this.db.unit.update({
      where: { id: unitId },
      data: {
        ...(moved ? { floor, sequence, unitCode: formatUnitCode(floor, sequence) } : {}),
        ...(input.startCol !== undefined ? { startCol: input.startCol } : {}),
        ...(input.endCol !== undefined ? { endCol: input.endCol } : {}),
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
        ...(input.presenceMonths !== undefined ? { presenceMonths: input.presenceMonths } : {}),
        ...(input.ownerLastStayAt !== undefined ? { ownerLastStayAt: input.ownerLastStayAt } : {}),
        ...(input.vacancyDeclaredAt !== undefined
          ? { vacancyDeclaredAt: input.vacancyDeclaredAt }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
      },
    });

    this.record({
      action: 'UNIT_UPDATED',
      buildingId: before.buildingId,
      before: {
        unitCode: before.unitCode,
        surveyStatus: before.surveyStatus,
        unitStatus: before.unitStatus,
      },
      after: {
        unitCode: updated.unitCode,
        surveyStatus: updated.surveyStatus,
        unitStatus: updated.unitStatus,
      },
      actor,
    });

    return toUnitRow(updated);
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
  async deleteUnit(unitId: string, actor: { id: string; role: string }): Promise<void> {
    const unit = await this.db.unit.findUnique({
      where: { id: unitId },
      select: { id: true, buildingId: true, unitCode: true, floor: true, sequence: true },
    });
    if (!unit) throw new NotFoundError('الوحدة غير موجودة');

    const [current, historical, visits, damage, cards] = await Promise.all([
      this.db.unitOccupancy.count({ where: { unitId, toDate: null } }),
      this.db.unitOccupancy.count({ where: { unitId } }),
      this.db.unitVisit.count({ where: { unitId } }),
      this.db.damageAssessment.count({ where: { unitId } }),
      this.db.buildingUnit.count({ where: { unitId } }),
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

    this.record({
      action: 'UNIT_DELETED',
      buildingId: unit.buildingId,
      before: { unitCode: unit.unitCode, floor: unit.floor, sequence: unit.sequence },
      actor,
    });
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
   *
   * ## And it now writes the citizen’s half of the record too
   *
   * `endOccupancy` has always released the census claim on the citizen’s file
   * when a spell ends. Nothing established it when a spell *began*, so the two
   * halves of one fact were maintained in one direction of travel only: an
   * officer who tapped «تسجيل شاغل» got an occupancy on the matrix and a citizen
   * file that went on saying nothing about the flat — «غير مرتبط بملفه» on the
   * commonest correct action in the census, with nothing the officer could do
   * about the warning but go and edit that person’s card by hand.
   *
   * It was a billing fault as much as a display one, and in the direction that
   * costs the municipality: `assessCitizen` bills the cards a citizen filed, so
   * an occupancy with no card behind it is a flat nobody is charged for.
   *
   * See `claimOnFile` for what is written and, more importantly, for the three
   * things it deliberately refuses to do.
   */
  async recordOccupancy(
    input: UpsertOccupancyInput,
    actor: { id: string; role: string },
  ): Promise<{ occupancy: OccupancyRow; casesResolved: number; fileLink: FileLinkResult }> {
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

    /*
      A non-owner spell settles حالة الوحدة — and nothing used to write it.

      Who is in a flat and what state the flat is in are one fact stored twice,
      and this path wrote only the first. So recording a مستأجر never made the
      unit «مؤجرة»; the owner's card went on saying «مشغولة من المالك»,
      `bearsFee` read that and charged them the occupancy fee, and the tenant
      was charged it too on their own card. One flat, two bills, every row
      individually valid.

      `unitStatusForRole` returns null for OWNER on purpose: a deed is not a
      statement of residence, and an owner abroad with a tenant downstairs is
      the case the join table exists for (D2).

      Narrowed to `unitStatus: null` for the same reason the lift above is
      narrowed — only "nobody was asked" may be answered by a side effect. An
      officer who set «شاغرة» and an occupancy that says otherwise are a
      contradiction for a person to look at, and the drawer now shows it rather
      than letting this quietly win.
    */
    /*
      An owner’s own answer, and it *replaces* rather than fills a gap.

      This is the other half of the asymmetry above. `unitStatusForRole` is an
      inference and is narrowed accordingly; `input.unitStatus` is a person standing
      in the building saying what the flat is — the same kind of statement
      `logVisit` makes, and treated the same way. It is only ever reachable for an
      OWNER (the schema refuses it on anyone else, whose capacity already settles
      the question), so it cannot be used to contradict a tenancy recorded in the
      same breath.

      It is what makes the four owner cases distinguishable at last. An owner
      living there («مشغولة من المالك»), an owner who lets it («مؤجرة»), an owner
      whose relative is in it («مشغولة بتسامح») and an owner of an empty or
      unfinished flat («شاغرة» / «قيد الإنشاء») are four different bills, and
      recording the owner used to state none of them — so `bearsFee` read the null
      as «nobody was asked» and charged them the occupancy fee regardless.
    */
    const impliedStatus = unitStatusForRole(input.role);
    if (input.unitStatus) {
      await this.db.unit.update({
        where: { id: input.unitId },
        data: { unitStatus: input.unitStatus as never },
      });
    } else if (impliedStatus) {
      await this.db.unit.updateMany({
        where: { id: input.unitId, unitStatus: null },
        data: { unitStatus: impliedStatus as never },
      });
    }

    const casesResolved = await this.cases.resolveForUnit(input.unitId, input.citizenId, actor);

    const fileLink = await this.claimOnFile({
      unitId: input.unitId,
      buildingId: unit.buildingId,
      citizenId: input.citizenId,
      role: input.role,
      shares: input.shares ?? null,
      unitStatus: input.unitStatus ?? impliedStatus ?? null,
    });

    this.record({
      action: 'OCCUPANCY_RECORDED',
      buildingId: unit.buildingId,
      after: {
        unitCode: unit.unitCode,
        citizenId: input.citizenId,
        role: input.role,
        unitStatus: input.unitStatus ?? null,
        casesResolved,
        /*
          Named in the audit row for the reason `endOccupancy` names its release:
          this is the part that edits somebody’s own file rather than the census,
          and a resident disputing a bill is entitled to see when their card
          started claiming the flat and who made it do so.
        */
        fileLink: fileLink.outcome,
      },
      actor,
    });

    return { occupancy: toOccupancyRow(occupancy, fileLink.backed), casesResolved, fileLink };
  }

  /**
   * Puts the flat on the citizen’s own file — the mirror of
   * `releaseCensusClaim`, and the write that was never on this side.
   *
   * ## What "backed" has to mean
   *
   * Not "a row exists somewhere" but "billing would read this". `assessCitizen`
   * charges the property cards a citizen filed, so the claim has to land in one
   * of the three shapes `claimsBackingOccupancies` recognises — which are the
   * three shapes `attachOccupancies` and `bearsFee` actually consume. A row that
   * satisfied the warning without satisfying billing would be worse than the
   * warning: it would hide the uncollected flat instead of flagging it.
   *
   * ## The three things it will not do
   *
   * **It never rewrites a card that already claims this building.** That card is
   * the citizen’s own account of what they hold, and topping one up changes how
   * it is billed — an itemised مبنى card stops consuming the occupancy list
   * (`attachOccupancies`), so adding a flat to one can *reduce* what its holder
   * is charged. An existing card is reported as the backing it already is and
   * left exactly as filed. The one exception is a card that itemises flats and
   * simply has not ticked this one: adding the tick is the same act the unit
   * picker performs, in the same shape, and withholding it would leave the
   * occupancy unbacked beside a card listing every other flat in the block.
   *
   * **It never mints a card on a structure a card cannot hold.** A خيمة drops
   * `buildingId` on the next edit (`branchFieldsOnly`), so the claim would be a
   * holding attached to nothing — the same refusal `declareOwnership` makes, for
   * the same reason.
   *
   * **It never invents a file.** A citizen with no registration gets no card;
   * the occupancy stands on its own and the matrix goes on saying so. That is
   * the state the warning was written for, and it is now the only state that
   * produces it.
   */
  private async claimOnFile(input: {
    unitId: string;
    buildingId: string;
    citizenId: string;
    role: string;
    shares: number | null;
    unitStatus: string | null;
  }): Promise<FileLinkResult> {
    const building = await this.db.building.findUnique({
      where: { id: input.buildingId },
      select: { id: true, parcelNumber: true, name: true, structureType: true },
    });
    if (!building) return { backed: false, outcome: 'NO_BUILDING' };

    /*
      The citizen’s current file *is* their latest registration — the convention
      `CitizensService.update` and `declareOwnership` both follow. A citizen with
      none cannot receive a card, which is barely reachable through the register
      (a citizen exists because a registration created them) but is refused
      rather than assumed.
    */
    const registration = await this.db.registration.findFirst({
      where: { citizenId: input.citizenId },
      orderBy: { submittedAt: 'desc' },
      select: { id: true },
    });
    if (!registration) return { backed: false, outcome: 'NO_FILE' };

    const unitsInBuilding = await this.db.unit.count({ where: { buildingId: building.id } });

    /*
      Any card of theirs on this structure, in any capacity — the same breadth
      `declareOwnership` uses and for the same reason: a citizen who filed a
      مستأجر card here and has now been recorded as owner of a *different* flat
      in it is a real situation, and minting a second card under them is not
      this path’s call to make.
    */
    const existing = await this.db.propertyEntry.findFirst({
      where: { buildingId: building.id, registration: { citizenId: input.citizenId } },
      select: {
        id: true,
        propertyType: true,
        units: { select: { id: true, unitId: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (existing) {
      // Already ticked, or already backed by one of the two whole-structure
      // shapes. Nothing to write, and nothing to warn about either.
      const claimed =
        existing.units.some((row) => row.unitId === input.unitId) ||
        (existing.propertyType === 'HOUSE' && unitsInBuilding === 1) ||
        (existing.propertyType === 'BUILDING' && existing.units.length === 0);
      if (claimed) return { backed: true, outcome: 'ALREADY_CLAIMED' };

      /*
        An itemised card that has not ticked this flat.

        The tick is added rather than withheld — see the docblock. A card
        already listing flats 1, 2 and 4 does not stop consuming the occupancy
        list by gaining flat 3; it stopped the moment it listed anything, so a
        row here is the only way this occupancy can be backed at all.

        A منزل card on a multi-unit structure falls through to the same tick: it
        itemises nothing and infers nothing (the inference is single-unit only),
        so without a row here it claims no flat whatever.
      */
      const described = await this.unitDescription(input.unitId);
      await this.db.buildingUnit.create({
        data: {
          propertyEntryId: existing.id,
          unitId: input.unitId,
          // Copied from the canonical unit, which is the register’s own answer
          // and the only one available — the officer was not asked to describe a
          // flat the matrix already describes.
          unitType: described.unitType as never,
          floor: described.floor,
          side: described.side,
          unitArea: described.unitArea,
          unitStatus: (input.unitStatus ?? null) as never,
        },
      });

      return { backed: true, outcome: 'UNIT_ADDED' };
    }

    const mapped = STRUCTURE_TYPE_MAP[building.structureType as StructureType];

    /*
      A خيمة cannot carry the link and must not be minted as a holding.

      `branchFieldsOnly` drops `buildingId` from anything but مبنى and منزل, so the
      card would silently lose its link the first time anyone edited it — a
      holding attached to nothing. The occupancy still records who is there;
      only the card is withheld. An unmapped structure type takes the same exit
      rather than throwing, because the occupancy above is already written and
      losing it to a card that could not be minted would be the worse failure.
    */
    if (mapped?.propertyType !== 'BUILDING' && mapped?.propertyType !== 'HOUSE') {
      return { backed: false, outcome: 'UNLINKABLE_STRUCTURE' };
    }

    const described = await this.unitDescription(input.unitId);

    /*
      نوع الإشغال is the officer’s answer, carried straight across.

      `OccupancyRole` and `OccupancyType` are the same three values by design —
      مالك, مستأجر, شاغل بتسامح — because they are one question asked of the unit
      and of the card. This is the half that decides whether the register tells
      the truth about what it just recorded: a مستأجر named on the matrix now
      files a tenant’s card, not an owner’s, and a شاغل بتسامح files neither a
      tenancy that does not exist nor an ownership they do not have.
    */
    await this.db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: input.role as never,
        propertyType: mapped.propertyType as never,
        buildingId: building.id,
        // The parcel is the building’s own. الحي is left null rather than
        // guessed: the cadastre has no neighbourhood layer to ask, and this
        // path has no second card to copy one from the way `declareOwnership`
        // does.
        propertyNumber: building.parcelNumber || null,
        buildingName: building.name,
        /*
          A منزل bills its single unit from its own columns and has no units
          array to tick, so the description and the حالة go on the card itself.

          A مبنى carries a unit row instead — and carries one rather than none
          deliberately. An empty مبنى card claims *every* flat this citizen
          occupies in the block through `heldThroughOccupancy`, which is the right
          claim for a landlord whose holding nobody has enumerated and the wrong
          one for an officer who has just named a single flat.
        */
        ...(mapped.propertyType === 'HOUSE'
          ? {
              unitType: mapped.defaultUnitType as never,
              unitStatus: (input.unitStatus ?? null) as never,
              unitArea: described.unitArea,
            }
          : {
              units: {
                create: {
                  unitId: input.unitId,
                  unitType: described.unitType as never,
                  floor: described.floor,
                  side: described.side,
                  unitArea: described.unitArea,
                  unitStatus: (input.unitStatus ?? null) as never,
                },
              },
            }),
      },
    });

    return { backed: true, outcome: 'ENTRY_CREATED' };
  }

  /**
   * The canonical unit’s own description, in the shape a property card stores.
   *
   * The one conversion worth naming is the floor. `Unit.floor` is a signed
   * integer — the durable half of the unit code, basements negative — while
   * `BuildingUnit.floor` is the free text a citizen wrote on a form, which is why
   * `parseFloorLabel` exists to read «الطابق ٤» back out of it. The plain decimal
   * string is the one label that survives that round trip exactly, so it is what
   * a card minted from the register carries.
   */
  private async unitDescription(unitId: string) {
    const unit = await this.db.unit.findUnique({
      where: { id: unitId },
      select: { unitType: true, floor: true, side: true, unitArea: true },
    });
    return {
      unitType: unit?.unitType ?? null,
      floor: unit == null ? null : String(unit.floor),
      side: unit?.side ?? null,
      unitArea: unit?.unitArea ?? null,
    };
  }

  /**
   * Ends a spell without deleting it — the history is the point (D2) — and
   * releases the citizen's own claim on the flat at the same time.
   *
   * ## Why the second half exists
   *
   * Who is in a flat is recorded in two places: `UnitOccupancy`, which the
   * matrix shows, and the citizen's `PropertyEntry`/`BuildingUnit` link, which
   * billing reads and which their file displays. `CensusSyncService` writes
   * both together because a registration establishes both at once. This method
   * used to write only the first, and that asymmetry was the bug:
   *
   *   • an officer ended a spell from the matrix, saw the occupant disappear,
   *     and the citizen's file went on claiming the property — so the register
   *     still answered «من يملك هذه الوحدة؟» with someone the census had
   *     already moved out;
   *   • `heldThroughOccupancy` bills from the occupancy, the file shows the
   *     property, and the two now disagreed about the same flat;
   *   • worst, it came back. `CensusSyncService` re-reads the card on the next
   *     save and re-creates the occupancy from the link nobody cleared, so
   *     correcting a phone number six weeks later silently re-housed a
   *     household the municipality had evicted on paper.
   *
   * Ending a spell is the officer stating the household is not there. That is
   * one fact, so it is now written to both records or to neither.
   */
  async endOccupancy(
    occupancyId: string,
    input: { toDate?: Date; reason: string },
    actor: { id: string; role: string },
  ): Promise<OccupancyRow> {
    const existing = await this.db.unitOccupancy.findUnique({
      where: { id: occupancyId },
      include: { unit: { select: { buildingId: true, unitCode: true } } },
    });
    if (!existing) throw new NotFoundError('سجل الإشغال غير موجود');

    /*
      Ending an ended spell is refused rather than re-dated.

      A double tap, or two officers on one drawer, used to move `toDate` again
      and release the file claim a second time — harmless to the claim, but it
      rewrote *when* somebody left. The first answer stands.
    */
    if (existing.toDate) {
      throw new ConflictError('هذا الإشغال منتهٍ مسبقاً');
    }

    /*
      The reason has to fit the capacity.

      An owner does not «move out» — a deed is not a residence (D2), and an
      owner who left the flat but still holds it has not ended anything the
      matrix records; their unit is «شاغرة» or «مسكن موسمي». A tenant does not
      sell. Accepting either would store a history that reads as a fact and is
      not one. «سُجِّل بالخطأ» fits everyone.
    */
    const fits =
      input.reason === 'RECORDED_IN_ERROR' ||
      (existing.role === 'OWNER'
        ? input.reason === 'OWNERSHIP_TRANSFERRED'
        : input.reason === 'MOVED_OUT');
    if (!fits) {
      throw new ValidationError(
        existing.role === 'OWNER'
          ? 'إنهاء ملكية يكون ببيع أو نقل ملكية، أو لأنها سُجِّلت بالخطأ'
          : 'إنهاء إشغال مستأجر أو شاغل يكون بخروجه من الوحدة، أو لأنه سُجِّل بالخطأ',
        { reason: input.reason },
      );
    }

    const toDate = input.toDate ?? new Date();
    if (toDate < existing.fromDate) {
      throw new ValidationError('تاريخ الانتهاء قبل تاريخ بدء الإشغال', { toDate });
    }

    const updated = await this.db.unitOccupancy.update({
      where: { id: occupancyId },
      data: { toDate, endReason: input.reason as never },
      include: { citizen: { select: { firstName: true, lastName: true } } },
    });

    const released = await this.releaseCensusClaim({
      unitId: existing.unitId,
      buildingId: existing.unit.buildingId,
      citizenId: existing.citizenId,
    });

    this.record({
      action: 'OCCUPANCY_ENDED',
      buildingId: existing.unit.buildingId,
      after: {
        unitCode: existing.unit.unitCode,
        toDate: updated.toDate,
        role: existing.role,
        reason: input.reason,
        citizenId: existing.citizenId,
        /*
          Named in the audit row because this is the part that edits somebody's
          file rather than the census, and a resident disputing a bill is
          entitled to see when their card stopped claiming the flat and who
          did it.
        */
        unitLinksCleared: released.unitLinksCleared,
        buildingLinksCleared: released.buildingLinksCleared,
      },
      actor,
    });

    return toOccupancyRow(updated);
  }

  /**
   * Drops this citizen's census link to one unit, so their file stops claiming
   * a flat they are no longer recorded in.
   *
   * Two shapes of claim, because there are two ways a card reaches a unit and
   * clearing only the explicit one leaves the inferred one to resurrect it.
   *
   *   1. **An itemised unit.** A مبنى card ticks flats, and each tick is a
   *      `BuildingUnit` row carrying `unitId`. Only the link is dropped — the
   *      row itself is the citizen's own statement about a flat they filed
   *      (floor, area, أسهم), and deleting it would throw away what they said
   *      rather than what the census concluded.
   *
   *   2. **A منزل standing on a one-unit structure.** Such a card has no units
   *      to tick, so `CensusSyncService` infers the unit from the building —
   *      which means the claim lives in `PropertyEntry.buildingId` and
   *      clearing unit links alone would leave the next sync free to re-create
   *      exactly the occupancy just ended.
   *
   * Narrowed to buildings with exactly one unit, mirroring the inference it is
   * undoing. A منزل linked to a six-flat block claims nothing by inference, so
   * severing its `buildingId` would discard a link an officer made deliberately
   * and answer "this person left flat 3" by forgetting which building it was.
   *
   * A مبنى card keeps its `buildingId` for the same reason even when its last
   * tick is gone: the card is still about that structure, and it claims no unit
   * now that nothing points at one.
   */
  private async releaseCensusClaim(input: {
    unitId: string;
    buildingId: string;
    citizenId: string;
  }): Promise<{ unitLinksCleared: number; buildingLinksCleared: number }> {
    const unitLinks = await this.db.buildingUnit.updateMany({
      where: {
        unitId: input.unitId,
        propertyEntry: { registration: { citizenId: input.citizenId } },
      },
      data: { unitId: null },
    });

    const unitsInBuilding = await this.db.unit.count({
      where: { buildingId: input.buildingId },
    });

    if (unitsInBuilding !== 1) {
      return { unitLinksCleared: unitLinks.count, buildingLinksCleared: 0 };
    }

    const buildingLinks = await this.db.propertyEntry.updateMany({
      where: {
        buildingId: input.buildingId,
        propertyType: 'HOUSE' as never,
        registration: { citizenId: input.citizenId },
        // Nothing itemised; the `buildingId` is the whole of the claim. A card
        // that still ticks a flat elsewhere in this structure is not what the
        // single-unit inference acts on, and is left alone.
        units: { none: { unitId: { not: null } } },
      },
      data: { buildingId: null },
    });

    return { unitLinksCleared: unitLinks.count, buildingLinksCleared: buildingLinks.count };
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
      One array parameter, not one parameter per id — and certainly not two.

      This was `Prisma.join(...)` embedded in the template twice, once per arm
      of the UNION. Prisma flattens an embedded `Sql` at *each* occurrence, so
      the statement carried `2 × N` bind parameters: past ~32,768 candidates it
      breaks Postgres' 65,535-parameter ceiling and the ledger stops loading
      altogether, and long before that it is a multi-megabyte statement being
      re-parsed on every keystroke in the search box.

      `= ANY($1::uuid[])` binds the whole list once and can be reused in both
      arms for free. The cast is on the parameter rather than the column so the
      index on `buildingId` is still usable — casting the column instead would
      work and would throw away the one thing this query exists to use.
    */
    const ids = Prisma.sql`${buildingIds}::uuid[]`;

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
           WHERE d."buildingId" = ANY(${ids})
          UNION ALL
          SELECT u."buildingId", d."level", d."assessedAt"
            FROM ${S}"damage_assessments" d
            JOIN ${S}"units" u ON u."id" = d."unitId"
           WHERE u."buildingId" = ANY(${ids})
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
  basementsCount: number;
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
    basementsCount: row.basementsCount,
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
  startCol: number | null;
  endCol: number | null;
  unitCode: string;
  postedNumber: string | null;
  unitType: string;
  side: string | null;
  unitArea: { toString(): string } | null;
  unitStatus: string | null;
  surveyStatus: string;
  presenceMonths?: number[];
  ownerLastStayAt?: Date | null;
  vacancyDeclaredAt?: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}): UnitRow {
  return {
    id: row.id,
    buildingId: row.buildingId,
    floor: row.floor,
    sequence: row.sequence,
    startCol: row.startCol,
    endCol: row.endCol,
    unitCode: row.unitCode,
    postedNumber: row.postedNumber,
    unitType: row.unitType,
    side: row.side,
    // Decimal → number at the edge; a `Decimal` serialises as an object, which
    // the client would render as "[object Object]".
    unitArea: row.unitArea == null ? null : Number(row.unitArea.toString()),
    unitStatus: row.unitStatus,
    surveyStatus: row.surveyStatus,
    presenceMonths: row.presenceMonths ?? [],
    ownerLastStayAt: row.ownerLastStayAt ?? null,
    vacancyDeclaredAt: row.vacancyDeclaredAt ?? null,
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

function toOccupancyRow(
  row: {
    id: string;
    unitId: string;
    citizenId: string;
    citizen?: { firstName: string; lastName: string } | null;
    role: string;
    shares: number | null;
    fromDate: Date;
    toDate: Date | null;
    endReason?: string | null;
    registrationId: string | null;
  },
  /**
   * Defaults to `true` so the write paths — which return the row they just
   * wrote, not a survey of the register — do not have to answer a question
   * they were not asked. Only `get` passes it, and only `get` has the two
   * queries in hand to answer it honestly. See `OccupancyRow.backedByFile`.
   */
  backedByFile = true,
): OccupancyRow {
  return {
    id: row.id,
    unitId: row.unitId,
    citizenId: row.citizenId,
    citizenName: row.citizen ? `${row.citizen.firstName} ${row.citizen.lastName}` : null,
    role: row.role,
    shares: row.shares,
    fromDate: row.fromDate,
    toDate: row.toDate,
    endReason: row.endReason ?? null,
    registrationId: row.registrationId,
    backedByFile,
  };
}

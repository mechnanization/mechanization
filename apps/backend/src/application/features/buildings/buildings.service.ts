import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  formatBuildingCode,
  formatUnitCode,
  isOccupiableLifecycle,
  nextBuildingSuffix,
  OCCUPIABLE_LIFECYCLE,
  STRUCTURE_TYPE_MAP,
  contradictsVacancy,
  isDwellingUnitType,
  isUnoccupied,
  SURVEYED_STATUS,
  unitStatusForRole,
  type ConfirmVacancyInput,
  type CreateBuildingInput,
  type EndVacancyInput,
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
import { cardClaiming, takesAnotherFlat } from '../../../domain/entities/census-claim';
import { CasesService } from '../cases/cases.service';
import type {
  BuildingLedgerRow,
  BuildingListFilter,
  BuildingMapPin,
  BuildingRow,
  CensusSummary,
  FileLinkResult,
  LandlordSpec,
  OccupancyOwnerLink,
  OccupancyRow,
  UnitRow,
  VacancyRow,
  VisitRow,
} from './building.types';
import { activeVacancy, closeActiveVacancy, toVacancyRow } from './unit-vacancy';

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
 * «العقارات المشتركة», minus the building's own — the list as it is stored.
 *
 * A structure standing on two or three adjacent عقارات is ordinary here, and
 * `parcelNumber` can name only one of them: the display code and the per-parcel
 * suffix are both derived from it (D9), so widening it to a list would change
 * what a building code means and break the `(parcelNumber, codeSuffix)`
 * uniqueness the allocation turns on.
 *
 * The one rule this enforces is that the building's own parcel is never in it.
 * An officer who types it there has repeated themselves rather than recorded a
 * second parcel, and storing it would make the structure appear to straddle
 * itself — which is then *counted*, in a figure nobody would think to check
 * against the parcel it is already filed under.
 *
 * Exported for the same reason `rollupOf` is: it decides what gets written and
 * it is decidable without a database, so it is pinned by a test rather than
 * left to the integration suite that only runs where there is a Postgres.
 *
 * Duplicates within the list are already collapsed by
 * `createBuildingSchema`'s own transform; this is the one member the schema
 * cannot know about, because the schema does not know which parcel is being
 * edited.
 */
export function sharedParcelsExcluding(
  values: readonly string[] | undefined,
  own: string,
): string[] {
  const ownTrimmed = own.trim();
  return cleanList(values).filter((value) => value !== ownTrimmed);
}

/**
 * أرقام الأقسام, kept only where a فرز was actually recorded.
 *
 * The pairing rule for migration 0047's two partition columns, and it is here
 * rather than in a Zod refinement because a PATCH may legitimately send the
 * numbers without restating the flag — resolving that needs the stored row,
 * which a schema cannot see. The caller passes whichever answer now applies.
 *
 * Cleared rather than refused, which is the same judgement `PropertyEntry.
 * normalise` makes about an out-of-branch leftover: a form whose checkbox was
 * ticked, filled in and then cleared is a correction somebody got right, and
 * failing their save over the rows they just abandoned would be punishing them
 * for changing their mind. What must not survive is the leftover — أقسام under
 * a structure nobody has recorded a فرز for is a contradiction, and one a deed
 * search would later read as fact.
 */
export function partitionNumbersFor(
  isPartitioned: boolean | null | undefined,
  values: readonly string[] | undefined,
): string[] {
  return isPartitioned === true ? cleanList(values) : [];
}

/** Trimmed, de-duplicated, blanks dropped — the shape both lists are stored in. */
function cleanList(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of values ?? []) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }

  return out;
}

/**
 * The buildings standing on any of these عقارات — on them as their own parcel,
 * or across them as a shared one.
 *
 * ## Where this is the right question, and where it is not
 *
 * «What stands on عقار 25» has to find a building filed under 10 that also
 * covers 25: the ledger's parcel search, the registration form's building
 * picker and the duplicate-structure guard are all asking where a structure
 * *is*, and a building recorded on two parcels is on both. Leaving the shared
 * ones out sends an officer standing on 25 to create a second building for a
 * structure the census already holds — the duplicate D18 exists to stop.
 *
 * It is deliberately **not** used for the two questions that are about the
 * building's *own* parcel, and both stay on `parcelNumber` alone:
 *
 *  - the code suffix, which is allocated per own parcel and forms the code
 *    `ZONE-PARCEL-SUFFIX` (D7, D9) — a building on 10 sharing 25 takes no
 *    letter from 25's sequence;
 *  - the sector filter, because a building's sector is derived from its own
 *    parcel (D13). Listing it under a second sector would put one building on
 *    two dispatch lists.
 *
 * ## Why no index backs `sharedParcelNumbers`
 *
 * Prisma renders `hasSome` as the array-overlap operator `&&`, which a GIN index
 * can serve and a B-tree cannot. None is created, on purpose: a municipality has
 * at most about one building per parcel (1,825 in Albazourieh, 16 surveyed when
 * this was written), and at that size the planner reads the whole table faster
 * than it would read an index. Add `USING gin ("sharedParcelNumbers")` if a
 * tenant's `buildings` table ever reaches the tens of thousands — in a migration
 * of its own, and see AGENTS.md §3 on `CONCURRENTLY` under the tenant migrator.
 */
export function standsOnParcels(parcelNumbers: readonly string[]): Prisma.BuildingWhereInput {
  const wanted = cleanList(parcelNumbers);
  return {
    OR: [{ parcelNumber: { in: wanted } }, { sharedParcelNumbers: { hasSome: wanted } }],
  };
}

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

/**
 * How many of a unit's vacancy confirmations travel with the matrix.
 *
 * The one standing is what the panel acts on; the closed ones behind it are
 * context — «شاغرة من آذار إلى تموز» is what tells an officer the flat has been
 * through this before. Capped for `MAX_VISITS_RETURNED`'s reason, and smaller,
 * because a flat confirmed empty five times is already an unusual history.
 */
const MAX_VACANCIES_RETURNED = 5;

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
       * «تأكيد الشغور», newest first — capped at `MAX_VACANCIES_RETURNED`.
       *
       * The row with no `endedAt` is the one standing, and it is what makes the
       * flat read «شاغرة»; the rest are closed history. Sent with the matrix
       * rather than fetched per unit because the panel needs to say *why* a
       * unit is empty and offer to lift it, both without a second round trip on
       * a phone in a stairwell.
       */
      vacancies: VacancyRow[];
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
      | 'UNIT_VISIT_LOGGED'
      /*
        The two halves of «تأكيد الشغور». Audited as loudly as an occupancy is,
        and for the same reason: confirming a vacancy stops the owner's
        occupancy fee and lifting it starts it again, so each is a row a
        resident disputing a notice is entitled to see.
      */
      | 'UNIT_VACANCY_CONFIRMED'
      | 'UNIT_VACANCY_ENDED';
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
        /*
          Newest first, and the tiebreaker matters as much as the key.

          «سجل المباني» is read by the officer who has just filed something, and
          the old `(parcelNumber, codeSuffix)` order put their new record
          wherever its parcel number happened to sort — the middle of the list,
          in practice — so they went looking for work they had just done.

          `id` breaks ties because `createdAt` is a timestamp, not a sequence:
          a matrix save writes a building and its units in one transaction and
          two buildings can land on the same millisecond. Without a second key
          their relative order is undefined, and an undefined order under
          `LIMIT`/`OFFSET` is how a row appears on two pages or on neither.
        */
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
   * The filter vocabularies this municipality's census actually uses.
   *
   * The four selects above «سجل المباني» were built from the enum arrays in
   * `shared-schemas`, which is the *type* system's answer to "what values are
   * possible" and not the register's answer to "what values are here". A
   * municipality with no collapsed buildings was still offered «انهيار كامل»,
   * and choosing it returned an empty table — a filter that can only ever say
   * "nothing", presented as though it were a question worth asking.
   *
   * So these are read off the rows. Each list is the set of values present,
   * which means it is also the set that can return something.
   *
   * Sequential, like `list` and for the same reason: against a pooler with
   * `connection_limit=1` a fan-out of `Promise.all` queues and hits P2024.
   * This read is cached hard by the client, so its latency is paid once.
   */
  async filterOptions(): Promise<{
    structureTypes: string[];
    lifecycleStatuses: string[];
    surveyStatuses: string[];
    damageLevels: string[];
  }> {
    const structures = await withConnectionRetry(() =>
      this.db.building.groupBy({ by: ['structureType'], orderBy: { structureType: 'asc' } }),
    );
    const lifecycles = await withConnectionRetry(() =>
      this.db.building.groupBy({ by: ['lifecycleStatus'], orderBy: { lifecycleStatus: 'asc' } }),
    );

    /*
      Survey status is a *unit* column that the ledger filters *buildings* by,
      so the options have to be collected the way the filter resolves them —
      over the units of occupiable structures only. `buildWhere` narrows to
      `OCCUPIABLE_LIFECYCLE` for exactly this filter; offering a status that
      only a demolished block's units carry would put a value in the list that
      the filter itself then excludes.
    */
    const surveys = await withConnectionRetry(() =>
      this.db.unit.groupBy({
        by: ['surveyStatus'],
        where: { building: { lifecycleStatus: { in: [...OCCUPIABLE_LIFECYCLE] as never } } },
        orderBy: { surveyStatus: 'asc' },
      }),
    );

    /*
      And «غير ممسوح» covers one more case than any unit row does: a building
      with no matrix yet is unsurveyed — that is what an empty shell is, and
      `buildWhere` says so explicitly (`{ units: { none: {} } }`). Without this
      the option would be missing on exactly the census that needs it most: a
      municipality that has entered its buildings and not yet been inside one.
    */
    const unsurveyedShells = await withConnectionRetry(() =>
      this.db.building.count({
        where: {
          lifecycleStatus: { in: [...OCCUPIABLE_LIFECYCLE] as never },
          units: { none: {} },
        },
      }),
    );

    const surveyStatuses = new Set(surveys.map((row) => String(row.surveyStatus)));
    if (unsurveyedShells > 0) surveyStatuses.add('NOT_SURVEYED');

    return {
      structureTypes: structures.map((row) => String(row.structureType)),
      lifecycleStatuses: lifecycles.map((row) => String(row.lifecycleStatus)),
      surveyStatuses: [...surveyStatuses].sort(),
      damageLevels: await this.currentDamageLevelsPresent(),
    };
  }

  /**
   * The damage levels buildings are at **now**, deduplicated.
   *
   * Not `groupBy` on `damage_assessments`: that log is append-only, so it
   * still holds «غير صالح للسكن» for a building repaired and reassessed since.
   * Offering that level would be offering a filter that matches nothing, which
   * is the failure this whole method exists to remove — so it resolves current
   * levels the same way `buildingIdsAtCurrentLevel` does, through the one
   * `DISTINCT ON` query that defines what "current" means here.
   */
  private async currentDamageLevelsPresent(): Promise<string[]> {
    const candidates = await this.assessedBuildingIds();
    if (candidates.length === 0) return [];
    const current = await this.currentDamageLevels(candidates);
    return [...new Set(current.values())].sort();
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

    const candidates = await this.assessedBuildingIds();
    if (candidates.length === 0) return [];

    const wanted = new Set(levels);
    const current = await this.currentDamageLevels(candidates);
    return [...current.entries()]
      .filter(([, level]) => wanted.has(level))
      .map(([buildingId]) => buildingId);
  }

  /**
   * Every building anybody has ever recorded an assessment against.
   *
   * The candidate set for "what is the current level", shared by the filter
   * and by `filterOptions` so the two cannot disagree about which buildings
   * are even in the running.
   */
  private async assessedBuildingIds(): Promise<string[]> {
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

    return [
      ...new Set([
        ...direct.map((row) => row.buildingId).filter((id): id is string => Boolean(id)),
        ...viaUnit.map((row) => row.unit?.buildingId).filter((id): id is string => Boolean(id)),
      ]),
    ];
  }

  private async buildWhere(filter: BuildingListFilter): Promise<Prisma.BuildingWhereInput> {
    const where: Prisma.BuildingWhereInput = {};

    /*
      «على العقار» means standing on it — as its own parcel or as a shared one.
      See `standsOnParcels`. ANDed rather than assigned, because the predicate is
      an OR and the survey-status filter below assigns `where.OR` of its own.
    */
    if (filter.parcelNumber) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        standsOnParcels([filter.parcelNumber]),
      ];
    }
    if (filter.parcelNumbers) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        standsOnParcels(filter.parcelNumbers),
      ];
    }
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

      Matched against the building's *own* parcel only, never a shared one: the
      sector is derived from that parcel (D13) and is what the code carries, so
      a building on 10 that also covers a parcel in the next sector is still
      that one sector's building — see `standsOnParcels`.

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
        // Exact rather than `contains`: an array element cannot be matched by
        // substring, and a whole parcel number is what somebody searching one types.
        { sharedParcelNumbers: { has: term } },
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
                include: { citizen: { select: { firstName: true, lastName: true, phone: true } } },
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
              /*
                «تأكيد الشغور», standing or lifted.

                Newest first and capped, as the visits beside it are. The one
                still open is what the panel offers to lift; the closed ones are
                why the flat reads the way it does — and they are the only place
                an officer can see that a vacancy was recorded in error rather
                than simply never recorded.
              */
              vacancies: {
                orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }],
                take: MAX_VACANCIES_RETURNED,
                include: {
                  confirmedBy: { select: { firstName: true, lastName: true } },
                  endedBy: { select: { firstName: true, lastName: true } },
                },
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
    const ownerLinks = await this.occupancyOwnerLinks(row.id, row.units);

    return {
      ...toBuildingRow(row),
      zoneCode: zone?.code ?? null,
      zoneName: zone?.name ?? null,
      units: row.units.map((unit) => ({
        ...toUnitRow(unit),
        occupants: unit.occupancies.map((occupancy) => {
          const key = `${occupancy.unitId}:${occupancy.citizenId}`;
          return toOccupancyRow(
            occupancy,
            backing.has(key),
            occupancy.toDate === null && occupancy.role !== 'OWNER'
              ? (ownerLinks.get(key) ?? null)
              : null,
          );
        }),
        visits: unit.visits.map(toVisitRow),
        visitCount: unit._count.visits,
        vacancies: unit.vacancies.map(toVacancyRow),
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
          endedAt: null,
          propertyEntry: { occupancyType: 'OWNER' as never, endedAt: null },
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
              endedAt: null,
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
   * Whether a unit is a seasonal home as billing sees it — its own حالة, or
   * its owner's card where it has none.
   *
   * The siblings are read because `ownerDeclaredStatuses` needs the building's
   * real unit count: a منزل card speaks for a structure only when it has
   * exactly one unit, and handing it this unit alone would make every flat
   * look like the only one.
   */
  private async isSeasonal(unit: {
    id: string;
    buildingId: string;
    unitStatus: string | null;
  }): Promise<boolean> {
    if (unit.unitStatus) return unit.unitStatus === 'SEASONAL';
    const siblings = await this.db.unit.findMany({
      where: { buildingId: unit.buildingId },
      select: { id: true, unitStatus: true },
    });
    const declared = await this.ownerDeclaredStatuses(unit.buildingId, siblings);
    return declared.get(unit.id) === 'SEASONAL';
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
      // Current claims only: an ended tenancy row still names its flat, as
      // history, and must not read as a live claim backing anybody.
      this.db.buildingUnit.findMany({
        where: {
          unitId: { in: unitIds },
          endedAt: null,
          propertyEntry: { endedAt: null, registration: { citizenId: { in: citizenIds } } },
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
              endedAt: null,
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
        where: { buildingId, endedAt: null, registration: { citizenId: { in: citizenIds } } },
        select: {
          propertyType: true,
          registration: { select: { citizenId: true } },
          _count: { select: { units: { where: { endedAt: null } } } },
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

  /**
   * Who each current tenant or شاغل بتسامح in this building holds their flat
   * from, according to their own tenancy card — and whether that owner is an
   * owner of the flat. See `OccupancyOwnerLink`.
   *
   * One read for the building. The card is found by `claimsFlat` — the rule
   * `claimOnFile` files by — because that is the card the flat is billed and
   * ended through, and a column here saying «لا توجد بطاقة» about a card that
   * exists sends an officer to file a second one.
   */
  private async occupancyOwnerLinks(
    buildingId: string,
    units: ReadonlyArray<{
      id: string;
      occupancies: ReadonlyArray<{ citizenId: string; role: string; toDate: Date | null }>;
    }>,
  ): Promise<ReadonlyMap<string, OccupancyOwnerLink>> {
    const links = new Map<string, OccupancyOwnerLink>();
    const tenantIds = [
      ...new Set(
        units.flatMap((unit) =>
          unit.occupancies
            .filter((row) => row.toDate === null && row.role !== 'OWNER')
            .map((row) => row.citizenId),
        ),
      ),
    ];
    if (tenantIds.length === 0) return links;

    const cards = await this.db.propertyEntry.findMany({
      where: {
        buildingId,
        endedAt: null,
        occupancyType: { in: ['TENANT', 'FREE_OCCUPANT'] as never },
        registration: { citizenId: { in: tenantIds } },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        propertyType: true,
        occupancyType: true,
        landlordName: true,
        landlordCitizenId: true,
        landlordCitizen: { select: { firstName: true, middleName: true, lastName: true } },
        registration: { select: { citizenId: true } },
        units: { where: { endedAt: null }, select: { unitId: true } },
      },
    });

    /*
      Each tenant's cards and current spells, grouped once rather than scanned
      per flat. `claimsFlat` needs the spells because a card that names no flat
      is read against what the census says they hold here — and every one of
      them is already in `units`, so the grouping costs no read at all.
    */
    const cardsByCitizen = new Map<string, Array<(typeof cards)[number]>>();
    for (const card of cards) {
      const theirs = cardsByCitizen.get(card.registration.citizenId);
      if (theirs) theirs.push(card);
      else cardsByCitizen.set(card.registration.citizenId, [card]);
    }
    const spellsByCitizen = new Map<string, Array<{ unitId: string; role: string }>>();
    for (const unit of units) {
      for (const row of unit.occupancies) {
        if (row.toDate !== null) continue;
        const theirs = spellsByCitizen.get(row.citizenId);
        const spell = { unitId: unit.id, role: row.role };
        if (theirs) theirs.push(spell);
        else spellsByCitizen.set(row.citizenId, [spell]);
      }
    }

    for (const unit of units) {
      const owners = new Set(
        unit.occupancies
          .filter((row) => row.toDate === null && row.role === 'OWNER')
          .map((row) => row.citizenId),
      );
      for (const spell of unit.occupancies) {
        if (spell.toDate !== null || spell.role === 'OWNER') continue;
        const theirs = cardsByCitizen.get(spell.citizenId) ?? [];
        const card = cardClaiming(
          theirs,
          spellsByCitizen.get(spell.citizenId) ?? [],
          unit.id,
          spell.role,
        );

        links.set(`${unit.id}:${spell.citizenId}`, {
          state: !card
            ? 'NO_CARD'
            : !card.landlordCitizenId
              ? 'UNLINKED'
              : owners.has(card.landlordCitizenId)
                ? 'LINKED'
                : 'LINKED_ELSEWHERE',
          propertyEntryId: card?.id ?? null,
          ownerId: card?.landlordCitizenId ?? null,
          ownerName: card?.landlordCitizen ? personName(card.landlordCitizen) : null,
          typedName: card && !card.landlordCitizenId ? card.landlordName : null,
        });
      }
    }
    return links;
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
    /*
      Asked whether or not the officer already acknowledged. Refused on when
      nothing was acknowledged; written into the audit row when something was,
      so "created 3.6 m from Z-3-56-A, because …" is a fact on record rather
      than a tick nobody can see afterwards.
    */
    const neighbours = await this.parcelNeighbours(parcelNumber, input);

    if (!input.acknowledgedDuplicates && neighbours.length > 0) {
      throw new ConflictError(
        `يوجد ${neighbours.length === 1 ? 'مبنى مسجَّل' : `${neighbours.length} مبانٍ مسجَّلة`} على العقار ${parcelNumber}. تأكَّد أن هذه منشأة مختلفة قبل المتابعة.`,
        {
          /*
            The candidates travel with the refusal so the dialog can show
            them without a second round trip — an officer offline enough to
            have queued this creation may not get one.
          */
          parcelNumber,
          candidates: neighbours,
        },
      );
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
          /*
            `?? null` rather than `|| null`: `false` is «غير مفروزة», a finding
            an officer made, and it must not be flattened into «لم يُسأل».
          */
          isPartitioned: input.isPartitioned ?? null,
          // Dropped unless a فرز was actually asserted — see `partitionNumbersFor`.
          partitionNumbers: partitionNumbersFor(input.isPartitioned, input.partitionNumbers),
          // Never the parcel the code derives from — see `sharedParcelsExcluding`.
          sharedParcelNumbers: sharedParcelsExcluding(input.sharedParcelNumbers, parcelNumber),
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
        /*
          What the officer said this was not, and how far away it stood.

          Only where there was something to acknowledge. This is the row a
          reviewer reads when two records on one parcel turn out to be one
          building: the distances say whether the tick was a judgement or a
          reflex, and the reason says what the officer saw.
        */
        ...(created.latitude == null && input.noPinReason?.trim()
          ? { noPinReason: input.noPinReason.trim() }
          : {}),
        ...(neighbours.length > 0
          ? {
              acknowledgedNeighbours: neighbours.map((row) => ({
                id: row.id,
                code: row.code,
                distanceMetres: row.distanceMetres,
              })),
              duplicateReason: input.duplicateReason?.trim() || null,
            }
          : {}),
      },
      actor,
    });

    return { building: toBuildingRow(created), reconciled, deduplicated: false };
  }

  /**
   * Every structure standing on this عقار, nearest first where both pins exist.
   *
   * Including one filed under a neighbouring parcel that also covers this one —
   * see `standsOnParcels`. That second kind is the likelier duplicate of the
   * two: an officer on 25 who does not know Z-2-10-A reaches over the boundary
   * will create it again.
   *
   * Ordered by distance because distance is the fact that decides the question:
   * parcel 56's second and third records were created 3.6 m and 4.1 m from the
   * first, off a list ordered by code. Rows with no distance keep the old order
   * after the measured ones — own parcel first, then by code.
   *
   * `distanceMetres` is null where either pin is missing rather than defaulted
   * to zero: "we cannot tell how far apart these are" and "they are in the same
   * place" are opposite findings, and the second is the one that would talk
   * somebody out of a real building.
   */
  private async parcelNeighbours(
    parcelNumber: string,
    pin: { latitude?: number | null; longitude?: number | null },
  ) {
    const found = await this.db.building.findMany({
      where: standsOnParcels([parcelNumber]),
      orderBy: [{ code: 'asc' }],
      select: {
        id: true,
        code: true,
        parcelNumber: true,
        name: true,
        postedNumber: true,
        structureType: true,
        lifecycleStatus: true,
        unitsTotal: true,
        latitude: true,
        longitude: true,
      },
    });

    const rows = [
      ...found.filter((row) => row.parcelNumber === parcelNumber),
      ...found.filter((row) => row.parcelNumber !== parcelNumber),
    ].map(({ parcelNumber: ownParcel, ...row }) => ({
      ...row,
      /*
        Named so the dialog can say «يمتد على هذا العقار — عقاره الأساسي 10»
        instead of listing a building whose code names a different parcel with
        no explanation.
      */
      ownParcelNumber: ownParcel,
      sharesParcel: ownParcel !== parcelNumber,
      distanceMetres:
        pin.latitude != null &&
        pin.longitude != null &&
        row.latitude != null &&
        row.longitude != null
          ? Math.round(
              metresBetween(
                { latitude: pin.latitude, longitude: pin.longitude },
                { latitude: row.latitude, longitude: row.longitude },
              ),
            )
          : null,
    }));

    return sortByDistance(rows);
  }

  async update(
    id: string,
    input: UpdateBuildingInput,
    actor: { id: string; role: string },
  ): Promise<BuildingRow> {
    const before = await this.db.building.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('المبنى غير موجود');

    /*
      Somebody saved this building after the editor was opened. Refused before
      anything is written, naming them, so a screen loaded an hour ago does not
      quietly put back a lifecycle, a فرز or a pin a colleague has since changed.
    */
    if (input.expectedUpdatedAt && before.updatedAt.toISOString() !== new Date(input.expectedUpdatedAt).toISOString()) {
      const last = await this.db.auditLogEntry.findFirst({
        where: { entityType: 'Building', entityId: id },
        orderBy: { createdAt: 'desc' },
        select: { actorId: true, createdAt: true },
      });
      const staff = last?.actorId
        ? await this.db.user.findFirst({
            where: { id: last.actorId, kind: 'STAFF' },
            select: { firstName: true, lastName: true },
          })
        : null;
      const who = staff ? `${staff.firstName} ${staff.lastName}` : null;
      throw new ConflictError(
        who
          ? `عدّل ${who} هذا المبنى بعد أن فتحتَه. أعد فتح المبنى لترى تعديلاته قبل الحفظ.`
          : 'عُدِّل هذا المبنى بعد أن فتحتَه. أعد فتح المبنى لترى التعديلات قبل الحفظ.',
        {
          staleEdit: {
            updatedAt: before.updatedAt.toISOString(),
            lastEditedBy: who,
            lastEditedAt: last?.createdAt.toISOString() ?? null,
            byViewer: last?.actorId === actor.id,
          },
        },
      );
    }

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
        // `null` is «غير محدد» and is storable, so the presence check is on
        // `undefined` alone — an absent key leaves the column as it is.
        ...(input.isPartitioned !== undefined ? { isPartitioned: input.isPartitioned } : {}),
        /*
          The أقسام follow the flag, whichever of the two this request restates.

          Written whenever *either* field is present, because they are one fact:
          a PATCH that unsets `isPartitioned` and says nothing about the numbers
          must still clear them, or the building keeps أقسام under a فرز it no
          longer records. `partitioned` resolves the flag against the stored row
          so a request carrying only the numbers is judged against the فرز the
          building actually has.
        */
        ...(input.partitionNumbers !== undefined || input.isPartitioned !== undefined
          ? {
              partitionNumbers: partitionNumbersFor(
                input.isPartitioned !== undefined ? input.isPartitioned : before.isPartitioned,
                input.partitionNumbers !== undefined
                  ? input.partitionNumbers
                  : before.partitionNumbers,
              ),
            }
          : {}),
        ...(input.sharedParcelNumbers !== undefined
          ? {
              // `parcelNumber` cannot be edited, so `before` is the authority
              // on which one this list may not contain.
              sharedParcelNumbers: sharedParcelsExcluding(
                input.sharedParcelNumbers,
                before.parcelNumber,
              ),
            }
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

    /*
      Every field this save changed, on both sides — and only those.

      This logged name, structure type and lifecycle, always, whether they
      moved or not. So on 2026-09-16 twenty rows read as identical before/after
      pairs while the parcel's فرز, its shared parcels and a DERELICT → IN_USE
      flip-flop left no field-level trail at all. The lifecycle is still written
      on both sides every time: it is the one field that moves a building in and
      out of the census denominator, and a coverage figure that jumped needs a
      row naming the building that did it.
    */
    const changes = changedBuildingFields(before, updated);
    this.record({
      action: 'BUILDING_UPDATED',
      buildingId: id,
      before: { ...changes.before, lifecycleStatus: before.lifecycleStatus },
      after: {
        ...changes.after,
        lifecycleStatus: updated.lifecycleStatus,
        changedFields: Object.keys(changes.after),
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
      await this.assertMayBeCalledEmpty(before);
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

  // ─────────────────────────  «تأكيد الشغور»  ─────────────────────────

  /**
   * The two things that make "this flat is empty" untrue, refused wherever it
   * is said.
   *
   * **Somebody living there.** A مستأجر or شاغل بتسامح recorded on the unit is
   * the flat's occupant, and writing «شاغرة» over them leaves a row saying
   * nobody is there beside rows naming who is — which `isUnoccupied` then reads
   * as an exemption, so the contradiction silently stops a bill. Refused rather
   * than cascaded into ending their spells: those are opposite statements about
   * people, and only the officer knows which is true. «إنهاء الإشغال» is a click
   * away and asks who left and when.
   *
   * **An owner is not one of them**, and that asymmetry is load-bearing. This
   * used to refuse over any live spell including the owner's, so officers ended
   * the *ownership* to record an empty flat — erasing the deed from the file,
   * billing and all. A deed is not a statement of residence (D2); an owner
   * recorded on a شاغرة unit is exactly what the join table exists to say.
   *
   * **A seasonal home.** Its owners being away is what «مسكن موسمي» means, and
   * a seasonal home is billed to them (`OWNER_BILLED_WHILE_ABSENT`) while a
   * vacant one is exempt — so a summer house surveyed in January was one tap
   * from cancelling the summer's fees. Read the way billing reads it: the
   * unit's own حالة, or the owner's card where the unit has none.
   */
  /**
   * One transaction — or the caller's, when there already is one.
   *
   * «إنهاء الإيجار» confirms the vacancy it leaves behind inside its own
   * transaction, so the tenancy and the vacancy commit together. The client this
   * service reads is that transaction then, and a transaction client has no
   * `$transaction` of its own: the work simply joins the one already open.
   */
  private atomic<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const client = this.db as unknown as { $transaction?: unknown };
    return typeof client.$transaction === 'function'
      ? this.db.$transaction(work, { maxWait: 15_000, timeout: 30_000 })
      : work(this.db as unknown as Prisma.TransactionClient);
  }

  private async assertMayBeCalledEmpty(unit: {
    id: string;
    buildingId: string;
    unitCode: string;
    unitStatus: string | null;
  }): Promise<void> {
    const live = await this.db.unitOccupancy.count({
      where: { unitId: unit.id, toDate: null, role: { in: ['TENANT', 'FREE_OCCUPANT'] as never } },
    });
    if (live > 0) {
      throw new ConflictError(
        `لا يمكن تسجيل الوحدة ${unit.unitCode} كشاغرة: يسكنها ${live} مستأجر أو شاغل مسجَّل. أنهِ إشغاله أولاً`,
      );
    }

    if (await this.isSeasonal(unit)) {
      throw new ConflictError(
        `لا يمكن تسجيل الوحدة ${unit.unitCode} كشاغرة: هي مسكن موسمي، وغياب أصحابه لا يجعلها شاغرة. سجّل تصريح الشغور في بيانات السكن الموسمي، أو أعد ربط المالك بحالة «شاغرة» إن لم يعودوا يأتون`,
      );
    }
  }

  /**
   * Records that a unit was found empty — as a row that says so, not as two
   * overwritten columns.
   *
   * ## Why this is not a status edit
   *
   * A confirmed vacancy exempts the owner from the occupancy fee (Law 60/1988
   * Art. 11 — the fee is owed for *actual* occupancy), so it is a finding with a
   * cost to the municipality if it is wrong and a cost to the owner if it is
   * missing. The old button wrote «شاغرة» and «مؤكَّدة الشغور» and kept nothing
   * else: not who decided, not what they had, not what the flat said before. A
   * resident disputing an assessment could be told only that the register said
   * so.
   *
   * So the confirmation is the record, and the unit's two columns are its
   * *effect*. `basis` is what it rests on (the law is specific — see
   * `VACANCY_BASIS`), `observedAt` is when the flat was seen empty, and the
   * previous حالة and حالة مسح are snapshotted so `endVacancy` can put them
   * back.
   *
   * ## What it refuses
   *
   * The two in `assertMayBeCalledEmpty`, plus a vacancy already standing — the
   * partial unique index in migration 0043 is the backstop for two officers
   * confirming the same flat at once, and this is the message for the ordinary
   * case of one officer pressing twice.
   *
   * A unit already marked `DEMOLISHED` is allowed through deliberately: a
   * demolished flat is empty, and refusing here would leave the only way to say
   * so blocked behind a status nobody is going to change back.
   */
  async confirmVacancy(
    unitId: string,
    input: ConfirmVacancyInput,
    actor: { id: string; role: string },
  ): Promise<{ vacancy: VacancyRow; unit: UnitRow; casesResolved: number }> {
    const unit = await this.db.unit.findUnique({ where: { id: unitId } });
    if (!unit) throw new NotFoundError('الوحدة غير موجودة');

    const standing = await activeVacancy(this.db, unitId);
    if (standing) {
      throw new ConflictError(
        `الوحدة ${unit.unitCode} مؤكَّد شغورها مسبقاً منذ ${standing.observedAt
          .toISOString()
          .slice(0, 10)}`,
      );
    }

    await this.assertMayBeCalledEmpty(unit);

    /*
      One transaction, because the row and the effect are one fact. A
      confirmation with the unit left unchanged would be a vacancy nothing bills
      on; a changed unit with no confirmation is the state this whole feature
      exists to get rid of.
    */
    const [vacancy, updated] = await this.atomic(async (tx) => {
      const created = await tx.unitVacancyConfirmation.create({
        data: {
          unitId,
          basis: input.basis as never,
          ...(input.observedAt ? { observedAt: input.observedAt } : {}),
          notes: input.notes?.trim() || null,
          confirmedById: actor.id,
          previousUnitStatus: unit.unitStatus,
          previousSurveyStatus: unit.surveyStatus,
        },
        include: {
          confirmedBy: { select: { firstName: true, lastName: true } },
          endedBy: { select: { firstName: true, lastName: true } },
        },
      });

      const unitRow = await tx.unit.update({
        where: { id: unitId },
        data: { unitStatus: 'VACANT', surveyStatus: 'VACANT_CONFIRMED' },
      });

      return [created, unitRow] as const;
    });

    /*
      A «شاغرة قيد التحقق» case is a question this answers.

      Only that type, and only on this exact unit: the other case types are
      about access, ownership or a note, and closing them here would silently
      clear somebody else's dispatch item — the specific way a case list stops
      being believed.
    */
    const casesResolved = await this.cases.resolveVacancyCasesForUnit(unitId, actor);

    this.record({
      action: 'UNIT_VACANCY_CONFIRMED',
      buildingId: unit.buildingId,
      before: { unitStatus: unit.unitStatus, surveyStatus: unit.surveyStatus },
      after: {
        unitCode: unit.unitCode,
        vacancyId: vacancy.id,
        basis: input.basis,
        observedAt: vacancy.observedAt,
        casesResolved,
      },
      actor,
    });

    return { vacancy: toVacancyRow(vacancy), unit: toUnitRow(updated), casesResolved };
  }

  /**
   * Lifts the vacancy standing on a unit — the undo, available at any time.
   *
   * ## Why it is always available
   *
   * The old action had no way back at all: an officer who confirmed the wrong
   * flat could only type a status in again and hope they remembered the right
   * one, and nothing recorded that the register had ever called it empty. A
   * finding that changes a bill has to be reversible by the people who make it,
   * or it gets worked around — and the workaround here was ending the owner's
   * spell, which erases a deed.
   *
   * ## What it restores, and what it refuses to touch
   *
   * `vacancyReversal` decides, and it only ever rewrites the two values the
   * confirmation itself wrote. A unit whose حالة has moved on since is left
   * alone: that is a newer statement about the flat, and an undo pressed a month
   * later has no business overruling it.
   *
   * The confirmation is closed, never deleted — including one «سُجِّل بالخطأ»,
   * which is kept for the reason an occupancy recorded in error is: the row is
   * evidence of what was entered and by whom. What it is *not* is history, so
   * the matrix hides it from the unit's timeline while the audit keeps it.
   */
  async endVacancy(
    unitId: string,
    input: EndVacancyInput,
    actor: { id: string; role: string },
  ): Promise<{ vacancy: VacancyRow; unit: UnitRow }> {
    const unit = await this.db.unit.findUnique({ where: { id: unitId } });
    if (!unit) throw new NotFoundError('الوحدة غير موجودة');

    const standing = await activeVacancy(this.db, unitId);
    if (!standing) {
      throw new ConflictError(`لا يوجد تأكيد شغور قائم على الوحدة ${unit.unitCode}`);
    }

    /*
      Refused rather than clamped, unlike `closeActiveVacancy`'s own guard: here
      a person typed the date, and a vacancy that ended before it was observed is
      something for them to correct, not for the server to quietly round.
    */
    if (input.endedAt && input.endedAt < standing.observedAt) {
      throw new ValidationError(
        `التاريخ قبل تاريخ تأكيد الشغور (${standing.observedAt.toISOString().slice(0, 10)})`,
        { endedAt: input.endedAt },
      );
    }

    const [vacancy, updated] = await this.db.$transaction(async (tx) => {
      const closed = await closeActiveVacancy(tx, {
        unitId,
        unit,
        reason: input.reason,
        endedAt: input.endedAt,
        notes: input.notes,
        actorId: actor.id,
      });
      // Nothing can have closed it in between — the read above and this write
      // are in the same request — but the helper is the only thing that knows
      // how, so its null is handled rather than asserted away.
      if (!closed) throw new ConflictError(`لا يوجد تأكيد شغور قائم على الوحدة ${unit.unitCode}`);

      const unitRow =
        Object.keys(closed.restore).length > 0
          ? await tx.unit.update({
              where: { id: unitId },
              data: {
                ...(closed.restore.unitStatus !== undefined
                  ? { unitStatus: closed.restore.unitStatus as never }
                  : {}),
                ...(closed.restore.surveyStatus !== undefined
                  ? { surveyStatus: closed.restore.surveyStatus as never }
                  : {}),
              },
            })
          : unit;

      const withNames = await tx.unitVacancyConfirmation.findUniqueOrThrow({
        where: { id: closed.confirmation!.id },
        include: {
          confirmedBy: { select: { firstName: true, lastName: true } },
          endedBy: { select: { firstName: true, lastName: true } },
        },
      });

      return [withNames, unitRow] as const;
    });

    this.record({
      action: 'UNIT_VACANCY_ENDED',
      buildingId: unit.buildingId,
      before: { unitStatus: unit.unitStatus, surveyStatus: unit.surveyStatus },
      after: {
        unitCode: unit.unitCode,
        vacancyId: vacancy.id,
        reason: input.reason,
        endedAt: vacancy.endedAt,
        unitStatus: updated.unitStatus,
        surveyStatus: updated.surveyStatus,
      },
      actor,
    });

    return { vacancy: toVacancyRow(vacancy), unit: toUnitRow(updated) };
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
      select: {
        id: true,
        buildingId: true,
        unitCode: true,
        unitType: true,
        unitStatus: true,
        surveyStatus: true,
        unitArea: true,
      },
    });
    if (!unit) throw new NotFoundError('الوحدة غير موجودة');

    const citizen = await this.db.user.findUnique({ where: { id: input.citizenId } });
    if (!citizen || citizen.kind !== 'CITIZEN') {
      throw new ValidationError('المواطن غير موجود', { citizenId: input.citizenId });
    }

    assertNonResidentOccupancy({
      residence: citizen.residence,
      role: input.role,
      unitType: unit.unitType,
      unitStatus: input.unitStatus,
      unitCode: unit.unitCode,
    });

    /*
      Linking somebody to a flat the municipality has confirmed empty.

      This is the other half of «تأكيد الشغور» being undoable: a unit found
      empty in March and let in June must be re-linkable without an officer
      first remembering to go and lift the vacancy, and without the register
      spending the interval saying both things at once. It used to say both —
      `recordOccupancy`'s حالة write is narrowed to `unitStatus: null`, so a
      tenant recorded on a «شاغرة» unit left the unit empty on paper, the owner
      exempt, and the matrix showing «تعارض».

      So it is asked rather than assumed. Without `endsVacancy` the refusal
      carries the confirmation with it, so the client can show *when* the flat
      was confirmed empty and on what basis before anyone overrides a finding
      somebody else recorded. With it, the vacancy is closed as «لم تعد شاغرة»
      in the same request.

      An owner is not asked: a deed is not residence (D2), and an owner on a
      شاغرة flat is the ordinary case. What an owner *says* about the flat can
      still contradict it — see `contradictsVacancy`.
    */
    const standing = await activeVacancy(this.db, input.unitId);
    if (standing && contradictsVacancy(input.role, input.unitStatus)) {
      if (!input.endsVacancy) {
        throw new ConflictError(
          `الوحدة ${unit.unitCode} مؤكَّد شغورها منذ ${standing.observedAt
            .toISOString()
            .slice(0, 10)}. تسجيل من يشغلها يُنهي تأكيد الشغور`,
          {
            vacancy: {
              id: standing.id,
              basis: standing.basis,
              observedAt: standing.observedAt,
              notes: standing.notes,
            },
          },
        );
      }

      /*
        Closed before the writes below rather than after, so they see the unit
        the reversal leaves: the survey lift reads `PARTIAL` as still open and
        carries it to «مكتملة», and the حالة write finds the null it needs to
        fill with «مؤجرة» or «مشغولة بتسامح».
      */
      const closed = await closeActiveVacancy(this.db, {
        unitId: input.unitId,
        unit,
        reason: 'NO_LONGER_VACANT',
        actorId: actor.id,
      });
      if (closed) {
        await this.db.unit.update({
          where: { id: input.unitId },
          data: {
            ...(closed.restore.unitStatus !== undefined
              ? { unitStatus: closed.restore.unitStatus as never }
              : {}),
            ...(closed.restore.surveyStatus !== undefined
              ? { surveyStatus: closed.restore.surveyStatus as never }
              : {}),
          },
        });
        this.record({
          action: 'UNIT_VACANCY_ENDED',
          buildingId: unit.buildingId,
          before: { unitStatus: unit.unitStatus, surveyStatus: unit.surveyStatus },
          after: {
            unitCode: unit.unitCode,
            vacancyId: closed.confirmation!.id,
            reason: 'NO_LONGER_VACANT',
            citizenId: input.citizenId,
            via: 'OCCUPANCY',
          },
          actor,
        });
      }
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
          include: { citizen: { select: { firstName: true, lastName: true, phone: true } } },
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
          include: { citizen: { select: { firstName: true, lastName: true, phone: true } } },
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

    /*
      مساحة الوحدة, filled in from the doorstep — and only where it is missing.

      The gap this closes: `generateUnits` and the grid painter both create
      flats with no area, because they assert that a flat exists rather than
      that anyone has measured it. Recording an occupant was the first moment
      somebody had actually been inside, and the form had nowhere to put the
      number — so `claimOnFile` below minted the citizen's property card from a
      unit with `unitArea` null, billing could not price a PER_AREA notice
      against it, and the edit form rendered the absence as «0».

      Narrowed to `unitArea: null` for the same reason the survey-status lift
      and the implied حالة are narrowed: only "nobody established this" may be
      answered by a side effect of recording who lives here. A flat the census
      has already measured keeps its measurement — correcting a surveyed area is
      the unit editor's job, and silently overwriting it while filing a tenant
      would be a change nobody asked for and nobody would see.

      Written before `claimOnFile` so the card it mints copies the new area
      rather than the null it replaced.
    */
    if (input.unitArea !== undefined) {
      await this.db.unit.updateMany({
        where: { id: input.unitId, unitArea: null },
        data: { unitArea: input.unitArea },
      });
    }

    const casesResolved = await this.cases.resolveForUnit(input.unitId, input.citizenId, actor);

    const landlord: LandlordSpec | null =
      input.role === 'OWNER'
        ? null
        : {
            citizenId: input.landlordCitizenId ?? null,
            name: input.landlordName ?? null,
            phone: input.landlordPhone ?? null,
          };

    const fileLink = await this.claimOnFile({
      unitId: input.unitId,
      buildingId: unit.buildingId,
      citizenId: input.citizenId,
      role: input.role,
      shares: input.shares ?? null,
      unitStatus: input.unitStatus ?? impliedStatus ?? null,
      landlord,
    });

    this.record({
      action: 'OCCUPANCY_RECORDED',
      buildingId: unit.buildingId,
      after: {
        unitCode: unit.unitCode,
        citizenId: input.citizenId,
        role: input.role,
        unitStatus: input.unitStatus ?? null,
        ...(input.landlordCitizenId ? { landlordCitizenId: input.landlordCitizenId } : {}),
        /*
          Logged only where it was actually written — i.e. where the unit had
          no area and this request supplied one. An audit row saying an area
          was recorded when the update matched nothing would be a lie about the
          one field on this form that decides a PER_AREA bill.
        */
        ...(input.unitArea !== undefined && unit.unitArea == null
          ? { unitArea: input.unitArea }
          : {}),
        // «لم تُقَس» with its reason — only where the unit really has no area.
        ...(input.unitArea === undefined && unit.unitArea == null && input.unitAreaMissingReason
          ? { unitAreaNotMeasured: input.unitAreaMissingReason }
          : {}),
        // «لم يُعرف من يشغلها» with its reason — an owner with no answer given.
        ...(input.role === 'OWNER' && !input.unitStatus && input.unitStatusMissingReason
          ? { unitStatusNotEstablished: input.unitStatusMissingReason }
          : {}),
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
   *
   * ## One card per capacity, and one tenancy card per owner
   *
   * A card's rows are billed in the card's own نوع الإشغال, and a tenancy card
   * names one owner. So a flat goes onto an existing card only when both agree:
   * the same capacity, and — for a مستأجر or شاغل بتسامح — the same owner
   * (`holdsFrom`). Otherwise a new card is minted.
   *
   * This used to take the first card on the building whatever it said: a flat
   * rented from one owner was ticked onto the tenancy card of another, and a
   * flat somebody owns onto their own مستأجر card. Somebody renting a shop from
   * one owner and the flat above it from another is ordinary, and each tenancy
   * has to be able to name its own owner and end on its own.
   */
  /**
   * `claimOnFile` for a spell that already exists.
   *
   * The owner-link path's door onto the same rules. When the owner is already
   * recorded on a flat — the matrix put them there, or an earlier link did —
   * re-running `recordOccupancy` would rewrite that spell (its أسهم are reset
   * from the input), so the link records nothing on the census and asks only
   * that the file back what the census already says.
   */
  ensureOnFile(input: {
    unitId: string;
    buildingId: string;
    citizenId: string;
    role: string;
    shares: number | null;
    unitStatus: string | null;
    landlord?: LandlordSpec | null;
  }): Promise<FileLinkResult> {
    return this.claimOnFile(input);
  }

  private async claimOnFile(input: {
    unitId: string;
    buildingId: string;
    citizenId: string;
    role: string;
    shares: number | null;
    unitStatus: string | null;
    /** Non-owner capacities only: who the flat is held from. */
    landlord?: LandlordSpec | null;
  }): Promise<FileLinkResult> {
    /*
      Five reads with nothing to say to each other, issued together.

      They used to be five round-trips in a row on a path that runs once per tap
      on the matrix and once per flat on an owner link — a link over a
      twelve-flat block paid for sixty. Two of them can still end the call and
      the other three are reads, so nothing is wasted by having asked.
    */
    const [building, registration, unitsInBuilding, cards, spellsHere] = await Promise.all([
      this.db.building.findUnique({
        where: { id: input.buildingId },
        select: { id: true, parcelNumber: true, name: true, structureType: true },
      }),
      /*
        The citizen’s current file *is* their latest registration — the convention
        `CitizensService.update` and `declareOwnership` both follow. A citizen with
        none cannot receive a card, which is barely reachable through the register
        (a citizen exists because a registration created them) but is refused
        rather than assumed.
      */
      this.db.registration.findFirst({
        where: { citizenId: input.citizenId },
        orderBy: { submittedAt: 'desc' },
        select: { id: true },
      }),
      this.db.unit.count({ where: { buildingId: input.buildingId } }),
      /*
        Current cards only. An ended tenancy is the citizen's history on this
        structure, not a card to tick a new flat onto — somebody who rented here,
        left, and now owns a flat gets a card saying so, not a row on the old lease.
      */
      this.db.propertyEntry.findMany({
        where: {
          buildingId: input.buildingId,
          endedAt: null,
          registration: { citizenId: input.citizenId },
        },
        select: {
          id: true,
          propertyType: true,
          occupancyType: true,
          landlordCitizenId: true,
          landlordPhone: true,
          landlordLinkDismissedIds: true,
          units: { where: { endedAt: null }, select: { id: true, unitId: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      /*
        What the census says this citizen holds in this structure — the only
        thing a card that names no flat can be read against. See `claimsFlat`.
      */
      this.db.unitOccupancy.findMany({
        where: { citizenId: input.citizenId, toDate: null, unit: { buildingId: input.buildingId } },
        select: { unitId: true, role: true },
      }),
    ]);
    if (!building) return { backed: false, outcome: 'NO_BUILDING' };
    if (!registration) return { backed: false, outcome: 'NO_FILE' };

    /*
      Already ticked, or already backed by one of the shapes that claim a flat
      without naming it. Nothing to write, and nothing to warn about either.

      `claimsFlat` is shared with every other reader of the same question — the
      matrix's owner-link column, the tenancy card an owner link attaches to,
      the card «إنهاء الإيجار» ends a row on — because a claim this path makes
      and those paths cannot see is a card that bills a flat nothing can end,
      correct or unlink.
    */
    const holder = cardClaiming(cards, spellsHere, input.unitId, input.role);
    if (holder) {
      return { backed: true, outcome: 'ALREADY_CLAIMED', propertyEntryId: holder.id };
    }

    const nonOwner = input.role !== 'OWNER';
    const owner =
      nonOwner && input.landlord?.citizenId
        ? await this.db.user.findUnique({
            where: { id: input.landlord.citizenId },
            select: {
              id: true,
              firstName: true,
              middleName: true,
              lastName: true,
              phone: true,
              whatsapp: true,
            },
          })
        : null;

    /*
      The card this flat may join: same capacity — rows bill in the card's نوع
      الإشغال — and for a non-owner, the same owner. See the docblock.

      And one that can take a row without losing what it already bills:
      `takesAnotherFlat` passes over a card that bills from its own columns, for
      the reason it gives. The flat gets a card of its own below, and both are
      billed.
    */
    const sameCapacity = cards.filter(
      (card) => card.occupancyType === input.role && takesAnotherFlat(card),
    );
    const existing = nonOwner
      ? await this.cardHeldFrom(sameCapacity, input.landlord ?? null, owner)
      : sameCapacity[0];

    if (existing) {
      /*
        An itemised card that has not ticked this flat.

        The tick is added rather than withheld — see the docblock. A card
        already listing flats 1, 2 and 4 does not stop consuming the occupancy
        list by gaining flat 3; it stopped the moment it listed anything, so a
        row here is the only way this occupancy can be backed at all.

        Only a card that already itemises reaches here — `takesAnotherFlat`
        above — so the tick can never be the row that stops a card billing its
        own columns.
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

      return { backed: true, outcome: 'UNIT_ADDED', propertyEntryId: existing.id };
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
      نوع العقار is decided by the census, not by the structure type alone.

      `STRUCTURE_TYPE_MAP` calls a منزل مستقل a HOUSE, and that is right for a
      structure holding one flat: the card bills that flat from its own columns
      and needs no units array. Where the matrix holds several — an officer who
      found the منزل had been built up, Z-5-201-A — such a card cannot say
      *which* of them it is about, and there is no honest way to make it say so:
      a HOUSE card is forbidden a units array by `PropertyEntry` («a house
      cannot be divided into units»), the منزل branch of `propertyEntrySchema`
      has no such field for a form to round-trip, and a row written past both is
      deleted by the first save of the citizen's file. So the flat is filed as a
      مبنى card naming it — the shape every reader of a claim already
      understands, and the honest one: several units are standing there.
    */
    const cardType = mapped.propertyType === 'HOUSE' && unitsInBuilding === 1 ? 'HOUSE' : 'BUILDING';

    /*
      نوع الإشغال is the officer’s answer, carried straight across.

      `OccupancyRole` and `OccupancyType` are the same three values by design —
      مالك, مستأجر, شاغل بتسامح — because they are one question asked of the unit
      and of the card. This is the half that decides whether the register tells
      the truth about what it just recorded: a مستأجر named on the matrix now
      files a tenant’s card, not an owner’s, and a شاغل بتسامح files neither a
      tenancy that does not exist nor an ownership they do not have.
    */
    const minted = await this.db.propertyEntry.create({
      select: { id: true },
      data: {
        registrationId: registration.id,
        occupancyType: input.role as never,
        propertyType: cardType as never,
        buildingId: building.id,
        // The parcel is the building’s own. الحي is left null rather than
        // guessed: the cadastre has no neighbourhood layer to ask, and this
        // path has no second card to copy one from the way `declareOwnership`
        // does.
        propertyNumber: building.parcelNumber || null,
        buildingName: building.name,
        /*
          Who the flat is held from, on the tenancy card that exists for it.

          A registered owner's own name and number: a tenancy card needs both to
          pass the form it is edited in, and the number is what an owner link is
          kept against. The link itself (`landlordCitizenId`) is written by the
          owner-link service with the rest of what it records, not here.
        */
        ...(nonOwner && owner
          ? {
              landlordName: personName(owner),
              landlordPhone: owner.phone ?? owner.whatsapp ?? null,
            }
          : nonOwner && (input.landlord?.name || input.landlord?.phone)
            ? {
                landlordName: input.landlord.name ?? null,
                landlordPhone: input.landlord.phone ?? null,
              }
            : {}),
        /*
          A منزل bills its single unit from its own columns and has no units
          array to tick, so the description and the حالة go on the card itself.

          A مبنى carries a unit row instead — and carries one rather than none
          deliberately. An empty مبنى card claims *every* flat this citizen
          occupies in the block through `heldThroughOccupancy`, which is the right
          claim for a landlord whose holding nobody has enumerated and the wrong
          one for an officer who has just named a single flat.
        */
        ...(cardType === 'HOUSE'
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

    return { backed: true, outcome: 'ENTRY_CREATED', propertyEntryId: minted.id };
  }

  /**
   * The tenant's card, among `cards` (one capacity, oldest first), that holds
   * its flats from this landlord — or none, and a new card is minted.
   *
   *  - **A registered owner**: the card already linked to them, or a card not
   *    linked to anyone whose typed number is theirs (a number somebody said
   *    «لا أحد منهم» to on this card does not count). A card whose flats are
   *    recorded as owned by somebody else is never theirs, whatever it says.
   *  - **A typed number**: an unlinked card naming that same number.
   *  - **Nothing known**: no card. Two flats whose owners nobody has named are
   *    not known to share one, and filing them together would give both the
   *    first owner anyone identifies.
   */
  private async cardHeldFrom<
    T extends {
      id: string;
      landlordCitizenId: string | null;
      landlordPhone: string | null;
      landlordLinkDismissedIds: string[];
      units: Array<{ unitId: string | null }>;
    },
  >(
    cards: readonly T[],
    landlord: LandlordSpec | null,
    owner: { id: string; phone: string | null; whatsapp: string | null } | null,
  ): Promise<T | undefined> {
    if (owner) {
      const linked = cards.find((card) => card.landlordCitizenId === owner.id);
      if (linked) return linked;

      const numbers = [owner.phone, owner.whatsapp].filter(Boolean);
      const typed = cards.filter(
        (card) =>
          !card.landlordCitizenId &&
          card.landlordPhone !== null &&
          numbers.includes(card.landlordPhone) &&
          !card.landlordLinkDismissedIds.includes(owner.id),
      );
      if (typed.length === 0) return undefined;

      const unitIds = [
        ...new Set(
          typed.flatMap((card) =>
            card.units.map((row) => row.unitId).filter((id): id is string => Boolean(id)),
          ),
        ),
      ];
      const otherOwners = unitIds.length
        ? await this.db.unitOccupancy.findMany({
            where: {
              unitId: { in: unitIds },
              toDate: null,
              role: 'OWNER' as never,
              citizenId: { not: owner.id },
            },
            select: { unitId: true },
          })
        : [];
      const ownedElsewhere = new Set(otherOwners.map((row) => row.unitId));
      return typed.find((card) =>
        card.units.every((row) => !row.unitId || !ownedElsewhere.has(row.unitId)),
      );
    }

    const phone = landlord?.phone ?? null;
    if (phone) {
      return cards.find((card) => !card.landlordCitizenId && card.landlordPhone === phone);
    }
    return undefined;
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
      include: { citizen: { select: { firstName: true, lastName: true, phone: true } } },
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
        // An ended row keeps naming its flat on purpose — it is the record of
        // which flat the tenancy was. Only a current claim is released.
        endedAt: null,
        propertyEntry: { endedAt: null, registration: { citizenId: input.citizenId } },
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
        endedAt: null,
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
  ): Promise<{ visit: VisitRow; visitCount: number; vacancyStands: boolean }> {
    const unit = await this.db.unit.findUnique({
      where: { id: input.unitId },
      select: { id: true, buildingId: true, unitCode: true, surveyStatus: true },
    });
    if (!unit) throw new NotFoundError('الوحدة غير موجودة');

    /*
      The same officer, the same door, the same day, the same finding: asked,
      not refused.

      Each part rules out an ordinary sequence. Logged by this officer in the
      last twelve hours, so a colleague's knock is not it. Dated within a day
      of this one, so three back-dated paper visits a week apart are not it.
      The same outcome, so «لا يوجد رد» in the morning and «مكتملة» in the
      evening — a real second finding — is not it. What is left is the double
      submit of one knock: 2026-09-15, one closed shop, «مغلق» twice, a case
      each time.
    */
    if (!input.acknowledgedRepeat) {
      const claimedAt = (input.visitedAt ?? new Date()).getTime();
      const recent = (
        await this.db.unitVisit.findMany({
          where: {
            unitId: input.unitId,
            officerId: actor.id,
            outcome: input.outcome as never,
            createdAt: { gte: new Date(Date.now() - REPEAT_VISIT_WINDOW_MS) },
          },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, visitedAt: true, outcome: true },
        })
      ).find((visit) => Math.abs(visit.visitedAt.getTime() - claimedAt) < SAME_VISIT_DAY_MS);
      if (recent) {
        const minutesAgo = Math.max(0, Math.round((Date.now() - recent.createdAt.getTime()) / 60_000));
        throw new ConflictError(
          `سجَّلتَ زيارة بالنتيجة نفسها لهذه الوحدة قبل ${
            minutesAgo === 1
              ? 'دقيقة واحدة'
              : minutesAgo === 2
                ? 'دقيقتين'
                : minutesAgo >= 3 && minutesAgo <= 10
                  ? `${minutesAgo} دقائق`
                  : `${minutesAgo} دقيقة`
          }. إن كانت هذه محاولة جديدة فأكِّد ذلك قبل التسجيل.`,
          {
            repeatVisit: {
              unitId: input.unitId,
              loggedAt: recent.createdAt.toISOString(),
              outcome: recent.outcome,
              minutesAgo,
            },
          },
        );
      }
    }

    /*
      A visit to a flat whose vacancy is standing is logged, and leaves the
      finding alone.

      The status is otherwise *set* by the outcome, which is right for a finding
      an officer states directly — but a confirmed vacancy is a finding too, and
      one with a record behind it and an exemption resting on it. Letting an
      ordinary «زيارة بلا رد» walk the unit out of `VACANT_CONFIRMED` would
      leave the confirmation standing with the unit no longer reading as empty:
      the register saying two things, which is what the confirmation table was
      added to stop. A locked door on an empty flat is also not news.

      The visit itself is always recorded — it happened, and D10's count is what
      dispatch reads — and the caller is told the vacancy still stands so the
      officer can lift it if what they found says otherwise.
    */
    const standing = await activeVacancy(this.db, input.unitId);

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

      if (!standing) {
        await tx.unit.update({
          where: { id: input.unitId },
          data: { surveyStatus: input.outcome as never },
        });
      }

      return [created, await tx.unitVisit.count({ where: { unitId: input.unitId } })] as const;
    });

    this.record({
      action: 'UNIT_VISIT_LOGGED',
      buildingId: unit.buildingId,
      before: { surveyStatus: unit.surveyStatus },
      after: {
        unitCode: unit.unitCode,
        outcome: input.outcome,
        attempts: visitCount,
        // Named in the audit row because the outcome and the unit's status
        // disagree in this case, and the reason has to be readable later.
        ...(standing ? { vacancyStands: true } : {}),
        ...(input.acknowledgedRepeat ? { acknowledgedRepeat: true } : {}),
      },
      actor,
    });

    return { visit: toVisitRow(visit), visitCount, vacancyStands: standing !== null };
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
/**
 * How recently this officer's own visit to a unit makes another one worth a
 * question. Twelve hours covers one working day's morning-and-evening retry,
 * which is still allowed — it is only asked.
 */
const REPEAT_VISIT_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * How close two visits' own dates must be to read as one knock. A day, because
 * the form sends a date without a time, so a visit dated "today" is midnight.
 */
const SAME_VISIT_DAY_MS = 24 * 60 * 60 * 1000;

/** The building columns `update` can write — what its audit row compares. */
const AUDITED_BUILDING_FIELDS = [
  'name',
  'postedNumber',
  'isPartitioned',
  'partitionNumbers',
  'sharedParcelNumbers',
  'structureType',
  'lifecycleStatus',
  'latitude',
  'longitude',
  'floorsCount',
  'basementsCount',
  'notes',
] as const;

type AuditedBuilding = { [K in (typeof AUDITED_BUILDING_FIELDS)[number]]: unknown };

/**
 * The fields that differ between two versions of a building, each side keyed
 * by field. Arrays compare by content, so re-saving the same أقسام in the same
 * order is not a change. Exported for its spec.
 */
export function changedBuildingFields(
  before: AuditedBuilding,
  after: AuditedBuilding,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const changed = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
  for (const field of AUDITED_BUILDING_FIELDS) {
    if (JSON.stringify(before[field] ?? null) === JSON.stringify(after[field] ?? null)) continue;
    changed.before[field] = before[field] ?? null;
    changed.after[field] = after[field] ?? null;
  }
  return changed;
}

/**
 * Measured rows nearest first; unmeasured rows after them, in the order given.
 *
 * Exported for its spec. Stable by construction (the original index breaks
 * every tie), so a parcel whose buildings have no pins reads exactly as it did
 * before distances were sorted on.
 */
export function sortByDistance<T extends { distanceMetres: number | null }>(
  rows: readonly T[],
): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const da = a.row.distanceMetres;
      const db = b.row.distanceMetres;
      if (da != null && db != null) return da - db || a.index - b.index;
      if (da != null) return -1;
      if (db != null) return 1;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

export function metresBetween(
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
  isPartitioned: boolean | null;
  partitionNumbers: string[];
  sharedParcelNumbers: string[];
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
    isPartitioned: row.isPartitioned,
    partitionNumbers: row.partitionNumbers,
    sharedParcelNumbers: row.sharedParcelNumbers,
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

/**
 * The matrix's half of the rule the registration schema applies to a
 * non-resident's cards («غير مقيم في البلدة» — see `nonResidentCardIssues`).
 *
 * Both doors must refuse the same thing or the matrix becomes the way round
 * the form: an officer who could not file a non-resident as the tenant of a
 * شقة on the registration form could record exactly that from the unit panel,
 * and `claimOnFile` would then mint the very card the form refused.
 *
 *  - a مستأجر or شاغل بتسامح of a dwelling lives in it — a household, not a
 *    non-resident;
 *  - an owner who lives elsewhere cannot answer «مشغولة من المالك» for a
 *    dwelling — «مسكن موسمي» or «شاغرة» is the true answer.
 *
 * A محل، مكتب، عيادة or مستودع is open to either capacity. Exported for its spec.
 */
export function assertNonResidentOccupancy(input: {
  residence: string | null | undefined;
  role: string;
  unitType: string;
  unitStatus?: string | null;
  unitCode: string;
}): void {
  if (input.residence !== 'NON_RESIDENT_OWNER' || !isDwellingUnitType(input.unitType)) return;

  if (input.role !== 'OWNER') {
    throw new ValidationError(
      `الوحدة ${input.unitCode} مسكن، وغير المقيم لا يُسجَّل مستأجراً أو شاغلاً لمسكن. من يستأجر مسكناً ويسكنه يُسجَّل بملف أسرة، وإن كانت الوحدة تُستعمل لغير السكن فصحّح نوعها`,
      { role: input.role, unitType: input.unitType },
    );
  }

  if (input.unitStatus === 'OWNER_OCCUPIED') {
    throw new ValidationError(
      `غير المقيم لا يسكن الوحدة ${input.unitCode} — اختر «مسكن موسمي» إن كان يحضر في مواسم، أو «شاغرة»`,
      { unitStatus: input.unitStatus },
    );
  }
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
    citizen?: { firstName: string; lastName: string; phone?: string | null } | null;
    role: string;
    shares: number | null;
    fromDate: Date;
    toDate: Date | null;
    endReason?: string | null;
    registrationId: string | null;
    createdAt: Date;
  },
  /**
   * Defaults to `true` so the write paths — which return the row they just
   * wrote, not a survey of the register — do not have to answer a question
   * they were not asked. Only `get` passes it, and only `get` has the two
   * queries in hand to answer it honestly. See `OccupancyRow.backedByFile`.
   */
  backedByFile = true,
  ownerLink: OccupancyOwnerLink | null = null,
): OccupancyRow {
  return {
    id: row.id,
    unitId: row.unitId,
    citizenId: row.citizenId,
    citizenName: row.citizen ? `${row.citizen.firstName} ${row.citizen.lastName}` : null,
    citizenPhone: row.citizen?.phone ?? null,
    role: row.role,
    shares: row.shares,
    fromDate: row.fromDate,
    toDate: row.toDate,
    endReason: row.endReason ?? null,
    registrationId: row.registrationId,
    backedByFile,
    recordedAt: row.createdAt,
    ownerLink,
  };
}

function personName(person: { firstName: string; middleName?: string | null; lastName: string }): string {
  return [person.firstName, person.middleName, person.lastName].filter(Boolean).join(' ').trim();
}

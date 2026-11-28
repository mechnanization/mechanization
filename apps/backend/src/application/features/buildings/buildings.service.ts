import { calendarDayOf, citizenDisplayName } from '@mechanization/shared-schemas';
import { Injectable, Logger } from '@nestjs/common';
import { isNonPersonRecord, isOwnerRecord } from '@mechanization/shared-schemas';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  formatBuildingCode,
  formatUnitCode,
  isOccupiableLifecycle,
  nextBuildingSuffix,
  OCCUPIABLE_LIFECYCLE,
  STRUCTURE_TYPE_MAP,
  getLabels,
  isDwellingUnitType,
  isStructuralUnitType,
  feeBearerClass,
  unitTopFloor,
  SURVEYED_STATUS,
  type CreateBuildingInput,
  type StructureType,
  type UpdateBuildingInput,
  type WorklistQuery,
  type ReinspectionsPage,
  IMPAIRED_DAMAGE_LEVELS,
} from '@mechanization/shared-schemas';
import { worklistOwner, type WorklistViewer } from '../../common/worklist-viewer';
import { reinspections, unsurveyedUnits } from './census-worklists';
import { assertNoFeeExemptionHistory } from './fee-exemption';
import { resolveBuildingType } from './building-types';
import { buildingSuffixLockKey } from './suffix-lock-key';
import { loadUnitTypes } from './unit-types';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { withConnectionRetry } from '../../../infrastructure/prisma/with-connection-retry';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { cardClaiming } from '../../../domain/entities/census-claim';
import type {
  BuildingLedgerRow,
  BuildingListFilter,
  BuildingMapPin,
  BuildingRow,
  CensusSummary,
  OccupancyOwnerLink,
  OccupancyRow,
  UnitRow,
  UnsurveyedUnitRow,
  VacancyRow,
  VisitRow,
} from './building.types';
import { toVacancyRow } from './unit-vacancy';
import { settleUnit, unitsUnderReview } from './unit-status';
import { BUILDINGS_PAGE_DEFAULT, BUILDINGS_PAGE_MAX } from '@mechanization/shared-schemas';
import { StaffActor } from '../../common/actor';

/** What a whole-matrix save did — or, on a dry run, would do. */
export interface MatrixSaveResult {
  dryRun: boolean;
  building: BuildingRow;
  /** Unit codes, as they were before the save. */
  removed: string[];
  /** Unit codes after the save — a moved unit's new code. */
  updated: string[];
  added: string[];
}

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

/**
 * A building with its units, as the matrix drawer reads it.
 */
export interface BuildingDetail extends BuildingRow {
  /** The zone this building's parcel belongs to, resolved at read time (D13). */
  zoneCode: string | null;
  zoneName: string | null;
  /**
   * Codes this building carried before «تصحيح رقم العقار», newest first. Still
   * found by search and never given to another building — see
   * `BuildingCodeAlias`.
   */
  previousCodes: Array<{ code: string; parcelNumber: string; reason: string; retiredAt: string }>;
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
    private readonly events: EventEmitter2,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  record(input: {
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
      | 'UNIT_VACANCY_ENDED'
      /*
        «هذا المنزل يصبح مبنى» (D28): the «منزل» cards on a structure that got
        a second unit, made «مبنى» cards naming the house's unit. Each card's
        holder gets a CITIZEN_UPDATED row of their own as well.
      */
      | 'HOUSE_CARDS_PROMOTED';
    buildingId: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    actor: StaffActor;
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

  /**
   * «حالة الوحدة» brought back in line with who is recorded in the flat, and the
   * unit's «تعارض» case with it — see `settleUnit`. Called last by every action
   * here that changes who is in a flat or what anyone says about it.
   */
  async settle(
    unitId: string,
    actor: StaffActor,
    via: string,
  ): Promise<{ statusChanged: boolean }> {
    const outcome = await settleUnit(this.db, {
      unitId,
      tenantSlug: this.tenantContext.tenantSlug,
      actor,
      via,
    });
    for (const event of outcome?.events ?? []) this.events.emit(event.channel, event.payload);
    return { statusChanged: Boolean(outcome && outcome.before !== outcome.after) };
  }

  /**
   * «مراجعة حالة الوحدات» — the rule applied to every flat that needs it, once.
   *
   * Every write path settles the flat it touches from now on, but the flats
   * nobody touches keep whatever the old paths left: on 2026-09-30 that was 23
   * flats marked «مؤجرة» with no tenant anywhere, and a seasonal home billed
   * to its owner and its tenant both. Billing already holds them (it reads the
   * rule, not the stored status); this writes the settled status and opens the
   * «تعارض في حالة الوحدة» case on each, so an officer has something to act on,
   * and closes cases whose disagreement is gone. Safe to run again: a settled
   * flat is left alone.
   */
  async settleAllUnits(actor: StaffActor): Promise<{
    unitsChecked: number;
    statusesChanged: number;
    casesOpened: number;
    casesResolved: number;
    stillUnderReview: number;
  }> {
    const held = await unitsUnderReview(this.db);
    const withCases = await this.db.case.findMany({
      where: {
        caseType: 'STATUS_CONFLICT' as never,
        status: { in: ['OPEN', 'SCHEDULED'] as never },
        unitId: { not: null },
      },
      select: { unitId: true },
    });
    const unitIds = new Set<string>([...held.keys(), ...withCases.map((row) => row.unitId!)]);

    let statusesChanged = 0;
    let casesOpened = 0;
    let casesResolved = 0;
    for (const unitId of unitIds) {
      const outcome = await settleUnit(this.db, {
        unitId,
        tenantSlug: this.tenantContext.tenantSlug,
        actor,
        via: 'STATUS_REVIEW',
      });
      if (!outcome) continue;
      if (outcome.before !== outcome.after) statusesChanged += 1;
      if (outcome.caseOpened) casesOpened += 1;
      casesResolved += outcome.casesResolved;
      for (const event of outcome.events) this.events.emit(event.channel, event.payload);
    }

    const after = await unitsUnderReview(this.db);
    return {
      unitsChecked: unitIds.size,
      statusesChanged,
      casesOpened,
      casesResolved,
      stillUnderReview: after.size,
    };
  }

  // ───────────────────────────────  Reads  ───────────────────────────────

  /**
   * «وحدات غير ممسوحة» — see `unsurveyedUnits` in `census-worklists.ts`.
   * Two plain reads, not a transaction: a worklist is read-only, and a door
   * recorded between the page and its count moves one number by one.
   */
  async unsurveyedUnits(
    query: WorklistQuery,
    viewer?: WorklistViewer,
  ): Promise<{ items: UnsurveyedUnitRow[]; total: number }> {
    return withConnectionRetry(() => unsurveyedUnits(this.db, this.S, query, viewer));
  }

  /**
   * «بانتظار إعادة الكشف» — see `reinspections` in `census-worklists.ts`.
   * `seesAll` tells the screen whether it is showing everyone's readings.
   */
  async reinspections(query: WorklistQuery, viewer?: WorklistViewer): Promise<ReinspectionsPage> {
    const page = await withConnectionRetry(() => reinspections(this.db, this.S, query, viewer));
    return { ...page, seesAll: worklistOwner(viewer) === null };
  }

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
  ): Promise<{
    buildings: BuildingLedgerRow[];
    total: number;
    summary: CensusSummary;
    /**
     * With a `parcelNumber` filter only: the suffixes «تصحيح رقم العقار»
     * retired on that parcel, so the editor's predicted code for a new
     * building skips them exactly as `create` does.
     */
    retiredSuffixes?: string[];
  }> {
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
        take: Math.min(filter.limit ?? BUILDINGS_PAGE_DEFAULT, BUILDINGS_PAGE_MAX),
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
    const damaged = await this.countAtDamageLevels(where, IMPAIRED_DAMAGE_LEVELS);
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
    const retired = filter.parcelNumber
      ? await withConnectionRetry(() =>
          this.db.buildingCodeAlias.findMany({
            where: { parcelNumber: filter.parcelNumber!.trim() },
            select: { codeSuffix: true },
          }),
        )
      : null;
    // Which rows the search found by a retired code rather than their own.
    const matchedAliases =
      filter.search?.trim() && ids.length > 0
        ? await withConnectionRetry(() =>
            this.db.buildingCodeAlias.findMany({
              where: {
                buildingId: { in: ids },
                code: { contains: filter.search!.trim(), mode: 'insensitive' },
              },
              orderBy: { retiredAt: 'desc' },
              select: { buildingId: true, code: true },
            }),
          )
        : [];
    const matchedAlias = new Map<string, string>();
    for (const alias of matchedAliases) {
      if (alias.buildingId && !matchedAlias.has(alias.buildingId)) matchedAlias.set(alias.buildingId, alias.code);
    }

    return {
      ...(retired ? { retiredSuffixes: retired.map((row) => row.codeSuffix) } : {}),
      buildings: rows.map((row) => {
        const zone = zoneOf.get(row.parcelNumber);
        const previous = matchedAlias.get(row.id);
        return {
          ...toBuildingRow(row),
          zoneCode: zone?.code ?? null,
          zoneName: zone?.name ?? null,
          damageLevel: damageOf.get(row.id) ?? null,
          // Only when the term did not match the live code itself.
          ...(previous && !row.code.toLowerCase().includes(filter.search!.trim().toLowerCase())
            ? { matchedPreviousCode: previous }
            : {}),
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
    /** The types buildings are filed under (0106); the names come from `GET building-types`. */
    buildingTypeIds: string[];
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
    const types = await withConnectionRetry(() =>
      this.db.building.groupBy({ by: ['buildingTypeId'], where: { buildingTypeId: { not: null } } }),
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
      buildingTypeIds: types.map((row) => row.buildingTypeId).filter((id): id is string => id !== null),
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
    if (filter.buildingTypeId) where.buildingTypeId = filter.buildingTypeId;
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
        // A code retired by «تصحيح رقم العقار» still finds its building: it is on
        // paper forms and receipts that outlive the correction.
        { codeAliases: { some: { code: match } } },
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
                include: { citizen: { select: { firstName: true, lastName: true, phone: true, isActive: true, residence: true } } },
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
              // Who granted «معفاة من الرسوم», shown beside it.
              feeExemptedBy: { select: { firstName: true, lastName: true } },
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
    const previousCodes = await withConnectionRetry(() =>
      this.db.buildingCodeAlias.findMany({
        where: { buildingId: row.id },
        orderBy: { retiredAt: 'desc' },
        select: { code: true, parcelNumber: true, reason: true, retiredAt: true },
      }),
    );

    return {
      ...toBuildingRow(row),
      zoneCode: zone?.code ?? null,
      zoneName: zone?.name ?? null,
      previousCodes: previousCodes.map((alias) => ({ ...alias, retiredAt: alias.retiredAt.toISOString() })),
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
        landlordCitizen: { select: { firstName: true, middleName: true, lastName: true, residence: true } },
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
    actor: StaffActor,
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

    // «نوع المبنى» (0106): the type decides the structure; refused here, before the transaction, if inactive.
    const typed = (await resolveBuildingType(this.db, input, null))!;
    // «نوع الوحدة» (0109): each inline unit's type decides its `unitType`; refused here too if inactive.
    const unitTypes = input.units?.length ? await loadUnitTypes(this.db) : null;

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

    const created = await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      /*
        The lock key names the schema explicitly, for the same reason the query
        above does (`buildingSuffixLockKey` says why); without it the suffix
        race §4.4 exists to prevent would be back.
      */
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${buildingSuffixLockKey(this.tenantContext.schemaName, parcelNumber)}))`;

      const codeSuffix = nextBuildingSuffix(await this.suffixesInUse(tx, parcelNumber));
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
          structureType: typed.structureType as never,
          buildingTypeId: typed.buildingTypeId,
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
            const unitTyped = unitTypes!.resolve(unit, null)!;

            return {
              ...(unit.id ? { id: unit.id } : {}),
              buildingId: building.id,
              floor: unit.floor,
              sequence: next,
              startCol: unit.startCol ?? null,
              endCol: unit.endCol ?? null,
              unitCode: formatUnitCode(unit.floor, next),
              unitType: unitTyped.unitType as never,
              unitTypeId: unitTyped.unitTypeId,
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
    actor: StaffActor,
  ): Promise<BuildingRow> {
    const before = await this.db.building.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('المبنى غير موجود');

    await this.assertFresh(before, input.expectedUpdatedAt, actor);

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
    // «نوع المبنى» (0106): a type sent decides the structure; the body's `structureType` beside it is not read.
    const typed = await resolveBuildingType(this.db, input, before);
    if (typed && typed.structureType !== before.structureType) {
      this.assertUnitFits(
        { structureType: typed.structureType, code: before.code },
        await this.db.unit.count({ where: { buildingId: id } }),
        0,
      );
    }

    /*
      Fewer floors than the matrix already uses.

      The matrix is drawn from these two counts, so a unit above the top floor
      or below the deepest basement is on no row of it: it keeps billing and
      counting while the editor cannot show it or remove it. Only a shrink can
      do that, so only a shrink is checked. The editor removes the units first
      and sends the smaller count afterwards; see `saveEdit`.
    */
    const floorsAfter = input.floorsCount ?? before.floorsCount;
    const basementsAfter = input.basementsCount ?? before.basementsCount;
    if (floorsAfter < before.floorsCount || basementsAfter < before.basementsCount) {
      const outside = unitsOutsideFloors(
        await this.db.unit.findMany({
          where: { buildingId: id },
          select: { unitCode: true, floor: true },
          orderBy: [{ floor: 'asc' }, { sequence: 'asc' }],
        }),
        floorsAfter,
        basementsAfter,
      );
      if (outside.length > 0) {
        throw new ConflictError(
          `لا يمكن إنقاص طوابق المبنى ${before.code}: ${outside.length === 1 ? 'الوحدة' : 'الوحدات'} ${listCodes(outside)} خارج الطوابق الجديدة. احذفها من مصفوفة الوحدات أو انقلها إلى طابق قائم أولاً`,
          { unitCodes: outside.map((unit) => unit.unitCode), floorsCount: floorsAfter, basementsCount: basementsAfter },
        );
      }
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
        ...(typed ? { structureType: typed.structureType as never, buildingTypeId: typed.buildingTypeId } : {}),
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

  /**
   * Somebody saved this building after the screen was opened. Refused before
   * anything is written, naming them, so a screen loaded an hour ago does not
   * quietly put back a lifecycle, a فرز or a pin a colleague has since changed.
   * An absent `expectedUpdatedAt` means "do not check" — older clients.
   */
  async assertFresh(
    before: { id: string; updatedAt: Date },
    expectedUpdatedAt: string | undefined,
    actor: { id: string },
  ): Promise<void> {
    if (!expectedUpdatedAt) return;
    if (before.updatedAt.toISOString() === new Date(expectedUpdatedAt).toISOString()) return;

    const last = await this.db.auditLogEntry.findFirst({
      where: { entityType: 'Building', entityId: before.id },
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

  async remove(id: string, actor: StaffActor): Promise<void> {
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
        `لا يمكن حذف مبنى سُجّل فيه سكان: ${historical} إشغال سابق على وحداته. حذفه يمحو سجل من سكنها. عدّل بيانات المبنى أو غيّر حالته إلى «مهدوم» بدلاً من الحذف، وإن كان رقم العقار خاطئاً فاستخدم «تصحيح رقم العقار»`,
      );
    }

    // A unit's fee exemption history keys onto it with RESTRICT (0104): refused here, with a code.
    await assertNoFeeExemptionHistory(this.db, { buildingId: id });

    await this.db.building.delete({ where: { id } });

    this.record({
      action: 'BUILDING_DELETED',
      buildingId: id,
      before: { code: before.code, parcelNumber: before.parcelNumber, units: before._count.units },
      actor,
    });
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
  assertUnitFits(
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

  /** See `updateUnit`: an owner-side status over a registered tenant is a double charge. */
  async assertNoOccupantBesidesOwner(
    unit: { id: string; unitCode: string },
    status: string,
    exceptCitizenId?: string,
  ): Promise<void> {
    const live = await this.db.unitOccupancy.count({
      where: {
        unitId: unit.id,
        toDate: null,
        role: { in: ['TENANT', 'FREE_OCCUPANT'] as never },
        ...(exceptCitizenId ? { citizenId: { not: exceptCitizenId } } : {}),
      },
    });
    if (live > 0) {
      if (feeBearerClass(status) === 'NOBODY') {
        const empty = status === 'UNDER_CONSTRUCTION' ? 'قيد الإنجاز' : 'شاغرة';
        throw new ConflictError(
          `لا يمكن تسجيل الوحدة ${unit.unitCode} ${empty}: يسكنها ${live} مستأجر أو شاغل مسجَّل. أنهِ إشغاله أولاً`,
        );
      }
      const label = status === 'SEASONAL' ? 'مسكناً موسمياً' : 'مشغولة من المالك';
      throw new ConflictError(
        `لا يمكن تسجيل الوحدة ${unit.unitCode} ${label}: يسكنها ${live} مستأجر أو شاغل مسجَّل، وكلاهما يُكلَّف برسم الإشغال عندها. أنهِ إشغاله أولاً، أو اختر «مؤجرة» / «مشغولة بتسامح»`,
      );
    }
  }

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
  async assertMayBeCalledEmpty(
    unit: {
      id: string;
      buildingId: string;
      unitCode: string;
      unitStatus: string | null;
    },
    options: { seasonalAllowed?: boolean } = {},
  ): Promise<void> {
    const live = await this.db.unitOccupancy.count({
      where: { unitId: unit.id, toDate: null, role: { in: ['TENANT', 'FREE_OCCUPANT'] as never } },
    });
    if (live > 0) {
      throw new ConflictError(
        `لا يمكن تسجيل الوحدة ${unit.unitCode} كشاغرة: يسكنها ${live} مستأجر أو شاغل مسجَّل. أنهِ إشغاله أولاً`,
      );
    }

    if (!options.seasonalAllowed && (await this.isSeasonal(unit))) {
      throw new ConflictError(
        `لا يمكن تسجيل الوحدة ${unit.unitCode} كشاغرة: هي مسكن موسمي، وغياب أصحابه لا يجعلها شاغرة. سجّل تصريح الشغور في بيانات السكن الموسمي، أو أعد ربط المالك بحالة «شاغرة» إن لم يعودوا يأتون`,
      );
    }
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
    actor?: StaffActor,
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

    await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
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
   * building itself or on any of its units, whichever was observed last, and of
   * two observed the same day the one recorded last (`createdAt`), as
   * `habitability.ts` and `DamageService` order them. Without that tie-break
   * `DISTINCT ON` picks either, and the map's colour flips between reloads.
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
          SELECT d."buildingId", d."level", d."assessedAt", d."createdAt"
            FROM ${S}"damage_assessments" d
           WHERE d."buildingId" = ANY(${ids})
          UNION ALL
          SELECT u."buildingId", d."level", d."assessedAt", d."createdAt"
            FROM ${S}"damage_assessments" d
            JOIN ${S}"units" u ON u."id" = d."unitId"
           WHERE u."buildingId" = ANY(${ids})
        ) t
       ORDER BY t."buildingId", t."assessedAt" DESC, t."createdAt" DESC
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

  /**
   * Every suffix that may not be allocated on this parcel: the ones its
   * buildings hold, and the ones «تصحيح رقم العقار» retired there
   * (`BuildingCodeAlias`), so an old code on a receipt or a notice never comes
   * to name a different building.
   *
   * `reclaimFor` lets one building take back a suffix it retired itself — a
   * correction that is corrected again returns the building to its own old
   * code, which is not reuse by anybody else.
   *
   * Read under the caller's per-parcel lock, inside its transaction.
   */
  async suffixesInUse(
    client: Prisma.TransactionClient,
    parcelNumber: string,
    reclaimFor?: string,
  ): Promise<string[]> {
    const [buildings, retired] = await Promise.all([
      client.building.findMany({ where: { parcelNumber }, select: { codeSuffix: true } }),
      client.buildingCodeAlias.findMany({
        where: { parcelNumber, ...(reclaimFor ? { NOT: { buildingId: reclaimFor } } : {}) },
        select: { codeSuffix: true },
      }),
    ]);
    return [...buildings, ...retired].map((row) => row.codeSuffix);
  }

  /** The sector a parcel belongs to — see `zoneOfParcel`. */
  zoneFor(parcelNumber: string, tx?: Prisma.TransactionClient) {
    return this.zoneOfParcel(parcelNumber, tx);
  }

  /** Every structure standing on a parcel, nearest first — see `parcelNeighbours`. */
  neighboursOn(parcelNumber: string, pin: { latitude?: number | null; longitude?: number | null }) {
    return this.parcelNeighbours(parcelNumber, pin);
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
          buildingTypeId: true,
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
      buildingTypeId: building.buildingTypeId,
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

/** The building columns `update` can write — what its audit row compares. */
const AUDITED_BUILDING_FIELDS = [
  'name',
  'postedNumber',
  'isPartitioned',
  'partitionNumbers',
  'sharedParcelNumbers',
  'structureType',
  // «نوع المبنى» (0106): an id; the type's names are read from the list it points to.
  'buildingTypeId',
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

/** The unit fields `UNIT_UPDATED` records when they change. */
const AUDITED_UNIT_FIELDS = [
  'floor',
  'sequence',
  'unitCode',
  'unitType',
  // «نوع الوحدة» (0109): a school retyped as an office keeps its base, so `unitType` alone would say nothing.
  'unitTypeId',
  'unitArea',
  'unitStatus',
  'surveyStatus',
  'postedNumber',
  'side',
  'startCol',
  'endCol',
  'levels',
  'presenceMonths',
  'ownerLastStayAt',
  'vacancyDeclaredAt',
  'notes',
] as const;

/** Optional keys: a caller that predates a field (the older specs, a change record) simply does not carry it. */
type AuditedUnit = { [K in (typeof AUDITED_UNIT_FIELDS)[number]]?: unknown };

/**
 * The fields that differ between two versions of a unit, each side keyed by
 * field — `changedBuildingFields` for a unit. Decimals and dates compare by
 * their serialised form, so re-saving 120 m² as 120 m² is not a change.
 * Exported for its spec.
 */
export function changedUnitFields(
  before: AuditedUnit,
  after: AuditedUnit,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const changed = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
  for (const field of AUDITED_UNIT_FIELDS) {
    if (JSON.stringify(before[field] ?? null) === JSON.stringify(after[field] ?? null)) continue;
    changed.before[field] = before[field] ?? null;
    changed.after[field] = after[field] ?? null;
  }
  return changed;
}

/**
 * The units a building's floors would no longer hold — above the top floor
 * (`floorsCount - 1`) or below the deepest basement (`-basementsCount`).
 * Exported for its spec.
 */
export function unitsOutsideFloors<T extends { floor: number; levels?: number | null }>(
  units: readonly T[],
  floorsCount: number,
  basementsCount: number,
): T[] {
  // A «دوبلكس» on the top floor reaches the floor above it (0095).
  return units.filter((unit) => unitTopFloor(unit) > floorsCount - 1 || unit.floor < -basementsCount);
}

/** «0401، 0402، 0403 و5 غيرها» — enough codes to find them, never a wall of them. */
function listCodes(units: ReadonlyArray<{ unitCode: string }>, shown = 6): string {
  const codes = units.map((unit) => unit.unitCode);
  const head = codes.slice(0, shown).join('، ');
  return codes.length > shown ? `${head} و${codes.length - shown} غيرها` : head;
}

/**
 * Why a unit edit would put a non-resident somewhere the record cannot hold
 * them, or null when it would not — the unit-edit face of
 * `assertNonResidentOccupancy`. Each message names the people and both ways
 * out, because only the officer knows which one is true. Exported for its spec.
 */
export function nonResidentUnitConflict(input: {
  unitCode: string;
  /** Tenants or free occupants of this unit whose file says they live elsewhere. */
  nonResidentOccupants: readonly string[];
  /** The edit says the owner lives here, and every recorded owner lives elsewhere. */
  ownerOccupiedByNonResident: boolean;
  /**
   * The edit says «مسكن موسمي», and every recorded owner is an estate or an
   * institution: that kind (the first owner's), for the refusal's wording.
   */
  seasonalOwner?: string | null;
}): string | null {
  const occupants = [...new Set(input.nonResidentOccupants.filter(Boolean))];

  if (occupants.length > 0) {
    return (
      `لا يمكن جعل الوحدة ${input.unitCode} مسكناً: ${occupants.join('، ')} ` +
      `${occupants.length === 1 ? 'مسجَّل عليها مستأجراً أو شاغلاً وملفه ليس' : 'مسجَّلون عليها مستأجرين أو شاغلين وملفاتهم ليست'} ملف أسرة مقيمة ` +
      '(غير مقيم في البلدة، أو تركة، أو جهة)، وهذا لا يستأجر مسكناً. إن كان يسكنها فعلاً فصحّح نوع ملفه إلى «أسرة مقيمة»، وإن كان قد تركها فأنهِ إيجاره أولاً'
    );
  }

  if (input.ownerOccupiedByNonResident) {
    return (
      `لا يمكن تسجيل الوحدة ${input.unitCode} «مشغولة من المالك»: مالكها ليس أسرة مقيمة في البلدة (غير مقيم، أو تركة، أو جهة). ` +
      'اختر «مسكن موسمي» (لغير المقيم) أو «مشغولة بتسامح» أو «شاغرة»، أو صحّح نوع ملف المالك إن كان يسكنها'
    );
  }

  if (input.seasonalOwner) return ownerLivesThereRefusal(input.seasonalOwner, input.unitCode);

  return null;
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
  buildingTypeId?: string | null;
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
    buildingTypeId: row.buildingTypeId ?? null,
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
  if (!isOwnerRecord(input.residence)) return;

  /*
    An estate owns and nothing else (0076): whoever lives in or uses the flat —
    the widow, a tenant — is recorded in their own name, which is how the
    occupancy fee reaches someone who can pay it.
  */
  if (input.residence === 'ESTATE' && input.role !== 'OWNER') {
    throw new ValidationError({
      code: 'ESTATE_OWNS_ONLY',
      message: `An estate only owns: whoever rents or lives in unit ${input.unitCode} is filed in their own name.`,
      params: { unitCode: input.unitCode },
      details: { role: input.role, residence: input.residence },
    });
  }

  if (!isDwellingUnitType(input.unitType)) return;

  if (input.role !== 'OWNER') {
    throw new ValidationError(
      `الوحدة ${input.unitCode} مسكن، وغير المقيم لا يُسجَّل مستأجراً أو شاغلاً لمسكن. من يستأجر مسكناً ويسكنه يُسجَّل بملف أسرة، وإن كانت الوحدة تُستعمل لغير السكن فصحّح نوعها`,
      { role: input.role, unitType: input.unitType },
    );
  }

  // An estate or an institution comes back for no season either (see `nonResidentCardIssues`).
  if (ownerSaidToLiveThere(input.residence, input.unitStatus)) {
    throw new ValidationError(ownerLivesThereRefusal(input.residence, input.unitCode), {
      unitStatus: input.unitStatus,
    });
  }
}

/**
 * Whether this status says an owner record lives in the dwelling it owns:
 * «مشغولة من المالك» for any of them, and «مسكن موسمي» for an estate or an
 * institution — «مسكن موسمي» is the owner's own seasonal absence, billed to the
 * owner, and neither has a season to come back for. The matrix's and the unit
 * edit's twin of `livesThere` in the card schema (`nonResidentCardIssues`).
 */
function ownerSaidToLiveThere(residence: string | null | undefined, unitStatus: string | null | undefined): boolean {
  return unitStatus === 'OWNER_OCCUPIED' || (isNonPersonRecord(residence) && unitStatus === 'SEASONAL');
}

/** The refusal of `ownerSaidToLiveThere`, in the words of the record kind. */
function ownerLivesThereRefusal(residence: string | null | undefined, unitCode: string): string {
  return residence === 'ESTATE'
    ? `المرحوم لا يسكن الوحدة ${unitCode} — إن كانت عائلته تسكنها فاختر «مشغولة بتسامح» وسجّل أحدهم بملف أسرة، وإلا فـ«مؤجرة» أو «شاغرة»`
    : residence === 'INSTITUTION'
      ? `الجهة لا تسكن المسكن ${unitCode} — اختر حالة من يشغله («مؤجرة»، «مشغولة بتسامح») أو «شاغرة»`
      : `غير المقيم لا يسكن الوحدة ${unitCode} — اختر «مسكن موسمي» إن كان يحضر في مواسم، أو «شاغرة»`;
}

/**
 * Nobody is recorded in a طابق أعمدة.
 *
 * A structural row draws a level of the building — see `STRUCTURAL_UNIT_TYPE`.
 * It has no door, so «من يسكنها» has no answer, and an occupancy on one would
 * propagate exactly like a real one: `claimOnFile` would mint a card for it,
 * `assessCitizen` would bill that card, and a fee notice would go out for a
 * floor of columns.
 *
 * Placed beside `assertNonResidentOccupancy` and called from the same two
 * places for the same stated reason — **both doors must refuse the same
 * thing**. The matrix's occupant panel and a registration claiming a flat are
 * separate code paths to one table, and a rule on one of them is not a rule,
 * it is a preference the other path ignores.
 *
 * The message names the correction rather than only the refusal. An officer
 * who reaches this has almost always picked the wrong block on a grid where
 * the pilotis sits directly under the flat they wanted.
 */
export function assertOccupiableUnit(input: { unitType: string; unitCode: string }): void {
  if (!isStructuralUnitType(input.unitType)) return;

  throw new ValidationError(
    `الوحدة ${input.unitCode} ${structuralLabel(input.unitType)} — لا يُسجَّل عليها شاغل. اختر وحدة في أحد الطوابق الأخرى، أو صحّح نوع الوحدة إن كانت مقسَّمة ومستعملة`,
    { unitType: input.unitType, unitCode: input.unitCode },
  );
}

/**
 * «طابق أعمدة» or «طابق فارغ (بلا وحدات)», as the case may be.
 *
 * Read from the shared labels rather than written into each message, because
 * there are two structural types now and telling an officer their block is a
 * طابق أعمدة when they marked it فارغ is the kind of wrongness that makes
 * people distrust the rest of the sentence. The Arabic label is the only one
 * used: these messages go to `ValidationError`, which this API returns in
 * Arabic throughout.
 */
export function structuralLabel(unitType: string): string {
  const labels = getLabels('ar').unitType as Record<string, string | undefined>;
  return labels[unitType] ?? 'وحدة إنشائية';
}

export function toUnitRow(row: {
  id: string;
  buildingId: string;
  floor: number;
  sequence: number;
  startCol: number | null;
  endCol: number | null;
  unitCode: string;
  postedNumber: string | null;
  unitType: string;
  unitTypeId?: string | null;
  side: string | null;
  unitArea: { toString(): string } | null;
  unitStatus: string | null;
  surveyStatus: string;
  presenceMonths?: number[];
  ownerLastStayAt?: Date | null;
  vacancyDeclaredAt?: Date | null;
  ownerBillingMode?: UnitRow['ownerBillingMode'];
  responsibleOwnerId?: string | null;
  feeExemption?: UnitRow['feeExemption'];
  feeExemptionNote?: string | null;
  feeExemptedAt?: Date | null;
  feeExemptedBy?: { firstName: string; lastName: string } | null;
  feeExemptionValidUntil?: Date | null;
  levels?: number;
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
    unitTypeId: row.unitTypeId ?? null,
    side: row.side,
    // Decimal → number at the edge; a `Decimal` serialises as an object, which
    // the client would render as "[object Object]".
    unitArea: row.unitArea == null ? null : Number(row.unitArea.toString()),
    unitStatus: row.unitStatus,
    surveyStatus: row.surveyStatus,
    presenceMonths: row.presenceMonths ?? [],
    ownerLastStayAt: row.ownerLastStayAt ?? null,
    vacancyDeclaredAt: row.vacancyDeclaredAt ?? null,
    ownerBillingMode: row.ownerBillingMode ?? null,
    responsibleOwnerId: row.responsibleOwnerId ?? null,
    feeExemption: row.feeExemption ?? null,
    feeExemptionNote: row.feeExemptionNote ?? null,
    feeExemptedAt: row.feeExemptedAt ?? null,
    feeExemptedByName: row.feeExemptedBy ? `${row.feeExemptedBy.firstName} ${row.feeExemptedBy.lastName}` : null,
    feeExemptionValidUntil: row.feeExemptionValidUntil ? calendarDayOf(row.feeExemptionValidUntil) : null,
    levels: row.levels ?? 1,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toVisitRow(row: {
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

export function toOccupancyRow(
  row: {
    id: string;
    unitId: string;
    citizenId: string;
    citizen?: {
      firstName: string;
      lastName: string;
      phone?: string | null;
      isActive?: boolean;
      residence?: string | null;
    } | null;
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
    // «ورثة المرحوم …» for an estate (0076).
    citizenName: row.citizen ? citizenDisplayName(row.citizen, { middleName: false }) : null,
    citizenPhone: row.citizen?.phone ?? null,
    citizenActive: row.citizen?.isActive ?? true,
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

/** A citizen's name as shown — «ورثة المرحوم …» for an estate (0076). */
export function personName(person: { firstName: string; middleName?: string | null; lastName: string; residence?: string | null }): string {
  return citizenDisplayName(person);
}

import { citizenDisplayName, csvCell } from '@mechanization/shared-schemas';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { withConnectionRetry } from '../../../infrastructure/prisma/with-connection-retry';

export interface DashboardCounters {
  total: number;
  byPropertyType: Record<string, number>;
  byResidentStatus: Record<string, number>;
  submittedLast7Days: number;
}

/**
 * Everything the analytics dashboard plots, in one payload.
 *
 * Assembled server-side rather than derived in the browser from three separate
 * endpoints: the KPI tiles and the charts have to agree with each other, and
 * three independently-cached fetches guarantee a window where they do not —
 * a "collection rate" computed from one response against a total from another
 * is a number nobody can reconcile.
 */
export interface DashboardAnalytics {
  /** Household records on file — one row per registered citizen. */
  citizenRecords: number;
  /**
   * العدد الفعلي لسكان البلدة — sum(actualHouseholdMembers): the real, deduplicated
   * population, excluding married children who have branched into their own
   * household (and so are counted once, under that household, not twice).
   *
   * This is the municipality's population as it has actually been declared,
   * not a headcount of portal accounts — one registration speaks for a whole
   * household, so the record count understates the people served by roughly a
   * factor of four here.
   */
  populationTotal: number;
  /**
   * إجمالي المسجلين في سجلات النفوس — sum(totalRegisteredMembers): the gross
   * civil-registry headcount, including every married child still listed on
   * their parents' إخراج قيد. Always >= `populationTotal`.
   */
  grossRegisteredTotal: number;
  /**
   * Households whose actual household size was never recorded. Reported
   * rather than hidden: they contribute nothing to `populationTotal`, so the
   * figure is understated by at least this many people, and a dashboard that
   * quietly rounded them to zero would be lying by omission.
   */
  householdsWithoutSize: number;
  /** One entry per distinct actual household size. */
  familySizes: Array<{ size: number; households: number }>;

  /**
   * The municipality's building stock, by نوع العقار — مبنى / منزل / أرض / خيمة.
   */
  propertiesByType: Record<string, number>;
  propertyTotal: number;

  /**
   * Individual units by نوع الوحدة — شقة / عيادة / محل.
   *
   * Counted across **both** places a unit type is stored, which is the whole
   * subtlety here: a unit inside a registered building is a `building_units`
   * row, but a property registered as a single unit carries its type on the
   * property row itself. Counting only the first silently drops every
   * standalone unit in the municipality — on the current data that is one of
   * the two apartments on file, i.e. a 50% undercount of that category.
   */
  unitsByType: Record<string, number>;
  unitTotal: number;

  /**
   * The physical stock, read from the building census — the same rows «سجل
   * المباني» lists, under the same predicates.
   *
   * Everything above this field counts *filings*: a `property_entries` row is
   * a card on one citizen's file, so a block of twelve registered households
   * is twelve «مبنى» cards and one structure. That is the right answer to
   * "how much has been registered" and the wrong one to "how much is there",
   * and the dashboard was asking the second question with the first number —
   * 1,236 against the census's 713 on production on 2026-10-16.
   *
   * Counted off `units`/`buildings` rather than the trigger-maintained
   * `buildings.unitsTotal` the ledger sums, because the units table is where
   * the fact lives and the counter is a cache of it. The two agreed exactly on
   * production when this shipped (2,323 either way); if they ever stop
   * agreeing that is a `sync_building_unit_counts` fault worth seeing, not
   * something this query should hide by reading the cache too.
   */
  census: {
    /**
     * Every structure on the register, including the ones no household can
     * occupy. Matches «عدد المباني» on the ledger, which likewise counts the
     * whole set — the figure has to mean what the list below it shows.
     */
    buildings: number;
    /**
     * Units in structures that can hold households, excluding طابق أعمدة and
     * طابق فارغ. Matches the ledger's denominator.
     */
    unitsTotal: number;
    /** Of those, surveyed — COMPLETE or VACANT_CONFIRMED. */
    unitsSurveyed: number;
    /** The same units as `unitsTotal`, split by نوع الوحدة. Sums to it. */
    unitsByType: Record<string, number>;
    /**
     * Every structure on the register by «نوع المبنى» (0106), keyed by the type's
     * id — `NONE` for a building not typed yet. Sums to `buildings`. The names
     * come from `GET building-types`, which the screen already holds.
     */
    buildingsByType: Record<string, number>;
    /** Census buildings at least one live property card points at. */
    buildingsWithFilings: number;
  };

  /**
   * How many property_entries / building_units rows this payload already
   * excluded as duplicate filings: a TENANT or FREE_OCCUPANT registration of
   * a unit an OWNER already registered under the same رقم العقار — the same
   * apartment filed twice, once by whoever owns it and once by whoever rents
   * it. Surfaced so staff can see the correction happened, not just a smaller
   * number in `propertyTotal`/`unitTotal`.
   */
  duplicateFilingsExcluded: {
    properties: number;
    units: number;
  };

  billedTotal: number;
  collectedTotal: number;
  outstandingTotal: number;
  /** Unpaid and past its due date — see the note on late fees below. */
  overdueTotal: number;
  overdueCount: number;
  pendingReviewCount: number;

  /**
   * The last six months, keyed by the month an invoice fell **due**.
   *
   * One time axis for all three measures on purpose. Plotting "billed by due
   * date" against "collected by payment date" would put two different
   * populations of rows on one chart and invite the reader to subtract them.
   */
  monthly: Array<{ month: string; billed: number; collected: number; overdue: number }>;
}

export interface SpatialFeature {
  id: string;
  propertyNumber: string;
  propertyType: string;
  latitude: number;
  longitude: number;
}

/** One citizen registered against a parcel, as the staff map drawer shows them. */
interface ParcelRegistrantFinancials {
  totalBilled: number;
  totalPaid: number;
  totalDue: number;
  paymentStatus: 'PAID' | 'PARTIALLY_PAID' | 'UNPAID' | 'NO_BILLS';
}

/** One structure/card registered against a parcel — a building, house, shop, or plot. */
interface ParcelStructure {
  id: string;
  propertyType: string;
  occupancyType: string;
  buildingName: string | null;
  unitCount: number;
  unitType?: string | null;
  unitArea?: number | null;
}

interface ParcelRegistrant {
  citizenId: string;
  registrationId: string;
  fullName: string;
  phone: string | null;
  /** «لا يملك رقم هاتف» — the empty phone is an answer, not a gap. */
  hasNoPhone: boolean;
  /** «رقم للتواصل» — a relative's number, for reaching a citizen with none of their own. */
  contactPhone: string | null;
  /** مالك / مستأجر — the primary role. */
  occupancyType: string;
  propertyType: string;
  /** Which building this registrant's unit sits in — if named. */
  buildingName: string | null;
  registeredAt: string;
  /** Total units inside this citizen's structures on this parcel. */
  unitCount: number;
  financials?: ParcelRegistrantFinancials;
  /** All structures/cards owned or occupied by this citizen on this parcel */
  structures: ParcelStructure[];
}

interface ParcelFinancials {
  totalBilled: number;
  totalPaid: number;
  totalDue: number;
  status: 'PAID' | 'PARTIALLY_PAID' | 'UNPAID' | 'NO_BILLS';
}

/**
 * A parcel that has at least one registration, with everyone attached to it.
 *
 * Only registered parcels appear. The map draws all ~1,800 cadastral parcels
 * from a static GeoJSON underneath; an interactive marker is reserved for the
 * handful that actually have citizen data, so a dot on the map always means
 * "there is something to open here".
 *
 * **One row per رقم العقار, deliberately.** P5-T5 split it per censused
 * structure and P5-T7 put it back: the map has a separate census layer that
 * already draws a pin per building at its own entrance, and two layers saying
 * the same thing in two visual languages is worse than either alone. This one
 * is about the plot — everyone registered on it, in one dot, at the parcel's
 * own point. See §10.6.
 */
export interface RegisteredParcel {
  propertyNumber: string;
  /** The parcel's own representative point, from the cadastre. */
  latitude: number;
  longitude: number;
  registrants: ParcelRegistrant[];
  financials?: ParcelFinancials;
  /** Total property cards across every registrant on this parcel. */
  structureCount: number;
}

/**
 * A key in a municipality's dashboard cache: `dashboard:<slug>:<name>`.
 *
 * Namespaced per tenant so one municipality's entries can be invalidated, or
 * simply expire, without touching any other's. `CitizenProfileService` caches a
 * profile here too (`citizen:<id>`), so the one prefix delete in
 * `ReportingService.onDashboardDataChanged` clears it with the rest.
 */
export function dashboardCacheKey(tenantSlug: string, name: string): string {
  return `dashboard:${tenantSlug}:${name}`;
}

/**
 * Read side of the dashboard.
 *
 * These are `groupBy` aggregates and multi-table reads over tables with
 * thousands of rows per municipality, which Postgres alone answers in
 * single-digit milliseconds — but admins hit `counters`, `map`, `map/parcels`
 * and a citizen's profile (`CitizenProfileService`, sharing this cache) repeatedly (dashboard polling, re-opening the same
 * map drawer, a citizen page revisited mid-review), so a short-lived cache
 * still cuts real load even though no single query is slow. `RedisCacheService`
 * degrades to a no-op when `REDIS_URL` is unset, so this is additive rather
 * than a hard dependency.
 *
 * This service reads the tenant client directly rather than going through a
 * repository port: these are reporting projections with no domain invariants to
 * enforce, and routing them through an entity-shaped port would mean mapping
 * rows into aggregates only to count them.
 */
@Injectable()
export class ReportingService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
    private readonly cache: RedisCacheService,
    private readonly config: ConfigService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /**
   * The schema prefix every raw query in this class writes into its SQL.
   *
   * Raw SQL is sent to Postgres untouched, so an unqualified table name resolves
   * through `search_path` — session state on a connection shared through a
   * transaction pooler, which is not required to carry it. See
   * `tenant-schema-ref.ts` for the 42P01 this prevents.
   */
  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  private get cacheTtlSeconds(): number {
    return this.config.getOrThrow<number>('DASHBOARD_CACHE_TTL_SECONDS');
  }

  private cacheKey(name: string): string {
    return dashboardCacheKey(this.tenantContext.tenantSlug, name);
  }

  /** Headline totals, served from cache when warm. */
  async getDashboardCounters(): Promise<DashboardCounters> {
    const key = this.cacheKey('counters');
    const cached = await this.cache.get<DashboardCounters>(key);
    if (cached) return cached;

    const counters = await this.computeDashboardCounters();
    await this.cache.set(key, counters, this.cacheTtlSeconds);
    return counters;
  }

  /**
   * One round trip instead of five separate queries across three tables. The
   * five used to run via `Promise.all`, which — against a pooler with
   * `connection_limit=1` — meant five queries briefly fighting over one
   * connection on every cache miss; combining them into a single query with
   * scalar subqueries removes that contention entirely rather than just
   * widening the pool to tolerate it.
   */
  private async computeDashboardCounters(): Promise<DashboardCounters> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3_600_000);

    const [row] = await withConnectionRetry(() =>
      this.db.$queryRaw<
        Array<{
          total: number;
          recent: number;
          byPropertyType: Record<string, number>;
          byResidentStatus: Record<string, number>;
        }>
      >`
        SELECT
          (SELECT count(*)::int FROM ${this.S}registrations) AS total,
          (SELECT count(*)::int FROM ${this.S}registrations WHERE "submittedAt" >= ${sevenDaysAgo}) AS recent,
          (SELECT COALESCE(json_object_agg("propertyType", cnt), '{}'::json)
             FROM (SELECT "propertyType", count(*)::int AS cnt FROM ${this.S}property_entries WHERE "endedAt" IS NULL GROUP BY "propertyType") p
          ) AS "byPropertyType",
          (SELECT COALESCE(json_object_agg("residentStatus", cnt), '{}'::json)
             FROM (
               SELECT "residentStatus", count(*)::int AS cnt FROM ${this.S}users
               WHERE kind = 'CITIZEN' AND residence = 'RESIDENT' AND ${this.S}users.id NOT IN (SELECT "absorbedId" FROM ${this.S}citizen_merges WHERE "undoneAt" IS NULL) AND "residentStatus" IS NOT NULL
               GROUP BY "residentStatus"
             ) u
          ) AS "byResidentStatus"
      `,
    );

    return {
      total: row.total,
      byPropertyType: row.byPropertyType,
      byResidentStatus: row.byResidentStatus,
      submittedLast7Days: row.recent,
    };
  }

  /**
   * Everything the analytics dashboard plots, served from cache when warm.
   *
   * Shares the `dashboard:{tenant}:` namespace, so the existing event-driven
   * invalidation — registration, citizen and money events alike — already
   * clears it without a listener of its own.
   */
  async getAnalytics(): Promise<DashboardAnalytics> {
    const key = this.cacheKey('analytics');
    const cached = await this.cache.get<DashboardAnalytics>(key);
    if (cached) return cached;

    const analytics = await this.computeAnalytics();
    await this.cache.set(key, analytics, this.cacheTtlSeconds);
    return analytics;
  }

  /**
   * One round trip for a screen made entirely of aggregates.
   *
   * Same reasoning as `computeDashboardCounters`: against a pooler holding a
   * single connection per tenant schema, issuing eight `groupBy` calls in
   * parallel makes them contend with each other, and this page opens with all
   * of them at once. Scalar subqueries in one statement remove the contention
   * rather than widening the pool to tolerate it.
   */
  private async computeAnalytics(): Promise<DashboardAnalytics> {
    type AnalyticsRow = Omit<DashboardAnalytics, 'duplicateFilingsExcluded' | 'census'> & {
      duplicatePropertiesExcluded: number;
      duplicateUnitsExcluded: number;
      censusBuildings: number;
      censusUnitsTotal: number;
      censusUnitsSurveyed: number;
      censusUnitsByType: Record<string, number>;
      censusBuildingsByType: Record<string, number>;
      censusBuildingsWithFilings: number;
    };

    const [row] = await withConnectionRetry(() =>
      this.db.$queryRaw<AnalyticsRow[]>`
        WITH owned_parcels AS (
          SELECT DISTINCT "propertyNumber" FROM ${this.S}property_entries
           WHERE "occupancyType" = 'OWNER' AND "propertyNumber" IS NOT NULL AND "endedAt" IS NULL
        ),
        -- A TENANT/FREE_OCCUPANT filing of a unit whose رقم العقار some OWNER
        -- already registered under: the same apartment, filed twice — once by
        -- whoever owns it, once by whoever rents it. Excluded from every
        -- property/unit count below so it counts once, not twice.
        excluded_entries AS (
          SELECT pe.* FROM ${this.S}property_entries pe
           WHERE pe."occupancyType" <> 'OWNER'
             AND pe."endedAt" IS NULL
             AND pe."propertyNumber" IS NOT NULL
             AND EXISTS (SELECT 1 FROM owned_parcels op WHERE op."propertyNumber" = pe."propertyNumber")
        ),
        countable_entries AS (
          SELECT pe.* FROM ${this.S}property_entries pe
           WHERE pe.id NOT IN (SELECT id FROM excluded_entries)
             -- An ended tenancy (migration 0046) is history, not a property held.
             AND pe."endedAt" IS NULL
        )
        SELECT
          -- A file «دمج ملفين» folded into another is the same household
          -- counted once already, on the file that stays: every people-count
          -- below leaves it out (migration 0061).
          -- Households only. A non-resident record («غير مقيم في البلدة», migration 0040)
          -- is somebody who lives elsewhere: counting them — or whatever
          -- household size a file converted to a non-resident record still carries —
          -- would put people in the town's population who are not in the town.
          -- The residence column is NOT NULL, so this comparison drops no existing row.
          (SELECT count(*)::int FROM ${this.S}users WHERE kind = 'CITIZEN' AND residence = 'RESIDENT' AND ${this.S}users.id NOT IN (SELECT "absorbedId" FROM ${this.S}citizen_merges WHERE "undoneAt" IS NULL))
            AS "citizenRecords",
          (SELECT COALESCE(sum("actualHouseholdMembers"), 0)::int FROM ${this.S}users
            WHERE kind = 'CITIZEN' AND residence = 'RESIDENT' AND ${this.S}users.id NOT IN (SELECT "absorbedId" FROM ${this.S}citizen_merges WHERE "undoneAt" IS NULL))
            AS "populationTotal",
          (SELECT COALESCE(sum("totalRegisteredMembers"), 0)::int FROM ${this.S}users
            WHERE kind = 'CITIZEN' AND residence = 'RESIDENT' AND ${this.S}users.id NOT IN (SELECT "absorbedId" FROM ${this.S}citizen_merges WHERE "undoneAt" IS NULL))
            AS "grossRegisteredTotal",
          (SELECT count(*)::int FROM ${this.S}users
            WHERE kind = 'CITIZEN' AND residence = 'RESIDENT' AND ${this.S}users.id NOT IN (SELECT "absorbedId" FROM ${this.S}citizen_merges WHERE "undoneAt" IS NULL) AND "actualHouseholdMembers" IS NULL)
            AS "householdsWithoutSize",
          (SELECT COALESCE(
                    json_agg(json_build_object('size', size, 'households', c) ORDER BY size),
                    '[]'::json)
             FROM (SELECT "actualHouseholdMembers" AS size, count(*)::int AS c
                     FROM ${this.S}users
                    WHERE kind = 'CITIZEN' AND residence = 'RESIDENT' AND ${this.S}users.id NOT IN (SELECT "absorbedId" FROM ${this.S}citizen_merges WHERE "undoneAt" IS NULL) AND "actualHouseholdMembers" IS NOT NULL
                    GROUP BY 1) f)
            AS "familySizes",
          (SELECT COALESCE(json_object_agg("propertyType", cnt), '{}'::json)
             FROM (SELECT "propertyType", count(*)::int AS cnt
                     FROM countable_entries GROUP BY 1) p)
            AS "propertiesByType",
          (SELECT count(*)::int FROM countable_entries)
            AS "propertyTotal",
          -- Unit types live in two tables: a unit inside a registered building
          -- is a building_units row, while a property registered as a single
          -- unit carries its type on the property row. Summing both is what
          -- keeps standalone units from vanishing out of the count.
          -- (No backticks in here — this is a tagged template literal, so one
          --  would close the string and take the rest of the query with it.)
          (SELECT COALESCE(json_object_agg(t, n), '{}'::json)
             FROM (SELECT type AS t, sum(n)::int AS n
                     FROM (SELECT bu."unitType"::text AS type, count(*)::int AS n
                             FROM ${this.S}building_units bu
                             JOIN countable_entries ce ON ce.id = bu."propertyEntryId"
                            WHERE bu."endedAt" IS NULL
                            GROUP BY 1
                           UNION ALL
                           SELECT "unitType"::text, count(*)::int
                             FROM countable_entries WHERE "unitType" IS NOT NULL GROUP BY 1) u
                    GROUP BY 1) x)
            AS "unitsByType",
          (SELECT ((SELECT count(*) FROM ${this.S}building_units bu
                      JOIN countable_entries ce ON ce.id = bu."propertyEntryId"
                     WHERE bu."endedAt" IS NULL)
                 + (SELECT count(*) FROM countable_entries WHERE "unitType" IS NOT NULL))::int)
            AS "unitTotal",
          -- ── The census: what is actually there ────────────────────
          -- The lifecycle and unit-type sets are spelled out because SQL
          -- cannot read OCCUPIABLE_LIFECYCLE or STRUCTURAL_UNIT_TYPE out of
          -- shared-schemas — the same compromise migration 0054 makes, and
          -- the same place to edit when a value is added: both arrays there,
          -- this query, and the trigger.
          (SELECT count(*)::int FROM ${this.S}buildings)
            AS "censusBuildings",
          (SELECT count(*)::int FROM ${this.S}units u
             JOIN ${this.S}buildings b ON b.id = u."buildingId"
            WHERE u."unitType" NOT IN ('PILOTIS', 'EMPTY_FLOOR')
              AND b."lifecycleStatus" IN ('IN_USE', 'DERELICT'))
            AS "censusUnitsTotal",
          (SELECT count(*)::int FROM ${this.S}units u
             JOIN ${this.S}buildings b ON b.id = u."buildingId"
            WHERE u."unitType" NOT IN ('PILOTIS', 'EMPTY_FLOOR')
              AND b."lifecycleStatus" IN ('IN_USE', 'DERELICT')
              AND u."surveyStatus" IN ('COMPLETE', 'VACANT_CONFIRMED'))
            AS "censusUnitsSurveyed",
          (SELECT COALESCE(json_object_agg(t, n), '{}'::json)
             FROM (SELECT u."unitType"::text AS t, count(*)::int AS n
                     FROM ${this.S}units u
                     JOIN ${this.S}buildings b ON b.id = u."buildingId"
                    WHERE u."unitType" NOT IN ('PILOTIS', 'EMPTY_FLOOR')
                      AND b."lifecycleStatus" IN ('IN_USE', 'DERELICT')
                    GROUP BY 1) x)
            AS "censusUnitsByType",
          -- Every structure by its building type (0106); NONE before its first save since.
          (SELECT COALESCE(json_object_agg(t, n), '{}'::json)
             FROM (SELECT COALESCE(b."buildingTypeId"::text, 'NONE') AS t, count(*)::int AS n
                     FROM ${this.S}buildings b
                    GROUP BY 1) x)
            AS "censusBuildingsByType",
          -- Coverage: structures some live card points at. Over the
          -- countable entries and not every live card (and no backticks in
          -- this comment, for the reason given above), so a tenant duplicate
          -- filing cannot make a building look covered that its owner never
          -- registered.
          (SELECT count(DISTINCT ce."buildingId")::int FROM countable_entries ce
            WHERE ce."buildingId" IS NOT NULL)
            AS "censusBuildingsWithFilings",
          (SELECT count(*)::int FROM excluded_entries)
            AS "duplicatePropertiesExcluded",
          (SELECT (SELECT count(*)::int FROM excluded_entries WHERE "unitType" IS NOT NULL)
                + (SELECT count(*)::int FROM ${this.S}building_units bu
                     JOIN excluded_entries ee ON ee.id = bu."propertyEntryId"
                    WHERE bu."endedAt" IS NULL))
            AS "duplicateUnitsExcluded",
          -- A cancelled bill (0090) was raised in error and withdrawn: not billed,
          -- so billed stays collected plus outstanding (decision of 2026-10-13). The part
          -- of a bill written off («شطب», 0107) is forgiven, so it is left out the same way.
          COALESCE((SELECT sum(amount - COALESCE("writeOffAmount", 0)) FROM ${this.S}citizen_payments
                     WHERE "paymentStatus" <> 'CANCELLED'), 0)::float8
            AS "billedTotal",
          COALESCE((SELECT sum("paidAmount") FROM ${this.S}citizen_payments), 0)::float8
            AS "collectedTotal",
          COALESCE((SELECT sum(amount - "paidAmount") FROM ${this.S}citizen_payments
                     WHERE "paymentStatus" NOT IN ('PAID', 'CANCELLED', 'WRITTEN_OFF')), 0)::float8
            AS "outstandingTotal",
          -- Derived from the due date on read, never stored: a flag written by
          -- a nightly job is wrong for every hour between a due date passing
          -- and the job next running.
          COALESCE((SELECT sum(amount - "paidAmount") FROM ${this.S}citizen_payments
                     WHERE "paymentStatus" = 'UNPAID' AND "dueDate" < now()), 0)::float8
            AS "overdueTotal",
          (SELECT count(*)::int FROM ${this.S}citizen_payments
            WHERE "paymentStatus" = 'UNPAID' AND "dueDate" < now())
            AS "overdueCount",
          (SELECT count(*)::int FROM ${this.S}citizen_payments
            WHERE "paymentStatus" = 'PENDING_REVIEW')
            AS "pendingReviewCount",
          (SELECT COALESCE(json_agg(row_to_json(m) ORDER BY m.month), '[]'::json)
             FROM (
               SELECT to_char(d.m, 'YYYY-MM') AS month,
                      COALESCE(sum(p.amount - COALESCE(p."writeOffAmount", 0)) FILTER (WHERE p."paymentStatus" <> 'CANCELLED'), 0)::float8 AS billed,
                      COALESCE(sum(p."paidAmount"), 0)::float8 AS collected,
                      COALESCE(sum(p.amount - p."paidAmount")
                        FILTER (WHERE p."paymentStatus" = 'UNPAID'
                                  AND p."dueDate" < now()), 0)::float8 AS overdue
                 -- A generated month spine, LEFT JOINed: a month in which the
                 -- municipality billed nothing has to plot as a zero, not go
                 -- missing and silently shorten the axis.
                 FROM generate_series(
                        (date_trunc('month', now()) - interval '5 months')::timestamp,
                        date_trunc('month', now())::timestamp,
                        interval '1 month') AS d(m)
                 LEFT JOIN ${this.S}citizen_payments p
                        ON date_trunc('month', p."dueDate") = d.m
                GROUP BY d.m) m)
            AS "monthly"
      `,
    );

    const {
      duplicatePropertiesExcluded,
      duplicateUnitsExcluded,
      censusBuildings,
      censusUnitsTotal,
      censusUnitsSurveyed,
      censusUnitsByType,
      censusBuildingsByType,
      censusBuildingsWithFilings,
      ...rest
    } = row;
    return {
      ...rest,
      duplicateFilingsExcluded: {
        properties: duplicatePropertiesExcluded,
        units: duplicateUnitsExcluded,
      },
      census: {
        buildings: censusBuildings,
        unitsTotal: censusUnitsTotal,
        unitsSurveyed: censusUnitsSurveyed,
        unitsByType: censusUnitsByType,
        buildingsByType: censusBuildingsByType,
        buildingsWithFilings: censusBuildingsWithFilings,
      },
    };
  }

  /**
   * Points for the admin map. Returns plain coordinates rather than GeoJSON
   * because the frontend uses MapLibre markers directly — v2 dropped deck.gl,
   * whose WebGL layer pipeline bought nothing at a few hundred points and cost
   * bundle size on exactly the low-end Android devices this project targets.
   */
  async getSpatialData(): Promise<SpatialFeature[]> {
    const key = this.cacheKey('map');
    const cached = await this.cache.get<SpatialFeature[]>(key);
    if (cached) return cached;

    const features = await this.computeSpatialData();
    await this.cache.set(key, features, this.cacheTtlSeconds);
    return features;
  }

  private async computeSpatialData(): Promise<SpatialFeature[]> {
    const rows = await withConnectionRetry(() =>
      this.db.propertyEntry.findMany({
        /*
          `propertyNumber: not null` is redundant against the coordinate filter
          and stated anyway.

          Coordinates only ever come from looking رقم العقار up in the cadastre,
          so a card whose number was left «غير مؤكَّد» has none and is already
          excluded. Saying so here means a marker's label can never be blank —
          and if that ever stops being true, this is the line that says the map
          was written expecting it.
        */
        where: {
          latitude: { not: null },
          longitude: { not: null },
          propertyNumber: { not: null },
          // A tenant who left is not on the map (migration 0046).
          endedAt: null,
        },
        select: {
          id: true,
          propertyNumber: true,
          propertyType: true,
          latitude: true,
          longitude: true,
        },
        // A municipality that somehow has more than this has a data problem, and
        // a map with 5k markers is unusable anyway.
        take: 5000,
      }),
    );

    /*
      The card's own point, which is the parcel's.

      P5-T4 made this prefer the linked building's entrance and P5-T7 reverted
      it, for the reason `computeRegisteredParcels` was reverted: the map draws
      buildings on their own layer, from `mapPins`, and a second per-building
      dot from a *registration* endpoint duplicates it. This answers "where is
      the property this card is about", and the answer is its parcel.
    */
    return rows.map((row) => ({
      id: row.id,
      propertyNumber: row.propertyNumber!,
      propertyType: row.propertyType,
      latitude: row.latitude!,
      longitude: row.longitude!,
    }));
  }

  /**
   * Parcels that have registrations, each with every citizen attached to it.
   *
   * Grouped by رقم العقار rather than returned as a flat property list because
   * that is the unit the staff map interacts with: one dot per parcel, and
   * clicking it opens everyone on it. An apartment building is a single
   * cadastral number shared by all its residents, so the many-to-one shape
   * here is the common case and not an edge one.
   *
   * Coordinates come from the property row, which the submission path fills
   * from the cadastre — so a parcel missing them was registered before the
   * cadastre import and simply cannot be placed on a map.
   */
  async getRegisteredParcels(): Promise<RegisteredParcel[]> {
    const key = this.cacheKey('parcels');
    const cached = await this.cache.get<RegisteredParcel[]>(key);
    if (cached) return cached;

    const parcels = await this.computeRegisteredParcels();
    await this.cache.set(key, parcels, this.cacheTtlSeconds);
    return parcels;
  }

  private async computeRegisteredParcels(): Promise<RegisteredParcel[]> {
    const rows = await withConnectionRetry(() =>
      this.db.propertyEntry.findMany({
        // Same reasoning as `computeSpatialData`: a parcel is keyed by its
        // رقم العقار here, and a card that has none was never located.
        where: {
          latitude: { not: null },
          longitude: { not: null },
          propertyNumber: { not: null },
          endedAt: null,
        },
        select: {
          id: true,
          propertyNumber: true,
          propertyType: true,
          occupancyType: true,
          buildingName: true,
          unitType: true,
          unitArea: true,
          latitude: true,
          longitude: true,
          createdAt: true,
          _count: { select: { units: { where: { endedAt: null } } } },
          registration: {
            select: {
              id: true,
              submittedAt: true,
              citizen: {
                select: {
                  id: true,
                  firstName: true,
                  middleName: true,
                  lastName: true,
                  residence: true,
                  phone: true,
                  hasNoPhone: true,
                  contactPhone: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 5000,
      }),
    );

    // Collect all citizen IDs to fetch their payment ledger summary in one go
    const citizenIds = Array.from(new Set(rows.map((r) => r.registration.citizen.id)));
    const payments =
      citizenIds.length > 0
        ? await withConnectionRetry(() =>
            this.db.citizenPayment.findMany({
              /*
                Their own bills, and the shared unit bills they are a debtor on
                (0099, D5): a shared bill is owed by each of its debtors until
                one pays it, so it stands in each one's standing.
              */
              where: {
                OR: [{ citizenId: { in: citizenIds } }, { debtors: { some: { citizenId: { in: citizenIds } } } }],
              },
              select: {
                citizenId: true,
                amount: true,
                paidAmount: true,
                paymentStatus: true,
                debtors: { select: { citizenId: true } },
              },
            }),
          )
        : [];

    const paymentsByCitizen = new Map<
      string,
      Array<{ amount: number; paidAmount: number; status: string }>
    >();
    const listed = new Set(citizenIds);
    for (const p of payments) {
      const holders = p.citizenId ? [p.citizenId] : p.debtors.map((debtor) => debtor.citizenId);
      for (const holder of holders.filter((id) => listed.has(id))) {
        const list = paymentsByCitizen.get(holder) ?? [];
        list.push({
          amount: Number(p.amount),
          paidAmount: Number(p.paidAmount),
          status: p.paymentStatus,
        });
        paymentsByCitizen.set(holder, list);
      }
    }

    /*
      One citizen's standing, folded once and reused.

      A citizen appears here once per card they hold, and a parcel may now carry
      several of theirs — a building, the house behind it, the shop on the
      street. Re-summing their whole payment history for each of those cards
      re-answers a question that has one answer per citizen, not one per card.
    */
    const financialsByCitizen = new Map<string, ParcelRegistrantFinancials>();
    const citizenFinancials = (citizenId: string): ParcelRegistrantFinancials => {
      const cached = financialsByCitizen.get(citizenId);
      if (cached) return cached;

      let totalBilled = 0;
      let totalPaid = 0;
      for (const cp of paymentsByCitizen.get(citizenId) ?? []) {
        totalBilled += cp.amount;
        totalPaid += cp.paidAmount;
      }
      const totalDue = Math.max(totalBilled - totalPaid, 0);

      const computed: ParcelRegistrantFinancials = {
        totalBilled,
        totalPaid,
        totalDue,
        paymentStatus:
          totalBilled === 0
            ? 'NO_BILLS'
            : totalDue === 0
              ? 'PAID'
              : totalPaid > 0
                ? 'PARTIALLY_PAID'
                : 'UNPAID',
      };

      financialsByCitizen.set(citizenId, computed);
      return computed;
    };

    // Keyed by رقم العقار: one entry per parcel, whatever is standing on it.
    const byParcel = new Map<string, RegisteredParcel>();
    /*
      Each parcel's registrants, indexed by citizen id.

      A keyed lookup rather than scanning `parcel.registrants` for every card:
      the scan is quadratic in the registrants on one parcel, and an apartment
      building — the case with the most cards on a single number — is exactly
      where that count is highest. Keyed on the parcel object itself so no
      separator has to be safe against whatever a رقم العقار contains.
    */
    const registrantsByParcel = new Map<RegisteredParcel, Map<string, ParcelRegistrant>>();

    for (const row of rows) {
      const citizenId = row.registration.citizen.id;
      const propertyNumber = row.propertyNumber!;

      /*
        One marker per parcel, at the parcel's own point.

        P5-T5 split this by censused structure and P5-T7 reverted it: the map
        already draws a **separate census layer** — an icon per building at its
        own entrance, coloured by survey status and ringed by damage — so
        splitting these too put a second dot on top of every building pin and
        said the same thing twice in two visual languages.

        This layer answers a question about the *plot*: «who is registered on
        عقار 403». Everyone on it belongs to one dot, whichever structure they
        are in, and the parcel's own coordinate is the honest position for an
        answer about the parcel.
      */
      let parcel = byParcel.get(propertyNumber);
      if (!parcel) {
        parcel = {
          propertyNumber,
          latitude: row.latitude!,
          longitude: row.longitude!,
          registrants: [],
          structureCount: 0,
        };
        byParcel.set(propertyNumber, parcel);
        registrantsByParcel.set(parcel, new Map());
      }
      const byCitizen = registrantsByParcel.get(parcel)!;

      const structure: ParcelStructure = {
        id: row.id,
        propertyType: row.propertyType,
        occupancyType: row.occupancyType,
        buildingName: row.buildingName,
        unitCount: row._count.units,
        unitType: row.unitType,
        // `!= null` rather than a truthiness test: a unit measured at zero is a
        // recorded measurement, not a missing one.
        unitArea: row.unitArea != null ? Number(row.unitArea) : null,
      };

      const existing = byCitizen.get(citizenId);

      if (existing) {
        existing.structures.push(structure);
        existing.unitCount += row._count.units;
      } else {
        const registrant: ParcelRegistrant = {
          citizenId,
          registrationId: row.registration.id,
          fullName: citizenDisplayName(row.registration.citizen),
          phone: row.registration.citizen.phone,
          hasNoPhone: row.registration.citizen.hasNoPhone,
          contactPhone: row.registration.citizen.contactPhone,
          occupancyType: row.occupancyType,
          propertyType: row.propertyType,
          buildingName: row.buildingName,
          registeredAt: row.registration.submittedAt.toISOString(),
          unitCount: row._count.units,
          financials: citizenFinancials(citizenId),
          structures: [structure],
        };

        parcel.registrants.push(registrant);
        byCitizen.set(citizenId, registrant);
      }

      parcel.structureCount += 1;
    }

    // Compute parcel-level aggregated financials (deduplicated by citizen)
    for (const parcel of byParcel.values()) {
      let parcelBilled = 0;
      let parcelPaid = 0;

      for (const reg of parcel.registrants) {
        if (reg.financials) {
          parcelBilled += reg.financials.totalBilled;
          parcelPaid += reg.financials.totalPaid;
        }
      }

      const parcelDue = Math.max(parcelBilled - parcelPaid, 0);
      let parcelStatus: 'PAID' | 'PARTIALLY_PAID' | 'UNPAID' | 'NO_BILLS' = 'NO_BILLS';
      if (parcelBilled === 0) {
        parcelStatus = 'NO_BILLS';
      } else if (parcelDue === 0) {
        parcelStatus = 'PAID';
      } else if (parcelPaid > 0) {
        parcelStatus = 'PARTIALLY_PAID';
      } else {
        parcelStatus = 'UNPAID';
      }

      parcel.financials = {
        totalBilled: parcelBilled,
        totalPaid: parcelPaid,
        totalDue: parcelDue,
        status: parcelStatus,
      };
    }

    return [...byParcel.values()];
  }

  /**
   * CSV export. Emits an audit event with the row count, because this is the
   * action that turns a governed dashboard into an ungoverned spreadsheet.
   */
  async exportCsv(input: {
    tenantSlug: string;
    actor: { id: string; role: string; email?: string };
  }): Promise<string> {
    const header = [
      'reference_number',
      'submitted_at',
      'citizen_name',
      'phone',
      'resident_status',
      'total_registered_members',
      'actual_household_members',
      'property_number',
      'property_type',
      'occupancy_type',
      'building_name',
      'unit_type',
      'floor',
      'unit_area',
      // Empty for every row recorded before حالة الوحدة existed and for every
      // card whose occupant was not its owner — an absence, not an OCCUPIED.
      // A reader summing this column has to treat blank as "not asked", the
      // same way the assessment does.
      'unit_status',
      // When the tenancy on this line ended (migration 0046). Blank is current;
      // a line with a date is history and holds nothing today.
      'ended_at',
      // «لا يملك رقم هاتف» and «رقم للتواصل» (0069), last so no column moves:
      // a blank `phone` with `has_no_phone` true is an answer, and the contact
      // number is a relative's, never the citizen's own.
      'has_no_phone',
      'contact_phone_relative',
    ];

    const lines = [header.join(',')];
    const BATCH_SIZE = 500;
    let offset = 0;
    let totalProcessed = 0;

    while (true) {
      const rows = await this.db.registration.findMany({
        skip: offset,
        take: BATCH_SIZE,
        include: {
          citizen: {
            select: {
              firstName: true,
              middleName: true,
              lastName: true,
              residence: true,
              phone: true,
              hasNoPhone: true,
              contactPhone: true,
              residentStatus: true,
              totalRegisteredMembers: true,
              actualHouseholdMembers: true,
            },
          },
          properties: {
            select: {
              propertyNumber: true,
              propertyType: true,
              occupancyType: true,
              unitArea: true,
              unitStatus: true,
              buildingName: true,
              endedAt: true,
              units: {
                select: { unitType: true, floor: true, unitArea: true, unitStatus: true, endedAt: true },
              },
            },
          },
        },
        orderBy: { submittedAt: 'desc' },
      });

      if (rows.length === 0) break;
      totalProcessed += rows.length;

      for (const row of rows) {
        // «ورثة المرحوم …» for an estate (0076), as on every screen.
        const name = citizenDisplayName(row.citizen);

        // One line per property, so a citizen with three properties produces three
        // rows — municipality staff filter by property, not by person. A building
        // goes one further and emits a line per unit: the whole point of owning
        // one is that it holds several, and a single row would report the parcel
        // while hiding everything inside it.
        const properties = row.properties.length > 0 ? row.properties : [null];

        for (const property of properties) {
          const units =
            property && property.units.length > 0
              ? property.units
              : [null];

          for (const unit of units) {
            lines.push(
              [
                row.referenceNumber,
                row.submittedAt.toISOString(),
                name,
                row.citizen.phone ?? '',
                row.citizen.residentStatus ?? '',
                row.citizen.totalRegisteredMembers ?? '',
                row.citizen.actualHouseholdMembers ?? '',
                property?.propertyNumber ?? '',
                property?.propertyType ?? '',
                property?.occupancyType ?? '',
                property?.buildingName ?? '',
                unit?.unitType ?? '',
                unit?.floor ?? '',
                // The area lives on the unit for a building and on the property
                // itself for everything else.
                (unit?.unitArea ?? property?.unitArea)?.toString() ?? '',
                // Same split, same reason — a building states it per unit.
                unit?.unitStatus ?? property?.unitStatus ?? '',
                (unit?.endedAt ?? property?.endedAt)?.toISOString() ?? '',
                row.citizen.hasNoPhone ? 'true' : 'false',
                row.citizen.contactPhone ?? '',
              ]
                .map(csvCell)
                .join(','),
            );
          }
        }
      }

      offset += rows.length;
      if (rows.length < BATCH_SIZE) break;
    }

    this.events.emit('report.exported', {
      tenantSlug: input.tenantSlug,
      actorId: input.actor.id,
      actorRole: input.actor.role,
      actorEmail: input.actor.email,
      rowCount: totalProcessed,
    });

    return lines.join('\n');
  }

  /**
   * Cache invalidation, event-driven like the audit trail: this service does
   * not know which feature just wrote data, only that everything under the
   * tenant's `dashboard:` namespace is now stale — counters, map parcels, and
   * RegistrationService's cached list table all share that one prefix, so a
   * single wildcard delete clears all three without a listener per cache key.
   * Listeners run inside the emitting request's tenant scope (see
   * app.module.ts), so this needs no tenant slug from the event payload.
   */
  @OnEvent('registration.submitted')
  @OnEvent('cadastre.imported')
  /** A staff edit rewrites the very profile this caches under `citizen:{id}`. */
  @OnEvent('citizen.changed')
  /**
   * The profile now carries the citizen's invoices, so money events stale it
   * too. Without these three a clerk who has just confirmed a payment reloads
   * the profile and still sees the fee outstanding — for the whole TTL, which
   * is five minutes in the shipped config and reads as "the confirmation did
   * not save".
   */
  @OnEvent('fee.issued')
  @OnEvent('payment.declared')
  @OnEvent('payment.reviewed')
  /** A reversal moves the same totals back, so it stales the same caches. */
  @OnEvent('payment.reversed')
  /** A cancelled bill leaves what is owed, so it stales them too. */
  @OnEvent('payment.cancelled')
  /** A municipal request raising its fee is a new bill on the citizen's profile and the totals (0092). */
  @OnEvent('request.bill.raised')
  /** An approved old-debts batch, or one linked line, raises bills on citizens' files (task 5). */
  @OnEvent('arrears.bills.raised')
  /**
   * The census moves the map, so the census has to clear the map's cache.
   *
   * This was missing and became visible the moment `getRegisteredParcels`
   * started positioning its markers on `Building.latitude/longitude` instead of
   * the parcel centroid: an officer places a building's entrance, reloads the
   * map, and the dot does not move — for the whole TTL, which is five minutes
   * in the shipped config and reads exactly like the pin having failed to save.
   *
   * `building.changed` covers every write in `BuildingsService` and
   * `CensusSyncService` — created, edited, deleted, units generated, occupancy
   * recorded or ended, a visit logged, a code recomputed — and each of those
   * can change what a marker is, where it sits, or who is listed under it.
   */
  @OnEvent('building.changed')
  /**
   * Damage is drawn as the ring on every census pin and counted on the ledger's
   * «مبانٍ متضررة» tile, so an assessment recorded in the field is stale data on
   * two screens until this fires.
   */
  @OnEvent('damage.recorded')
  async onDashboardDataChanged(): Promise<void> {
    /*
      From inside a transaction, cleared once it commits. Cleared before, a read
      in between re-caches the state the transaction is about to replace, and
      serves it for the whole TTL.
    */
    const prefix = dashboardCacheKey(this.tenantContext.tenantSlug, '');
    const transaction = this.tenantContext.peek()?.transaction;
    if (transaction) {
      transaction.afterCommit.push(() => this.cache.invalidatePrefix(prefix));
      return;
    }
    await this.cache.invalidatePrefix(prefix);
  }
}

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
   * إجمالي الأبناء المتزوجين المؤسسين لأسر — sum(totalRegisteredMembers -
   * actualHouseholdMembers): how much of the gross registry total is married
   * children who no longer live in the household they're still filed under.
   */
  marriedOffspringTotal: number;
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
export interface ParcelRegistrantFinancials {
  totalBilled: number;
  totalPaid: number;
  totalDue: number;
  paymentStatus: 'PAID' | 'PARTIALLY_PAID' | 'UNPAID' | 'NO_BILLS';
}

/** One structure/card registered against a parcel — a building, house, shop, or plot. */
export interface ParcelStructure {
  id: string;
  propertyType: string;
  occupancyType: string;
  buildingName: string | null;
  unitCount: number;
  unitType?: string | null;
  unitArea?: number | null;
}

export interface ParcelRegistrant {
  citizenId: string;
  registrationId: string;
  fullName: string;
  phone: string | null;
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

export interface ParcelFinancials {
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

/** One unit inside a BUILDING — شقة, عيادة or محل. */
export interface CitizenProfileUnit {
  id: string;
  /**
   * Nullable since migration 0031 — a per-unit «غير مؤكَّد» flag blanks the
   * field it excuses, so the review screen has to be able to render a flat the
   * officer could not fully describe. Null here means "not established", never
   * "zero"; the reason is on the registration's `flaggedFields`.
   */
  unitType: string | null;
  floor: string | null;
  side: string | null;
  unitArea: number | null;
  sharedRights: string[];
  /** حالة الوحدة — set by the building's owner. Null on a tenant's own card. */
  unitStatus: string | null;
}

/**
 * A property card as the citizen filed it.
 *
 * Everything the wizard's four property branches can collect is here, not just
 * the fields common to all of them: staff reviewing a claim were previously
 * shown a tenant's property with no landlord on it, a plot with no land type,
 * a tent with no location, and a building reduced to a unit *count* — all of
 * it stored correctly and simply never selected.
 */
export interface CitizenProfileProperty {
  id: string;
  /**
   * Null when the officer recorded الحي or رقم العقار as «غير مؤكَّد».
   *
   * The profile is the record as it actually stands, so an absence shows as an
   * absence rather than as an empty string that reads like a rendering bug —
   * the registration's own flag list is what says why.
   */
  neighborhood: string | null;
  propertyNumber: string | null;
  propertyType: string;
  occupancyType: string;
  /**
   * Non-owner occupancies only. The name is required of both a مستأجر and a
   * شاغل بتسامح; the phone only of the first — see `occupancyBranch`.
   */
  landlordName: string | null;
  landlordPhone: string | null;
  /** HOUSE only, owner only, and null wherever nobody was asked. */
  unitStatus: string | null;
  buildingName: string | null;
  /** HOUSE/LAND carry these directly; a BUILDING keeps them per unit below. */
  unitType: string | null;
  landType: string | null;
  floor: string | null;
  side: string | null;
  tentLocation: string | null;
  unitArea: number | null;
  sharedRights: string[];
  latitude: number | null;
  longitude: number | null;
  unitCount: number;
  units: CitizenProfileUnit[];
}

export interface CitizenProfileDocument {
  id: string;
  type: string;
  mimeType: string;
  sizeBytes: number;
  propertyEntryId: string | null;
  createdAt: string;
}

export interface CitizenProfileRegistration {
  id: string;
  referenceNumber: string;
  submittedAt: string;
  /** `REQUIRES_REVIEW` when `flags` is non-empty; `PENDING` otherwise. */
  status: string;
  flags: Array<{ path: string; reason: string }>;
  properties: CitizenProfileProperty[];
  documents: CitizenProfileDocument[];
}

/**
 * The stored flags, read back without trusting the json column's shape.
 *
 * Same reasoning as `CitizensService.readFlags` — an entry missing either half
 * is dropped, because a flag with no reason is the exact thing this feature
 * exists to prevent and rendering one would report the gap as explained when
 * nobody explained it. Duplicated rather than shared because these two
 * services deliberately have no dependency between them.
 */
function readRegistrationFlags(value: unknown): Array<{ path: string; reason: string }> {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { path, reason } = entry as Record<string, unknown>;
    if (typeof path !== 'string' || typeof reason !== 'string') return [];
    return [{ path, reason }];
  });
}

/** One invoice on the citizen's profile — the same shape the portal shows them. */
export interface CitizenProfilePayment {
  id: string;
  title: string;
  amount: number;
  /** Received so far — below `amount` on a part-settled invoice. */
  paidAmount: number;
  /** `amount - paidAmount`, floored at zero. */
  remaining: number;
  currency: string;
  dueDate: string;
  /** `OVERDUE` is derived from the due date on read, never stored. */
  paymentStatus: string;
  paymentMethod: string | null;
  whishTransactionRef: string | null;
  paidAt: string | null;
  reviewNote: string | null;
  frequency: string | null;
}

/**
 * Where this citizen stands with the municipality's fees.
 *
 * `overdueTotal` is the unpaid amount whose due date has passed. This system
 * levies no penalty on top of a late fee, so a late fee *is* the unpaid fee —
 * reported as its own total because "owes 400,000" and "owes 400,000, all of
 * it late" are different conversations at the counter.
 */
export interface CitizenFeeTotals {
  feesTotal: number;
  paidTotal: number;
  outstandingTotal: number;
  overdueTotal: number;
  overdueCount: number;
  pendingReviewCount: number;
}

/** The staff-facing view of one citizen and everything they have filed. */
export interface CitizenProfile {
  id: string;
  fullName: string;
  phone: string | null;
  whatsapp: string | null;
  gender: string | null;
  nationality: string | null;
  isLebanese: boolean | null;
  residencyNumber: string | null;
  residentStatus: string | null;
  identityDocType: string | null;
  identityDocNumber: string | null;
  civilRecordNumber: string | null;
  totalRegisteredMembers: number | null;
  actualHouseholdMembers: number | null;
  marriedChildrenCount: number | null;
  maritalStatus: string | null;
  bloodType: string | null;
  referenceNumber: string | null;
  /** نوع الملف — a household, or «غير مقيم في البلدة» (stored as NON_RESIDENT_OWNER). */
  residence: string;
  residencePlace: string | null;
  localContactName: string | null;
  localContactPhone: string | null;
  registeredAt: string;
  /** False for a deactivated record — kept for its history, refused a session. */
  isActive: boolean;
  registrations: CitizenProfileRegistration[];
  payments: CitizenProfilePayment[];
  fees: CitizenFeeTotals;
}

/**
 * Read side of the dashboard.
 *
 * These are `groupBy` aggregates and multi-table reads over tables with
 * thousands of rows per municipality, which Postgres alone answers in
 * single-digit milliseconds — but admins hit `counters`, `map`, `map/parcels`
 * and a citizen's profile repeatedly (dashboard polling, re-opening the same
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
    return this.config.get<number>('DASHBOARD_CACHE_TTL_SECONDS') ?? 60;
  }

  /** Namespaced per tenant so one municipality's cache entries can be
   * invalidated, or simply expire, without touching any other's. */
  private cacheKey(name: string): string {
    return `dashboard:${this.tenantContext.tenantSlug}:${name}`;
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
             FROM (SELECT "propertyType", count(*)::int AS cnt FROM ${this.S}property_entries GROUP BY "propertyType") p
          ) AS "byPropertyType",
          (SELECT COALESCE(json_object_agg("residentStatus", cnt), '{}'::json)
             FROM (
               SELECT "residentStatus", count(*)::int AS cnt FROM ${this.S}users
               WHERE kind = 'CITIZEN' AND residence = 'RESIDENT' AND "residentStatus" IS NOT NULL
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
    type AnalyticsRow = Omit<DashboardAnalytics, 'duplicateFilingsExcluded'> & {
      duplicatePropertiesExcluded: number;
      duplicateUnitsExcluded: number;
    };

    const [row] = await withConnectionRetry(() =>
      this.db.$queryRaw<AnalyticsRow[]>`
        WITH owned_parcels AS (
          SELECT DISTINCT "propertyNumber" FROM ${this.S}property_entries
           WHERE "occupancyType" = 'OWNER' AND "propertyNumber" IS NOT NULL
        ),
        -- A TENANT/FREE_OCCUPANT filing of a unit whose رقم العقار some OWNER
        -- already registered under: the same apartment, filed twice — once by
        -- whoever owns it, once by whoever rents it. Excluded from every
        -- property/unit count below so it counts once, not twice.
        excluded_entries AS (
          SELECT pe.* FROM ${this.S}property_entries pe
           WHERE pe."occupancyType" <> 'OWNER'
             AND pe."propertyNumber" IS NOT NULL
             AND EXISTS (SELECT 1 FROM owned_parcels op WHERE op."propertyNumber" = pe."propertyNumber")
        ),
        countable_entries AS (
          SELECT pe.* FROM ${this.S}property_entries pe
           WHERE pe.id NOT IN (SELECT id FROM excluded_entries)
        )
        SELECT
          -- Households only. A non-resident record («غير مقيم في البلدة», migration 0040)
          -- is somebody who lives elsewhere: counting them — or whatever
          -- household size a file converted to a non-resident record still carries —
          -- would put people in the town's population who are not in the town.
          -- The residence column is NOT NULL, so this comparison drops no existing row.
          (SELECT count(*)::int FROM ${this.S}users WHERE kind = 'CITIZEN' AND residence = 'RESIDENT')
            AS "citizenRecords",
          (SELECT COALESCE(sum("actualHouseholdMembers"), 0)::int FROM ${this.S}users
            WHERE kind = 'CITIZEN' AND residence = 'RESIDENT')
            AS "populationTotal",
          (SELECT COALESCE(sum("totalRegisteredMembers"), 0)::int FROM ${this.S}users
            WHERE kind = 'CITIZEN' AND residence = 'RESIDENT')
            AS "grossRegisteredTotal",
          (SELECT COALESCE(sum("totalRegisteredMembers" - "actualHouseholdMembers"), 0)::int
             FROM ${this.S}users
            WHERE kind = 'CITIZEN'
              AND residence = 'RESIDENT'
              AND "totalRegisteredMembers" IS NOT NULL
              AND "actualHouseholdMembers" IS NOT NULL)
            AS "marriedOffspringTotal",
          (SELECT count(*)::int FROM ${this.S}users
            WHERE kind = 'CITIZEN' AND residence = 'RESIDENT' AND "actualHouseholdMembers" IS NULL)
            AS "householdsWithoutSize",
          (SELECT COALESCE(
                    json_agg(json_build_object('size', size, 'households', c) ORDER BY size),
                    '[]'::json)
             FROM (SELECT "actualHouseholdMembers" AS size, count(*)::int AS c
                     FROM ${this.S}users
                    WHERE kind = 'CITIZEN' AND residence = 'RESIDENT' AND "actualHouseholdMembers" IS NOT NULL
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
                            GROUP BY 1
                           UNION ALL
                           SELECT "unitType"::text, count(*)::int
                             FROM countable_entries WHERE "unitType" IS NOT NULL GROUP BY 1) u
                    GROUP BY 1) x)
            AS "unitsByType",
          (SELECT ((SELECT count(*) FROM ${this.S}building_units bu
                      JOIN countable_entries ce ON ce.id = bu."propertyEntryId")
                 + (SELECT count(*) FROM countable_entries WHERE "unitType" IS NOT NULL))::int)
            AS "unitTotal",
          (SELECT count(*)::int FROM excluded_entries)
            AS "duplicatePropertiesExcluded",
          (SELECT (SELECT count(*)::int FROM excluded_entries WHERE "unitType" IS NOT NULL)
                + (SELECT count(*)::int FROM ${this.S}building_units bu
                     JOIN excluded_entries ee ON ee.id = bu."propertyEntryId"))
            AS "duplicateUnitsExcluded",
          COALESCE((SELECT sum(amount) FROM ${this.S}citizen_payments), 0)::float8
            AS "billedTotal",
          COALESCE((SELECT sum("paidAmount") FROM ${this.S}citizen_payments), 0)::float8
            AS "collectedTotal",
          COALESCE((SELECT sum(amount - "paidAmount") FROM ${this.S}citizen_payments
                     WHERE "paymentStatus" <> 'PAID'), 0)::float8
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
                      COALESCE(sum(p.amount), 0)::float8 AS billed,
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

    const { duplicatePropertiesExcluded, duplicateUnitsExcluded, ...rest } = row;
    return {
      ...rest,
      duplicateFilingsExcluded: {
        properties: duplicatePropertiesExcluded,
        units: duplicateUnitsExcluded,
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
   * Everything staff see on one citizen's page: who they are, and every
   * property they have filed.
   *
   * Returns null rather than throwing so the controller decides the HTTP shape
   * — this layer has no opinion about 404s.
   */
  async getCitizenProfile(citizenId: string): Promise<CitizenProfile | null> {
    const key = this.cacheKey(`citizen:${citizenId}`);
    const cached = await this.cache.get<CitizenProfile>(key);
    if (cached) return cached;

    const profile = await this.computeCitizenProfile(citizenId);
    // A missing citizen isn't cached: caching the 404 would keep serving it
    // for the TTL window even after the citizen is created moments later.
    if (profile) await this.cache.set(key, profile, this.cacheTtlSeconds);
    return profile;
  }

  private async computeCitizenProfile(citizenId: string): Promise<CitizenProfile | null> {
    const citizen = await withConnectionRetry(() => this.db.user.findFirst({
      // `kind` is part of the filter, not an afterthought: without it a staff
      // id in the URL would render a staff member through the citizen view.
      where: { id: citizenId, kind: 'CITIZEN' },
      select: {
        id: true,
        firstName: true,
        middleName: true,
        lastName: true,
        phone: true,
        whatsapp: true,
        gender: true,
        nationality: true,
        isLebanese: true,
        residencyNumber: true,
        residentStatus: true,
        identityDocType: true,
        identityDocNumber: true,
        civilRecordNumber: true,
        totalRegisteredMembers: true,
        actualHouseholdMembers: true,
        maritalStatus: true,
        bloodType: true,
        referenceNumber: true,
        residence: true,
        residencePlace: true,
        localContactName: true,
        localContactPhone: true,
        isActive: true,
        createdAt: true,
        /**
         * The citizen's ledger, alongside their claims rather than a page
         * away. Staff reviewing a registration are routinely also the people
         * asked "what do I owe?", and until now the answer lived only on the
         * fees screen, keyed by a name they had to search for again.
         */
        payments: {
          orderBy: [{ paymentStatus: 'asc' }, { dueDate: 'asc' }],
          select: {
            id: true,
            title: true,
            amount: true,
            paidAmount: true,
            currency: true,
            dueDate: true,
            paymentStatus: true,
            paymentMethod: true,
            whishTransactionRef: true,
            paidAt: true,
            reviewNote: true,
            feeNotice: { select: { frequency: true } },
          },
        },
        registrations: {
          orderBy: { submittedAt: 'desc' },
          select: {
            id: true,
            referenceNumber: true,
            submittedAt: true,
            status: true,
            flaggedFields: true,
            notes: true,
            properties: {
              select: {
                id: true,
                neighborhood: true,
                propertyNumber: true,
                propertyType: true,
                occupancyType: true,
                landlordName: true,
                landlordPhone: true,
                unitStatus: true,
                buildingName: true,
                unitType: true,
                landType: true,
                floor: true,
                side: true,
                tentLocation: true,
                unitArea: true,
                sharedRights: true,
                latitude: true,
                longitude: true,
                /*
                  The censused structure behind the card, when there is one.

                  Two fields and they are not interchangeable (D14): `code` is
                  the municipality's own `ZONE-PARCEL-SUFFIX`, and
                  `postedNumber` is what is actually painted on the building.
                  A notice prints both, because where they disagree the
                  collector standing in the street trusts the paint.
                */
                buildingId: true,
                building: { select: { code: true, postedNumber: true } },
                // The units themselves, not just how many: a landlord's claim
                // over a building *is* the unit list, and a bare count told a
                // reviewer nothing about which floors were being claimed.
                units: {
                  orderBy: { createdAt: 'asc' },
                  select: {
                    id: true,
                    unitType: true,
                    floor: true,
                    side: true,
                    unitArea: true,
                    sharedRights: true,
                    unitStatus: true,
                    unitId: true,
                    unit: { select: { unitCode: true, postedNumber: true } },
                  },
                },
              },
            },
            // Staff previously had no way to see a citizen's uploaded proofs
            // from this page at all — the documents existed (uploaded and
            // stored correctly) but were never queried here.
            documents: {
              select: {
                id: true,
                type: true,
                mimeType: true,
                sizeBytes: true,
                propertyEntryId: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    }));

    if (!citizen) return null;

    const now = new Date();

    // OVERDUE is derived here for the same reason `FeesService` derives it: a
    // status written by a nightly job is wrong for every hour between a due
    // date passing and the job next running.
    const payments = citizen.payments.map((payment) => ({
      id: payment.id,
      title: payment.title,
      amount: Number(payment.amount),
      paidAmount: Number(payment.paidAmount),
      remaining: Math.max(Number(payment.amount) - Number(payment.paidAmount), 0),
      currency: payment.currency,
      dueDate: payment.dueDate.toISOString(),
      paymentStatus:
        payment.paymentStatus === 'UNPAID' && payment.dueDate < now
          ? 'OVERDUE'
          : payment.paymentStatus,
      paymentMethod: payment.paymentMethod,
      whishTransactionRef: payment.whishTransactionRef,
      paidAt: payment.paidAt?.toISOString() ?? null,
      reviewNote: payment.reviewNote,
      frequency: payment.feeNotice?.frequency ?? null,
    }));

    // Summed from the rows just mapped rather than by a second set of
    // aggregate queries: the totals and the list a reviewer reads them against
    // then cannot disagree, which they could if one was cached a moment apart
    // from the other.
    // `field` rather than always `amount`, because since partial payments the
    // three totals below measure different columns: what was billed, what has
    // been received, and what is still owed.
    const sum = (rows: typeof payments, field: 'amount' | 'paidAmount' | 'remaining') =>
      rows.reduce((total, payment) => total + payment[field], 0);
    const overdue = payments.filter((payment) => payment.paymentStatus === 'OVERDUE');

    return {
      id: citizen.id,
      fullName: [citizen.firstName, citizen.middleName, citizen.lastName]
        .filter(Boolean)
        .join(' '),
      phone: citizen.phone,
      whatsapp: citizen.whatsapp,
      gender: citizen.gender,
      nationality: citizen.nationality,
      isLebanese: citizen.isLebanese,
      residencyNumber: citizen.residencyNumber,
      residentStatus: citizen.residentStatus,
      identityDocType: citizen.identityDocType,
      identityDocNumber: citizen.identityDocNumber,
      civilRecordNumber: citizen.civilRecordNumber,
      totalRegisteredMembers: citizen.totalRegisteredMembers,
      actualHouseholdMembers: citizen.actualHouseholdMembers,
      marriedChildrenCount:
        citizen.totalRegisteredMembers != null && citizen.actualHouseholdMembers != null
          ? citizen.totalRegisteredMembers - citizen.actualHouseholdMembers
          : null,
      maritalStatus: citizen.maritalStatus,
      bloodType: citizen.bloodType,
      referenceNumber: citizen.referenceNumber,
      residence: citizen.residence,
      residencePlace: citizen.residencePlace,
      localContactName: citizen.localContactName,
      localContactPhone: citizen.localContactPhone,
      registeredAt: citizen.createdAt.toISOString(),
      isActive: citizen.isActive,
      payments,
      fees: {
        feesTotal: sum(payments, 'amount'),
        // Every pound received, across all rows — a part-payment sitting on an
        // UNPAID invoice is money the municipality has, and filtering to PAID
        // would leave it out.
        paidTotal: sum(payments, 'paidAmount'),
        // What is left on rows not fully settled, not their face value.
        outstandingTotal: sum(
          payments.filter((payment) => payment.paymentStatus !== 'PAID'),
          'remaining',
        ),
        overdueTotal: sum(overdue, 'remaining'),
        overdueCount: overdue.length,
        pendingReviewCount: payments.filter(
          (payment) => payment.paymentStatus === 'PENDING_REVIEW',
        ).length,
      },
      registrations: citizen.registrations.map((registration) => ({
        id: registration.id,
        referenceNumber: registration.referenceNumber,
        submittedAt: registration.submittedAt.toISOString(),
        status: registration.status,
        /**
         * The «غير مؤكَّد» fields and the reason given for each.
         *
         * On the profile rather than only on the edit form because this is the
         * page a collector opens before knocking on a door: "we have no phone
         * number for this household, and here is why" is exactly what they
         * need before setting out, and it is not something to discover by
         * opening the record for editing.
         */
        flags: readRegistrationFlags(registration.flaggedFields),
        /*
          «ملاحظات» — on the profile for the same reason the flags above are.

          This is the page a collector opens before knocking on a door, and a
          note is frequently the single most useful thing on it: «الأسرة تنتقل
          نهاية الشهر» or «الدرج مكسور، الزيارة القادمة من الخلف» is what the
          last officer learned by standing there. A note visible only inside
          the edit form is a note nobody reads before setting out.
        */
        notes: registration.notes,
        properties: registration.properties.map((property) => ({
          id: property.id,
          neighborhood: property.neighborhood,
          propertyNumber: property.propertyNumber,
          propertyType: property.propertyType,
          occupancyType: property.occupancyType,
          landlordName: property.landlordName,
          landlordPhone: property.landlordPhone,
          unitStatus: property.unitStatus,
          buildingName: property.buildingName,
          unitType: property.unitType,
          landType: property.landType,
          floor: property.floor,
          side: property.side,
          tentLocation: property.tentLocation,
          // Decimal → number at the edge; `Decimal` serialises as an object,
          // which the client would render as "[object Object]".
          unitArea: property.unitArea == null ? null : Number(property.unitArea),
          sharedRights: property.sharedRights,
          latitude: property.latitude,
          longitude: property.longitude,
          buildingId: property.buildingId,
          buildingCode: property.building?.code ?? null,
          buildingPostedNumber: property.building?.postedNumber ?? null,
          unitCount: property.units.length,
          units: property.units.map((unit) => ({
            id: unit.id,
            unitType: unit.unitType,
            floor: unit.floor,
            side: unit.side,
            unitArea: unit.unitArea == null ? null : Number(unit.unitArea),
            sharedRights: unit.sharedRights,
            unitStatus: unit.unitStatus,
            unitId: unit.unitId,
            unitCode: unit.unit?.unitCode ?? null,
            unitPostedNumber: unit.unit?.postedNumber ?? null,
          })),
        })),
        documents: registration.documents.map((document) => ({
          id: document.id,
          type: document.type,
          mimeType: document.mimeType,
          sizeBytes: document.sizeBytes,
          propertyEntryId: document.propertyEntryId,
          createdAt: document.createdAt.toISOString(),
        })),
      })),
    };
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
          _count: { select: { units: true } },
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
                  phone: true,
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
              where: { citizenId: { in: citizenIds } },
              select: {
                citizenId: true,
                amount: true,
                paidAmount: true,
                paymentStatus: true,
              },
            }),
          )
        : [];

    const paymentsByCitizen = new Map<
      string,
      Array<{ amount: number; paidAmount: number; status: string }>
    >();
    for (const p of payments) {
      const list = paymentsByCitizen.get(p.citizenId) ?? [];
      list.push({
        amount: Number(p.amount),
        paidAmount: Number(p.paidAmount),
        status: p.paymentStatus,
      });
      paymentsByCitizen.set(p.citizenId, list);
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
          fullName: [
            row.registration.citizen.firstName,
            row.registration.citizen.middleName,
            row.registration.citizen.lastName,
          ]
            .filter(Boolean)
            .join(' '),
          phone: row.registration.citizen.phone,
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
              phone: true,
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
              units: {
                select: { unitType: true, floor: true, unitArea: true, unitStatus: true },
              },
            },
          },
        },
        orderBy: { submittedAt: 'desc' },
      });

      if (rows.length === 0) break;
      totalProcessed += rows.length;

      for (const row of rows) {
        const name = [row.citizen.firstName, row.citizen.middleName, row.citizen.lastName]
          .filter(Boolean)
          .join(' ');

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
    await this.cache.invalidatePrefix(`dashboard:${this.tenantContext.tenantSlug}:`);
  }
}

/**
 * Quotes a CSV field, and neutralises formula injection.
 *
 * Arabic names are fine, but a value starting with =, +, - or @ is executed by
 * Excel when a staff member opens the export — a field a citizen controls should
 * not be able to run a formula on a municipality clerk's machine.
 */
function csvCell(value: unknown): string {
  const text = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

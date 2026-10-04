import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  adminCreateCitizenSchema,
  buildCitizenPayload,
  cadastreFlags,
  FIELD_FLAG_KINDS,
  flaggedPaths,
  formatUnitCode,
  IMPORT_COLUMNS,
  internationalPhone,
  POSSIBLE_DUPLICATE_FLAG_PATH,
  statusForFlags,
} from '@mechanization/shared-schemas';
import type {
  AdminCitizenSubmission,
  AdminCitizenUpdateSubmission,
  CitizenImportResult,
  CitizenImportRowResult,
  CitizenRecordStatus,
  FieldFlag,
  ImportRow,
  PossibleDuplicatesQuery,
} from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { withConnectionRetry } from '../../../infrastructure/prisma/with-connection-retry';
import { likePattern, searchTokens } from '../../common/search-terms';
import { Prisma } from '../../../generated/tenant-client';
import { PropertyEntry, PropertyType } from '../../../domain/entities/property-entry.entity';
import { ReferenceNumber } from '../../../domain/value-objects/reference-number.vo';
import { PARCEL_REPOSITORY } from '../../../domain/interfaces/base-repository.interface';
import type {
  ParcelLocation,
  ParcelRepository,
} from '../../../domain/interfaces/parcel-repository.interface';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { fileChanges, highImpactChanges, type EditableFileView, type FileChanges } from './file-changes';
import { CensusSyncService, type CardEnding } from '../buildings/census-sync.service';
import {
  LandlordLinkService,
  type LandlordProposal,
  type PendingEvent,
  type ReconcileResult,
  type RevertReport,
} from './landlord-link.service';
import { AuditService, type CitizenChange } from '../audit/audit.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import {
  identityDocumentOf,
  RegistrationService,
  unestablishedOnCard,
} from '../registration/registration.service';
import { TenantService } from '../tenant/tenant.service';
import { REVIEW_AUDIT_ACTIONS } from '../quality/record-review.service';
import {
  assessFindings,
  hasFindings,
  NO_FINDINGS,
  outstandingFindings,
  possibleDuplicateFlag,
  type DuplicateCandidate,
  type DuplicateReviewFindings,
} from './possible-duplicates';
import { normalizeSearchText } from '../../common/search-terms';
import { assertNotMergedAway } from './merged-away';

/**
 * The most register rows one duplicate lookup compares.
 *
 * The lookup is blocked on the phone and on the name parts, so this is only
 * reached by a very common first name in a very large municipality. Comparing
 * in the application is cheap; this bounds the read.
 */
const MAX_DUPLICATE_LOOKUP_ROWS = 1000;

/** A page of the registry beyond this is a report, not a screen. */
const MAX_LIST_ROWS = 500;

/**
 * Turns a Zod issue path into the Arabic column header the clerk sees.
 *
 * The message alone ("الطابق مطلوب") is not enough to act on when the file has
 * twenty-nine columns: the clerk needs to know which one to look at. Paths are
 * nested (`properties.0.units.0.floor`) while the spreadsheet is flat, so the
 * leaf name is what identifies the column — except inside `units`, where the
 * flat template prefixes the header to keep it distinct from the property's own
 * `side`/`unitArea`.
 */
function columnHeaderFor(path: ReadonlyArray<string | number> | undefined): string | undefined {
  if (!path || path.length === 0) return undefined;

  const leaf = path.filter((segment) => typeof segment === 'string').at(-1);
  if (!leaf) return undefined;

  const key = path.includes('units') && leaf === 'floor' ? 'unitFloor' : leaf;
  return IMPORT_COLUMNS.find((column) => column.key === key)?.header;
}

/**
 * The stored «غير مؤكَّد» flags, read back defensively.
 *
 * `flaggedFields` is a json column, so Prisma's type for it is "any json" and
 * the database will hand back whatever was written — including `[]` from the
 * default, and, for a row written before this column existed, nothing at all.
 * Rather than trusting the shape, entries that do not carry both a path and a
 * reason are dropped: a flag with no reason is precisely the thing this feature
 * exists to prevent, and showing one would misreport the record as explained.
 */
function readFlags(value: unknown): FieldFlag[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { path, reason, kind } = entry as Record<string, unknown>;
    if (typeof path !== 'string' || typeof reason !== 'string') return [];

    /*
      An unreadable `kind` reads as `UNESTABLISHED`, which is both the value
      every row written before the column split carried and the safer of the
      two to guess: it shows the field as blank-and-explained, which is what
      those rows actually are. Guessing `UNVERIFIED` would put a "we have a
      value" badge on a field holding nothing.
    */
    const flagKind = FIELD_FLAG_KINDS.find((candidate) => candidate === kind) ?? 'UNESTABLISHED';
    return [{ path, reason, kind: flagKind }];
  });
}

/**
 * One row of the staff citizens registry.
 *
 * Deliberately flat and pre-aggregated: this is what a table renders, so the
 * money columns arrive as totals rather than as an invoice array the browser
 * would have to sum per row — which is the version that quietly becomes an
 * N+1 the first time someone adds a filter.
 */
export interface CitizenListItem {
  id: string;
  fullName: string;
  phone: string | null;
  whatsapp: string | null;
  gender: string | null;
  referenceNumber: string | null;
  identityDocType: string | null;
  identityDocNumber: string | null;
  residentStatus: string | null;
  /** نوع الملف — a household file, or «غير مقيم في البلدة» (stored as NON_RESIDENT_OWNER). */
  residence: string;
  isActive: boolean;
  /**
   * The file «دمج ملفين» folded this one into, while that merge stands. Every
   * screen that offers people for picking skips a file carrying it, and the
   * register shows where the person is now.
   */
  mergedIntoId: string | null;
  registeredAt: string;

  registrationCount: number;
  propertyCount: number;
  /** Status of the most recent registration, or null for a citizen with none. */
  latestStatus: string | null;
  latestSubmittedAt: string | null;
  /**
   * How many fields on that registration were left «غير مؤكَّد».
   *
   * The registry shows the count rather than the flags themselves — the list
   * answers "how much of this record is missing", the record's own page
   * answers "which parts, and why".
   */
  unestablishedFieldCount: number;

  /** Everything ever billed to this citizen. */
  feesTotal: number;
  paidTotal: number;
  /** Billed and not yet confirmed paid — includes claims awaiting a clerk. */
  outstandingTotal: number;
  /**
   * The slice of `outstandingTotal` whose due date has passed — المتأخرات.
   *
   * Derived from `dueDate < now()` at read time for the same reason
   * `FeesService` derives the OVERDUE status that way: a stored flag is wrong
   * for every hour between a due date passing and a job next running. This
   * system charges no penalty on top, so a late fee *is* the unpaid fee — it
   * is reported separately here because "owes 400,000" and "owes 400,000, all
   * of it late" are different conversations at the counter.
   */
  overdueTotal: number;
  overdueCount: number;
  pendingReviewCount: number;
}

/** A shape the raw list query returns, before ISO/Number normalisation. */
interface CitizenListRow {
  id: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  motherName: string | null;
  phone: string | null;
  whatsapp: string | null;
  gender: string | null;
  referenceNumber: string | null;
  identityDocType: string | null;
  identityDocNumber: string | null;
  residentStatus: string | null;
  residence: string;
  isActive: boolean;
  mergedIntoId: string | null;
  createdAt: Date;
  registrationCount: number;
  propertyCount: number;
  latestStatus: string | null;
  latestSubmittedAt: Date | null;
  unestablishedFieldCount: number;
  feesTotal: number;
  paidTotal: number;
  outstandingTotal: number;
  overdueTotal: number;
  overdueCount: number;
  pendingReviewCount: number;
}

/**
 * The second statement's single row: the figures over the whole filtered set.
 *
 * Separate from the page rather than carried on it, because an aggregate query
 * returns its row whether or not anything matched — which is exactly what the
 * window-function version could not do. See `list`.
 */
interface CitizenListAggregate {
  total: number;
  allRequiringReview: number;
  allOutstanding: number;
  allOverdue: number;
  allInArrears: number;
}

/**
 * One row of «يتطلب مراجعة»: who the record is, how to reach them, and how
 * much is still open on it — nothing else. The queue is worked by people who
 * finish records, not by people who collect money, so it carries no fee
 * figures and no identity-document number: what a screen does not show, its
 * payload does not send.
 */
export interface ReviewQueueItem {
  id: string;
  fullName: string;
  /** Null on records filed before migration 0044 — «لم يُسأل», not a difference. */
  motherName: string | null;
  referenceNumber: string | null;
  phone: string | null;
  /** The latest registration's status: always `REQUIRES_REVIEW` in this list. */
  status: string;
  /** How many «غير مؤكَّد» fields that registration carries. */
  openFieldCount: number;
  /** When it was filed — the queue is worked oldest first. */
  submittedAt: string;
}

interface ReviewQueueRow {
  id: string;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  motherName: string | null;
  referenceNumber: string | null;
  phone: string | null;
  status: string;
  openFieldCount: number;
  submittedAt: Date;
}

/**
 * Staff-side management of the citizen registry.
 *
 * The public wizard is gone from the landing page — a municipality clerk now
 * enters registrations from whatever the citizen brought to the counter — so
 * this is where creating a citizen lives. Creation deliberately delegates to
 * `RegistrationService.submit` rather than writing its own rows: the cadastre
 * lookup that turns رقم العقار into coordinates, the tenant's enabled property
 * types, the aggregate's own taxonomy checks and the `registration.submitted`
 * event (which is what invalidates the dashboard cache and writes the audit
 * entry) all hang off that one path. A second write path would be a second set
 * of those guarantees to keep in step, and the first one to drift silently.
 */
@Injectable()
export class CitizensService {
  private readonly logger = new Logger(CitizensService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly registrations: RegistrationService,
    private readonly tenants: TenantService,
    @Inject(PARCEL_REPOSITORY) private readonly parcels: ParcelRepository,
    private readonly census: CensusSyncService,
    private readonly landlordLinks: LandlordLinkService,
    private readonly events: EventEmitter2,
    private readonly auditTrail: AuditService,
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

  // ──────────────────────────────  Read  ──────────────────────────────

  /**
   * The registry table: every citizen with their registration summary and
   * their standing with the municipality's fees.
   *
   * One query with scalar subqueries rather than a `findMany` plus a
   * `groupBy` per money column — same reasoning as
   * `ReportingService.computeDashboardCounters`: against a pooler holding a
   * single connection per tenant schema, parallel queries contend with each
   * other, and this page opens with all of them at once.
   */
  async list(
    filter: {
      search?: string;
      limit?: number;
      offset?: number;
      /**
       * Narrows to citizens whose latest registration stands at this status —
       * in practice only ever `REQUIRES_REVIEW`, which is the work queue of
       * records filed with fields left unestablished.
       */
      status?: string;
    } = {},
  ): Promise<{
    items: CitizenListItem[];
    total: number;
    totals: { outstanding: number; overdue: number; inArrears: number; requiringReview: number };
  }> {
    const limit = Math.min(filter.limit ?? 100, MAX_LIST_ROWS);
    const offset = Math.max(filter.offset ?? 0, 0);
    /*
      Every token has to appear somewhere in the row's folded text.

      This replaced one `ILIKE` per column ORed together, which could not match
      «أحمد نصرالله» against أحمد خالد نصرالله — the name was compared
      as one string including the middle name, so a first-plus-family search,
      which is how everyone refers to everyone, found nobody. It also compared
      raw: أ against ا, ٠٧٠ against 070, and a reference number typed without
      its dashes against one stored with them.

      `searchText` is the generated column those cases fold into (migration
      0018); `searchTokens` applies the identical fold to the query. Two
      substring tests then answer what seven ILIKEs could not.
    */
    const tokens = searchTokens(filter.search);

    const searchFilter = tokens.length
      ? Prisma.join(
          tokens.map((token) => Prisma.sql`AND u."searchText" LIKE ${likePattern(token)}`),
          ' ',
        )
      : Prisma.empty;

    /*
      "Show me only the records still waiting to be finished."

      Matched against the *latest* registration alone, which is the one the edit
      form owns: a citizen who came back a year later with a second, complete
      filing is not still queued for the first one. Compared as text rather than
      cast to the enum so a status this build has not heard of narrows to
      nothing instead of failing the whole query — the enum is per-tenant DDL,
      and a schema part-way through `tenant:migrate-all` is a thing that happens.
    */
    const statusFilter = filter.status
      ? Prisma.sql`AND (
          SELECT r.status::text FROM ${this.S}registrations r
           WHERE r."citizenId" = u.id ORDER BY r."submittedAt" DESC LIMIT 1
        ) = ${filter.status}`
      : Prisma.empty;

    /*
      The page and the figures above it, on one connection and one snapshot.

      They were a single query, with `count(*) OVER()` and three `sum(...)
      OVER()` carrying the totals on every row. That is elegant while the page
      has rows and wrong the moment it does not: window aggregates arrive
      *attached to rows*, so an empty page — a search that matched nothing, or
      an offset past the end after a filter narrowed the set — returned no
      rows at all, `rows[0]` was `undefined`, and the screen reported a total
      of zero with all three headline cards blanked. A clerk on page 4 who
      ticked «المتأخرات» saw a municipality that owed nothing.

      An aggregate query with no GROUP BY always returns exactly one row, so
      the totals no longer depend on the page having content. `$transaction`
      rather than two awaits, for the same reason `listAllPayments` uses it:
      both statements read the same snapshot, so the count above the table
      cannot disagree with the rows in it.
    */
    const [rows, [aggregate]] = await withConnectionRetry(() =>
      this.db.$transaction([
        this.db.$queryRaw<CitizenListRow[]>`
        SELECT
          u.id,
          u."firstName",
          u."middleName",
          u."lastName",
          u."motherName",
          u.phone,
          u.whatsapp,
          u.gender::text AS gender,
          u."referenceNumber",
          u."identityDocType"::text  AS "identityDocType",
          u."identityDocNumber",
          u."residentStatus"::text   AS "residentStatus",
          u.residence::text          AS residence,
          u."isActive",
          (SELECT m."survivorId" FROM ${this.S}citizen_merges m
            WHERE m."absorbedId" = u.id AND m."undoneAt" IS NULL LIMIT 1)
            AS "mergedIntoId",
          u."createdAt",
          (SELECT count(*)::int FROM ${this.S}registrations r WHERE r."citizenId" = u.id)
            AS "registrationCount",
          (SELECT count(*)::int
             FROM ${this.S}property_entries pe
             JOIN ${this.S}registrations r ON r.id = pe."registrationId"
            WHERE r."citizenId" = u.id AND pe."endedAt" IS NULL)
            AS "propertyCount",
          (SELECT r.status::text FROM ${this.S}registrations r
            WHERE r."citizenId" = u.id ORDER BY r."submittedAt" DESC LIMIT 1)
            AS "latestStatus",
          (SELECT r."submittedAt" FROM ${this.S}registrations r
            WHERE r."citizenId" = u.id ORDER BY r."submittedAt" DESC LIMIT 1)
            AS "latestSubmittedAt",
          -- How many «غير مؤكَّد» fields that latest registration carries.
          -- jsonb_typeof guards the count against a row whose column holds
          -- something other than an array; the default is an empty array, but
          -- a hand-run fix or an older backup restored here need not be.
          COALESCE((SELECT
              CASE WHEN jsonb_typeof(r."flaggedFields") = 'array'
                   THEN jsonb_array_length(r."flaggedFields") ELSE 0 END
             FROM ${this.S}registrations r
            WHERE r."citizenId" = u.id ORDER BY r."submittedAt" DESC LIMIT 1), 0)::int
            AS "unestablishedFieldCount",
          COALESCE((SELECT sum(p.amount) FROM ${this.S}citizen_payments p
                     WHERE p."citizenId" = u.id), 0)::float8
            AS "feesTotal",
          COALESCE((SELECT sum(p."paidAmount") FROM ${this.S}citizen_payments p
                     WHERE p."citizenId" = u.id), 0)::float8
            AS "paidTotal",
          COALESCE((SELECT sum(p.amount - p."paidAmount") FROM ${this.S}citizen_payments p
                     WHERE p."citizenId" = u.id AND p."paymentStatus" <> 'PAID'), 0)::float8
            AS "outstandingTotal",
          COALESCE((SELECT sum(p.amount - p."paidAmount") FROM ${this.S}citizen_payments p
                     WHERE p."citizenId" = u.id
                       AND p."paymentStatus" = 'UNPAID'
                       AND p."dueDate" < now()), 0)::float8
            AS "overdueTotal",
          (SELECT count(*)::int FROM ${this.S}citizen_payments p
            WHERE p."citizenId" = u.id
              AND p."paymentStatus" = 'UNPAID'
              AND p."dueDate" < now())
            AS "overdueCount",
          (SELECT count(*)::int FROM ${this.S}citizen_payments p
            WHERE p."citizenId" = u.id AND p."paymentStatus" = 'PENDING_REVIEW')
            AS "pendingReviewCount"
        FROM ${this.S}users u
        WHERE u.kind = 'CITIZEN'
        ${searchFilter}
        ${statusFilter}
        ORDER BY u."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
        /*
          The registry's headline figures, over the whole filtered set rather
          than the page. The screen used to sum them in the browser, which was
          correct only while the browser held every row; once the list is
          paged, that silently turns "outstanding" into "outstanding on this
          page".
        */
        this.db.$queryRaw<CitizenListAggregate[]>`
        SELECT
          count(*)::int AS total,
          COALESCE(sum(
            COALESCE((SELECT sum(p.amount - p."paidAmount") FROM ${this.S}citizen_payments p
                       WHERE p."citizenId" = u.id AND p."paymentStatus" <> 'PAID'), 0)
          ), 0)::float8 AS "allOutstanding",
          COALESCE(sum(
            COALESCE((SELECT sum(p.amount - p."paidAmount") FROM ${this.S}citizen_payments p
                       WHERE p."citizenId" = u.id
                         AND p."paymentStatus" = 'UNPAID'
                         AND p."dueDate" < now()), 0)
          ), 0)::float8 AS "allOverdue",
          count(*) FILTER (
            WHERE (SELECT count(*) FROM ${this.S}citizen_payments p
                    WHERE p."citizenId" = u.id
                      AND p."paymentStatus" = 'UNPAID'
                      AND p."dueDate" < now()) > 0
          )::int AS "allInArrears",
          /*
            How many records still need finishing, over the whole search — not
            over the page, and deliberately not narrowed by the status filter
            either. It is the count the «يتطلب مراجعة» tab offers to *show*, so
            it has to keep reporting the same number once that tab is on;
            narrowed too, ticking it would make the tab read its own result back.
          */
          count(*) FILTER (
            WHERE (SELECT r.status::text FROM ${this.S}registrations r
                    WHERE r."citizenId" = u.id
                    ORDER BY r."submittedAt" DESC LIMIT 1) = 'REQUIRES_REVIEW'
          )::int AS "allRequiringReview"
        FROM ${this.S}users u
        WHERE u.kind = 'CITIZEN'
        ${searchFilter}
      `,
      ]),
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        fullName: [row.firstName, row.middleName, row.lastName].filter(Boolean).join(' '),
        /*
          Carried on the list row because this is what tells two «محمد خليل»s
          apart wherever people are offered for picking — the occupant search on
          a unit, the duplicate check on a new file. Null on records filed before
          migration 0044, and every reader must render that as «لم يُسأل» rather
          than as a difference between two people.
        */
        motherName: row.motherName,
        phone: row.phone,
        whatsapp: row.whatsapp,
        gender: row.gender,
        referenceNumber: row.referenceNumber,
        identityDocType: row.identityDocType,
        identityDocNumber: row.identityDocNumber,
        residentStatus: row.residentStatus,
        residence: row.residence,
        isActive: row.isActive,
        mergedIntoId: row.mergedIntoId,
        registeredAt: row.createdAt.toISOString(),
        registrationCount: row.registrationCount,
        propertyCount: row.propertyCount,
        latestStatus: row.latestStatus,
        latestSubmittedAt: row.latestSubmittedAt?.toISOString() ?? null,
        unestablishedFieldCount: row.unestablishedFieldCount,
        feesTotal: row.feesTotal,
        paidTotal: row.paidTotal,
        outstandingTotal: row.outstandingTotal,
        overdueTotal: row.overdueTotal,
        overdueCount: row.overdueCount,
        pendingReviewCount: row.pendingReviewCount,
      })),
      total: aggregate?.total ?? 0,
      /** Across every matching citizen, not the returned page. */
      totals: {
        outstanding: aggregate?.allOutstanding ?? 0,
        overdue: aggregate?.allOverdue ?? 0,
        inArrears: aggregate?.allInArrears ?? 0,
        requiringReview: aggregate?.allRequiringReview ?? 0,
      },
    };
  }

  /**
   * «يتطلب مراجعة» — citizens whose latest registration was filed with fields
   * left «غير مؤكَّد», oldest first.
   *
   * Its own query rather than `list` with a status filter: `list` computes six
   * fee subqueries per row and four over the whole register for the cards
   * above the table, none of which this queue shows, and it sends the identity
   * document number with every row. Narrowed in the WHERE, so a citizen who is
   * not in the queue never leaves the database.
   *
   * Matched against the *latest* registration, as `list` is: a citizen who
   * came back with a complete second filing is not still queued for the first.
   * The search is `list`'s, token for token, so a name found in one is found in
   * the other.
   */
  async reviewQueue(
    filter: { search?: string; limit?: number; offset?: number } = {},
  ): Promise<{ items: ReviewQueueItem[]; total: number }> {
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), MAX_LIST_ROWS);
    const offset = Math.max(filter.offset ?? 0, 0);
    const tokens = searchTokens(filter.search);
    const searchFilter = tokens.length
      ? Prisma.join(
          tokens.map((token) => Prisma.sql`AND u."searchText" LIKE ${likePattern(token)}`),
          ' ',
        )
      : Prisma.empty;

    // `jsonb_typeof` guards the count as `list` does: the column defaults to an
    // array, but a hand-run fix or a restored backup need not hold one.
    const queued = Prisma.sql`
      FROM ${this.S}users u
      JOIN LATERAL (
        SELECT r.status::text AS status, r."submittedAt",
               CASE WHEN jsonb_typeof(r."flaggedFields") = 'array'
                    THEN jsonb_array_length(r."flaggedFields") ELSE 0 END AS "openFieldCount"
          FROM ${this.S}registrations r
         WHERE r."citizenId" = u.id
         ORDER BY r."submittedAt" DESC
         LIMIT 1
      ) latest ON true
      WHERE u.kind = 'CITIZEN'
        AND latest.status = 'REQUIRES_REVIEW'
        ${searchFilter}
    `;

    // One snapshot for the page and its count, for the reason `list` gives.
    const [rows, [count]] = await withConnectionRetry(() =>
      this.db.$transaction([
        this.db.$queryRaw<ReviewQueueRow[]>`
          SELECT u.id, u."firstName", u."middleName", u."lastName", u."motherName",
                 u."referenceNumber", u.phone,
                 latest.status, latest."openFieldCount"::int AS "openFieldCount",
                 latest."submittedAt"
          ${queued}
          ORDER BY latest."submittedAt" ASC, u.id
          LIMIT ${limit} OFFSET ${offset}
        `,
        this.db.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total ${queued}`,
      ]),
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        fullName: [row.firstName, row.middleName, row.lastName].filter(Boolean).join(' '),
        motherName: row.motherName,
        referenceNumber: row.referenceNumber,
        phone: row.phone,
        status: row.status,
        openFieldCount: row.openFieldCount,
        submittedAt: row.submittedAt.toISOString(),
      })),
      total: count?.total ?? 0,
    };
  }

  /**
   * The citizen's record shaped back into the form that edits it.
   *
   * Returns exactly the three sections `adminUpdateCitizenSchema` expects, so
   * the edit page can load and post the same object. Only the *latest*
   * registration's properties are included — see `update` for why that is the
   * one the form owns.
   */
  /**
   * An opaque token for "this file as it stands": the latest registration and
   * every card on it, including ended ones. Any save through the form, a link,
   * an ended tenancy or a card the matrix added moves it.
   *
   * Not a lock. It exists for the human-scale race — two officers with one file
   * open for half an hour — not for two requests a millisecond apart, which
   * the write path's own row locks already serialise.
   */
  private async fileVersion(citizenId: string): Promise<string> {
    const registration = await this.db.registration.findFirst({
      where: { citizenId },
      orderBy: { submittedAt: 'desc' },
      select: { id: true, updatedAt: true, properties: { select: { updatedAt: true } } },
    });
    if (!registration) return 'none';
    const cards = registration.properties.map((card) => card.updatedAt.getTime());
    return [
      registration.id,
      registration.updatedAt.getTime(),
      cards.length,
      cards.length ? Math.max(...cards) : 0,
    ].join(':');
  }

  /**
   * The last member of staff whose change to this citizen reached the audit log.
   *
   * A reviewer's decision is logged against the citizen too, but changes
   * nothing on the file — see `REVIEW_AUDIT_ACTIONS`.
   */
  private async lastStaffEdit(
    citizenId: string,
  ): Promise<{ staffId: string | null; name: string | null; at: string } | null> {
    const entry = await this.db.auditLogEntry.findFirst({
      where: {
        entityType: 'User',
        entityId: citizenId,
        actorType: 'STAFF',
        action: { notIn: [...REVIEW_AUDIT_ACTIONS] },
      },
      orderBy: { createdAt: 'desc' },
      select: { actorId: true, createdAt: true },
    });
    if (!entry) return null;
    const staff = entry.actorId
      ? await this.db.user.findFirst({
          where: { id: entry.actorId, kind: 'STAFF' },
          select: { firstName: true, lastName: true },
        })
      : null;
    return {
      staffId: entry.actorId,
      name: staff ? `${staff.firstName} ${staff.lastName}` : null,
      at: entry.createdAt.toISOString(),
    };
  }

  async getEditable(citizenId: string, viewerId?: string) {
    const citizen = await withConnectionRetry(() =>
      this.db.user.findFirst({
        where: { id: citizenId, kind: 'CITIZEN' },
        select: {
          id: true,
          referenceNumber: true,
          firstName: true,
          middleName: true,
          lastName: true,
          motherName: true,
          gender: true,
          nationality: true,
          isLebanese: true,
          residencyNumber: true,
          residentStatus: true,
          identityDocType: true,
          identityDocNumber: true,
          civilRecordNumber: true,
          phone: true,
          whatsapp: true,
          maritalStatus: true,
          totalRegisteredMembers: true,
          actualHouseholdMembers: true,
          bloodType: true,
          residence: true,
          residencePlace: true,
          localContactName: true,
          localContactPhone: true,
          registrations: {
            orderBy: { submittedAt: 'desc' },
            take: 1,
            select: {
              id: true,
              referenceNumber: true,
              status: true,
              flaggedFields: true,
              notes: true,
              properties: {
                /*
                  Current cards only. An ended tenancy is history on the file —
                  shown on the profile, never edited or re-saved — and loading it
                  here would put it back into the payload as a card still held.
                */
                where: { endedAt: null },
                orderBy: { createdAt: 'asc' },
                include: {
                  units: {
                    where: { endedAt: null },
                    orderBy: { createdAt: 'asc' },
                    // The census unit each flat is, for its code — see `propertyRefs`.
                    include: { unit: { select: { floor: true, sequence: true } } },
                  },
                  building: {
                    select: {
                      code: true,
                      parcelNumber: true,
                      // What the elevation drawing reads — its shape, never its occupants.
                      structureType: true,
                      lifecycleStatus: true,
                      floorsCount: true,
                      basementsCount: true,
                      // The census summary beside it, as the unit matrix shows it.
                      postedNumber: true,
                      sharedParcelNumbers: true,
                      isPartitioned: true,
                      partitionNumbers: true,
                      latitude: true,
                      unitsTotal: true,
                      unitsSurveyed: true,
                      units: {
                        orderBy: [{ floor: 'asc' }, { sequence: 'asc' }],
                        select: {
                          id: true,
                          floor: true,
                          sequence: true,
                          unitType: true,
                          unitCode: true,
                          startCol: true,
                          endCol: true,
                        },
                      },
                    },
                  },
                  landlordCitizen: {
                    select: {
                      id: true,
                      firstName: true,
                      middleName: true,
                      lastName: true,
                      referenceNumber: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    if (!citizen) throw new NotFoundError({
      code: 'CITIZEN_NOT_FOUND',
      message: `Citizen ${citizenId} was not found`,
    });

    const registration = citizen.registrations[0] ?? null;

    const [version, lastEdit] = await Promise.all([
      this.fileVersion(citizen.id),
      this.lastStaffEdit(citizen.id),
    ]);

    /*
      The sector each linked building stands in — resolved from the parcel at
      read time, as the building read does (D13), in one query for the whole
      record rather than one per card.
    */
    const parcels = [
      ...new Set(
        (registration?.properties ?? [])
          .map((property) => property.building?.parcelNumber)
          .filter((parcel): parcel is string => Boolean(parcel)),
      ),
    ];
    const zones = parcels.length
      ? await withConnectionRetry(() =>
          this.db.zone.findMany({
            where: { parcelNumbers: { hasSome: parcels } },
            select: { code: true, name: true, parcelNumbers: true },
          }),
        )
      : [];
    const zoneOf = (parcel: string) => zones.find((zone) => zone.parcelNumbers.includes(parcel)) ?? null;

    return {
      id: citizen.id,
      registrationId: registration?.id ?? null,
      /** The filing's own number — not the citizen's; see `citizenReferenceNumber`. */
      referenceNumber: registration?.referenceNumber ?? null,
      /**
       * The citizen's own الرقم المرجعي — what the file shows, what staff search
       * by and what the citizen signs in with. Every registration is issued two
       * numbers at once (citizen and filing, registration.service), so the two
       * look alike and differ on every record; the edit form showed the filing's
       * unlabelled, and it read as the wrong citizen's.
       */
      citizenReferenceNumber: citizen.referenceNumber ?? null,
      status: registration?.status ?? null,
      /** Sent back as `expectedVersion` on save — see `fileVersion`. */
      version,
      /**
       * Who last changed this file, so the form can say «عدّله حسين حدرج قبل ٤
       * دقائق» when it was somebody else and recently. Not live presence: it
       * knows who saved, not who has the form open.
       */
      lastStaffEdit: lastEdit
        ? { name: lastEdit.name, at: lastEdit.at, byViewer: Boolean(viewerId && lastEdit.staffId === viewerId) }
        : null,
      /**
       * The «غير مؤكَّد» fields and the reasons given for them, so the edit
       * form opens with the record's gaps already marked rather than making
       * whoever completes it re-derive which blanks were deliberate.
       */
      flags: readFlags(registration?.flaggedFields),
      /*
        Loaded back so an edit opens with the note already in the box.

        Without this the field renders empty on every edit and the officer's
        save — which replaces the note rather than merging it — would silently
        delete whatever the last visit wrote. A write-only note is worse than
        no note at all.
      */
      notes: registration?.notes ?? null,
      /**
       * Each card's place in the census, read-only: the building's code and
       * parcel, each flat's unit code («0101») and census unit, and the
       * building's shape for the elevation drawing. What a reviewer reads a
       * property by, and where in the building it is.
       *
       * Beside `properties` rather than inside them, because the cards are the
       * form's own values and travel back on save; these are facts the census
       * owns and the form never writes. Codes and shape only — no other
       * occupant of the building reaches this response.
       */
      propertyRefs: (registration?.properties ?? []).map((property) => ({
        propertyId: property.id,
        buildingCode: property.building?.code ?? null,
        parcelNumber: property.building?.parcelNumber ?? null,
        units: property.units.map((unit) => ({
          id: unit.id,
          unitCode: unit.unit ? formatUnitCode(unit.unit.floor, unit.unit.sequence) : null,
          /** The census unit this flat is — what the drawing lights. */
          unitId: unit.unitId,
        })),
        /**
         * The building drawn: its shape and every unit's place in it, so the
         * reviewer sees where this citizen's unit is. Shape only — not one
         * occupant of the building is in it.
         */
        building: property.building
          ? {
              structureType: property.building.structureType,
              lifecycleStatus: property.building.lifecycleStatus,
              floorsCount: property.building.floorsCount,
              basementsCount: property.building.basementsCount,
              units: property.building.units,
              parcelNumber: property.building.parcelNumber,
              postedNumber: property.building.postedNumber,
              sharedParcelNumbers: property.building.sharedParcelNumbers,
              isPartitioned: property.building.isPartitioned,
              partitionNumbers: property.building.partitionNumbers,
              /** Whether it is placed on the map — the coordinates themselves are not needed here. */
              located: property.building.latitude != null,
              unitsTotal: property.building.unitsTotal,
              unitsSurveyed: property.building.unitsSurveyed,
              zoneCode: zoneOf(property.building.parcelNumber)?.code ?? null,
              zoneName: zoneOf(property.building.parcelNumber)?.name ?? null,
            }
          : null,
      })),
      residence: citizen.residence,
      personal: {
        firstName: citizen.firstName,
        middleName: citizen.middleName ?? '',
        lastName: citizen.lastName,
        /*
          Empty for a record filed before migration 0044, which is exactly what
          the form needs: the field renders blank and required, so an officer
          editing an old household either learns the answer or marks it «غير
          مؤكَّد» with a reason. Nothing is invented to fill the gap, and the
          gap stops being invisible.
        */
        motherName: citizen.motherName ?? '',
        gender: citizen.gender,
        bloodType: citizen.bloodType ?? '',
        nationality: citizen.nationality,
        isLebanese: citizen.isLebanese,
        residencyNumber: citizen.residencyNumber ?? '',
        residentStatus: citizen.residentStatus,
        identityDocType: citizen.identityDocType,
        identityDocNumber: citizen.identityDocNumber ?? '',
        civilRecordNumber: citizen.civilRecordNumber ?? '',
        residencePlace: citizen.residencePlace ?? '',
      },
      contact: {
        phone: citizen.phone,
        whatsapp: citizen.whatsapp,
        // The stored pair is what it is; the form re-derives its own checkbox
        // from whether the two numbers currently match. No WhatsApp on file
        // reads as "same as the phone" — the schemas' own default — not as a
        // second number the officer must now produce: a record filed with its
        // phone «غير مؤكَّد» has neither, and filling the phone in later would
        // otherwise open an empty, required WhatsApp field nobody ever asked for.
        whatsappSameAsPhone: citizen.whatsapp == null || citizen.whatsapp === citizen.phone,
        maritalStatus: citizen.maritalStatus,
        totalRegisteredMembers: citizen.totalRegisteredMembers,
        actualHouseholdMembers: citizen.actualHouseholdMembers,
        localContactName: citizen.localContactName ?? '',
        localContactPhone: citizen.localContactPhone ?? '',
      },
      properties: (registration?.properties ?? []).map((property) => ({
        id: property.id,
        occupancyType: property.occupancyType,
        landlordName: property.landlordName,
        landlordPhone: property.landlordPhone,
        /*
          A standing owner link travels back, so the form opens saying so.

          Without it an already-linked card renders «هل هو المالك؟» over a
          question a clerk answered last week — and the name renders unlocked
          and editable, inviting a second spelling of a person the register has
          already identified. Re-answering it is harmless (`claimsFiledBy`
          offers only unresolved claims, so the agreement matches nothing and is
          dropped), which is exactly why it would go unnoticed.

          It is not what re-writes the column on save: the link is the server's
          to make through `confirm`, and an edit that leaves the number alone
          leaves the link alone (`landlordLinkReset`).
        */
        landlordCitizenId: property.landlordCitizenId,
        /*
          The owner the link names, as the register holds them.

          The form shows this name — read-only, with «إلغاء الربط» beside it —
          in place of `landlordName`, which stays what the tenant said. Two
          fields rather than one overwritten, so a later correction of the
          owner's own spelling shows everywhere with nothing to rewrite, and an
          unlink hands the tenant's words back untouched.
        */
        landlordLink: property.landlordCitizen
          ? {
              citizenId: property.landlordCitizen.id,
              name: [
                property.landlordCitizen.firstName,
                property.landlordCitizen.middleName,
                property.landlordCitizen.lastName,
              ]
                .filter(Boolean)
                .join(' '),
              referenceNumber: property.landlordCitizen.referenceNumber,
            }
          : null,
        propertyType: property.propertyType,
        neighborhood: property.neighborhood,
        propertyNumber: property.propertyNumber,
        landType: property.landType,
        buildingName: property.buildingName,
        side: property.side,
        tentLocation: property.tentLocation,
        // Decimal → number at the edge, as everywhere else in this codebase.
        unitArea: property.unitArea == null ? null : Number(property.unitArea),
        shares: property.shares,
        sharedRights: property.sharedRights,
        unitStatus: property.unitStatus,
        /*
          The census link travels back to the form so a re-save keeps it.

          Without this the edit path is silently destructive: an officer
          correcting a phone number would re-submit the card with no
          `buildingId`, and the link a colleague made from the matrix would be
          gone — along with `Unit`'s authority over the row (P2-T8), which is
          what a bill is computed from.
        */
        buildingId: property.buildingId,
        units: property.units.map((unit) => ({
          id: unit.id,
          unitType: unit.unitType,
          floor: unit.floor,
          side: unit.side,
          /*
            Null-guarded, exactly like the card's own `unitArea` above it.

            `Number(null)` is `0`, and this line was the bare form of it. Since
            migration 0031 `BuildingUnit.unitArea` is nullable, and two ordinary
            paths produce a null there: a field flag saying the area could not be
            established, and — far more often — `claimOnFile`, which mints a card
            line from the canonical `Unit` and copies whatever area the census
            holds, which for a flat painted on the matrix and never measured is
            nothing.

            So linking an existing owner to a flat from the unit matrix put a
            `null` in the column, and this line handed the edit form a `0`. The
            officer opened the record and saw «المساحة: 0» for a flat nobody had
            measured — indistinguishable from a measurement of zero, and a
            number `areaField` then refuses on the next save («المساحة يجب أن
            تكون أكبر من صفر»), so the card could not be re-saved at all until
            someone typed an area they may not have had.

            Null travels instead, the form renders an empty box, and the officer
            standing in the flat is asked for the one thing they can answer.
          */
          unitArea: unit.unitArea == null ? null : Number(unit.unitArea),
          sharedRights: unit.sharedRights,
          unitStatus: unit.unitStatus,
          unitId: unit.unitId,
        })),
      })),
    };
  }

  // ──────────────────────────────  Write  ──────────────────────────────

  /**
   * A clerk filing a citizen and their first registration.
   *
   * The claim lands as PENDING, exactly as a citizen-filed one did: a clerk
   * typing what someone handed over the counter has not thereby verified it,
   * and skipping the review queue would hide staff-entered claims from the
   * only screen that checks them.
   */
  /**
   * «هل هو مسجَّل مسبقاً؟» for one filing — read-only.
   *
   * The form asks this before it writes anything (it may be about to create a
   * new structure for the household), and `create` asks it again, because a
   * question the browser skipped is not a question the register may skip.
   * The candidates come from `duplicateLookup`.
   */
  async reviewDuplicates(
    payload: AdminCitizenSubmission,
    actor: { id: string },
  ): Promise<DuplicateReviewFindings> {
    const personal = payload.personal as Record<string, unknown>;
    const contact = payload.contact as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

    const incoming = {
      firstName: text(personal.firstName) ?? '',
      middleName: text(personal.middleName),
      lastName: text(personal.lastName) ?? '',
      motherName: text(personal.motherName),
      phone: text(contact.phone),
      whatsapp: text(contact.whatsapp) ?? text(contact.phone),
      civilRecordNumber: text(personal.civilRecordNumber),
      residencyNumber: text(personal.residencyNumber),
      gender: text(personal.gender),
      isLebanese: typeof personal.isLebanese === 'boolean' ? personal.isLebanese : null,
      // The flats this filing's cards name: the same door, filed a second time.
      unitIds: (payload.properties as Array<{ units?: Array<{ unitId?: string | null }> }>)
        .flatMap((card) => card.units ?? [])
        .map((unit) => unit.unitId)
        .filter((unitId): unitId is string => Boolean(unitId)),
    };

    const rows = await this.duplicateLookup(incoming);
    if (!rows) return NO_FINDINGS;

    return assessFindings({
      incoming,
      rows,
      cards: payload.properties as ReadonlyArray<{
        occupancyType?: string | null;
        landlordPhone?: string | null;
        landlordName?: string | null;
      }>,
      actorId: actor.id,
      now: new Date(),
    });
  }

  /**
   * «قد يكون مسجَّلاً مسبقاً» while the form is typed — the rule the save asks
   * by, on whatever has been typed so far.
   *
   * The panel used to run the register's search box instead: the first name
   * and the family name as two words, each of which had to appear *anywhere*
   * in a row's folded text. That text holds the father's name and the
   * mother's name too, so «حسين وطفى» offered «ابراهيم حسين برو» (حسين as his
   * father, وطفى as his mother's family) — four warnings on one screen that the
   * save's own check would never have raised, and a panel officers learned to
   * read past. Now the two agree: the panel shows exactly who the save would
   * ask about, compared part by part and never across fields.
   *
   * `excludeId` drops the file being edited, which is never its own duplicate.
   */
  async possibleDuplicates(query: PossibleDuplicatesQuery): Promise<DuplicateCandidate[]> {
    const number = (value: string | undefined) => {
      const parsed = value ? internationalPhone.safeParse(value) : null;
      return parsed?.success ? parsed.data : null;
    };
    const phone = number(query.phone);
    const incoming = {
      firstName: query.firstName?.trim() ?? '',
      middleName: query.middleName?.trim() || null,
      lastName: query.lastName?.trim() ?? '',
      motherName: query.motherName?.trim() || null,
      phone,
      whatsapp: number(query.whatsapp) ?? phone,
      civilRecordNumber: query.civilRecordNumber?.trim() || null,
      residencyNumber: query.residencyNumber?.trim() || null,
      gender: query.gender ?? null,
      isLebanese: query.isLebanese ?? null,
      unitIds: query.unitIds ?? [],
    };

    const rows = await this.duplicateLookup(incoming, query.excludeId);
    if (!rows) return [];

    const { possibleDuplicates } = assessFindings({
      incoming,
      rows,
      cards: [],
      actorId: '',
      now: new Date(),
    });
    // The strongest first: a match the save will refuse on, then a match on more facts.
    return possibleDuplicates.sort(
      (a, b) => Number(b.certain) - Number(a.certain) || b.matchedOn.length - a.matchedOn.length,
    );
  }

  /**
   * The citizens worth comparing with one person, or null when there is nothing
   * to look up by.
   *
   * Blocked on what can be matched cheaply — either number, and each name part
   * as a substring of the folded search column — and compared in the
   * application, where the Arabic-aware edit distance lives. A typo in the
   * family name is still found through the first name, and the other way round.
   */
  private async duplicateLookup(
    incoming: {
      firstName: string;
      lastName: string;
      phone: string | null;
      whatsapp: string | null;
      unitIds?: readonly string[];
    },
    excludeId?: string,
  ) {
    const numbers = [...new Set([incoming.phone, incoming.whatsapp].filter((v): v is string => Boolean(v)))];
    const tokens = [
      ...new Set(
        [incoming.firstName, incoming.lastName]
          .flatMap((part) => normalizeSearchText(part).split(' '))
          .filter((token) => token.length >= 2),
      ),
    ];
    if (numbers.length === 0 && tokens.length === 0) return null;

    const rows = await this.db.user.findMany({
      where: {
        kind: 'CITIZEN',
        isActive: true,
        ...(excludeId ? { id: { not: excludeId } } : {}),
        OR: [
          ...(numbers.length ? [{ phone: { in: numbers } }, { whatsapp: { in: numbers } }] : []),
          ...tokens.map((token) => ({ searchText: { contains: token } })),
          ...(incoming.unitIds?.length
            ? [{ unitOccupancies: { some: { unitId: { in: [...incoming.unitIds] }, toDate: null } } }]
            : []),
        ],
      },
      take: MAX_DUPLICATE_LOOKUP_ROWS,
      select: {
        id: true,
        firstName: true,
        middleName: true,
        lastName: true,
        motherName: true,
        phone: true,
        whatsapp: true,
        civilRecordNumber: true,
        residencyNumber: true,
        gender: true,
        isLebanese: true,
        referenceNumber: true,
        residence: true,
        unitOccupancies: { where: { toDate: null }, select: { unitId: true } },
        registrations: {
          orderBy: { submittedAt: 'desc' },
          select: {
            submittedAt: true,
            createdById: true,
            createdBy: { select: { firstName: true, lastName: true } },
            _count: { select: { properties: { where: { endedAt: null } } } },
          },
        },
      },
    });
    return rows.map(({ unitOccupancies, ...row }) => ({
      ...row,
      unitIds: unitOccupancies.map((spell) => spell.unitId),
    }));
  }

  async create(input: {
    tenantSlug: string;
    payload: AdminCitizenSubmission;
    actor: { id: string; role: string };
  }) {
    /*
      The duplicate question, before anything is written.

      Skipped for a re-delivery: the record a lost response already created is
      itself the "match", and refusing the retry would strand the officer on a
      household that is safely on file.

      Refused only when a person is at the screen (`reviewDuplicates`). A
      filing delivered from the offline queue is written and held at «يتطلب
      مراجعة» with the match named — see `POSSIBLE_DUPLICATE_FLAG_PATH`.
    */
    const replay = input.payload.clientSubmissionId
      ? await this.db.registration.findUnique({
          where: { clientSubmissionId: input.payload.clientSubmissionId },
          select: { id: true },
        })
      : null;
    const findings = replay ? NO_FINDINGS : await this.reviewDuplicates(input.payload, input.actor);
    const open = outstandingFindings(findings, input.payload.duplicateReview);

    /*
      Somebody already on file beyond reasonable doubt — refused, not asked.

      For every path: the form, the offline queue (the delivery parks on the
      phone as «مرفوض» with this sentence, and nothing is lost) and the
      spreadsheet import (the row fails with it). A question the officer can
      answer «شخص آخر» to is what let the same household be filed twice; here
      the answer is the file on record, and the message names it.

      An administrator may still file past it by naming each blocking record as
      a different person, with the reason `duplicateReview` already requires.
    */
    const blocking = findings.possibleDuplicates.filter((candidate) => candidate.certain);
    const overridden =
      input.actor.role === 'SUPER_ADMIN' &&
      blocking.every((candidate) => input.payload.duplicateReview?.differentFrom.includes(candidate.id));
    if (blocking.length > 0 && !overridden) {
      const named = blocking
        .slice(0, 3)
        .map((candidate) =>
          candidate.referenceNumber ? `${candidate.fullName} (${candidate.referenceNumber})` : candidate.fullName,
        )
        .join('، ');
      throw new ConflictError({
        code: 'CITIZEN_DUPLICATE_BLOCKED',
        message: 'This person is already registered: <name>. A second file is not created. Open their file and add the property there. If it really is someone else, a system administrator decides.',
        params: { name: named },
        details: { code: 'DUPLICATE_BLOCKED', duplicateReview: { ...open, possibleDuplicates: findings.possibleDuplicates } },
      });
    }

    if (input.payload.reviewDuplicates && hasFindings(open)) {
      throw open.possibleDuplicates.length > 0
        ? new ConflictError({
            code: 'CITIZEN_POSSIBLE_DUPLICATE',
            message: 'This citizen may already be registered. Review the similar files before creating a new one.',
            details: { duplicateReview: open },
          })
        : new ConflictError({
            code: 'PHONE_BELONGS_TO_OTHER',
            message: 'This phone number is registered to someone else. Check whose number it is before saving.',
            details: { duplicateReview: open },
          });
    }

    const serverFlags =
      !input.payload.reviewDuplicates && open.possibleDuplicates.length > 0
        ? [possibleDuplicateFlag(open.possibleDuplicates)]
        : [];

    const referenceOf = new Map(
      [...findings.possibleDuplicates, ...findings.phoneOwners].map((row) => [
        row.id,
        row.referenceNumber ?? row.id,
      ]),
    );

    const result = await this.registrations.submit({
      tenantSlug: input.tenantSlug,
      payload: input.payload,
      createdById: input.actor.id,
      serverFlags,
    });

    /*
      The census learns what the register just learned (P5-T1).

      Runs only for a submission that actually wrote something. A re-delivered
      offline record changed nothing, and re-syncing it would end and re-open
      the same occupancy — harmless, but it would log a second visit against a
      door somebody stood at once.

      `syncQuietly` never throws: the citizen is already committed, and a census
      that failed to keep up must not be reported to the officer as a
      registration that failed to save. The result rides back on the response so
      the form can say what it linked.
    */
    const census = result.deduplicated
      ? null
      : await this.census.syncQuietly({
          registrationId: result.registrationId,
          citizenId: result.citizenId,
          actor: input.actor,
          /*
            A new filing releases nothing it did not itself claim.

            Scoped wider, a filing attached to someone already on file closed
            every flat their earlier registrations held — a shop registered on
            Monday lost to a flat registered on Tuesday. In production that
            evicted each merged brother from the flat the previous one had just
            been recorded in. Only an *edit* of a file is a statement about
            everything it holds.
          */
          scope: 'REGISTRATION',
        });

    /*
      And the owner question, asked at the one moment it can be answered well.

      Both directions land here, because a single save can be either: this
      household may have *named* an owner the register already holds, or this
      household may *be* the owner three other tenants have been naming for
      months. The officer is at the desk with both files in front of them, and
      one tap settles a link that would otherwise become somebody else's queue.

      Nothing is linked by this call — it only reports what matches. A phone is
      not an identity here (see `User`'s own comment on why uniqueness is on the
      identity document) and a link can bill, so the confirmation is always a
      person pressing a button. Quiet for the same reason the census sync is:
      the registration is committed, and a lookup that failed must not be
      reported as a registration that failed.
    */
    const landlordLinks = result.deduplicated
      ? null
      : await this.landlordClaimsQuietly(
          result.registrationId,
          result.citizenId,
          input.payload,
          input.actor,
        );

    // A re-delivered offline submission created nothing, so it is not a change
    // to announce: the audit log already carries the entry the first delivery
    // wrote, and a second one would read as the citizen having been registered
    // twice by a clerk who only did it once.
    if (!result.deduplicated) {
      this.events.emit('citizen.changed', {
        tenantSlug: input.tenantSlug,
        citizenId: result.citizenId,
        action: 'CITIZEN_CREATED',
        after: {
          referenceNumber: result.referenceNumber,
          propertyCount: result.propertyCount,
          status: result.status,
          unestablishedFields: input.payload.flags.length,
          residence: input.payload.residence,
          // Which way a given passport number went: a new holder, added to the
          // file of the person who already holds it, or a clash left for review.
          ...(result.identity ? { identity: result.identity } : {}),
          /*
            What the officer was shown and what they said about it — by
            reference, never by phone number. This is the row a reviewer reads
            when two files turn out to be one person after all.
          */
          ...(input.payload.duplicateReview
            ? {
                duplicateReview: {
                  differentFrom: input.payload.duplicateReview.differentFrom.map(
                    (id) => referenceOf.get(id) ?? id,
                  ),
                  sharedPhoneWith: input.payload.duplicateReview.sharedPhoneWith.map(
                    (id) => referenceOf.get(id) ?? id,
                  ),
                  sharedPhoneWithLandlord: input.payload.duplicateReview.sharedPhoneWithLandlord,
                  reason: input.payload.duplicateReview.reason,
                },
              }
            : {}),
          ...(serverFlags.length > 0
            ? {
                heldAsPossibleDuplicateOf: open.possibleDuplicates.map(
                  (candidate) => candidate.referenceNumber ?? candidate.id,
                ),
              }
            : {}),
        },
        actorId: input.actor.id,
        actorRole: input.actor.role,
      });
    }

    return {
      citizenId: result.citizenId,
      registrationId: result.registrationId,
      referenceNumber: result.referenceNumber,
      propertyCount: result.propertyCount,
      status: result.status,
      /** The queue reads this to tell "created" from "already had it". */
      deduplicated: result.deduplicated,
      /**
       * `ATTACHED` — added to the file of the person already holding this
       * passport number. `CONFLICT` — somebody with a different name holds it;
       * a separate citizen was created without it. Absent when no number was
       * given. The form says which, because both change what the officer does
       * next.
       */
      identity: result.identity ?? null,
      /**
       * What the census did about it — units linked, cases closed, a building
       * named.
       *
       * `null` carries two meanings and the caller must read `deduplicated`
       * above to tell them apart. With `deduplicated: false` the sync **failed**
       * and the link is still to be made from the ledger. With
       * `deduplicated: true` it was **skipped**, because this delivery changed
       * nothing and the first one already did all of this — announcing a
       * failure there sends an officer to re-link a building that is already
       * linked, and the occupancy they would create carries no `registrationId`
       * for `endUnclaimed` to ever close.
       *
       * The record itself is safe in all three cases.
       */
      census,
      /**
       * Owner links this save could make, waiting on somebody to say yes.
       *
       * `filed` are cards *this* registration wrote that name a number the
       * register already knows a citizen by; `naming` are cards other
       * households filed that name *this* citizen. Both are offers, never
       * facts — nothing here has been linked.
       *
       * `null` means the lookup failed, exactly as with `census` above, and the
       * queue at «روابط المالكين» still holds every one of them.
       */
      landlordLinks,
    };
  }

  /**
   * Both directions of the owner match, with their failure kept off the caller.
   *
   * Same contract as `CensusSyncService.syncQuietly`, and here for the same
   * reason: the registration these run after is already committed, and
   * answering a saved record with an error would send the officer back to
   * re-enter a household the municipality already holds. Logged, reported as
   * `null`, and surfaced rather than hidden.
   */
  private async landlordClaimsQuietly(
    registrationId: string,
    citizenId: string,
    payload: { properties: ReadonlyArray<{ landlordPhone?: string; landlordCitizenId?: string }> },
    actor: { id: string; role: string },
  ): Promise<{ filed: LandlordProposal[]; naming: LandlordProposal[] } | null> {
    try {
      /*
        A save naming no landlord number cannot have filed a claim, so the
        filed-by lookup is skipped for it — most saves, since an owner's own
        file names nobody. The naming lookup always runs: it is how an owner
        registering after their tenants is found.
      */
      const namesLandlord = payload.properties.some((card) => Boolean(card.landlordPhone));
      const [filed, naming] = await Promise.all([
        namesLandlord ? this.landlordLinks.claimsFiledBy(registrationId) : Promise.resolve([]),
        this.landlordLinks.claimsNaming(citizenId),
      ]);

      /*
        The officer already answered this on the form, so it is not asked again.

        «نعم، هو المالك» is pressed while the tenant is still at the door and the
        number is still correctable; the only thing that could not happen then
        was the write, because the card did not exist yet. Applying it here is
        what makes the button mean something on a submission that was filed
        offline and delivered by a queue hours later.

        Nothing is taken on trust: every answer goes through `confirm`, which
        re-derives the match from the committed card. What comes back is the
        claims *still* open, so the dialog and the queue ask about exactly what
        remains unanswered — an answer that failed among them.
      */
      const agreements = payload.properties.flatMap((card) =>
        card.landlordCitizenId && card.landlordPhone
          ? [{ phone: card.landlordPhone, citizenId: card.landlordCitizenId }]
          : [],
      );
      const applied = await this.landlordLinks.applyAgreements({ filed, agreements, actor });

      return { filed: applied.remaining, naming };
    } catch (error) {
      this.logger.error(
        `landlord claim lookup failed for registration ${registrationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }

  /**
   * Bulk import — a municipality's existing register, one spreadsheet row per
   * citizen.
   *
   * Three decisions worth stating, because each has an obvious wrong answer:
   *
   * **Rows are independent.** One malformed row does not abort the batch and
   * does not roll back the rows before it. A register of two hundred typed by
   * hand over years will contain a handful of bad rows, and an all-or-nothing
   * import means the clerk fixes one, re-uploads, and discovers the next — two
   * hundred round trips to load two hundred citizens. Each row reports its own
   * outcome and the clerk re-uploads only what failed.
   *
   * **Sequential, not `Promise.all`.** Every row resolves parcels and writes a
   * registration inside a transaction; the tenant pool is five connections
   * (`connection_limit=5`), so a parallel map over two hundred rows exhausts it
   * and fails rows for reasons that have nothing to do with their data.
   *
   * **`dryRun` writes nothing.** It runs the identical shaping and validation
   * and reports what would happen, which is what makes the preview screen
   * trustworthy — it is not a second, weaker check written for the UI.
   */
  async importMany(input: {
    tenantSlug: string;
    rows: ReadonlyArray<ImportRow>;
    /** Row number of `rows[0]` in the clerk's file, so batches stay addressable. */
    startRow: number;
    dryRun: boolean;
    actor: { id: string; role: string };
  }): Promise<CitizenImportResult> {
    const results: CitizenImportRowResult[] = [];

    for (const [index, raw] of input.rows.entries()) {
      const row = input.startRow + index;
      // Name is echoed back even on failure: "الصف ٧ فشل" is far harder to act
      // on than "الصف ٧ — علي حسن فشل" when the clerk is scanning a spreadsheet.
      const name = [raw['firstName'], raw['lastName']].filter(Boolean).join(' ').trim() || undefined;

      const parsed = adminCreateCitizenSchema.safeParse(buildCitizenPayload(raw));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        results.push({
          row,
          ok: false,
          name,
          error: issue?.message ?? 'صف غير صالح',
          column: columnHeaderFor(issue?.path),
        });
        continue;
      }

      if (input.dryRun) {
        results.push({ row, ok: true, name });
        continue;
      }

      try {
        const created = await this.create({
          tenantSlug: input.tenantSlug,
          /*
            A spreadsheet row carries no `UNESTABLISHED` flags, and cannot.

            «غير مؤكَّد» is a statement by a named officer about one field they
            personally could not establish, with their reason. A bulk import is
            a municipality's existing paper register arriving in one file, with
            nobody standing behind any individual gap — so a row is either
            complete enough for `adminCreateCitizenSchema`, which validated it
            above, or it is reported as a failed row for the clerk to fix.

            An imported row can still end up carrying an `UNVERIFIED` one, and
            that is the point: the submit path checks every رقم العقار against
            the cadastre and annotates the ones it cannot find. A register typed
            up over years is exactly where those live, and a row that used to be
            rejected outright — losing the household's data over a parcel the
            survey office has not exported yet — now lands as «يتطلب مراجعة»
            with the number intact and the reason attached.
          */
          /*
            A spreadsheet row carries no blanket reason either, and could not.
            The reason is a sentence an officer says about a visit they made;
            a row typed from a ledger years ago has no visit behind it, and
            inventing one would put words in somebody's mouth on a record that
            outlives them.
          */
          payload: {
            ...parsed.data,
            // A register typed up from paper is a register of households; an
            // owner record is a decision somebody makes at a doorstep.
            residence: 'RESIDENT',
            flags: [],
            blanketFlagReason: undefined,
            // Nor a note, and for the same reason: a note is something an
            // officer observed at a door. A spreadsheet row has no visit
            // behind it to have observed anything.
            notes: undefined,
            clientSubmissionId: undefined,
          },
          actor: input.actor,
        });
        results.push({ row, ok: true, name, referenceNumber: created.referenceNumber });
      } catch (caught) {
        // A duplicate identity document is the commonest real failure — the
        // same person already on the register, or listed twice in the file —
        // and it is a fact about that row, not a reason to stop the batch.
        results.push({
          row,
          ok: false,
          name,
          error: caught instanceof Error ? caught.message : 'تعذّر إنشاء السجل',
        });
      }
    }

    return {
      dryRun: input.dryRun,
      created: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      results,
    };
  }

  /**
   * A clerk correcting a citizen already on file.
   *
   * Properties are reconciled against the citizen's **latest** registration
   * only. A citizen may hold several — someone who came back a year later with
   * a second building — and each is a separate claim with its own review state
   * and its own attached deeds; letting one form silently rewrite all of them
   * would mean a typo fix on a name could reopen a claim approved months ago.
   * The earlier registrations stay visible, and editable through their own
   * review screen, on the citizen's profile page.
   *
   * A property present in the database and absent from the payload is deleted,
   * and its attached documents go with it (`Document.propertyEntryId` cascades)
   * — the UI says so before it lets the row be removed.
   */
  async update(input: {
    tenantSlug: string;
    citizenId: string;
    payload: AdminCitizenUpdateSubmission;
    actor: { id: string; role: string };
  }) {
    const tenant = await this.tenants.resolve(input.tenantSlug);

    const citizen = await this.db.user.findFirst({
      where: { id: input.citizenId, kind: 'CITIZEN' },
      select: {
        id: true,
        referenceNumber: true,
        // Only to tell a cleared passport box from a box that never showed this
        // number — see `citizenColumnsForEdit`.
        identityDocType: true,
        registrations: {
          orderBy: { submittedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            // `landlordPhone` and the link come back so this save can tell a
            // card whose owner fields are locked to a confirmed link from one
            // whose number *changed* — which is what invalidates any answer
            // somebody gave about it. Both are read again, locked, inside the
            // transaction; this copy only decides which flags stand.
            //
            // The capacity, the structure and the current flats come back so a
            // card this save removes can say which flats it claimed, for the
            // census to close them with the officer's answer (`removals`).
            properties: {
              select: {
                id: true,
                landlordPhone: true,
                landlordCitizenId: true,
                endedAt: true,
                occupancyType: true,
                propertyType: true,
                buildingId: true,
                units: { where: { endedAt: null }, select: { unitId: true } },
              },
            },
            flaggedFields: true,
          },
        },
      },
    });
    if (!citizen) throw new NotFoundError({
      code: 'CITIZEN_NOT_FOUND',
      message: `Citizen ${input.citizenId} was not found`,
    });

    /*
      A file «دمج ملفين» folded into another holds no filing, and a save here
      would create one — cards, flats and all on a person nobody bills. The
      officer meant the file that stays, and the refusal names it.
    */
    await assertNotMergedAway(this.db, citizen.id);

    /*
      Somebody changed this file after the form was opened. Refused before any
      read that decides a write, with who and when, so the officer chooses
      between reloading and replacing — instead of the second save of the day
      quietly undoing the first.
    */
    if (input.payload.expectedVersion) {
      const current = await this.fileVersion(citizen.id);
      /*
        A different *filing* is the file now — «دمج ملفين» made the other
        file's newer one the newest. The form on screen holds none of the cards
        that came across, so «احفظ لتستبدلها» would end every one of them. Not
        a replaceable edit: the form has to be opened again.
      */
      if (current !== input.payload.expectedVersion && current.split(':')[0] !== input.payload.expectedVersion.split(':')[0]) {
        throw new ConflictError({
          code: 'CITIZEN_FILE_STALE_MERGED',
          message: 'The filing behind this file changed since you opened the form (another file was merged into it). Reopen the file before saving.',
          details: {
            code: 'STALE',
          },
        });
      }
      if (current !== input.payload.expectedVersion) {
        const lastEdit = await this.lastStaffEdit(citizen.id);
        const details = {
          staleEdit: {
            version: current,
            lastEditedBy: lastEdit?.name ?? null,
            lastEditedAt: lastEdit?.at ?? null,
            byViewer: lastEdit?.staffId === input.actor.id,
          },
        };
        throw lastEdit?.name
          ? new ConflictError({
              code: 'CITIZEN_EDITED_BY_OTHER',
              message: '<name> edited this file after you opened it. Refresh the page to see their changes, or save to replace them.',
              params: { name: lastEdit.name },
              details,
            })
          : new ConflictError({
              code: 'CITIZEN_EDITED_SINCE_OPENED',
              message: 'This file was edited after you opened it. Refresh the page to see the changes, or save to replace them.',
              details,
            });
      }
    }

    // The file as the form showed it, for the field-level trail — see `fileChanges`.
    const fileBefore = await this.getEditable(citizen.id);

    /*
      A high-impact correction carries its reason (the user's decision of
      2026-09-27): refused here, before anything is written, naming the fields.
      The review step asks for it; a client that skipped it is told what to add.
    */
    const needsReason = highImpactChanges(
      fileBefore,
      submittedView(input.payload),
      flaggedPaths(input.payload.flags),
    );
    if (needsReason.length > 0 && !input.payload.changeReason) {
      throw new ValidationError({
        code: 'EDIT_REASON_REQUIRED',
        message: 'Give a reason for this edit: it changes fields that need one.',
        details: {
          code: 'REASON_REQUIRED',
          fields: needsReason,
        },
      });
    }

    /*
      «سجل مشابه» is the server's note, so the form never sends it back — and an
      edit that says nothing about it must not be what clears it. It stands
      until the edit carries `duplicateReview`: somebody looked, and it is a
      different person.
    */
    const storedFlags = Array.isArray(citizen.registrations[0]?.flaggedFields)
      ? (citizen.registrations[0]!.flaggedFields as unknown as FieldFlag[])
      : [];
    const standingDuplicateFlag = storedFlags.find(
      (flag) => flag?.path === POSSIBLE_DUPLICATE_FLAG_PATH,
    );
    const duplicateFlagResolved = Boolean(standingDuplicateFlag && input.payload.duplicateReview);

    // Same construction the submit path performs: the taxonomy rules live in
    // the aggregate, so an edit gets the identical guarantees a submission did
    // — including which of them this edit's own flags waive.
    const { found: cadastre, missing } = await this.resolveParcels(
      input.payload.properties
        .map((property) => property.propertyNumber)
        .filter((number): number is string => Boolean(number)),
    );

    /*
      Recomputed on every save, exactly as on the create path — which is what
      makes the «يتطلب مراجعة» status self-clearing. A record held only because
      its parcel was missing from the cadastre leaves that queue the first time
      anyone saves it after the survey office imports the parcel, with nobody
      having to remember that this record was waiting on it.
    */
    const submittedFlags: FieldFlag[] = [
      ...input.payload.flags,
      ...cadastreFlags(input.payload.properties, missing, input.payload.flags),
    ];

    /*
      Cards whose owner is a confirmed link keep the owner fields the link was
      made against.

      The form shows those fields read-only, so only a stale client sends
      anything else — but a lock that holds only in the browser is not a lock.
      The number is what the link was confirmed about and the name is what the
      tenant said; neither is this save's to change while the link stands, and
      «إلغاء الربط» is the one way to release them. A «غير مؤكَّد» flag on either
      is dropped for the same reason: the register established both.

      A number that genuinely differs (and is not merely flagged away) is still
      honoured as before — it is somebody's correction, and it undoes the link
      below rather than being silently discarded.
    */
    const serverCards = new Map(
      (citizen.registrations[0]?.properties ?? [])
        .filter((property) => !property.endedAt)
        .map((property) => [property.id, property]),
    );
    const linkLocked = new Set<number>();
    input.payload.properties.forEach((property, index) => {
      const card = property as { id?: string; landlordPhone?: string };
      const server = card.id ? serverCards.get(card.id) : undefined;
      if (!server?.landlordCitizenId) return;
      const phoneFlagged = submittedFlags.some(
        (flag) => flag.path === `properties.${index}.landlordPhone`,
      );
      if (phoneFlagged || (card.landlordPhone ?? null) === server.landlordPhone) {
        linkLocked.add(index);
      }
    });
    const flags: FieldFlag[] = [
      ...submittedFlags.filter((flag) => {
        const match = /^properties\.(\d+)\.(landlordName|landlordPhone)$/.exec(flag.path);
        return !(match && linkLocked.has(Number(match[1])));
      }),
      ...(standingDuplicateFlag && !duplicateFlagResolved ? [standingDuplicateFlag] : []),
    ];

    const entries = input.payload.properties.map((property, index) => {
      const { id, ...values } = property as { id?: string } & Record<string, unknown>;
      const parcel =
        typeof values.propertyNumber === 'string'
          ? cadastre.get(values.propertyNumber.trim())
          : undefined;
      return {
        id,
        index,
        entry: PropertyEntry.create(
          {
            ...values,
            latitude: parcel?.latitude ?? null,
            longitude: parcel?.longitude ?? null,
          } as never,
          // The flags as submitted: a locked card's flagged owner field is
          // excused here and restored from the link when it is written.
          unestablishedOnCard(submittedFlags, index),
        ),
      };
    });

    for (const { entry } of entries) {
      if (!tenant.allowsPropertyType(entry.props.propertyType as PropertyType)) {
        throw new ConflictError({
          code: 'PROPERTY_TYPE_NOT_ACCEPTED',
          message: `This municipality does not currently accept registrations of this property type (${entry.props.propertyType}).`,
          params: { propertyType: entry.props.propertyType },
        });
      }
    }

    const existing = citizen.registrations[0];
    /*
      The cards this save reconciles — the current ones. An ended tenancy is not
      in the form, so it must not read as a card the officer removed: deleting it
      would take the lease and the record of the tenancy with it.
    */
    const endedIds = new Set(
      (existing?.properties ?? []).filter((property) => property.endedAt).map((property) => property.id),
    );
    const existingIds = new Set(
      (existing?.properties ?? [])
        .filter((property) => !property.endedAt)
        .map((property) => property.id),
    );

    // An id from another citizen's claim must not be steered into this one.
    // Checked before anything is written, so a crafted payload fails whole.
    for (const { id } of entries) {
      if (id && endedIds.has(id)) {
        throw new ConflictError({
          code: 'TENANCY_ENDED_SINCE_OPENED',
          message: 'A tenancy on one of the cards ended after this form was opened. Refresh the page.',
          details: {
            propertyId: id,
          },
        });
      }
      if (id && !existingIds.has(id)) {
        throw new ValidationError({
          code: 'PROPERTY_NOT_IN_LATEST_FILING',
          message: 'This property does not belong to this citizen’s latest filing.',
          details: {
            propertyId: id,
          },
        });
      }
    }

    const keptIds = new Set(entries.map(({ id }) => id).filter(Boolean) as string[]);
    const removedIds = [...existingIds].filter((id) => !keptIds.has(id));

    /*
      Why each removed card is going, when the officer was asked.

      Checked before anything is written, like the ids above: an answer about a
      card this save keeps, or a sale on a card that owns nothing, is a form out
      of step with the file, and guessing which half is right would stamp a
      reason on the wrong flats.
    */
    const removals = input.payload.removals ?? [];
    const removedCards = new Map(
      (existing?.properties ?? [])
        .filter((property) => removedIds.includes(property.id))
        .map((property) => [property.id, property]),
    );
    for (const removal of removals) {
      const card = removedCards.get(removal.propertyId);
      if (!card) {
        throw new ConflictError({
          code: 'REMOVAL_REASON_FOR_KEPT_CARD',
          message: 'A card has a removal reason but was not removed. Refresh the page.',
          details: {
            propertyId: removal.propertyId,
          },
        });
      }
      if (removal.reason === 'OWNERSHIP_TRANSFERRED' && card.occupancyType !== 'OWNER') {
        throw new ValidationError({
          code: 'SALE_REASON_OWNER_ONLY',
          message: '“Sale or transfer” applies only to an owner’s card.',
          details: {
            propertyId: removal.propertyId,
          },
        });
      }
    }

    /*
      A flat this save takes off the owner's file — a deleted owner's card, a
      row dropped from one, a card no longer «مالك» — while a tenant's link
      still names this person as its landlord.

      Taking it off says the ownership was entered by mistake; the link says
      the opposite, and it is the tenant's record. Left standing, the tenant's
      next save would put this person back on the flat
      (`reconcileRegistration`). So the save stops before anything is written,
      as «إنهاء الملكية» does for a correction, and names whose card to unlink.
    */
    const linkedTenants = await this.tenantsLinkedToDroppedOwnership(
      citizen.id,
      (existing?.properties ?? []).filter((property) => !property.endedAt),
      entries.map(({ id, entry }) => ({ id, props: entry.props })),
    );
    if (linkedTenants.length > 0) {
      const names = [...new Set(linkedTenants.map((tenant) => tenant.name))];
      throw new ConflictError({
        code: 'OWNER_HAS_LINKED_TENANTS_ON_SAVE',
        message: '<names> are linked to this person as the owner of a unit this save removes from their file. Remove the link from the tenants’ cards first and then save, or use “End ownership” if they sold it.',
        params: { names: names.join('، '), count: names.length },
        details: { code: 'TENANTS_LINKED', linkedTenants },
      });
    }

    const endings = await this.removalEndings(removals, removedCards);

    /** What undoing links during this save wrote, emitted once it commits. */
    const revertEvents: PendingEvent[] = [];
    /*
      «حالة الوحدة» statements this save left as they were — card lines and منزل
      cards, by id. The census sync carries only a changed statement over the
      unit, so opening a file to fix a phone number never replays an old answer
      over a newer finding on the matrix (`CensusSyncService.declareUnitStatus`).
    */
    const unchangedStatements = new Set<string>();
    const unlinkedBySave: Array<{ propertyEntryId: string; report: RevertReport }> = [];

    // Where the record stands *after* this save. A record whose last gap was
    // just filled in leaves «يتطلب مراجعة» by the same rule that put it there.
    const nextStatus: CitizenRecordStatus = statusForFlags(flags);

    // Returned from the transaction rather than re-derived after it: the branch
    // below creates a registration where none existed, so "this citizen's
    // newest registration" is not necessarily the row this save just wrote to.
    const registrationId = await this.db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: citizen.id },
        data: citizenColumnsForEdit(input.payload, { identityDocType: citizen.identityDocType }),
      });

      /*
        Re-asked under the person's row lock, which the update above now holds
        and which «دمج ملفين» takes too. Everything this save decided was read
        before the transaction; a merge that committed in between may have
        folded this file away, or made another filing the newest — and this
        save would then write the flags, the note and the cards onto a filing
        that is no longer the file.
      */
      await assertNotMergedAway(tx, citizen.id);
      const newest = await tx.registration.findFirst({
        where: { citizenId: citizen.id },
        orderBy: { submittedAt: 'desc' },
        select: { id: true },
      });
      if ((newest?.id ?? null) !== (existing?.id ?? null)) {
        throw new ConflictError({
          code: 'CITIZEN_FILE_CHANGED_DURING_SAVE',
          message: 'This file changed while it was being saved (another file was merged into it). Reopen the file, then save.',
          details: {
            code: 'STALE',
          },
        });
      }

      // A citizen with no registration at all (never expected from this form,
      // but reachable if their only claim was deleted) gets one rather than
      // silently dropping the properties they just typed.
      const registrationId =
        existing?.id ??
        (
          await tx.registration.create({
            data: {
              citizenId: citizen.id,
              referenceNumber: ReferenceNumber.generate(tenant.referencePrefix).value,
              status: nextStatus,
              flaggedFields: flags as never,
              notes: input.payload.notes ?? null,
            },
            select: { id: true },
          })
        ).id;

      /*
        The flags are replaced by this save, not merged into what was there.

        The edit form shows every field and every flag on it at once, so what
        the officer submits *is* the current state of the record: a field they
        have now filled in arrives without its flag, and that is what clears
        it. Merging would make a completed field impossible to un-flag through
        the only screen that edits it — and leave records stuck at
        «يتطلب مراجعة» long after there was anything left to review.
      */
      if (existing?.id) {
        await tx.registration.update({
          where: { id: existing.id },
          data: {
            status: nextStatus,
            flaggedFields: flags as never,
            /*
              Replaced by this save, exactly as the flags above are, and for
              the same reason: the edit form shows the note and the officer
              submits the whole record. An absent one means they cleared the
              box, which has to be able to delete a note — merging would make a
              note written by mistake permanent.
            */
            notes: input.payload.notes ?? null,
          },
        });
      }

      /*
        The link state of these cards, read under a row lock.

        A clerk can confirm or undo a link on one of these cards from the queue
        while this form is open. Locking the registration's cards first makes
        that confirmation wait for this save (and then find the card as this
        save left it) instead of both deciding from a state neither will leave.
      */
      const linkState = new Map<
        string,
        {
          landlordPhone: string | null;
          landlordName: string | null;
          landlordCitizenId: string | null;
          landlordLinkFootprint: Prisma.JsonValue;
          unitStatus: string | null;
          buildingId: string | null;
          propertyType: string;
        }
      >();
      if (existing?.id) {
        await tx.$queryRaw`
          SELECT id FROM ${this.S}property_entries
          WHERE "registrationId" = ${existing.id}::uuid
          FOR UPDATE
        `;
        const cards = await tx.propertyEntry.findMany({
          where: { registrationId: existing.id },
          select: {
            id: true,
            landlordPhone: true,
            landlordName: true,
            landlordCitizenId: true,
            landlordLinkFootprint: true,
            unitStatus: true,
            buildingId: true,
            propertyType: true,
          },
        });
        for (const card of cards) linkState.set(card.id, card);
      }

      /*
        A card that leaves the file takes its link with it — and what that link
        wrote into the owner's records goes too, before the card and the
        footprint recording it are gone.
      */
      const undo = async (entryId: string) => {
        const state = linkState.get(entryId);
        if (!state?.landlordCitizenId) return;
        const reverted = await this.landlordLinks.revertLink(tx, {
          entryId,
          ownerId: state.landlordCitizenId,
          footprint: state.landlordLinkFootprint,
        });
        revertEvents.push(...reverted.events);
        unlinkedBySave.push({ propertyEntryId: entryId, report: reverted.report });
      };

      for (const removedId of removedIds) await undo(removedId);

      if (removedIds.length > 0) {
        await tx.propertyEntry.deleteMany({
          where: { id: { in: removedIds }, registrationId },
        });
      }

      for (const { id, index, entry } of entries) {
        const p = entry.props;
        const data = {
          occupancyType: p.occupancyType as never,
          landlordName: p.landlordName ?? null,
          landlordPhone: p.landlordPhone ?? null,
          propertyType: p.propertyType as never,
          neighborhood: p.neighborhood,
          propertyNumber: p.propertyNumber,
          unitType: (p.unitType ?? null) as never,
          landType: (p.landType ?? null) as never,
          buildingName: p.buildingName ?? null,
          floor: p.floor ?? null,
          side: p.side ?? null,
          tentLocation: p.tentLocation ?? null,
          unitArea: p.unitArea ?? null,
          shares: p.shares ?? null,
          sharedRights: p.sharedRights ?? [],
          unitStatus: (p.unitStatus ?? null) as never,
          latitude: p.latitude ?? null,
          longitude: p.longitude ?? null,
          buildingId: p.buildingId ?? null,
        };

        const units = (p.units ?? []).map((unit) => ({
          unitType: unit.unitType as never,
          floor: unit.floor,
          side: unit.side ?? null,
          unitArea: unit.unitArea,
          sharedRights: unit.sharedRights ?? [],
          unitStatus: (unit.unitStatus ?? null) as never,
          unitId: unit.unitId ?? null,
        }));
        /** The stored row each line was loaded from, when the form sent one. */
        const rowIds = (p.units ?? []).map((unit) => (unit as { id?: string }).id ?? null);

        if (id) {
          const state = linkState.get(id);
          // The same answer about the same flat: same status, same structure, still a منزل.
          if (
            state &&
            (state.unitStatus ?? null) === (data.unitStatus ?? null) &&
            (state.buildingId ?? null) === (data.buildingId ?? null) &&
            state.propertyType === data.propertyType
          ) {
            unchangedStatements.add(id);
          }
          const locked =
            Boolean(state?.landlordCitizenId) &&
            linkLocked.has(index) &&
            p.occupancyType !== 'OWNER';

          /*
            A changed number invalidates whatever was decided about the old one.

            A confirmed link and a dismissal are the two answers to the same
            question, and that question was asked about a number this save has
            just replaced. Left in place the link would carry over to a person
            the card no longer names — and go on billing them — so it is undone,
            with what it wrote into the owner's records, and the new number goes
            back to the queue like any newly typed one. Narrowed to an actual
            change, so an ordinary edit leaves a confirmed link alone.
          */
          const phoneChanged = (state?.landlordPhone ?? null) !== (p.landlordPhone ?? null);
          let landlordLinkReset: Record<string, unknown> = {};
          if (locked) {
            data.landlordName = state!.landlordName;
            data.landlordPhone = state!.landlordPhone;
          } else if (phoneChanged) {
            if (state?.landlordCitizenId) await undo(id);
            landlordLinkReset = {
              landlordCitizenId: null,
              landlordLinkFootprint: Prisma.DbNull,
              landlordLinkDismissedAt: null,
              landlordLinkDismissedIds: [],
            };
          }

          /*
            Rows are kept by identity: a line the form loaded is updated in place,
            a line it no longer sends is removed, a new line is created.

            They used to be deleted and re-created on every save, which gave the
            file nothing to recognise a line by — so a form left open across
            «إنهاء الإيجار» on one flat re-created that flat as held the next
            time it was saved. A line naming a row that has since ended is now
            refused instead. Ended rows are never touched: the form does not load
            them, and they are the record of what the tenancy gave up.
          */
          const stored = await tx.buildingUnit.findMany({
            where: { propertyEntryId: id },
            select: { id: true, endedAt: true, createdAt: true, unitStatus: true, unitId: true },
          });
          const storedById = new Map(stored.map((row) => [row.id, row]));
          const kept = new Set<string>();
          const lines = units.map((unit, position) => {
            const rowId = rowIds[position];
            const row = rowId ? storedById.get(rowId) : undefined;
            if (row?.endedAt) {
              throw new ConflictError({
                code: 'TENANCY_ENDED_ON_CARD_SINCE_OPENED',
                message: 'A tenancy on one of this card’s units ended after this form was opened. Refresh the page.',
                details: { propertyId: id, rowId },
              });
            }
            if (row && !kept.has(row.id)) {
              kept.add(row.id);
              // The owner said the same thing about the same flat as last time — see `unchangedStatements`.
              if ((row.unitStatus ?? null) === (unit.unitStatus ?? null) && (row.unitId ?? null) === (unit.unitId ?? null)) {
                unchangedStatements.add(row.id);
              }
              return { unit, row };
            }
            return { unit, row: undefined };
          });

          /*
            A row's place is its creation order — the order the form lists rows
            in and «غير مؤكَّد» flags count them in. Kept rows keep their own
            timestamps when the form's order already agrees with them (every new
            line after every kept one, kept ones in stored order); otherwise the
            order the form sent is written onto them, so a flag on the third line
            stays on the third line.
          */
          const keptTimes = lines.flatMap((line) => (line.row ? [line.row.createdAt.getTime()] : []));
          const lastKept = lines.map((line) => Boolean(line.row)).lastIndexOf(true);
          const firstNew = lines.findIndex((line) => !line.row);
          const inStoredOrder =
            keptTimes.every((time, index) => index === 0 || time >= keptTimes[index - 1]!) &&
            (firstNew === -1 || lastKept === -1 || firstNew > lastKept);
          // Explicit, a millisecond apart: rows written in one transaction can
          // otherwise share a timestamp and come back in any order.
          const base = inStoredOrder
            ? Math.max(Date.now(), keptTimes.length ? Math.max(...keptTimes) + 1 : 0)
            : Date.now() - lines.length;
          const order = (position: number, isNew: boolean) =>
            inStoredOrder && !isNew ? {} : { createdAt: new Date(base + position) };

          await tx.propertyEntry.update({
            where: { id },
            data: {
              ...data,
              ...landlordLinkReset,
              units: { deleteMany: { endedAt: null, id: { notIn: [...kept] } } },
            },
          });
          for (const [position, line] of lines.entries()) {
            if (line.row) {
              await tx.buildingUnit.update({
                where: { id: line.row.id },
                data: { ...line.unit, ...order(position, false) },
              });
            } else {
              await tx.buildingUnit.create({
                data: { ...line.unit, ...order(position, true), propertyEntryId: id },
              });
            }
          }
        } else {
          const base = Date.now();
          await tx.propertyEntry.create({
            data: {
              registrationId,
              ...data,
              units: {
                create: units.map((unit, position) => ({ ...unit, createdAt: new Date(base + position) })),
              },
            },
          });
        }
      }

      return registrationId;
    });

    /*
      And the census follows the correction (P5-T1).

      The edit path needs this at least as much as the create path does, and for
      a reason that only shows up on the second save: a card's unit links are
      replaced wholesale above, so an officer who unticks a flat has said the
      household is no longer in it. Without a sync the occupancy would stand,
      the matrix would keep showing them there, and P2-T8's `heldThroughOccupancy`
      would keep billing them for a flat their own file no longer claims.

      `syncQuietly` for the same reason as on create: the correction is already
      committed, and answering a saved edit with an error would send the officer
      round again.
    */
    this.landlordLinks.emitAll(revertEvents, input.actor);
    for (const { propertyEntryId, report } of unlinkedBySave) {
      this.events.emit('citizen.changed', {
        tenantSlug: input.tenantSlug,
        citizenId: citizen.id,
        action: 'LANDLORD_UNLINKED',
        after: { propertyEntryId, via: 'CITIZEN_UPDATED', ...report, kept: report.kept.length },
        actorId: input.actor.id,
        actorRole: input.actor.role,
      });
    }

    const census = await this.census.syncQuietly({
      registrationId,
      citizenId: citizen.id,
      actor: input.actor,
      endings,
      unchangedStatements,
    });

    /*
      And every standing link on this file follows what its card now names.

      After the census sync, so the tenant's own occupancy of a corrected flat
      is in place before the owner is put on it. See
      `LandlordLinkService.reconcileRegistration` — a card whose new state blocks
      its link is left as it was and reported, never silently unlinked.
    */
    const landlordLinkChanges = {
      unlinked: unlinkedBySave,
      reconciled: await this.reconcileLinksQuietly(registrationId, input.actor),
    };

    /*
      And the owner match is re-asked, because this save may have changed it.

      An edit is the one path that can *create* an open claim on a card that had
      none — an officer reaching the landlord for the first time and finally
      having a number to write down — and the one that can invalidate a link, by
      correcting the number it was made against (see `landlordLinkReset`). Both
      leave a question this screen should put now rather than post to a queue.
    */
    const landlordLinks = await this.landlordClaimsQuietly(
      registrationId,
      citizen.id,
      input.payload,
      input.actor,
    );

    /*
      Field by field, what this save changed — the question «who changed this,
      and what was it before?» the counts below could never answer. Sensitive
      fields are named, never valued (`SENSITIVE_FILE_FIELDS`).
    */
    const changes = fileChanges(fileBefore, await this.getEditable(citizen.id));

    this.events.emit('citizen.changed', {
      tenantSlug: input.tenantSlug,
      citizenId: citizen.id,
      action: 'CITIZEN_UPDATED',
      ...(Object.keys(changes.before).length > 0 ? { before: changes.before } : {}),
      after: {
        ...changes.after,
        ...(changes.changed.length > 0 ? { changed: changes.changed } : {}),
        ...(changes.cards.length > 0 ? { cards: changes.cards } : {}),
        ...(input.payload.changeReason ? { reason: input.payload.changeReason } : {}),
        // A real move («تغيير الإقامة»): the day it took effect. Only with a residence that changed.
        ...(input.payload.movedOn && changes.changed.includes('residence')
          ? { movedOn: input.payload.movedOn.toISOString() }
          : {}),
        propertyCount: entries.length,
        propertiesRemoved: removedIds.length,
        // What the officer said about each removed card — the reason its flats
        // closed the way they did in the census.
        ...(removals.length > 0
          ? {
              removals: removals.map((removal) => ({
                propertyId: removal.propertyId,
                reason: removal.reason,
                ...(removal.endedAt ? { endedAt: removal.endedAt } : {}),
              })),
            }
          : {}),
        status: nextStatus,
        unestablishedFields: flags.length,
        ...(duplicateFlagResolved
          ? {
              possibleDuplicateReviewed: {
                was: standingDuplicateFlag!.reason,
                reason: input.payload.duplicateReview!.reason,
              },
            }
          : {}),
      },
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });

    return {
      updated: true,
      citizenId: citizen.id,
      status: nextStatus,
      /** The file's version after this save, for a form that stays open. */
      version: await this.fileVersion(citizen.id),
      census,
      landlordLinks,
      /**
       * Links this save changed: undone because a card was removed or its
       * number corrected, and standing links brought into line with the flats
       * their card now names (or reported as blocked). The form says so,
       * because each one moves somebody else's bill.
       */
      landlordLinkChanges,
    };
  }

  /**
   * The flats each removed card claimed, keyed for the census sync, with what
   * the officer said about the card. See `CardEnding`.
   *
   * A card claims a flat the way `CensusSyncService` reads it: each current
   * row's `unitId`, or — a منزل with no rows — the one unit of its structure,
   * inferred only when the structure has exactly one. A flat claimed twice by
   * removed cards takes the first answer; the sync only closes a spell nothing
   * kept still claims, so a flat another current card holds is untouched.
   */
  private async removalEndings(
    removals: ReadonlyArray<{ propertyId: string; reason: CardEnding['reason']; endedAt?: Date }>,
    cards: ReadonlyMap<
      string,
      { propertyType: string; buildingId: string | null; units: Array<{ unitId: string | null }> }
    >,
  ): Promise<Map<string, CardEnding>> {
    const endings = new Map<string, CardEnding>();

    for (const removal of removals) {
      const card = cards.get(removal.propertyId);
      if (!card) continue;

      let unitIds = card.units.map((row) => row.unitId).filter((id): id is string => Boolean(id));
      if (unitIds.length === 0 && card.units.length === 0 && card.buildingId && card.propertyType === 'HOUSE') {
        const units = await this.db.unit.findMany({
          where: { buildingId: card.buildingId },
          select: { id: true },
          take: 2,
        });
        if (units.length === 1) unitIds = [units[0]!.id];
      }

      for (const unitId of unitIds) {
        if (endings.has(unitId)) continue;
        endings.set(unitId, {
          reason: removal.reason,
          ...(removal.endedAt ? { endedAt: removal.endedAt } : {}),
        });
      }
    }

    return endings;
  }

  /**
   * Tenants whose link names this person as the landlord of a flat the save
   * takes off their file — see the check in `update`.
   *
   * A flat is taken off when the owner's card holding it is deleted, turned
   * into something other than «مالك», or loses the row naming it — unless
   * another owner's card this save keeps still holds it. A card with no rows
   * holds its whole structure. A tenant's card with no rows claims the flats
   * the tenant is recorded living in, the census's own rule.
   */
  private async tenantsLinkedToDroppedOwnership(
    ownerId: string,
    stored: ReadonlyArray<{
      id: string;
      occupancyType: string;
      buildingId: string | null;
      units: ReadonlyArray<{ unitId: string | null }>;
    }>,
    kept: ReadonlyArray<{
      id?: string;
      props: {
        occupancyType?: unknown;
        buildingId?: unknown;
        units?: ReadonlyArray<{ unitId?: string | null }> | null;
      };
    }>,
  ): Promise<Array<{ citizenId: string; name: string; propertyEntryId: string }>> {
    const keptOwner = kept.filter((card) => card.props.occupancyType === 'OWNER');
    const rowsOf = (card: (typeof kept)[number]) =>
      (card.props.units ?? []).map((row) => row.unitId).filter((id): id is string => Boolean(id));
    const keptFlats = new Set(keptOwner.flatMap(rowsOf));
    const keptStructures = new Set(
      keptOwner
        .filter((card) => (card.props.units ?? []).length === 0 && typeof card.props.buildingId === 'string')
        .map((card) => card.props.buildingId as string),
    );
    const keptOwnerById = new Map(
      keptOwner.filter((card) => card.id).map((card) => [card.id as string, card]),
    );

    const droppedFlats = new Set<string>();
    const droppedFlatBuildings = new Set<string>();
    const droppedStructures = new Set<string>();
    for (const card of stored) {
      if (card.occupancyType !== 'OWNER') continue;
      if (card.buildingId && keptStructures.has(card.buildingId)) continue;
      const still = keptOwnerById.get(card.id);
      if (card.units.length === 0) {
        if (!still && card.buildingId) droppedStructures.add(card.buildingId);
        continue;
      }
      const stillRows = new Set(still ? rowsOf(still) : []);
      for (const row of card.units) {
        if (!row.unitId || stillRows.has(row.unitId) || keptFlats.has(row.unitId)) continue;
        droppedFlats.add(row.unitId);
        if (card.buildingId) droppedFlatBuildings.add(card.buildingId);
      }
    }
    if (droppedFlats.size === 0 && droppedStructures.size === 0) return [];

    const tenantCards = await this.db.propertyEntry.findMany({
      where: {
        landlordCitizenId: ownerId,
        endedAt: null,
        occupancyType: { in: ['TENANT', 'FREE_OCCUPANT'] as never },
        OR: [
          { units: { some: { unitId: { in: [...droppedFlats] }, endedAt: null } } },
          { buildingId: { in: [...droppedStructures, ...droppedFlatBuildings] } },
        ],
      },
      select: {
        id: true,
        buildingId: true,
        units: { where: { endedAt: null }, select: { unitId: true } },
        registration: {
          select: { citizen: { select: { id: true, firstName: true, middleName: true, lastName: true } } },
        },
      },
    });

    const linked: Array<{ citizenId: string; name: string; propertyEntryId: string }> = [];
    for (const card of tenantCards) {
      const tenant = card.registration.citizen;
      let claims = Boolean(card.buildingId && droppedStructures.has(card.buildingId));
      if (!claims && card.units.length > 0) {
        claims = card.units.some((row) => row.unitId && droppedFlats.has(row.unitId));
      } else if (!claims && card.buildingId) {
        const spells = await this.db.unitOccupancy.findMany({
          where: {
            citizenId: tenant.id,
            toDate: null,
            role: { not: 'OWNER' as never },
            unit: { buildingId: card.buildingId },
          },
          select: { unitId: true },
        });
        claims = spells.some((spell) => droppedFlats.has(spell.unitId));
      }
      if (!claims) continue;
      linked.push({
        citizenId: tenant.id,
        name: [tenant.firstName, tenant.middleName, tenant.lastName].filter(Boolean).join(' '),
        propertyEntryId: card.id,
      });
    }
    return linked;
  }

  /**
   * «مراجعة التعديلات» — what saving this edit would do, read and never written.
   *
   * The same comparison the save audits (`fileChanges`) between the file as it
   * stands and the file this payload would leave, and the same rules the save
   * enforces, asked early: whether a reason is needed (`highImpactChanges`),
   * and what would refuse it — a colleague's newer save, a tenant still linked
   * to an ownership this edit takes away. Plus what else the edit touches that
   * the form cannot show: the login it changes, the tenants' files that carry
   * this person's name, and the open bills calculated on what it corrects —
   * which a correction never changes, and which the accountant's list names.
   */
  async reviewEdit(citizenId: string, payload: AdminCitizenUpdateSubmission): Promise<EditReview> {
    const before = await this.getEditable(citizenId);
    const after = submittedView(payload);
    const changes = fileChanges(before, after);
    const reasonRequired = highImpactChanges(before, after, flaggedPaths(payload.flags));

    const blockers: EditReview['blockers'] = [];
    if (payload.expectedVersion && payload.expectedVersion !== before.version) {
      blockers.push({
        code: 'STALE',
        message: before.lastStaffEdit?.name
          ? `عدّل ${before.lastStaffEdit.name} هذا الملف بعد أن فتحتَه. حدِّث الصفحة لترى تعديلاته.`
          : 'عُدِّل هذا الملف بعد أن فتحتَه. حدِّث الصفحة لترى التعديلات.',
      });
    }
    const linked = await this.tenantsLinkedToDroppedOwnership(
      citizenId,
      before.properties.map((card) => ({
        id: card.id,
        occupancyType: card.occupancyType,
        buildingId: card.buildingId ?? null,
        units: card.units.map((row) => ({ unitId: row.unitId ?? null })),
      })),
      payload.properties.map((card) => ({ id: (card as { id?: string }).id, props: card as never })),
    );
    if (linked.length > 0) {
      blockers.push({
        code: 'TENANTS_LINKED',
        message: 'مستأجر مربوط بهذا الشخص مالكاً لوحدة يحذفها هذا الحفظ — ألغِ الربط من بطاقته أولاً، أو استخدم «إنهاء الملكية» إن كان قد باعها',
        tenants: linked,
      });
    }

    const nameOrPhone = changes.changed.some((field) => NAME_AND_PHONE.has(field));
    const tenantCards = nameOrPhone
      ? await this.db.propertyEntry.findMany({
          where: { landlordCitizenId: citizenId, endedAt: null },
          select: {
            registration: {
              select: { citizen: { select: { id: true, firstName: true, middleName: true, lastName: true } } },
            },
          },
        })
      : [];
    const tenants = new Map(
      tenantCards.map((card) => [
        card.registration.citizen.id,
        [card.registration.citizen.firstName, card.registration.citizen.middleName, card.registration.citizen.lastName]
          .filter(Boolean)
          .join(' '),
      ]),
    );

    const touchesBilling =
      changes.changed.includes('residence') ||
      changes.cards.some(
        (card) =>
          card.kind !== 'changed' ||
          Boolean(card.rows) ||
          (card.fields ?? []).some((field) => BILLING_FIELDS.has(field.field)),
      );
    const open = touchesBilling
      ? await this.db.citizenPayment.findMany({
          where: { citizenId, paymentStatus: { in: ['UNPAID', 'OVERDUE', 'PENDING_REVIEW'] as never } },
          select: { amount: true, paidAmount: true, currency: true },
        })
      : [];

    return {
      version: before.version,
      changes,
      reasonRequired,
      blockers,
      impacts: {
        loginChanges: changes.changed.includes('phone'),
        tenantsShowingName: [...tenants].map(([citizenId, name]) => ({ citizenId, name })),
        openBills:
          open.length > 0
            ? {
                count: open.length,
                outstanding: open.reduce((sum, bill) => sum + Number(bill.amount) - Number(bill.paidAmount), 0),
                currency: open[0]!.currency,
              }
            : null,
        cardsRemoved: changes.cards.filter((card) => card.kind === 'removed').length,
      },
    };
  }

  /** `reconcileRegistration`, with its failure kept off a save that committed. */
  private async reconcileLinksQuietly(
    registrationId: string,
    actor: { id: string; role: string },
  ): Promise<ReconcileResult | null> {
    try {
      return await this.landlordLinks.reconcileRegistration(registrationId, actor);
    } catch (error) {
      this.logger.error(
        `landlord link reconcile failed for registration ${registrationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }

  /**
   * Erases a citizen row outright — permitted only when nothing else in the
   * schema still points at them.
   *
   * Refused whenever the citizen has a registration, a payment of any status,
   * or a fee notice issued directly to them. A rejected claim or an unpaid
   * invoice is still the municipality's own record of what was reviewed and
   * why; cascading it away with the person would erase that history rather
   * than the citizen's identity data alone, and an orphaned fee notice would
   * be a bill with no one left to collect it from. Deactivate instead — hard
   * delete is left for a citizen row nothing has ever been built on top of.
   */
  async remove(input: {
    tenantSlug: string;
    citizenId: string;
    actor: { id: string; role: string };
  }) {
    const citizen = await this.db.user.findFirst({
      where: { id: input.citizenId, kind: 'CITIZEN' },
      select: { id: true, firstName: true, lastName: true, referenceNumber: true },
    });
    if (!citizen) throw new NotFoundError({
      code: 'CITIZEN_NOT_FOUND',
      message: `Citizen ${input.citizenId} was not found`,
    });

    /*
      A file on either side of a standing merge is not deleted: the delete
      cascades to `citizen_merges`, taking the record of the merge and its undo
      with it. The merge is undone first, or the file stays as the record of
      what was filed.
    */
    const merged = await this.db.citizenMerge.count({
      where: { undoneAt: null, OR: [{ survivorId: citizen.id }, { absorbedId: citizen.id }] },
    });
    if (merged > 0) {
      throw new ConflictError({
        code: 'CITIZEN_IN_MERGE',
        message: 'This file is part of an active merge, so it cannot be deleted. Undo the merge first if it must be deleted.',
        details: { code: 'MERGED' },
      });
    }

    const [registrations, payments, feeNotices] = await Promise.all([
      this.db.registration.count({ where: { citizenId: citizen.id } }),
      this.db.citizenPayment.count({ where: { citizenId: citizen.id } }),
      this.db.feeNotice.count({ where: { targetCitizenId: citizen.id } }),
    ]);
    if (registrations + payments + feeNotices > 0) {
      throw new ConflictError({
        code: 'CITIZEN_HAS_RECORDS',
        message: 'A citizen with filings, payments or fees cannot be deleted. Disable the account instead.',
      });
    }

    const deleted: CitizenChange & { tenantSlug: string } = {
      tenantSlug: input.tenantSlug,
      citizenId: citizen.id,
      action: 'CITIZEN_DELETED',
      before: {
        name: `${citizen.firstName} ${citizen.lastName}`,
        // A login credential: the trail keeps only the masked hint, never the key.
        maskedReference: ReferenceNumber.mask(citizen.referenceNumber),
      },
      actorId: input.actor.id,
      actorRole: input.actor.role,
    };
    // Tier 1 (docs/security.md): the deletion and its row commit together.
    await runInTenantTransaction(this.tenantContext, async () => {
      await this.db.user.delete({ where: { id: citizen.id } });
      await this.auditTrail.recordChangeInTransaction({ channel: 'citizen.changed', payload: deleted });
    });

    this.events.emit('citizen.changed', { ...deleted, alreadyAudited: true });

    return { deleted: true };
  }

  /** Soft delete and its undo — the reversible half of `remove`. */
  async setActive(input: {
    tenantSlug: string;
    citizenId: string;
    isActive: boolean;
    /** Why — the trail's answer to «why did this file stop being billed?». */
    reason?: string;
    /** A deactivation because they moved away: the day they left. */
    movedOn?: Date;
    actor: { id: string; role: string };
  }) {
    const citizen = await this.db.user.findFirst({
      where: { id: input.citizenId, kind: 'CITIZEN' },
      select: { id: true },
    });
    if (!citizen) throw new NotFoundError({
      code: 'CITIZEN_NOT_FOUND',
      message: `Citizen ${input.citizenId} was not found`,
    });

    /*
      Reactivating a file «دمج ملفين» folded away would bring back the double
      bill the merge removed, on a file that holds nothing — the undo is what
      makes it a file again, with everything it held.
    */
    if (input.isActive) await assertNotMergedAway(this.db, citizen.id);

    const changed: CitizenChange & { tenantSlug: string } = {
      tenantSlug: input.tenantSlug,
      citizenId: citizen.id,
      action: input.isActive ? 'CITIZEN_REACTIVATED' : 'CITIZEN_DEACTIVATED',
      ...(input.reason || input.movedOn
        ? {
            after: {
              ...(input.reason ? { reason: input.reason } : {}),
              ...(input.movedOn ? { movedOn: input.movedOn.toISOString() } : {}),
            },
          }
        : {}),
      actorId: input.actor.id,
      actorRole: input.actor.role,
    };
    // Tier 1 (docs/security.md): a status change and its row commit together.
    await runInTenantTransaction(this.tenantContext, async () => {
      await this.db.user.update({
        where: { id: citizen.id },
        data: { isActive: input.isActive },
      });
      await this.auditTrail.recordChangeInTransaction({ channel: 'citizen.changed', payload: changed });
    });

    this.events.emit('citizen.changed', { ...changed, alreadyAudited: true });

    return { isActive: input.isActive };
  }

  /**
   * Everyone registered on one رقم العقار, and what each of them holds there.
   *
   * The parcel-centric view of a citizen-centric register — a projection, not a
   * second place ownership is recorded. That distinction is the whole design.
   * A registrar naturally thinks in parcels ("who is on 1553?"), and it is
   * tempting to store the answer that way: a parcel row owning a list of units,
   * each naming its occupant. It cannot work here. Every fee is raised against
   * a `citizenId`, so an owner recorded as a name on a unit is an owner nobody
   * can bill — and the register would hold two answers to "who owns this",
   * which would disagree the first time one of them was edited.
   *
   * So ownership stays where billing can reach it, and the parcel view is
   * computed. Nothing can drift, because there is only one copy.
   *
   * Reads every registration rather than only the latest, deliberately: this
   * screen answers "who is on this parcel", and a household whose newest filing
   * is about a different property is still on this one.
   */
  async parcelRoster(propertyNumber: string) {
    const trimmed = propertyNumber.trim();

    const entries = await withConnectionRetry(() =>
      this.db.propertyEntry.findMany({
        // Who is on this parcel now — a tenant who left is not.
        where: { propertyNumber: trimmed, endedAt: null },
        select: {
          id: true,
          propertyType: true,
          occupancyType: true,
          buildingName: true,
          neighborhood: true,
          unitType: true,
          unitArea: true,
          unitStatus: true,
          units: {
            where: { endedAt: null },
            select: { id: true, unitType: true, floor: true, unitArea: true, unitStatus: true },
          },
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
                  referenceNumber: true,
                  isActive: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );

    /*
      Grouped by citizen, because that is the question being asked.

      One person may hold several cards on the same parcel now — a building, the
      house behind it, the shop on the street — and listing those as three
      unrelated rows would read as three different claimants on a screen whose
      entire purpose is to show who the claimants are.
    */
    const byCitizen = new Map<string, {
      citizenId: string;
      fullName: string;
      phone: string | null;
      referenceNumber: string | null;
      isActive: boolean;
      structures: Array<{
        propertyEntryId: string;
        propertyType: string;
        occupancyType: string;
        buildingName: string | null;
        units: Array<{
          id: string | null;
          unitType: string | null;
          floor: string | null;
          unitArea: number | null;
          /**
           * Why this parcel view is where حالة الوحدة earns the most.
           *
           * «مين على العقار ١٥٥٣؟» and «شو في فاضي بالعقار ١٥٥٣؟» are the same
           * question asked from either end, and the roster is the only screen
           * that already holds every card on the parcel at once. Null means
           * nobody was asked, which is not the same as occupied and must not
           * render as it.
           */
          unitStatus: string | null;
        }>;
      }>;
    }>();

    for (const entry of entries) {
      const citizen = entry.registration.citizen;
      const existing = byCitizen.get(citizen.id) ?? {
        citizenId: citizen.id,
        fullName: [citizen.firstName, citizen.middleName, citizen.lastName]
          .filter(Boolean)
          .join(' '),
        phone: citizen.phone,
        referenceNumber: citizen.referenceNumber,
        isActive: citizen.isActive,
        structures: [],
      };

      existing.structures.push({
        propertyEntryId: entry.id,
        propertyType: entry.propertyType,
        occupancyType: entry.occupancyType,
        buildingName: entry.buildingName,
        units:
          entry.units.length > 0
            ? entry.units.map((unit) => ({
                id: unit.id,
                unitType: unit.unitType,
                floor: unit.floor,
                unitArea: unit.unitArea === null ? null : Number(unit.unitArea),
                unitStatus: unit.unitStatus,
              }))
            : // A card whose single unit lives flat on the row itself. Shown the
              // same way, so the screen does not expose which of the two storage
              // shapes the register happened to use.
              [
                {
                  id: null,
                  unitType: entry.unitType,
                  floor: null,
                  unitArea: entry.unitArea === null ? null : Number(entry.unitArea),
                  unitStatus: entry.unitStatus,
                },
              ],
      });

      byCitizen.set(citizen.id, existing);
    }

    const neighborhood = entries.find((entry) => entry.neighborhood)?.neighborhood ?? null;

    return {
      propertyNumber: trimmed,
      neighborhood,
      citizenCount: byCitizen.size,
      structureCount: entries.length,
      citizens: [...byCitizen.values()],
    };
  }

  /**
   * The same cadastre resolution the submission path performs, with the same
   * outcome: a رقم العقار the registry has never heard of is reported, not
   * refused. See `RegistrationService.resolveParcels` for why that changed.
   *
   * Reporting matters more on this path than on the other one. This is the
   * screen someone opens to *finish* a record the cadastre already complained
   * about — and a save that threw would make correcting the rest of the record
   * impossible until the one field nobody can currently resolve is resolved.
   */
  private async resolveParcels(
    propertyNumbers: readonly string[],
  ): Promise<{ found: Map<string, ParcelLocation>; missing: Set<string> }> {
    const found = await this.parcels.findManyByNumber(propertyNumbers);

    const unresolved = propertyNumbers
      .map((number) => number.trim())
      .filter((number) => !found.has(number));

    const hasCadastre = unresolved.length > 0 && (await this.parcels.count()) > 0;

    return { found, missing: new Set(hasCadastre ? unresolved : []) };
  }
}

/**
 * The `users` columns an edit writes — which depends on what kind of file it is,
 * and deliberately leaves alone everything the form no longer asks.
 *
 * **Asked fields are written explicitly, `null` included.** `undefined` in a
 * Prisma `update` means "leave this alone", which is the wrong answer for a
 * field the officer has just flagged: the record would claim the value is
 * unestablished while still storing the old one. Flagging a field clears it,
 * here as on the create path.
 *
 * **Fields the form does not ask are not written at all**, and that is the
 * no-data-loss rule, not an oversight:
 *
 *  - The identity document. A Lebanese citizen is no longer asked for one, so
 *    this form cannot be the thing that erases the real numbers already on
 *    file. A non-Lebanese person's passport number is written when one is
 *    given, and cleared only when the box that showed it comes back empty:
 *    the stored document is a passport (so the form loaded it into that box)
 *    and the submission carries the field, blank. Anything else — a box that
 *    never held this number, an older client, a flagged field — keeps what is
 *    stored. Before this a wrong number typed at a doorstep could be replaced
 *    but never removed.
 *  - A non-resident record's household columns. A person converted to «غير
 *    مقيم في البلدة» keeps whatever was filed for them as a household; the form stops
 *    asking and stops showing, and nothing is erased by the conversion. The
 *    reverse conversion keeps `residencePlace` and the local contact for the
 *    same reason.
 */
export function citizenColumnsForEdit(
  payload: AdminCitizenUpdateSubmission,
  stored: { identityDocType: string | null } = { identityDocType: null },
): Prisma.UserUpdateInput {
  const { personal, contact } = payload;
  const shared = {
    firstName: personal.firstName,
    middleName: personal.middleName || null,
    lastName: personal.lastName,
    phone: contact.phone ?? null,
    whatsapp: contact.whatsapp ?? contact.phone ?? null,
  };

  if (payload.residence === 'NON_RESIDENT_OWNER') {
    return {
      ...shared,
      residence: 'NON_RESIDENT_OWNER',
      residencePlace: personal.residencePlace ?? null,
      localContactName: contact.localContactName ?? null,
      localContactPhone: contact.localContactPhone ?? null,
    };
  }

  const passport = identityDocumentOf(payload);
  const passportCleared =
    personal.isLebanese === false &&
    stored.identityDocType === 'PASSPORT' &&
    'identityDocNumber' in personal &&
    !String(personal.identityDocNumber ?? '').trim();

  return {
    ...shared,
    residence: 'RESIDENT',
    /*
      Written on the household branch alone, so converting a file to «غير مقيم
      في البلدة» keeps whatever was filed rather than erasing it — the same
      no-data-loss rule the household counts above follow.
    */
    motherName: personal.motherName || null,
    gender: (personal.gender ?? null) as never,
    nationality: personal.nationality ?? null,
    isLebanese: personal.isLebanese ?? null,
    residencyNumber: personal.residencyNumber || null,
    residentStatus: (personal.residentStatus ?? null) as never,
    civilRecordNumber: personal.civilRecordNumber || null,
    maritalStatus: (contact.maritalStatus ?? null) as never,
    totalRegisteredMembers: contact.totalRegisteredMembers ?? null,
    actualHouseholdMembers: contact.actualHouseholdMembers ?? null,
    bloodType: (personal.bloodType ?? null) as never,
    ...(passport.identityDocNumber
      ? {
          identityDocType: passport.identityDocType as never,
          identityDocNumber: passport.identityDocNumber,
        }
      : passportCleared
        ? { identityDocType: null, identityDocNumber: null }
        : {}),
  };
}

/**
 * A submitted edit, read as the file it would leave — the shape `getEditable`
 * returns — so it can be compared with the stored one before anything is
 * written (`highImpactChanges`, the review step).
 */
function submittedView(payload: AdminCitizenUpdateSubmission): EditableFileView {
  return {
    residence: payload.residence,
    notes: payload.notes ?? null,
    personal: payload.personal as Record<string, unknown>,
    contact: payload.contact as Record<string, unknown>,
    properties: payload.properties.map((card, index) => ({
      ...(card as Record<string, unknown>),
      // A new card has no id yet; a placeholder keeps it from matching a stored one.
      id: (card as { id?: string }).id ?? `new:${index}`,
    })) as EditableFileView['properties'],
  };
}

/** A name or number that tenants' files show for their landlord. */
const NAME_AND_PHONE = new Set(['firstName', 'middleName', 'lastName', 'phone']);

/** Card fields an assessment is calculated from. */
const BILLING_FIELDS = new Set(['unitArea', 'unitStatus', 'unitType', 'propertyType', 'occupancyType', 'landType', 'shares']);

/** What «مراجعة التعديلات» shows — see `CitizensService.reviewEdit`. */
export interface EditReview {
  /** The file's version now — the form sends it back as `expectedVersion`. */
  version: string;
  changes: FileChanges;
  /** High-impact fields this edit corrects: the save needs a reason. */
  reasonRequired: string[];
  /** What would refuse the save — shown before it is pressed. */
  blockers: Array<{
    code: 'STALE' | 'TENANTS_LINKED';
    message: string;
    tenants?: Array<{ citizenId: string; name: string; propertyEntryId: string }>;
  }>;
  impacts: {
    /** Citizens sign in with their reference number and phone. */
    loginChanges: boolean;
    /** Tenants whose files show this person as their landlord. */
    tenantsShowingName: Array<{ citizenId: string; name: string }>;
    /** Open bills calculated on what this edit corrects — never changed by it. */
    openBills: { count: number; outstanding: number; currency: string } | null;
    cardsRemoved: number;
  };
}

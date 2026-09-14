import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  adminCreateCitizenSchema,
  buildCitizenPayload,
  cadastreFlags,
  FIELD_FLAG_KINDS,
  IMPORT_COLUMNS,
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
import { CensusSyncService } from '../buildings/census-sync.service';
import {
  LandlordLinkService,
  type LandlordProposal,
  type PendingEvent,
  type ReconcileResult,
  type RevertReport,
} from './landlord-link.service';
import {
  identityDocumentOf,
  RegistrationService,
  unestablishedOnCard,
} from '../registration/registration.service';
import { TenantService } from '../tenant/tenant.service';

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
   * The citizen's record shaped back into the form that edits it.
   *
   * Returns exactly the three sections `adminUpdateCitizenSchema` expects, so
   * the edit page can load and post the same object. Only the *latest*
   * registration's properties are included — see `update` for why that is the
   * one the form owns.
   */
  async getEditable(citizenId: string) {
    const citizen = await withConnectionRetry(() =>
      this.db.user.findFirst({
        where: { id: citizenId, kind: 'CITIZEN' },
        select: {
          id: true,
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
                  units: { where: { endedAt: null }, orderBy: { createdAt: 'asc' } },
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

    if (!citizen) throw new NotFoundError('Citizen', citizenId);

    const registration = citizen.registrations[0] ?? null;

    return {
      id: citizen.id,
      registrationId: registration?.id ?? null,
      referenceNumber: registration?.referenceNumber ?? null,
      status: registration?.status ?? null,
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
        // from whether the two numbers currently match.
        whatsappSameAsPhone: citizen.whatsapp === citizen.phone,
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
          unitArea: Number(unit.unitArea),
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
  async create(input: {
    tenantSlug: string;
    payload: AdminCitizenSubmission;
    actor: { id: string; role: string };
  }) {
    const result = await this.registrations.submit({
      tenantSlug: input.tenantSlug,
      payload: input.payload,
      createdById: input.actor.id,
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
            properties: {
              select: { id: true, landlordPhone: true, landlordCitizenId: true, endedAt: true },
            },
          },
        },
      },
    });
    if (!citizen) throw new NotFoundError('Citizen', input.citizenId);

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
    const flags: FieldFlag[] = submittedFlags.filter((flag) => {
      const match = /^properties\.(\d+)\.(landlordName|landlordPhone)$/.exec(flag.path);
      return !(match && linkLocked.has(Number(match[1])));
    });

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
        throw new ConflictError(
          `هذه البلدية لا تستقبل حالياً تسجيل هذا النوع من العقارات (${entry.props.propertyType})`,
        );
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
        throw new ConflictError('انتهى الإيجار على إحدى البطاقات منذ فتح هذا النموذج — حدّث الصفحة', {
          propertyId: id,
        });
      }
      if (id && !existingIds.has(id)) {
        throw new ValidationError('هذا العقار لا ينتمي إلى آخر طلب لهذا المواطن', {
          propertyId: id,
        });
      }
    }

    const keptIds = new Set(entries.map(({ id }) => id).filter(Boolean) as string[]);
    const removedIds = [...existingIds].filter((id) => !keptIds.has(id));

    /** What undoing links during this save wrote, emitted once it commits. */
    const revertEvents: PendingEvent[] = [];
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
        data: citizenColumnsForEdit(input.payload),
      });

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
            select: { id: true, endedAt: true, createdAt: true },
          });
          const storedById = new Map(stored.map((row) => [row.id, row]));
          const kept = new Set<string>();
          const lines = units.map((unit, position) => {
            const rowId = rowIds[position];
            const row = rowId ? storedById.get(rowId) : undefined;
            if (row?.endedAt) {
              throw new ConflictError(
                'انتهى الإيجار على إحدى وحدات هذه البطاقة منذ فتح هذا النموذج — حدّث الصفحة',
                { propertyId: id, rowId },
              );
            }
            if (row && !kept.has(row.id)) {
              kept.add(row.id);
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

    this.events.emit('citizen.changed', {
      tenantSlug: input.tenantSlug,
      citizenId: citizen.id,
      action: 'CITIZEN_UPDATED',
      after: {
        propertyCount: entries.length,
        propertiesRemoved: removedIds.length,
        status: nextStatus,
        unestablishedFields: flags.length,
      },
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });

    return {
      updated: true,
      citizenId: citizen.id,
      status: nextStatus,
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
    if (!citizen) throw new NotFoundError('Citizen', input.citizenId);

    const [registrations, payments, feeNotices] = await Promise.all([
      this.db.registration.count({ where: { citizenId: citizen.id } }),
      this.db.citizenPayment.count({ where: { citizenId: citizen.id } }),
      this.db.feeNotice.count({ where: { targetCitizenId: citizen.id } }),
    ]);
    if (registrations + payments + feeNotices > 0) {
      throw new ConflictError(
        'لا يمكن حذف مواطن لديه طلبات تسجيل أو مدفوعات أو رسوم مرتبطة به — يمكنك تعطيل الحساب بدلاً من ذلك.',
      );
    }

    await this.db.user.delete({ where: { id: citizen.id } });

    this.events.emit('citizen.changed', {
      tenantSlug: input.tenantSlug,
      citizenId: citizen.id,
      action: 'CITIZEN_DELETED',
      before: {
        name: `${citizen.firstName} ${citizen.lastName}`,
        referenceNumber: citizen.referenceNumber,
      },
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });

    return { deleted: true };
  }

  /** Soft delete and its undo — the reversible half of `remove`. */
  async setActive(input: {
    tenantSlug: string;
    citizenId: string;
    isActive: boolean;
    actor: { id: string; role: string };
  }) {
    const citizen = await this.db.user.findFirst({
      where: { id: input.citizenId, kind: 'CITIZEN' },
      select: { id: true },
    });
    if (!citizen) throw new NotFoundError('Citizen', input.citizenId);

    await this.db.user.update({
      where: { id: citizen.id },
      data: { isActive: input.isActive },
    });

    this.events.emit('citizen.changed', {
      tenantSlug: input.tenantSlug,
      citizenId: citizen.id,
      action: input.isActive ? 'CITIZEN_REACTIVATED' : 'CITIZEN_DEACTIVATED',
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });

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
 *    file. A non-Lebanese person's passport number is written only when one is
 *    given; a blank field keeps what is stored.
 *  - A non-resident record's household columns. A person converted to «غير
 *    مقيم في البلدة» keeps whatever was filed for them as a household; the form stops
 *    asking and stops showing, and nothing is erased by the conversion. The
 *    reverse conversion keeps `residencePlace` and the local contact for the
 *    same reason.
 */
export function citizenColumnsForEdit(
  payload: AdminCitizenUpdateSubmission,
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
      : {}),
  };
}

import { Inject, Injectable } from '@nestjs/common';
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
import {
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
  phone: string | null;
  whatsapp: string | null;
  gender: string | null;
  referenceNumber: string | null;
  identityDocType: string | null;
  identityDocNumber: string | null;
  residentStatus: string | null;
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
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly registrations: RegistrationService,
    private readonly tenants: TenantService,
    @Inject(PARCEL_REPOSITORY) private readonly parcels: ParcelRepository,
    private readonly events: EventEmitter2,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
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
          SELECT r.status::text FROM registrations r
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
          u.phone,
          u.whatsapp,
          u.gender::text AS gender,
          u."referenceNumber",
          u."identityDocType"::text  AS "identityDocType",
          u."identityDocNumber",
          u."residentStatus"::text   AS "residentStatus",
          u."isActive",
          u."createdAt",
          (SELECT count(*)::int FROM registrations r WHERE r."citizenId" = u.id)
            AS "registrationCount",
          (SELECT count(*)::int
             FROM property_entries pe
             JOIN registrations r ON r.id = pe."registrationId"
            WHERE r."citizenId" = u.id)
            AS "propertyCount",
          (SELECT r.status::text FROM registrations r
            WHERE r."citizenId" = u.id ORDER BY r."submittedAt" DESC LIMIT 1)
            AS "latestStatus",
          (SELECT r."submittedAt" FROM registrations r
            WHERE r."citizenId" = u.id ORDER BY r."submittedAt" DESC LIMIT 1)
            AS "latestSubmittedAt",
          -- How many «غير مؤكَّد» fields that latest registration carries.
          -- jsonb_typeof guards the count against a row whose column holds
          -- something other than an array; the default is an empty array, but
          -- a hand-run fix or an older backup restored here need not be.
          COALESCE((SELECT
              CASE WHEN jsonb_typeof(r."flaggedFields") = 'array'
                   THEN jsonb_array_length(r."flaggedFields") ELSE 0 END
             FROM registrations r
            WHERE r."citizenId" = u.id ORDER BY r."submittedAt" DESC LIMIT 1), 0)::int
            AS "unestablishedFieldCount",
          COALESCE((SELECT sum(p.amount) FROM citizen_payments p
                     WHERE p."citizenId" = u.id), 0)::float8
            AS "feesTotal",
          COALESCE((SELECT sum(p."paidAmount") FROM citizen_payments p
                     WHERE p."citizenId" = u.id), 0)::float8
            AS "paidTotal",
          COALESCE((SELECT sum(p.amount - p."paidAmount") FROM citizen_payments p
                     WHERE p."citizenId" = u.id AND p."paymentStatus" <> 'PAID'), 0)::float8
            AS "outstandingTotal",
          COALESCE((SELECT sum(p.amount - p."paidAmount") FROM citizen_payments p
                     WHERE p."citizenId" = u.id
                       AND p."paymentStatus" = 'UNPAID'
                       AND p."dueDate" < now()), 0)::float8
            AS "overdueTotal",
          (SELECT count(*)::int FROM citizen_payments p
            WHERE p."citizenId" = u.id
              AND p."paymentStatus" = 'UNPAID'
              AND p."dueDate" < now())
            AS "overdueCount",
          (SELECT count(*)::int FROM citizen_payments p
            WHERE p."citizenId" = u.id AND p."paymentStatus" = 'PENDING_REVIEW')
            AS "pendingReviewCount"
        FROM users u
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
            COALESCE((SELECT sum(p.amount - p."paidAmount") FROM citizen_payments p
                       WHERE p."citizenId" = u.id AND p."paymentStatus" <> 'PAID'), 0)
          ), 0)::float8 AS "allOutstanding",
          COALESCE(sum(
            COALESCE((SELECT sum(p.amount - p."paidAmount") FROM citizen_payments p
                       WHERE p."citizenId" = u.id
                         AND p."paymentStatus" = 'UNPAID'
                         AND p."dueDate" < now()), 0)
          ), 0)::float8 AS "allOverdue",
          count(*) FILTER (
            WHERE (SELECT count(*) FROM citizen_payments p
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
            WHERE (SELECT r.status::text FROM registrations r
                    WHERE r."citizenId" = u.id
                    ORDER BY r."submittedAt" DESC LIMIT 1) = 'REQUIRES_REVIEW'
          )::int AS "allRequiringReview"
        FROM users u
        WHERE u.kind = 'CITIZEN'
        ${searchFilter}
      `,
      ]),
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        fullName: [row.firstName, row.middleName, row.lastName].filter(Boolean).join(' '),
        phone: row.phone,
        whatsapp: row.whatsapp,
        gender: row.gender,
        referenceNumber: row.referenceNumber,
        identityDocType: row.identityDocType,
        identityDocNumber: row.identityDocNumber,
        residentStatus: row.residentStatus,
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
          registrations: {
            orderBy: { submittedAt: 'desc' },
            take: 1,
            select: {
              id: true,
              referenceNumber: true,
              status: true,
              flaggedFields: true,
              properties: {
                orderBy: { createdAt: 'asc' },
                include: { units: { orderBy: { createdAt: 'asc' } } },
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
      personal: {
        firstName: citizen.firstName,
        middleName: citizen.middleName ?? '',
        lastName: citizen.lastName,
        gender: citizen.gender,
        bloodType: citizen.bloodType ?? '',
        nationality: citizen.nationality,
        isLebanese: citizen.isLebanese,
        residencyNumber: citizen.residencyNumber ?? '',
        residentStatus: citizen.residentStatus,
        identityDocType: citizen.identityDocType,
        identityDocNumber: citizen.identityDocNumber ?? '',
        civilRecordNumber: citizen.civilRecordNumber ?? '',
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
      },
      properties: (registration?.properties ?? []).map((property) => ({
        id: property.id,
        occupancyType: property.occupancyType,
        landlordName: property.landlordName,
        landlordPhone: property.landlordPhone,
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
        units: property.units.map((unit) => ({
          id: unit.id,
          unitType: unit.unitType,
          floor: unit.floor,
          side: unit.side,
          unitArea: Number(unit.unitArea),
          sharedRights: unit.sharedRights,
          unitStatus: unit.unitStatus,
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
    };
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
            flags: [],
            blanketFlagReason: undefined,
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
          select: { id: true, properties: { select: { id: true } } },
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
    const flags: FieldFlag[] = [
      ...input.payload.flags,
      ...cadastreFlags(input.payload.properties, missing, input.payload.flags),
    ];

    const entries = input.payload.properties.map((property, index) => {
      const { id, ...values } = property as { id?: string } & Record<string, unknown>;
      const parcel =
        typeof values.propertyNumber === 'string'
          ? cadastre.get(values.propertyNumber.trim())
          : undefined;
      return {
        id,
        entry: PropertyEntry.create(
          {
            ...values,
            latitude: parcel?.latitude ?? null,
            longitude: parcel?.longitude ?? null,
          } as never,
          unestablishedOnCard(flags, index),
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
    const existingIds = new Set(existing?.properties.map((property) => property.id) ?? []);

    // An id from another citizen's claim must not be steered into this one.
    // Checked before anything is written, so a crafted payload fails whole.
    for (const { id } of entries) {
      if (id && !existingIds.has(id)) {
        throw new ValidationError('هذا العقار لا ينتمي إلى آخر طلب لهذا المواطن', {
          propertyId: id,
        });
      }
    }

    const keptIds = new Set(entries.map(({ id }) => id).filter(Boolean) as string[]);
    const removedIds = [...existingIds].filter((id) => !keptIds.has(id));

    // Where the record stands *after* this save. A record whose last gap was
    // just filled in leaves «يتطلب مراجعة» by the same rule that put it there.
    const nextStatus: CitizenRecordStatus = statusForFlags(flags);

    await this.db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: citizen.id },
        data: {
          firstName: input.payload.personal.firstName,
          middleName: input.payload.personal.middleName || null,
          lastName: input.payload.personal.lastName,
          /*
            Every column is written explicitly, `null` included.

            `undefined` in a Prisma `update` means "leave this alone", which is
            the wrong answer for a field the officer has just flagged: the
            record would claim the value is unestablished while still storing
            the old one, and whoever came to complete it would find it already
            filled. Flagging a field clears it, here as on the create path.
          */
          gender: (input.payload.personal.gender ?? null) as never,
          nationality: input.payload.personal.nationality ?? null,
          isLebanese: input.payload.personal.isLebanese ?? null,
          residencyNumber: input.payload.personal.residencyNumber || null,
          residentStatus: (input.payload.personal.residentStatus ?? null) as never,
          identityDocType: (input.payload.personal.identityDocType ?? null) as never,
          /*
            Null, not '', when the document itself was left unestablished.

            The empty string is a value, and `users` is uniquely keyed by
            (نوع الوثيقة, رقم الوثيقة) — so a second citizen in the same
            position would collide with the first on a number neither of them
            has. A null is distinct from every other null in a Postgres unique
            index, which is exactly the semantics "we do not know" needs.
          */
          identityDocNumber:
            input.payload.personal.identityDocNumber ||
            input.payload.personal.residencyNumber ||
            null,
          civilRecordNumber: input.payload.personal.civilRecordNumber || null,
          phone: input.payload.contact.phone ?? null,
          whatsapp: input.payload.contact.whatsapp ?? input.payload.contact.phone ?? null,
          maritalStatus: (input.payload.contact.maritalStatus ?? null) as never,
          totalRegisteredMembers: input.payload.contact.totalRegisteredMembers ?? null,
          actualHouseholdMembers: input.payload.contact.actualHouseholdMembers ?? null,
          bloodType: (input.payload.personal.bloodType ?? null) as never,
        },
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
          data: { status: nextStatus, flaggedFields: flags as never },
        });
      }

      if (removedIds.length > 0) {
        await tx.propertyEntry.deleteMany({
          where: { id: { in: removedIds }, registrationId },
        });
      }

      for (const { id, entry } of entries) {
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
        };

        const units = (p.units ?? []).map((unit) => ({
          unitType: unit.unitType as never,
          floor: unit.floor,
          side: unit.side ?? null,
          unitArea: unit.unitArea,
          sharedRights: unit.sharedRights ?? [],
          unitStatus: (unit.unitStatus ?? null) as never,
        }));

        if (id) {
          await tx.propertyEntry.update({
            where: { id },
            data: {
              ...data,
              // Units are replaced wholesale rather than reconciled one by one.
              // They carry no documents and no id anyone outside this record
              // holds, so identity buys nothing here — unlike the property row
              // above, whose id a deed is attached to.
              units: { deleteMany: {}, create: units },
            },
          });
        } else {
          await tx.propertyEntry.create({
            data: { registrationId, ...data, units: { create: units } },
          });
        }
      }
    });

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

    return { updated: true, citizenId: citizen.id, status: nextStatus };
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
        where: { propertyNumber: trimmed },
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

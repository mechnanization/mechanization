import { IMPORT_BATCH_SIZE, type ReinspectionsPage, type CitizenImportResult, type CitizenMergePreview, type CitizenMergeRecord, type CitizenMergeResult, type CitizenUnmergePreview, type CitizenRecordStatus, type CitizenResidence, type DuplicateMatchedOn, type FieldFlag, type ImportRow, type PossibleDuplicateMatch, type PossibleDuplicatesQuery, type SurveyStatus, type UnitType } from '@mechanization/shared-schemas';
import { cachedRequest, invalidateRequests, peekCachedRequest } from '../request-cache';
import { ApiRequestError, apiFetch } from './core';
import { invalidateCensus, type CensusSyncResult } from './buildings';

export interface PropertyNumberCheck {
  propertyNumber: string;
  /** In the municipality's cadastre. Null when the municipality has none. */
  inCadastre: boolean | null;
  location: { latitude: number; longitude: number; approximate: boolean } | null;
  /** Nearest real parcel numbers, offered only when the typed one is unknown. */
  suggestions: string[];
  /**
   * Neighbours already registered on this parcel. Informational only — a
   * building shares one cadastral number, so this never blocks an entry.
   */
  registeredCount: number;
}

/**
 * Blur-check for رقم العقار while it is being typed into the entry form.
 *
 * Remembered per parcel, because the answer is a property of the cadastre
 * rather than of this visit: the same عقار is checked again by every card of a
 * household on it, again when the card is unfolded, and again when the record
 * is opened to fix a phone number. Only `registeredCount` moves, and a citizen
 * write drops the entry (see `invalidateParcelChecks`).
 */
export function checkPropertyNumber(tenant: string, propertyNumber: string) {
  return cachedRequest(parcelCheckKey(tenant, propertyNumber), PARCEL_CHECK_TTL_MS, () =>
    apiFetch<PropertyNumberCheck>(
      tenant,
      `/registrations/property-number/${encodeURIComponent(propertyNumber)}/availability`,
    ),
  );
}

const PARCEL_CHECK_TTL_MS = 5 * 60 * 1000;

const parcelCheckKey = (tenant: string, propertyNumber: string) =>
  `parcel-check:${tenant}:${propertyNumber}`;

function invalidateParcelChecks(tenant: string): void {
  invalidateRequests(`parcel-check:${tenant}:`);
}

/**
 * The verdict already held for this parcel, for a field seeding its first
 * render. A control that re-mounts on an unchanged number should state what it
 * knows, not spend half a second saying «جارٍ التحقق» about it again.
 */
export function peekPropertyNumberCheck(tenant: string, propertyNumber: string) {
  return peekCachedRequest<PropertyNumberCheck>(parcelCheckKey(tenant, propertyNumber));
}
// ─────────────────────  Citizens registry (staff CRUD)  ─────────────────────

/** One row of the admin citizens table — pre-aggregated, including fee totals. */
export interface CitizenListItem {
  id: string;
  fullName: string;
  /**
   * اسم الأم وشهرتها — the one thing on this row that tells two «محمد خليل»s
   * apart, which is why it travels with every list the UI offers people from.
   *
   * Optional and nullable on the wire: absent means «لم يُسأل» (a record filed
   * before migration 0044), never «a different mother».
   */
  motherName?: string | null;
  phone: string | null;
  whatsapp: string | null;
  /** «لا يملك رقم هاتف» — the empty phone is an answer. Absent from an older server. */
  hasNoPhone?: boolean;
  /** «رقم للتواصل» — a relative's number, never the citizen's own. */
  contactPhone?: string | null;
  /** The search found this row by its «رقم للتواصل». */
  matchedOnContactPhone?: boolean;
  gender: string | null;
  referenceNumber: string | null;
  identityDocType: string | null;
  identityDocNumber: string | null;
  residentStatus: string | null;
  /**
   * نوع الملف — a household (RESIDENT), «غير مقيم في البلدة» (NON_RESIDENT_OWNER),
   * «تركة (ورثة المرحوم)» (ESTATE) or «جهة أو وقف» (INSTITUTION).
   */
  residence?: CitizenResidence;
  isActive: boolean;
  /** The file «دمج ملفين» folded this one into — pickers skip it, the register points to it. */
  mergedIntoId?: string | null;
  registeredAt: string;

  registrationCount: number;
  propertyCount: number;
  /** When this citizen last filed, if ever. */
  latestSubmittedAt: string | null;
  /** Where their latest registration stands — `REQUIRES_REVIEW` or `PENDING`. */
  latestStatus: string | null;
  /**
   * How many fields on that registration were left «غير مؤكَّد».
   *
   * The registry shows the count; the record's own page shows which fields and
   * the reason given for each.
   */
  unestablishedFieldCount: number;

  feesTotal: number;
  paidTotal: number;
  outstandingTotal: number;
  /** The slice of `outstandingTotal` whose due date has passed — المتأخرات. */
  overdueTotal: number;
  overdueCount: number;
  pendingReviewCount: number;
}

/**
 * The citizen registry. `search` matches name, phone, رقم مرجعي or document
 * number server-side — the table's own search box narrows the page further in
 * the browser.
 */
export function listCitizens(
  tenant: string,
  token: string,
  filter: {
    search?: string;
    limit?: number;
    offset?: number;
    /** `REQUIRES_REVIEW` narrows to records with fields left «غير مؤكَّد». */
    status?: CitizenRecordStatus;
  } = {},
  /**
   * Cancels the request when a newer one supersedes it.
   *
   * Supplied by React Query, which fires it as soon as the query key changes —
   * a new search term, the next page, a different tab. Without it, two requests
   * for the same table race and the slower response wins, so a clerk who
   * corrects a search quickly is shown the results of the term they abandoned.
   */
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filter.search) query.set('search', filter.search);
  if (filter.status) query.set('status', filter.status);
  query.set('limit', String(filter.limit ?? 200));
  query.set('offset', String(filter.offset ?? 0));

  return apiFetch<{
    items: CitizenListItem[];
    total: number;
    /**
     * Computed over every matching citizen, not the returned page.
     *
     * `requiringReview` is deliberately *not* narrowed by the status filter —
     * it is the number the «يتطلب مراجعة» tab offers, so it has to keep saying
     * the same thing once that tab is the one you are on.
     */
    totals: {
      outstanding: number;
      overdue: number;
      inArrears: number;
      requiringReview: number;
      /**
       * «إجمالي الأسر» — live household files over the whole register, never
       * narrowed by the search. Absent from an older server.
       */
      families?: number;
    };
  }>(tenant, `/citizens?${query}`, { token, signal });
}

/**
 * One row of «يتطلب مراجعة» — `CitizensService.reviewQueue` on the server.
 * Only what the queue shows: no fee figures, no identity-document number.
 */
export interface ReviewQueueItem {
  id: string;
  fullName: string;
  /** Null on records filed before migration 0044 — «لم يُسأل», not a difference. */
  motherName: string | null;
  referenceNumber: string | null;
  phone: string | null;
  /** «لا يملك رقم هاتف» — absent from an older server. */
  hasNoPhone?: boolean;
  /** Always `REQUIRES_REVIEW` in this list. */
  status: CitizenRecordStatus;
  /** How many «غير مؤكَّد» fields the latest registration carries. */
  openFieldCount: number;
  submittedAt: string;
  /** Who filed it. Optional for an older server; null when unrecorded. */
  filedByName?: string | null;
  /** Their staff id — pressing the name narrows an admin's queue to that officer. */
  filedById?: string | null;
}

/**
 * «يتطلب مراجعة» — citizens whose latest registration was filed with fields
 * left «غير مؤكَّد», oldest first. Narrowed on the server; `search` matches as
 * the registry's does.
 */
export function getReviewQueue(
  tenant: string,
  token: string,
  filter: WorklistFilter = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filter.search) query.set('search', filter.search);
  if (filter.owner) query.set('owner', filter.owner);
  query.set('limit', String(filter.limit ?? 25));
  query.set('offset', String(filter.offset ?? 0));
  return apiFetch<{ items: ReviewQueueItem[]; total: number }>(
    tenant,
    `/citizens/review-queue?${query}`,
    { token, signal },
  );
}

/**
 * What a collection worklist is asked for. `owner` — a staff id, or
 * `WORKLIST_UNASSIGNED` for work whose officer is gone — is honoured only for a
 * role that sees everyone's work; an officer's list is always their own.
 */
export interface WorklistFilter {
  search?: string;
  owner?: string;
  limit?: number;
  offset?: number;
}

/** One row of «وحدات غير ممسوحة» — `GET /buildings/unsurveyed-units`. */
export interface UnsurveyedUnitRow {
  unitId: string;
  unitCode: string;
  floor: number;
  unitType: UnitType;
  surveyStatus: SurveyStatus;
  /** Attempts so far — three unanswered doors are a different visit from none. */
  visitCount: number;
  lastVisitAt: string | null;
  buildingId: string;
  buildingCode: string;
  buildingName: string | null;
  parcelNumber: string;
  /** Who put the building on the census — shown to the roles that see everyone's. */
  addedByName: string | null;
  /** Their staff id — pressing the name narrows an admin's list to that officer. */
  addedById?: string | null;
  /** The door's open case, if any — a refused or unreachable flat already booked for a revisit. */
  openCaseType?: string | null;
  scheduledRevisitAt?: string | null;
}

/**
 * «وحدات غير ممسوحة» — units with no survey answer and nobody recorded on
 * them, in the buildings the viewer added; the roles that see all staff work
 * (`seesAllStaffWork`) get everyone's. Narrowed and paged on the server.
 */
export function getUnsurveyedUnits(
  tenant: string,
  token: string,
  filter: WorklistFilter = {},
  signal?: AbortSignal,
) {
  return apiFetch<{ items: UnsurveyedUnitRow[]; total: number }>(
    tenant,
    `/buildings/unsurveyed-units?${worklistQuery(filter)}`,
    { token, signal },
  );
}

/**
 * «بانتظار إعادة الكشف» — flats and structures read «غير صالحة للسكن»,
 * waiting for the visit after repair that releases their fee hold. Planned
 * days first, the most overdue at the top. Narrowed and paged on the server.
 */
export function getReinspections(
  tenant: string,
  token: string,
  filter: WorklistFilter = {},
  signal?: AbortSignal,
) {
  return apiFetch<ReinspectionsPage>(tenant, `/buildings/reinspections?${worklistQuery(filter)}`, {
    token,
    signal,
  });
}

function worklistQuery(filter: WorklistFilter): URLSearchParams {
  const query = new URLSearchParams();
  if (filter.search) query.set('search', filter.search);
  if (filter.owner) query.set('owner', filter.owner);
  query.set('limit', String(filter.limit ?? 25));
  query.set('offset', String(filter.offset ?? 0));
  return query;
}

/**
 * The three sections the admin form edits, exactly as it posts them back.
 *
 * `properties` carries only the citizen's most recent registration — the one
 * the form owns. Earlier claims stay visible on the profile page with their
 * own review state, so a name correction cannot silently reopen a claim
 * approved months ago.
 */
export interface CitizenFormData {
  id: string;
  registrationId: string | null;
  /** The filing's own number (رقم الطلب) — not the citizen's. */
  referenceNumber: string | null;
  /** The citizen's الرقم المرجعي, as the citizen file shows it. */
  citizenReferenceNumber?: string | null;
  status: string | null;
  /** نوع الملف the record was filed as. */
  residence?: CitizenResidence;
  personal: Record<string, unknown>;
  contact: Record<string, unknown>;
  properties: Array<Record<string, unknown>>;
  /**
   * The «غير مؤكَّد» fields already on this record, with the reasons given.
   *
   * The edit form opens with these restored so whoever completes the record
   * sees which blanks were deliberate — and can clear a flag simply by filling
   * the field in, which is what takes the record out of «يتطلب مراجعة».
   */
  flags: FieldFlag[];
  /** «ملاحظات» on the most recent registration, or null for none. */
  notes: string | null;
  /**
   * Each card's place in the census, read-only: the building's code and
   * parcel, and each flat's unit code. Never sent back — the census owns it.
   */
  propertyRefs?: Array<{
    propertyId: string;
    buildingCode: string | null;
    parcelNumber: string | null;
    /** `unitId` is the census unit the flat is — what the drawing lights. */
    units: Array<{ id: string; unitCode: string | null; unitId: string | null }>;
    /**
     * The linked building's shape, for the elevation drawing, and its census
     * summary (`BuildingCensusSummary`) — no occupants.
     */
    building: {
      structureType: string;
      lifecycleStatus: string;
      floorsCount: number;
      basementsCount: number;
      parcelNumber: string;
      postedNumber: string | null;
      sharedParcelNumbers: string[];
      isPartitioned: boolean | null;
      partitionNumbers: string[];
      located: boolean;
      unitsTotal: number;
      unitsSurveyed: number;
      zoneCode: string | null;
      zoneName: string | null;
      units: Array<{
        id: string;
        floor: number;
        sequence: number;
        unitType: string | null;
        unitCode: string;
        startCol: number | null;
        endCol: number | null;
      }>;
    } | null;
  }>;
  /** The file as it stands now — sent back as `expectedVersion` on save. */
  version?: string;
  /** The last member of staff who changed this file, and whether it was the viewer. */
  lastStaffEdit?: { name: string | null; at: string; byViewer: boolean } | null;
}

/** Who changed a file after this form opened, carried by a refused save. */
export interface StaleEdit {
  version: string;
  lastEditedBy: string | null;
  lastEditedAt: string | null;
  byViewer: boolean;
}

/** The details of a save refused because the file changed since it was opened, or null. */
export function staleEditOf(caught: unknown): StaleEdit | null {
  if (!(caught instanceof ApiRequestError) || caught.kind !== 'CONFLICT') return null;
  const details = caught.payload.details;
  if (!details || Array.isArray(details)) return null;
  const stale = (details as { staleEdit?: unknown }).staleEdit;
  return stale && typeof stale === 'object' ? (stale as StaleEdit) : null;
}

export function getCitizenForm(tenant: string, token: string, citizenId: string) {
  return apiFetch<CitizenFormData>(
    tenant,
    `/citizens/${encodeURIComponent(citizenId)}/form`,
    { token },
  );
}

export interface CitizenWriteInput {
  /** نوع الملف. Absent reads as a household file on the server. */
  residence?: CitizenResidence;
  personal: Record<string, unknown>;
  contact: Record<string, unknown>;
  properties: Array<Record<string, unknown>>;
  /**
   * Fields the officer recorded as «غير مؤكَّد», each with their reason.
   *
   * Absent means "this record is complete", which is what every online save
   * from the counter sends and what the server validates strictly. The server
   * decides what a flag excuses — this only carries them.
   */
  flags?: FieldFlag[];
  /**
   * «ملاحظات» on the registration this submission writes.
   *
   * Stated here because a save *replaces* the note rather than merging it, so
   * anything editing a record outside the full form has to carry the stored one
   * back or silently delete what the last visit wrote. `CitizenForm` has always
   * sent it; it reached the wire through a spread, which is why the field was
   * missing from the type for so long.
   */
  notes?: string;
  /**
   * The browser's own id for this submission, sent only when it was queued
   * offline. It is what lets a retry after a lost response be recognised
   * rather than registering the household a second time.
   */
  clientSubmissionId?: string;
  /**
   * «اسألني إن بدا مسجَّلاً مسبقاً». Sent only on a save with a person at the
   * screen — never stored in the offline queue, whose deliveries must not be
   * refused on arrival. See `adminCreateCitizenSubmissionSchema`.
   */
  reviewDuplicates?: boolean;
  /** Set by the current form on every submission — see `submissionEnvelope.unitStatusAsked`. */
  unitStatusAsked?: boolean;
  /** The officer's answer to the duplicate question, when it was asked. */
  duplicateReview?: DuplicateReviewAnswer;
  /** On an edit: the version the form was opened at. See `CitizenFormData.version`. */
  expectedVersion?: string;
  /**
   * «سبب التعديل». Required by the server when the edit corrects a high-impact
   * field — see `CitizenEditReview.reasonRequired` — and kept on the audit row.
   */
  changeReason?: string;
}

/** One card's changes in a review or a history entry — see the server's `CardChange`. */
export interface CardChangeView {
  cardId: string;
  kind: 'added' | 'removed' | 'changed';
  propertyType: string | null;
  propertyNumber: string | null;
  occupancyType: string | null;
  fields?: Array<{ field: string; before: unknown; after: unknown }>;
  sensitive?: string[];
  rows?: { added: number; removed: number; changed: number };
}

/** «مراجعة التعديلات» — what saving an edit would do, read and never written. */
export interface CitizenEditReview {
  version: string;
  changes: {
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    /** Every field that changes; sensitive ones appear here only, never with values. */
    changed: string[];
    cards: CardChangeView[];
  };
  /** High-impact fields this edit corrects: the save needs a reason. */
  reasonRequired: string[];
  blockers: Array<{
    code: 'STALE' | 'TENANTS_LINKED';
    message: string;
    tenants?: Array<{ citizenId: string; name: string; propertyEntryId: string }>;
  }>;
  impacts: {
    loginChanges: boolean;
    tenantsShowingName: Array<{ citizenId: string; name: string }>;
    openBills: { count: number; outstanding: number; currency: string } | null;
    cardsRemoved: number;
  };
}

export function reviewCitizenEdit(tenant: string, token: string, citizenId: string, input: CitizenWriteInput) {
  return apiFetch<CitizenEditReview>(tenant, `/citizens/${encodeURIComponent(citizenId)}/edit-review`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** A record already on file that looks like the person being registered. */
export interface DuplicateCandidate {
  id: string;
  referenceNumber: string | null;
  fullName: string;
  motherName: string | null;
  phone: string | null;
  residence: string | null;
  propertyCount: number;
  registeredAt: string | null;
  registeredBy: string | null;
  matchedOn: DuplicateMatchedOn[];
  /**
   * The server is certain this is the same person: the save is refused for an
   * officer rather than asked about. See `DuplicateReviewDialog`.
   */
  certain?: boolean;
}

/** Which of the record's two numbers a match was on. `whatsapp` only when it differs from the phone. */
export type ContactNumberField = 'phone' | 'whatsapp';

/** Somebody this officer registered in the last two hours, on one of this record's numbers. */
export interface DuplicatePhoneOwner {
  id: string;
  referenceNumber: string | null;
  fullName: string;
  phone: string | null;
  fields: ContactNumberField[];
  registeredAt: string;
  minutesAgo: number;
}

export interface DuplicateReviewFindings {
  possibleDuplicates: DuplicateCandidate[];
  phoneOwners: DuplicatePhoneOwner[];
  /** Cards of this record whose landlord number is one of the citizen's own numbers. */
  landlordPhoneCards: Array<{ index: number; landlordName: string | null; field: ContactNumberField }>;
}

export interface DuplicateReviewAnswer {
  differentFrom: string[];
  sharedPhoneWith: string[];
  sharedPhoneWithLandlord: boolean;
  reason: string;
}

export function hasDuplicateFindings(findings: DuplicateReviewFindings): boolean {
  return (
    findings.possibleDuplicates.length > 0 ||
    findings.phoneOwners.length > 0 ||
    findings.landlordPhoneCards.length > 0
  );
}

/**
 * «هل هو مسجَّل مسبقاً؟» asked before anything is written — the same question
 * `createCitizen` refuses on when sent `reviewDuplicates`.
 */
export async function reviewCitizenDuplicates(
  tenant: string,
  token: string,
  input: CitizenWriteInput,
): Promise<DuplicateReviewFindings> {
  return apiFetch<DuplicateReviewFindings>(tenant, '/citizens/duplicate-review', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** The findings carried by a creation refused over a possible duplicate, or null. */
export function duplicateReviewOf(caught: unknown): DuplicateReviewFindings | null {
  if (!(caught instanceof ApiRequestError) || caught.kind !== 'CONFLICT') return null;
  const details = caught.payload.details;
  if (!details || Array.isArray(details)) return null;
  const review = (details as { duplicateReview?: unknown }).duplicateReview;
  return review && typeof review === 'object' ? (review as DuplicateReviewFindings) : null;
}

/**
 * «قد يكون مسجَّلاً مسبقاً» while the form is typed — the save's own rule on
 * what has been typed so far, never the register's search box.
 */
export function checkPossibleDuplicates(tenant: string, token: string, query: PossibleDuplicatesQuery) {
  return apiFetch<PossibleDuplicateMatch[]>(tenant, '/citizens/possible-duplicates', {
    token,
    method: 'POST',
    body: JSON.stringify(query),
  });
}

// ─────────────────────────  «دمج ملفين» — SUPER_ADMIN only  ─────────────────────────

/** What folding `absorbId` into `keepId` would do. Read-only. */
export function previewCitizenMerge(tenant: string, token: string, pair: { keepId: string; absorbId: string }) {
  return apiFetch<CitizenMergePreview>(tenant, '/citizens/merge/preview', {
    token,
    method: 'POST',
    body: JSON.stringify(pair),
  });
}

/** The merge, refused if either file moved since the preview whose versions it sends. */
export async function mergeCitizens(
  tenant: string,
  token: string,
  input: { keepId: string; absorbId: string; reason: string; expected: { keep: string; absorb: string } },
) {
  const result = await apiFetch<CitizenMergeResult>(tenant, '/citizens/merge', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  // Occupants moved between people, so every census screen is stale.
  invalidateCensus(tenant);
  invalidateParcelChecks(tenant);
  return result;
}

/** The file this one was folded into, and the ones folded into it. */
export function getCitizenMerges(tenant: string, token: string, citizenId: string) {
  return apiFetch<{ into: CitizenMergeRecord | null; from: CitizenMergeRecord[] }>(
    tenant,
    `/citizens/${encodeURIComponent(citizenId)}/merges`,
    { token },
  );
}

export function previewCitizenUnmerge(tenant: string, token: string, mergeId: string) {
  return apiFetch<CitizenUnmergePreview>(tenant, `/citizens/merges/${encodeURIComponent(mergeId)}/undo-preview`, {
    token,
  });
}

/** «التراجع عن الدمج» — refused once either file has changed since the merge. */
export async function undoCitizenMerge(tenant: string, token: string, mergeId: string, reason: string) {
  const result = await apiFetch<CitizenMergeRecord>(tenant, `/citizens/merges/${encodeURIComponent(mergeId)}/undo`, {
    token,
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
  invalidateCensus(tenant);
  invalidateParcelChecks(tenant);
  return result;
}

/**
 * Bulk import from a spreadsheet, sent in batches.
 *
 * Sends the raw cells rather than a shaped payload: the branch rules that turn
 * a flat row into a registration live in `buildCitizenPayload` on the server,
 * next to the schema that validates the result. Shaping here would be a second
 * copy of those rules, free to drift from the one that decides what is valid.
 *
 * Batched because one request per file failed two ways at real sizes. Arabic
 * costs two bytes a character, so a few hundred rows across twenty-nine columns
 * overran the body limit and came back as a 500 `PayloadTooLargeError`; and
 * because each row opens its own transaction, a whole file in one request holds
 * the connection open for minutes. `startRow` keeps every reported row number
 * pointing at the clerk's file rather than at the batch.
 *
 * Batches run in sequence, not `Promise.all`: the server writes rows serially
 * anyway (the tenant pool is five connections), so firing them together would
 * only queue them somewhere less visible while making the progress meaningless.
 *
 * `dryRun` runs the identical path and writes nothing, which is what the
 * preview step reports.
 */
export async function importCitizens(
  tenant: string,
  token: string,
  input: {
    rows: ImportRow[];
    dryRun: boolean;
    /** Called after each batch with rows finished so far, for the progress bar. */
    onProgress?: (done: number, total: number) => void;
  },
): Promise<CitizenImportResult> {
  const merged: CitizenImportResult = {
    dryRun: input.dryRun,
    created: 0,
    failed: 0,
    results: [],
  };

  for (let offset = 0; offset < input.rows.length; offset += IMPORT_BATCH_SIZE) {
    const batch = input.rows.slice(offset, offset + IMPORT_BATCH_SIZE);

    const result = await apiFetch<CitizenImportResult>(tenant, '/citizens/import', {
      token,
      method: 'POST',
      body: JSON.stringify({
        rows: batch,
        // 1-based, and counted in the file the clerk is holding.
        startRow: offset + 1,
        dryRun: input.dryRun,
      }),
    });

    merged.created += result.created;
    merged.failed += result.failed;
    merged.results.push(...result.results);
    input.onProgress?.(Math.min(offset + batch.length, input.rows.length), input.rows.length);
  }

  return merged;
}

/**
 * Files a citizen and their first registration.
 *
 * Lands as PENDING like any claim — or as REQUIRES_REVIEW when the submission
 * carries «غير مؤكَّد» flags, which is what `status` reports back.
 *
 * `deduplicated` says the server already held this `clientSubmissionId` and
 * returned the registration it created the first time. The sync queue counts
 * that as delivered, because it is: the household is on the register, and the
 * only thing that ever went missing was a response.
 */
export async function createCitizen(tenant: string, token: string, input: CitizenWriteInput) {
  const result = await apiFetch<{
    citizenId: string;
    registrationId: string;
    referenceNumber: string;
    propertyCount: number;
    status: CitizenRecordStatus;
    deduplicated: boolean;
    /**
     * What a passport number did: `ATTACHED` to the person already holding it
     * (same name), or `CONFLICT` — held by someone with a different name, so a
     * separate citizen was created and the number left for review.
     */
    identity?: 'NEW' | 'ATTACHED' | 'CONFLICT' | null;
    census: CensusSyncResult | null;
    landlordLinks: LandlordLinkOffers | null;
  }>(tenant, '/citizens', { token, method: 'POST', body: JSON.stringify(input) });
  /*
    A registration is a census write too.

    `census` in the response is the proof: saving this card opened occupancies,
    moved units out of «غير ممسوحة» and possibly created the structure itself.
    Anything the tab remembered about the parcel or the building describes the
    moment before that, including the roster count the رقم العقار field prints.
  */
  invalidateCensus(tenant);
  invalidateParcelChecks(tenant);
  return result;
}

/**
 * Replaces the citizen's details and reconciles the properties of their latest
 * registration: an entry with an `id` is updated, one without is created, and
 * a stored entry absent from the payload is deleted along with its documents.
 */
export async function updateCitizen(
  tenant: string,
  token: string,
  citizenId: string,
  input: CitizenWriteInput,
) {
  const result = await apiFetch<{
    updated: boolean;
    citizenId: string;
    status: CitizenRecordStatus;
    /** The file's version after the save. */
    version?: string;
    census: CensusSyncResult | null;
    landlordLinks: LandlordLinkOffers | null;
    /** Links the save undid or brought into line with the card — see the server. */
    landlordLinkChanges?: LandlordLinkChanges;
  }>(tenant, `/citizens/${encodeURIComponent(citizenId)}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  // Same reasoning as `createCitizen`: the save re-ran the census sync.
  invalidateCensus(tenant);
  invalidateParcelChecks(tenant);
  return result;
}

// ──────────────────  Owner links (روابط المالكين)  ──────────────────
//
// Identifying the owner a مستأجر named among the register's own citizens. The
// match is computed from `landlordPhone`, never stored, and nothing links
// itself — see `LandlordLinkService` on the server for why both of those are
// deliberate.

/** A registered citizen a claimed landlord number belongs to. */
export interface LandlordCandidate {
  id: string;
  name: string;
  /** The middle name — the father's, which is what tells brothers apart. */
  fatherName: string | null;
  /** Read by a person comparing two records, never a key. */
  motherName: string | null;
  phone: string | null;
  referenceNumber: string | null;
  residence: string;
  registeredAt: string | null;
  /**
   * How the form's lookup found them: the number is their own (`PHONE`), or
   * their recorded «رقم للتواصل» — a relative's (`CONTACT`), which is never
   * preselected. Absent from an older server.
   */
  matchedBy?: LandlordMatch;
}

/** How a candidate was found. Only `PHONE` — the person's own number — is ever preselected. */
export type LandlordMatch = 'PHONE' | 'CONTACT' | 'NAME' | 'PROPERTY';

/**
 * Why a link cannot be made yet. Each code names the step that unblocks it,
 * and `message` is the server's Arabic sentence saying so.
 */
export type LinkBlockCode =
  | 'NOT_ON_SURVEY'
  | 'NO_UNITS'
  | 'UNIT_VACANT'
  | 'OWNER_NO_FILE'
  | 'OWNER_CARD_UNLINKED'
  | 'OWNER_OCCUPIES_UNIT'
  /** A flat on the card is recorded as owned by somebody other than this candidate. */
  | 'UNIT_OWNED_BY_OTHER'
  | 'RECONCILE_FAILED';

export interface LinkBlock {
  code: LinkBlockCode;
  message: string;
  unitCode: string | null;
}

/** What a link would do on the owner's file, stated before it is pressed. */
export type LinkOutcome = 'NEW_CARD' | 'ADDED_TO_CARD' | 'ALREADY_ON_FILE' | 'OCCUPANCY_ONLY';

export interface LandlordProposalCandidate extends LandlordCandidate {
  /**
   * `PHONE` — the card's number is theirs. `CONTACT` — the number is their
   * recorded «رقم للتواصل», a relative's; never preselected, and the card
   * says whose. `NAME` — only the name the tenant typed is theirs; never
   * preselected. `PROPERTY` — the occupant gave no number, and this person is
   * on the register as the property's owner; never preselected either.
   */
  matchedBy: LandlordMatch;
  outcome: LinkOutcome | null;
  blocked: LinkBlock | null;
}

/** One unresolved claim, with whoever its number resolves to. */
export interface LandlordProposal {
  propertyEntryId: string;
  occupancyType: string;
  propertyType: string;
  /** What the tenant said, as typed. */
  landlordName: string | null;
  /** Null when the tenant gave only a name and the owner was found by it. */
  landlordPhone: string | null;
  propertyNumber: string | null;
  buildingName: string | null;
  buildingId: string | null;
  buildingCode: string | null;
  /** The flats a link would put the owner on. Empty when the card is blocked. */
  units: Array<{ unitId: string; unitCode: string | null }>;
  linkedUnitCount: number;
  filedAt: string;
  filedBy: {
    registrationId: string;
    referenceNumber: string;
    citizenId: string;
    name: string;
  } | null;
  /** Why no link can be made from this card yet, whoever the owner is. */
  blocked: LinkBlock | null;
  /** Oldest registration first. More than one is a shared household line. */
  candidates: LandlordProposalCandidate[];
}

/** What undoing a link reverted, and what it deliberately kept. */
export interface UnlinkResult {
  unlinked: boolean;
  /** Confirmed before links recorded what they wrote — nothing could be reverted precisely. */
  legacy: boolean;
  occupanciesEnded: number;
  rowsRemoved: number;
  cardsRemoved: number;
  casesReopened: number;
  kept: Array<{
    unitCode: string | null;
    reason: 'EDITED' | 'SHARED' | 'OWNER_FILE_CLAIMS' | 'HAS_DOCUMENTS' | 'HAS_REQUESTS' | 'FLAGGED';
    propertyEntryId?: string;
  }>;
  reviewUnits: Array<{ unitId: string; unitCode: string; buildingId: string }>;
}

/** What «إلغاء الربط» would do, read when its confirmation opens. */
export interface UnlinkPreview {
  linked: boolean;
  ownerId: string | null;
  ownerName: string | null;
  legacy: boolean;
  linkedAt: string | null;
  unitCodes: string[];
  cardsCreated: number;
  invoicesSinceLink: number;
}

/** Links a save of a household file changed. */
export interface LandlordLinkChanges {
  unlinked: Array<{ propertyEntryId: string; report: Omit<UnlinkResult, 'unlinked' | 'reviewUnits'> }>;
  reconciled: {
    updated: number;
    blocked: Array<{ propertyEntryId: string; block: LinkBlock }>;
  } | null;
}

/**
 * What a save turned up, in both directions.
 *
 * `filed` — this household named an owner the register already holds.
 * `naming` — this household *is* the owner other cards have been naming.
 *
 * Both are offers. Nothing has been linked, because a phone is not an identity
 * and a link can bill.
 */
export interface LandlordLinkOffers {
  filed: LandlordProposal[];
  naming: LandlordProposal[];
}

/** The standing queue — unresolved claims that match a citizen, a page at a time. */
export function getLandlordLinks(
  tenant: string,
  token: string,
  page: { limit: number; offset: number },
  signal?: AbortSignal,
) {
  return apiFetch<{ items: LandlordProposal[]; total: number }>(
    tenant,
    `/citizens/landlord-links?limit=${page.limit}&offset=${page.offset}`,
    { token, signal },
  );
}

/** One open claim — «فحص الرابط». 404 when it is no longer open. */
export function getLandlordLink(
  tenant: string,
  token: string,
  propertyEntryId: string,
  signal?: AbortSignal,
) {
  return apiFetch<LandlordProposal>(
    tenant,
    `/citizens/landlord-links/${encodeURIComponent(propertyEntryId)}`,
    { token, signal },
  );
}

/** How much ownership the register knows about and does not bill. */
export function getLandlordLinkSummary(tenant: string, token: string) {
  return apiFetch<{ units: number; owners: number }>(
    tenant,
    '/citizens/landlord-links/summary',
    { token },
  );
}

/**
 * Who is registered on this number? — the form's inline lookup.
 *
 * Everybody on it: a shared household line is where the officer standing with
 * the tenant is best placed to say which person was meant.
 */
export async function getLandlordCandidates(
  tenant: string,
  token: string,
  phone: string,
  signal?: AbortSignal,
) {
  const { candidates } = await apiFetch<{ candidates: LandlordCandidate[] }>(
    tenant,
    `/citizens/landlord-links/candidate?phone=${encodeURIComponent(phone)}`,
    { token, signal },
  );
  return candidates ?? [];
}

/**
 * «نعم، هذا هو المالك».
 *
 * Invalidates the census: confirming records an `OWNER` occupancy on every flat
 * the card names, so the matrix and the map pins this tab is holding describe
 * the moment before it.
 */
export async function confirmLandlordLink(
  tenant: string,
  token: string,
  propertyEntryId: string,
  citizenId: string,
) {
  const result = await apiFetch<{
    linked: boolean;
    occupanciesRecorded: number;
    unitsClaimed: number;
    /**
     * Whether the structure was added to the owner's own file by this link.
     *
     * False when they had already filed a card on it — the commoner case for an
     * owner the municipality knows — and the link is no less complete for it.
     */
    ownerCardCreated: boolean;
    rowsAdded?: number;
    outcome?: LinkOutcome | null;
  }>(tenant, `/citizens/landlord-links/${encodeURIComponent(propertyEntryId)}/confirm`, {
    token,
    method: 'POST',
    body: JSON.stringify({ citizenId }),
  });
  invalidateCensus(tenant);
  return result;
}

/** «لا أحد منهم» — these citizens are not the card's owner. */
export function dismissLandlordLink(
  tenant: string,
  token: string,
  propertyEntryId: string,
  candidateIds: readonly string[],
) {
  return apiFetch<{ dismissed: boolean }>(
    tenant,
    `/citizens/landlord-links/${encodeURIComponent(propertyEntryId)}/dismiss`,
    { token, method: 'POST', body: JSON.stringify({ candidateIds }) },
  );
}

/** The «تراجع» on a dismissal. */
export function restoreLandlordLink(
  tenant: string,
  token: string,
  propertyEntryId: string,
  candidateIds: readonly string[],
) {
  return apiFetch<{ restored: boolean }>(
    tenant,
    `/citizens/landlord-links/${encodeURIComponent(propertyEntryId)}/restore`,
    { token, method: 'POST', body: JSON.stringify({ candidateIds }) },
  );
}

/** What undoing this card's link would revert — for the confirmation to state. */
export function getLandlordUnlinkPreview(tenant: string, token: string, propertyEntryId: string) {
  return apiFetch<UnlinkPreview>(
    tenant,
    `/citizens/landlord-links/${encodeURIComponent(propertyEntryId)}/unlink-preview`,
    { token },
  );
}

/**
 * Undoes a confirmation: the claim goes back to the queue and what the link
 * wrote into the owner's records is reverted. Invalidates the census, because
 * the owner's spells and cards just changed.
 */
export async function unlinkLandlord(tenant: string, token: string, propertyEntryId: string) {
  const result = await apiFetch<UnlinkResult>(
    tenant,
    `/citizens/landlord-links/${encodeURIComponent(propertyEntryId)}`,
    { token, method: 'DELETE' },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * «أرشفة الملف» and its undo — the only way a citizen file leaves the register;
 * nothing deletes one (decision, 2026-10-05). An archived citizen is skipped by
 * the biller and by sign-in and keeps every row. Archiving requires `why.reason`
 * and `why.requestedBy` (who asked for it); both go on the audit row, with the
 * day they moved away when that is why («تغيير الإقامة»).
 */
export function setCitizenActive(
  tenant: string,
  token: string,
  citizenId: string,
  isActive: boolean,
  why: { reason?: string; requestedBy?: string; movedOn?: string } = {},
) {
  return apiFetch<{ isActive: boolean }>(
    tenant,
    `/citizens/${encodeURIComponent(citizenId)}/active`,
    { token, method: 'PATCH', body: JSON.stringify({ isActive, ...why }) },
  );
}

/** Opens the signed URL in a new tab; the backend records who viewed what. */
export function getDocumentViewUrl(tenant: string, token: string, documentId: string) {
  return apiFetch<{ url: string; expiresInSeconds: number }>(
    tenant,
    `/documents/${encodeURIComponent(documentId)}/url`,
    { token },
  );
}


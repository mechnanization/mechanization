import type { AuditEntry } from '../api-client';
import { FEE_NOTICES_PAGE_MAX, type ParcelDues } from '@mechanization/shared-schemas';
import { type CitizenSettingsField, type BackupSchedule, type CancelBill, type CurrencyCode, type DeclarePayment, type FeeAssessment, type FeeAssessmentLine, type FeeBasis, type FeeBearer, type FeeFrequency, type FeeMatrixBracket, type FeeNoticePeriodSummary, type FeeNoticePreviewInput, type FeeNoticePreviewResult, type FeeUnassessable, type SharedUnitBillView, type CancelNotice, type NumberingSequence, type PaymentMethod, type PaymentStatus, type ReverseTransaction, type SequenceKey, type SettlePayment, type BulkSettlePayments, type SettlementReceipt, type BillArrearsView, type BillWriteOffView, type WriteOffBillInput } from '@mechanization/shared-schemas';
import { cachedRequest, invalidateRequests } from '../request-cache';
import { apiFetch, type Session } from './core';

// ─────────────────────────  Fees & payments  ─────────────────────────

export interface MunicipalitySettings {
  /** The municipality's public number, printed on receipts. */
  contactPhone: string | null;
  /**
   * The office WhatsApp account: printed on the receipt for the citizen to
   * reply to, and the account a clerk should be signed into before sending
   * one. It cannot make a `wa.me` link send *from* this number — see the
   * settings screen.
   */
  whatsappNumber: string | null;
  whishMoneyNumber: string | null;
  cashOfficeHours: string | null;
  cashOfficeAddress: string | null;

  // ── Municipality profile ──────────────────────────────────────────────
  nameAr: string | null;
  nameEn: string | null;
  contactEmail: string | null;
  website: string | null;
  governorate: string | null;
  district: string | null;
  town: string | null;
  /** تاريخ ورقم قرار المجلس البلدي, if the council has issued one (§7 Q1). */
  councilDecisionRef: string | null;
  /**
   * Absent — not null — for a citizen.
   *
   * The crest is a data URI in the hundreds of kilobytes, and this endpoint is
   * read by everyone opening the pay dialog, so the server sends it to staff
   * only. The key being missing rather than null is deliberate: a client can
   * tell "not sent to you" from "no logo configured".
   */
  logoDataUri?: string | null;

  // ── Finance defaults ──────────────────────────────────────────────────
  defaultFeeFrequency: FeeFrequency;
  defaultDueDays: number;
  priceDisplay: 'compact' | 'exact';
  /** Percent. Display only — anything charging money must read the server's
   *  Decimal rather than this JSON number. */
  defaultRatePercent: number;
  baseCurrency: CurrencyCode;
  secondaryCurrency: CurrencyCode | null;
  exchangeRate: number | null;
  /** Stamped server-side, and only when the rate actually changes. */
  exchangeRateUpdatedAt: string | null;
  /**
   * «سقف الدفع العاجل»: the most an accountant may pay on the urgent path, per
   * voucher, in that currency; `null` for none (decision D6, docs/finance.md
   * §5.1). Absent — not null — for a citizen: the server strips both.
   */
  urgentExpenseCeilingLbp?: number | null;
  urgentExpenseCeilingUsd?: number | null;
  /**
   * «سقف صرف الرواتب» (0091): the most an accountant may pay one staff member as
   * a month's salary before the manager's order, in that currency; `null` for
   * none. Absent for a citizen, as the urgent ceilings are.
   */
  salaryUrgentCeilingLbp?: number | null;
  salaryUrgentCeilingUsd?: number | null;
  /**
   * How far an exchange may stray from the rate before it needs a reason, in
   * percent, and above what (on its non-base side) it is reviewed whatever its
   * rate (0084). Absent for a citizen, as the ceilings are.
   */
  exchangeRateTolerancePercent?: number;
  largeExchangeThreshold?: number;

  numberingSequences: Record<SequenceKey, NumberingSequence> | null;
  backupSchedule: BackupSchedule | null;
  /**
   * «معامل السقوف» (0095, D28): what a flat on N levels weighs in roofs under a
   * per-unit notice, keyed by N — `{"2": 1.8}` by default. Optional on the wire
   * for older responses.
   */
  levelFactors?: Record<string, number>;

  updatedAt: string | null;
}

/** How long a settings read is reused. It changes a few times a year. */
const SETTINGS_TTL_MS = 60_000;

/**
 * The staff screens' read of the settings. A citizen is answered three fields
 * alone (task S13) and reads them through `getCitizenPortalSettings`, never here.
 *
 * De-duplicated and briefly cached, because several unrelated screens read it: the
 * fees ledger, the payments log, every citizen profile and each settings tab as
 * it opens. Concurrent callers share one request.
 *
 * `includeLogo` is opt-in and off by default. The crest is a data URI in the
 * hundreds of kilobytes, and every one of those screens except the settings
 * form wants a phone number and some opening hours — they were all downloading
 * it and using none of it.
 */
export function getMunicipalitySettings(
  tenant: string,
  token: string,
  options: { includeLogo?: boolean } = {},
) {
  const includeLogo = options.includeLogo === true;
  // The token is deliberately not part of the key — see `cachedRequest`.
  return cachedRequest(
    `settings:${tenant}:${includeLogo ? 'full' : 'lite'}`,
    SETTINGS_TTL_MS,
    () =>
      apiFetch<MunicipalitySettings>(
        tenant,
        `/fees/settings${includeLogo ? '?includeLogo=true' : ''}`,
        { token },
      ),
  );
}

/** What a citizen's `GET fees/settings` answers: `CITIZEN_SETTINGS_FIELDS` alone (task S13). */
export type CitizenPortalSettings = Pick<MunicipalitySettings, CitizenSettingsField>;

/**
 * The portal's read of the settings: the three fields a citizen is given, typed as such.
 *
 * Not through `cachedRequest`. Its key names the tenant, not who asked, and a
 * citizen's answer is a different shape from staff's, so sharing the entry let a
 * citizen's three fields stand in for the staff settings on the same tab for up
 * to a minute (review of 2026-11-20). The portal reads it once per page.
 */
export function getCitizenPortalSettings(tenant: string, token: string) {
  return apiFetch<CitizenPortalSettings>(tenant, '/fees/settings', { token });
}

/**
 * The settings screen is SUPER_ADMIN only. The route is not: it admits
 * `FEE_ADMIN_ROLES` (`SUPER_ADMIN`, `ACCOUNTANT`) for every field but the two
 * urgent-payment ceilings, which the server keeps to the manager
 * (docs/security.md, gaps).
 *
 * Every field is optional and only what is sent is written — which is what
 * lets one section of the settings screen save without clearing the fields
 * owned by the five it did not render. An empty string clears a text field; a
 * missing key leaves it alone. The two are not the same and the server does
 * not treat them as such.
 */
export async function updateMunicipalitySettings(
  tenant: string,
  token: string,
  input: Partial<{
    contactPhone: string;
    whatsappNumber: string;
    whishMoneyNumber: string;
    cashOfficeHours: string;
    cashOfficeAddress: string;

    nameAr: string;
    nameEn: string;
    contactEmail: string;
    website: string;
    governorate: string;
    district: string;
    town: string;
    councilDecisionRef: string;
    logoDataUri: string;

    defaultFeeFrequency: FeeFrequency;
    defaultDueDays: number;
    priceDisplay: 'compact' | 'exact';
    defaultRatePercent: number;
    baseCurrency: CurrencyCode;
    /** `null` clears it. Omitting leaves whatever is stored. */
    secondaryCurrency: CurrencyCode | null;
    exchangeRate: number | null;
    /**
     * `null` clears the ceiling; omitting leaves it. The manager's alone: any
     * other role that changes one is refused (`URGENT_EXPENSE_CEILING_FORBIDDEN`).
     */
    urgentExpenseCeilingLbp: number | null;
    urgentExpenseCeilingUsd: number | null;
    /** The salary ceilings (0091), the manager's alone like the urgent ones. */
    salaryUrgentCeilingLbp: number | null;
    salaryUrgentCeilingUsd: number | null;

    numberingSequences: Record<SequenceKey, NumberingSequence>;
    backupSchedule: BackupSchedule;
    /** «معامل السقوف» (0095) — replaced whole when sent. */
    levelFactors: Record<string, number>;
  }>,
) {
  const result = await apiFetch<MunicipalitySettings>(tenant, '/fees/settings', {
    token,
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  // Both variants, before the caller sees the response. A clerk who saves and
  // is then shown the value they replaced — because another tab reads the
  // cached copy a moment later — reasonably concludes the save failed.
  invalidateRequests(`settings:${tenant}:`);
  return result;
}

export interface FeeNoticeSummary {
  id: string;
  title: string;
  /** Under FLAT the whole invoice; under the other two a rate. Read with `basis`. */
  amount: number;
  /** What `amount` is per. Absent on notices written before per-unit billing. */
  basis: FeeBasis;
  /** Who owes it — see `FEE_BEARER`. Meaningless under FLAT. */
  bearer: FeeBearer;
  currency: string;
  frequency: string;
  targetType: string;
  targetCategory: string | null;
  /** «من يشمل الإشعار» (0100): each null when the notice named none — every category, the bearer's statuses, every file. */
  targetCategories: string[] | null;
  unitStates: string[] | null;
  residences: string[] | null;
  targetCitizenName: string | null;
  dueDate: string;
  instructions: string | null;
  /** How many citizens this notice actually billed. */
  issuedCount: number;
  /** False stops the recurring biller re-issuing it each period. */
  isActive: boolean;
  createdAt: string;
}

/**
 * «إشعارات الرسوم», newest first, one page of them (PAG-04, PAG-05). `page`
 * names the rows wanted (`limit` at most `FEE_NOTICES_PAGE_MAX`, from `offset`),
 * and `total` is how many notices there are in all. Without `page` it asks for
 * the most one request may, which is what the backup export wants until it
 * pages through (audit PAG-05, U-11).
 */
export function getFeeNotices(
  tenant: string,
  token: string,
  page: { limit: number; offset: number } = { limit: FEE_NOTICES_PAGE_MAX, offset: 0 },
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ limit: String(page.limit), offset: String(page.offset) });
  return apiFetch<{ items: FeeNoticeSummary[]; total: number }>(tenant, `/fees/notices?${query.toString()}`, {
    token,
    signal,
  });
}

/**
 * Everyone registered on one رقم العقار, and what each of them holds there.
 *
 * The parcel view of a citizen-keyed register — computed, never stored. Every
 * fee is raised against a citizen, so ownership lives on the citizen and this
 * is a projection over it; there is no second copy to drift.
 */
export interface ParcelRoster {
  propertyNumber: string;
  neighborhood: string | null;
  citizenCount: number;
  structureCount: number;
  citizens: Array<{
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
        /** حالة الوحدة. Null means nobody was asked — not that it is occupied. */
        unitStatus: string | null;
      }>;
    }>;
  }>;
}

export function getParcelRoster(tenant: string, token: string, propertyNumber: string) {
  return apiFetch<ParcelRoster>(
    tenant,
    `/citizens/parcel/${encodeURIComponent(propertyNumber)}`,
    { token },
  );
}

/** Writes the rule and bills every matching citizen in one transaction. */
export async function issueFeeNotice(
  tenant: string,
  token: string,
  input: {
    title: string;
    amount: number;
    /** What `amount` is per — see `FEE_BASIS`. */
    basis: FeeBasis;
    /** Who owes it. Omitted means OCCUPANT — see `FEE_BEARER`. */
    bearer?: FeeBearer;
    frequency: string;
    targetType: string;
    targetCategory?: string;
    /** «من يشمل الإشعار» (0100): each absent is its default — see `feeNoticeScopeSchema`. */
    targetCategories?: FeeNoticePreviewInput['targetCategories'];
    unitStates?: FeeNoticePreviewInput['unitStates'];
    residences?: FeeNoticePreviewInput['residences'];
    /** The scope's warnings the clerk confirmed; the server refuses a scope with one unconfirmed. */
    acknowledgedWarnings?: FeeNoticePreviewInput['acknowledgedWarnings'];
    /** The active notices the preview listed as duplicates and the clerk issued beside (`FEE_NOTICE_DUPLICATE`), by id. */
    acknowledgedDuplicates?: string[];
    targetCitizenId?: string;
    dueDate: string;
    instructions?: string;
    /** The bracket table, under TIERED_AREA and only then (`feeMatrixSchema`). */
    matrixBrackets?: FeeMatrixBracket[];
    /** One id per issue (`fee-notice:new` in `lib/request-id.ts`): a retry is answered with the first notice. */
    clientRequestId: string;
  },
) {
  const result = await apiFetch<{
    noticeId: string;
    issued: number;
    /** True when the key had already issued this notice: nothing new was billed. */
    replayed?: boolean;
    /**
     * Targeted citizens whose holdings could not be measured — a building
     * whose units were never surveyed, or a unit with no recorded area. They
     * are not billed and not silently dropped: the caller names them so the
     * municipality can chase the survey.
     */
    unassessable?: FeeUnassessable[];
    /**
     * Units this notice declined to charge anyone for — let to a tenant who is
     * billed for them directly, empty, still being built, or not owned by the
     * person assessed.
     *
     * Reported for the same reason `unassessable` is: revenue absent by design
     * is still revenue absent, and a clerk who can see how much of the town a
     * bearer rule left out has something to take to the council.
     */
    exemptedUnits?: number;
    /**
     * Flats whose occupancy fee this notice held because their records
     * disagree — see `FeeAssessment.heldUnitCount`. Not charged for this
     * notice's period; once the «تعارض في حالة الوحدة» is settled they are
     * charged from the next period a recurring notice runs. Recovering the held
     * period itself is a manual charge.
     */
    heldUnits?: number;
    /**
     * Flats this notice did not charge because their current damage reading
     * says nobody can live in them — exempt from every fee (decisions of
     * 2026-10-05 and 2026-10-07); see `FeeAssessment.uninhabitableUnitCount`.
     * Charged again from the first period after a re-inspection reads them
     * habitable.
     */
    uninhabitableUnits?: number;
    /** Units «معفاة من الرسوم» this notice did not charge (0077). */
    feeExemptUnits?: number;
    /**
     * Co-owned flats this notice reached whose responsible owner («مالك مسؤول»)
     * pays for them in full, so the other owners were charged nothing for them —
     * see `FeeAssessment.coOwnerPaidUnitCount`. Each flat once.
     */
    coOwnerPaidUnits?: number;
    /** Of `issued`, the shared unit bills (TIERED_AREA, 0099): one per unit several citizens are charged for. */
    sharedBills?: number;
    /** Shared units billed to nobody because their holders' records put them in different brackets. */
    sharedUnitConflicts?: FeeNoticePreviewResult['conflicts'];
    /** Units the bracket table does not price (D11): not charged, counted. */
    outsideTableUnits?: number;
  }>(tenant, '/fees/notices', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  invalidateRequests(`fee-summary:${tenant}`);
  return result;
}

/** What «إلغاء الإشعار» did: the bills cancelled, those left with why, and whether the notice stopped. */
export interface FeeNoticeCancelResult {
  noticeId: string;
  cancelled: number;
  /** Bills left as they were: money on them, or a citizen's claim waiting (an `ERROR_CODES` code). */
  skipped: Array<{
    paymentId: string;
    invoiceNumber: string | null;
    reason: 'BILL_ALREADY_CANCELLED' | 'BILL_ALREADY_WRITTEN_OFF' | 'PAYMENT_CLAIM_UNDER_REVIEW' | 'BILL_CANCEL_HAS_PAYMENTS';
  }>;
  /** True when the notice was still recurring and has now stopped. */
  deactivated: boolean;
}

/**
 * «إلغاء الإشعار» (decision D6): cancels every bill of the notice nothing has
 * been paid on, reports the rest, and stops the notice. The manager only, with
 * a reason, as for one bill.
 */
export async function cancelFeeNotice(tenant: string, token: string, noticeId: string, input: CancelNotice) {
  const result = await apiFetch<FeeNoticeCancelResult>(
    tenant,
    `/fees/notices/${encodeURIComponent(noticeId)}/cancel`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateRequests(`fee-summary:${tenant}`);
  return result;
}

/**
 * A notice's periods as «إلغاء الإشعار» shows them before the press (D12):
 * each period's bills, what the cancel would cancel and for how much, and what
 * it would leave and why. `BILL_CANCEL_ROLES`, as the cancel itself.
 */
export function getFeeNoticePeriods(tenant: string, token: string, noticeId: string, signal?: AbortSignal) {
  return apiFetch<{ items: FeeNoticePeriodSummary[] }>(
    tenant,
    `/fees/notices/${encodeURIComponent(noticeId)}/periods`,
    { token, signal },
  );
}

/**
 * «معاينة قبل الإصدار»: what `issueFeeNotice` would bill for this notice, with
 * nothing written — the revenue, the bills, each bracket's units, what is not
 * charged and who cannot be assessed. The same notice as the issue takes,
 * without the retry key.
 */
export function previewFeeNotice(tenant: string, token: string, input: FeeNoticePreviewInput, signal?: AbortSignal) {
  return apiFetch<FeeNoticePreviewResult>(tenant, '/fees/notices/preview', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

export interface FeeSummary {
  unpaidTotal: number;
  unpaidCount: number;
  pendingReviewCount: number;
  paidTotal: number;
  paidCount: number;
}

export function getFeeSummary(tenant: string, token: string) {
  return cachedRequest(`fee-summary:${tenant}`, 30 * 1000, () =>
    apiFetch<FeeSummary>(tenant, '/fees/summary', { token }),
  );
}

export interface PendingPayment {
  id: string;
  title: string;
  /** The bill's face value. */
  amount: number;
  /** Already taken against it, at the counter or on a round. */
  paidAmount: number;
  /** What is left — what confirming the claim credits (`FeesService.review`). */
  remaining: number;
  currency: string;
  dueDate: string;
  paymentMethod: string | null;
  whishTransactionRef: string | null;
  isSeen?: boolean;
  /** Null on a shared unit bill (0099), which has no one citizen: see `sharedUnit`. */
  citizenId: string | null;
  citizenName: string | null;
  citizenPhone: string | null;
  citizenReference: string | null;
  /** On a shared unit bill, the unit and how many may pay it; null on a citizen's own bill. */
  sharedUnit: SharedUnitBillView | null;
}

/** The clerk's queue: money claimed but not yet confirmed. */
export function getPendingPayments(
  tenant: string,
  token: string,
  unseenOnly?: boolean,
  options: { background?: boolean } = {},
) {
  const query = unseenOnly ? '?unseenOnly=true' : '';
  return apiFetch<{ items: PendingPayment[] }>(tenant, `/fees/payments/pending${query}`, {
    token,
    background: options.background,
  });
}

/** Mark a pending payment notification as seen. */
export function markPaymentAsSeen(tenant: string, token: string, id: string) {
  return apiFetch<{ id: string; isSeen: boolean }>(
    tenant,
    `/fees/payments/${encodeURIComponent(id)}/seen`,
    { token, method: 'PATCH' },
  );
}

/** Mark all pending payment notifications as seen. */
export function markAllPendingPaymentsAsSeen(tenant: string, token: string) {
  return apiFetch<{ updatedCount: number }>(
    tenant,
    '/fees/payments/pending/mark-all-seen',
    { token, method: 'POST' },
  );
}

export async function reviewPayment(
  tenant: string,
  token: string,
  id: string,
  input: { confirmed: boolean; note?: string },
) {
  const result = await apiFetch<{ paymentStatus: string }>(
    tenant,
    `/fees/payments/${encodeURIComponent(id)}/review`,
    { token, method: 'PATCH', body: JSON.stringify(input) },
  );
  invalidateRequests(`fee-summary:${tenant}`);
  return result;
}

/** What a bill would be if it were raised today. */
export type BillFigure =
  | { kind: 'ASSESSED'; amount: number; assessment: FeeAssessment | null }
  | { kind: 'UNASSESSABLE'; reason: string }
  /** A flat charge to a category the citizen no longer holds any of. */
  | { kind: 'NOT_TARGETED' };

/** One open bill a correction affected — «فواتير تأثّرت بتصحيحات». */
export interface CorrectionAffectedBill {
  paymentId: string;
  citizenId: string;
  citizenName: string;
  title: string;
  periodKey: string;
  dueDate: string;
  status: string;
  raisedAt: string;
  amount: number;
  paidAmount: number;
  currency: string;
  billed: FeeAssessment | null;
  now: BillFigure;
  /** Today's figure minus the bill's; null when today's cannot be worked out. */
  difference: number | null;
  lines: { removed: FeeAssessmentLine[]; added: FeeAssessmentLine[] } | null;
  changes: Array<{
    /** CORRECTION: said to be one. DATED_CHANGE: a real change and its day. EDIT: anything else. */
    kind: 'CORRECTION' | 'DATED_CHANGE' | 'EDIT';
    effectiveOn: string | null;
    entry: AuditEntry;
  }>;
  review: { at: string; by: string | null; note: string; current: boolean } | null;
}

export interface CorrectionAffectedList {
  items: CorrectionAffectedBill[];
  total: number;
  totals: { billedTooMuch: number; billedTooLittle: number; unassessable: number; reviewed: number };
}

export function getCorrectionAffectedBills(
  tenant: string,
  token: string,
  query: { includeReviewed?: boolean; limit?: number; offset?: number } = {},
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({
    limit: String(query.limit ?? 20),
    offset: String(query.offset ?? 0),
    ...(query.includeReviewed ? { includeReviewed: 'true' } : {}),
  });
  return apiFetch<CorrectionAffectedList>(tenant, `/fees/correction-affected?${params.toString()}`, {
    token,
    signal,
  });
}

/** «المستحق على عقار» — open bills with a line on one رقم العقار. Read-only. */
export function getParcelDues(tenant: string, token: string, propertyNumber: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ propertyNumber });
  return apiFetch<ParcelDues>(tenant, `/fees/parcel-dues?${params.toString()}`, { token, signal });
}

/** The key a review records having seen — must match the server's `figureKey`. */
export function billFigureKey(figure: BillFigure): string {
  return figure.kind === 'ASSESSED' ? `ASSESSED:${figure.amount}` : figure.kind;
}

/** Records what the accountant decided. The bill itself is never changed. */
export function reviewBillBasis(
  tenant: string,
  token: string,
  paymentId: string,
  input: { note: string; figure: string },
) {
  return apiFetch<{ reviewedAt: string }>(
    tenant,
    `/fees/payments/${encodeURIComponent(paymentId)}/basis-review`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
}

export interface CitizenPaymentItem {
  id: string;
  /** «ARR-2611-0001» on an old debt, «INV-…» on any other bill the system raised; null before 0079. Optional for an older API. */
  invoiceNumber?: string | null;
  title: string;
  amount: number;
  paidAmount: number;
  remaining: number;
  currency: string;
  dueDate: string;
  /** `OVERDUE` is derived server-side from the due date, never stored. */
  paymentStatus: string;
  paymentMethod: string | null;
  whishTransactionRef: string | null;
  paidAt: string | null;
  reviewNote: string | null;
  /** Why the manager cancelled the bill (0091); null unless `paymentStatus` is CANCELLED. */
  cancellationReason?: string | null;
  /** «شطب» (0107): when, how much, why and on which decision; null unless WRITTEN_OFF. Optional for an older API. */
  writeOff?: BillWriteOffView | null;
  /** «متأخرات سنوات سابقة»: the year, the fee and the رقم العقار of an old debt, without the old books' reference; null on any other bill. */
  arrears?: BillArrearsView | null;
  frequency: string | null;
  /**
   * How this amount was arrived at — «6 محل تجاري × 100,000 ل.ل».
   *
   * The server has sent it on this route since per-unit billing existed
   * (`FeesService.listForCitizen`); the portal simply never read it, so the
   * person actually holding the bill was the one party shown the total with no
   * way to check it. Null on a flat charge, which explains itself.
   */
  assessment?: FeeAssessment | null;
  /**
   * On a shared unit bill (0099) this citizen owes with others: the unit and
   * how many may pay it, never who. Paid at the office, by any of them: the
   * portal offers neither Whish nor a declaration for it.
   */
  sharedUnit?: SharedUnitBillView | null;
}

/** The signed-in citizen's own bills. */
export function getMyPayments(tenant: string, token: string) {
  return apiFetch<{ items: CitizenPaymentItem[] }>(tenant, '/fees/payments/mine', { token });
}

/**
 * Opens a Whish checkout for one of the signed-in citizen's own bills.
 *
 * `redirectUrl` is where the browser goes next — the provider's hosted page
 * once credentials are configured, and back to the portal until then.
 * `pending` says which of those happened, so the UI can tell the citizen the
 * truth rather than claiming a payment that has not been taken.
 */
export function startWhishCheckout(tenant: string, token: string, paymentId: string) {
  return apiFetch<{ redirectUrl: string; pending: boolean }>(
    tenant,
    `/fees/payments/mine/${encodeURIComponent(paymentId)}/whish/checkout`,
    { token, method: 'POST' },
  );
}

/**
 * Reports a Whish Money transfer, with its reference: moves the bill to
 * PENDING_REVIEW, never straight to PAID. Cash is never declared (open-decisions §21).
 */
export function declarePayment(tenant: string, token: string, id: string, input: DeclarePayment) {
  return apiFetch<{ paymentStatus: string }>(
    tenant,
    `/fees/payments/mine/${encodeURIComponent(id)}/declare`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
}

/**
 * Citizen sign-in by رقم مرجعي + phone. Both are required — see the note on
 * `IdentityService.loginByReference`.
 */
export function loginByReference(
  tenant: string,
  input: { referenceNumber: string; phone: string },
) {
  return apiFetch<Session>(tenant, '/auth/citizen/reference/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Citizen sign-in by رقم مرجعي alone — the landing page's single field.
 *
 * A separate function against a separate route, not `loginByReference` with an
 * omitted phone: the payments portal still requires both, and the two bars are
 * meant to stay visibly different at every layer. See `referenceOnlyLoginSchema`
 * for what the municipality is accepting by using this one.
 */
export function openByReference(tenant: string, referenceNumber: string) {
  return apiFetch<Session>(tenant, '/auth/citizen/reference/open', {
    method: 'POST',
    body: JSON.stringify({ referenceNumber }),
  });
}

/** One invoice as the admin ledger shows it — who owes it, and where it stands. */
export interface AdminPaymentItem {
  id: string;
  /** «INV-2610-0001», or null on a bill raised before migration 0079. */
  invoiceNumber: string | null;
  title: string;
  amount: number;
  paidAmount: number;
  remaining: number;
  currency: string;
  dueDate: string;
  /** When the bill was raised — the tie-break of «oldest first» in a bulk settlement (`bulkSettlementOrder`). */
  createdAt: string;
  paymentStatus: string;
  paymentMethod: string | null;
  whishTransactionRef: string | null;
  paidAt: string | null;
  /** «إلغاء الفاتورة» (0091): when, and why; null on a bill still standing. Optional for an older API. */
  cancelledAt?: string | null;
  cancellationReason?: string | null;
  /** «شطب» (0107): when, how much, why and on which decision; null unless WRITTEN_OFF. Optional for an older API. */
  writeOff?: BillWriteOffView | null;
  /** «متأخرات سنوات سابقة»: the line behind an «ARR-» bill, with the old books' reference (staff only); null on any other bill. */
  arrears?: BillArrearsView | null;
  /**
   * Last write to the row. Stands in for the payment time on a *partial*
   * settlement, which never gets a `paidAt` — see the note on the server.
   */
  updatedAt: string;
  /** The محصّل holding the money — set only on a COLLECTOR payment. */
  collectedByName: string | null;
  frequency: string | null;
  /**
   * How this amount was arrived at, when it was not simply the notice's own.
   *
   * The answer to «ليش عليّ هالمبلغ؟» — null on a flat charge, which explains
   * itself, and on every invoice raised before per-unit billing existed.
   */
  assessment?: FeeAssessment | null;
  /** Null on a shared unit bill (0099), which has no one citizen: see `sharedUnit`. */
  citizenId: string | null;
  citizenName: string | null;
  citizenPhone: string | null;
  citizenReference: string | null;
  /** On a shared unit bill, the unit and how many may pay it; null on a citizen's own bill. */
  sharedUnit: SharedUnitBillView | null;
  /** On a shared unit bill, the debtor who last paid on it: whose file its receipt is reprinted from. */
  lastPaidByCitizenId?: string | null;
}

/**
 * Every invoice, filterable by status, method and by who owes it.
 *
 * `transactionsOnly` narrows it to rows where money moved (or is claimed to
 * have) and re-orders newest-first — the سجل العمليات view, as against the
 * fees ledger's "what is owed".
 */
export function getFeeTitles(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<string[]>(tenant, '/fees/titles', { token, signal });
}

/**
 * What the two money screens' filters may offer, as found in the ledger.
 *
 * The same kind of read as `getBuildingFilterOptions`: a vocabulary, not a
 * page. A municipality that has never taken a Whish transfer has no «Whish»
 * tab, because there is no answer behind it.
 */
export interface FeeFilterOptions {
  /**
   * Which status tabs the register can actually answer.
   *
   * Not simply "the stored values present". OVERDUE is never stored — nothing
   * writes it, it is derived from `dueDate` on read — and UNPAID is split
   * against the same boundary, so these two are counted rather than grouped.
   * See `paymentStatusWhere` on the server for the predicate behind each.
   *
   * Consequently this half of the read is time-dependent and must not be held
   * for the session the way `titles` and `methods` may be.
   */
  statuses: PaymentStatus[];
  /** Stored `paymentMethod` values present. Never null: an unpaid row has none. */
  methods: PaymentMethod[];
  /** Distinct bill titles, for the searchable «نوع الرسم» filter. */
  titles: string[];
}

export function getFeeFilterOptions(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<FeeFilterOptions>(tenant, '/fees/filter-options', { token, signal });
}

export function getAllPayments(
  tenant: string,
  token: string,
  filter: {
    status?: string;
    search?: string;
    feeTitle?: string;
    citizenId?: string;
    method?: string;
    transactionsOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {},
  /** See `listCitizens`. */
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filter.status) query.set('status', filter.status);
  if (filter.search) query.set('search', filter.search);
  if (filter.feeTitle) query.set('feeTitle', filter.feeTitle);
  if (filter.citizenId) query.set('citizenId', filter.citizenId);
  if (filter.method) query.set('method', filter.method);
  if (filter.transactionsOnly) query.set('transactionsOnly', 'true');
  if (filter.limit !== undefined) query.set('limit', String(filter.limit));
  if (filter.offset !== undefined) query.set('offset', String(filter.offset));
  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch<{
    items: AdminPaymentItem[];
    total: number;
    /** Computed over every matching row, not the returned page. */
    totals: {
      collected: number;
      cash: number;
      whish: number;
      collector: number;
      awaiting: number;
    };
  }>(tenant, `/fees/payments${suffix}`, { token, signal });
}

/**
 * One invoice, loaded directly by id.
 *
 * What تسجيل دفعة reads when it is its own page rather than a dialog opened
 * from an already-loaded row: a refresh, a bookmark, or a link from a receipt
 * arrives with nothing but this id.
 */
export function getPaymentById(tenant: string, token: string, id: string) {
  return apiFetch<
    AdminPaymentItem & {
      /**
       * On a shared unit bill (0099): everyone who may pay it, by name, for the
       * counter to say which of them did. Empty on a citizen's own bill.
       * `responsible`: the unit's «مالك مسؤول» (0075), offered first as the
       * payer (`defaultPayer`); absent from older answers.
       */
      sharedDebtors?: Array<{ citizenId: string; name: string; role: string; responsible?: boolean }>;
    }
  >(tenant, `/fees/payments/${encodeURIComponent(id)}`, {
    token,
  });
}

/** A one-off charge against a single citizen — no notice, no recurrence. */
export async function chargeCitizen(
  tenant: string,
  token: string,
  /** `clientRequestId`: one id per press (`charge:new` in `lib/request-id.ts`, 0102); a retry is answered with the first bill. */
  input: { citizenId: string; title: string; amount: number; dueDate: string; clientRequestId: string },
) {
  const result = await apiFetch<{
    id: string;
    invoiceNumber: string | null;
    /** True when the key had already raised this charge: nothing new was billed. */
    replayed: boolean;
  }>(tenant, '/fees/payments', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  invalidateRequests(`fee-summary:${tenant}`);
  return result;
}

/**
 * Records money handed over in person. Goes straight to PAID — the clerk
 * confirming it is the clerk who took it.
 */
export async function settlePayment(
  tenant: string,
  token: string,
  id: string,
  /**
   * The shared schema's shape — method, amount or tender, the day, the reason
   * for any departure from the official rate or today's date, and the retry
   * key. Not re-declared here, so the page cannot drift from what the server
   * validates.
   */
  input: Partial<SettlePayment> = {},
) {
  const result = await apiFetch<{
    paymentStatus: string;
    received: number;
    paidAmount: number;
    remaining: number;
    /** The ledger's RCP-… number — what the receipt prints and a reprint looks up. */
    receiptNumber: string;
    /** When the money moved: today's time, or midday of a back-dated day. */
    occurredAt: string;
    /** Handed back from a larger note, in the bill's currency. */
    changeGiven: number;
    /** The rate the foreign notes were taken at, and the municipality's own. */
    exchangeRate: number | null;
    officialExchangeRate: number | null;
    /**
     * True when this answers a retry with the receipt an earlier attempt
     * recorded — its number, day and amount, which may not be what the form
     * shows now. Optional: an API that does not send it answers as before.
     */
    replayed?: boolean;
  }>(
    tenant,
    `/fees/payments/${encodeURIComponent(id)}/settle`,
    // The `CASH` default is kept ahead of the spread so an omitted method
    // still means cash, as it did before the counter could bank a transfer.
    { token, method: 'PATCH', body: JSON.stringify({ method: 'CASH', ...input }) },
  );
  invalidateRequests(`fee-summary:${tenant}`);
  return result;
}

/**
 * «إلغاء الفاتورة» — the manager withdraws a bill nothing was paid on (finance
 * audit B3; `BILL_CANCEL_ROLES`). Refused with `BILL_CANCEL_HAS_PAYMENTS` when
 * money is on it and `PAYMENT_CLAIM_UNDER_REVIEW` while a citizen's claim waits.
 * Answers with the bill as it now stands, CANCELLED. The body is the shared
 * schema's (`cancelBillSchema`), not re-declared here.
 */
/** The cancelled bill, and the municipal request cancelled with it — null when it was no open request's fee. */
export interface CancelBillResult extends AdminPaymentItem {
  cancelledRequest: { requestId: string; requestNumber: string } | null;
}

export async function cancelBill(tenant: string, token: string, id: string, input: CancelBill) {
  const result = await apiFetch<CancelBillResult>(tenant, `/fees/payments/${encodeURIComponent(id)}/cancel`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  invalidateRequests(`fee-summary:${tenant}`);
  return result;
}

/**
 * «شطب» — what is left on a bill is written off on a council decision (0107,
 * docs/old-debts-plan.md decision 10; `BILL_WRITE_OFF_ROLES`). No money moves.
 * Refused with `BILL_ALREADY_WRITTEN_OFF`, `BILL_ALREADY_CANCELLED`,
 * `PAYMENT_CLAIM_UNDER_REVIEW`, `BILL_WRITE_OFF_NOTHING_LEFT`,
 * and `BILL_WRITE_OFF_DECISION_IN_FUTURE`. Answers with the bill as it now stands,
 * WRITTEN_OFF, and the municipal request that was waiting on it, now in review (null when
 * it was no request's fee). The body is the shared schema's.
 */
export interface WriteOffBillResult extends AdminPaymentItem {
  settledRequest: { requestId: string; requestNumber: string } | null;
}

export async function writeOffBill(tenant: string, token: string, id: string, input: WriteOffBillInput) {
  const result = await apiFetch<WriteOffBillResult>(tenant, `/fees/payments/${encodeURIComponent(id)}/write-off`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  invalidateRequests(`fee-summary:${tenant}`);
  return result;
}

export type { BulkSettlePayments, SettlementReceipt, SettlementReceiptItem } from '@mechanization/shared-schemas';

/**
 * «تسديد الفواتير المحددة» — several of one citizen's bills settled in one
 * press, all or nothing (docs/finance.md §3.7). Each bill gets its own «RCP-»
 * receipt; the answer is the consolidated receipt, «BRC-…», with `replayed`
 * when the retry key (`clientRequestId`) answers with a settlement an earlier
 * attempt recorded. The body is the shared schema's, not re-declared here.
 */
export async function bulkSettlePayments(tenant: string, token: string, input: BulkSettlePayments) {
  const result = await apiFetch<SettlementReceipt>(tenant, '/fees/payments/bulk-settle', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  // As `settlePayment`: the fee summary the fees screen caches counts these bills as unpaid.
  invalidateRequests(`fee-summary:${tenant}`);
  return result;
}

/** One consolidated receipt, for a reprint — what `bulkSettlePayments` answered, read again. */
export function getPaymentSettlement(tenant: string, token: string, id: string, signal?: AbortSignal) {
  return apiFetch<SettlementReceipt>(tenant, `/fees/settlements/${encodeURIComponent(id)}`, { token, signal });
}

/**
 * One movement on a bill (`PaymentLedgerService.listForPayment`): a receipt, or
 * the opposing row that reversed one.
 */
export interface PaymentLedgerEntry {
  id: string;
  /** «RCP-2610-0001» — the reversal has its own. */
  receiptNumber: string;
  /** In the bill's currency; negative on a reversal. */
  amount: number;
  currency: string;
  method: PaymentMethod;
  externalRef: string | null;
  collectedBy: string | null;
  recordedBy: string | null;
  /** True for the opposing row itself. */
  isReversal: boolean;
  /** True for a receipt that has been reversed. */
  reversed: boolean;
  note: string | null;
  occurredAt: string;
  tenderedLocal: number | null;
  tenderedForeign: number | null;
  tenderedForeignCurrency: string | null;
  exchangeRate: number | null;
  officialExchangeRate: number | null;
  changeGiven: number | null;
  adjustmentReason: string | null;
  /**
   * On a shared unit bill (0099), the debtor this money came from: the person its
   * receipt names (D9). Null on a citizen's own bill.
   */
  paidByCitizenId?: string | null;
  paidByName?: string | null;
}

/** Every movement on one bill, oldest first — `GET fees/payments/:id/transactions` (`FEE_READ_ROLES`). */
export function getPaymentTransactions(tenant: string, token: string, paymentId: string, signal?: AbortSignal) {
  return apiFetch<{ items: PaymentLedgerEntry[] }>(
    tenant,
    `/fees/payments/${encodeURIComponent(paymentId)}/transactions`,
    { token, signal },
  );
}

/**
 * «عكس الوصل» — reverses one receipt with an opposing row, never an edit
 * (`POST fees/transactions/:id/reverse`, `PAYMENT_REVERSE_ROLES`). The reason
 * is required (`reverseTransactionSchema`). Answers with the bill's totals
 * after the reversal and the opposing row's own receipt number.
 */
export async function reversePaymentTransaction(
  tenant: string,
  token: string,
  transactionId: string,
  input: ReverseTransaction,
) {
  const result = await apiFetch<{
    receiptNumber: string;
    transactionId: string;
    received: number;
    paidAmount: number;
    remaining: number;
    paymentStatus: 'PAID' | 'UNPAID';
    occurredAt: string;
  }>(tenant, `/fees/transactions/${encodeURIComponent(transactionId)}/reverse`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  invalidateRequests(`fee-summary:${tenant}`);
  return result;
}

/**
 * Runs the recurring biller now instead of waiting for the nightly cron.
 * Idempotent within a period — pressing it twice yields 0 new invoices.
 */
export function runRecurringBilling(tenant: string, token: string) {
  return apiFetch<{ tenants: number; invoicesCreated: number }>(
    tenant,
    '/fees/recurring/run',
    { token, method: 'POST' },
  );
}

/** Stops or resumes the recurring biller for one notice. */
export function setNoticeActive(
  tenant: string,
  token: string,
  id: string,
  isActive: boolean,
) {
  return apiFetch<{ isActive: boolean }>(
    tenant,
    `/fees/notices/${encodeURIComponent(id)}/active`,
    { token, method: 'PATCH', body: JSON.stringify({ isActive }) },
  );
}


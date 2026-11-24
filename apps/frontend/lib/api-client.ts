import {
  type StaffPresenceResponse,
  type StaffSelf,
  type CaseStatus,
  type CaseType,
  type CreateNewsCategoryInput,
  type CreateNewsPublisherInput,
  type NewsArticlePage,
  type NewsAvailability,
  type NewsArticleStatus,
  type NewsArticleView,
  type NewsCategoryView,
  type NewsMediaView,
  type NewsPlacementInput,
  type NewsPublisherView,
  type PublishNewsArticleInput,
  type SaveNewsArticleInput,
  type UpdateNewsCategoryInput,
  type UpdateNewsPublisherInput,
  type InspectorProfileResponse,
  type RecordInspectorPayoutInput,
  type RecordInspectorPayoutResult,
} from '@mechanization/shared-schemas';
import {
  cachedRequest,
} from './request-cache';
import {
  ApiRequestError,
  apiFetch,
  API_URL,
  ANSWERED_401,
  exchangeStaffToken,
  timeoutSignal,
  withRefreshLock,
  type ApiError,
  type Session,
} from './api/core';
import {
} from './api/buildings';
import {
} from './api/citizens';

export {
  checkPropertyNumber,
  peekPropertyNumberCheck,
  listCitizens,
  getReviewQueue,
  getUnsurveyedUnits,
  getReinspections,
  staleEditOf,
  getCitizenForm,
  reviewCitizenEdit,
  hasDuplicateFindings,
  reviewCitizenDuplicates,
  duplicateReviewOf,
  checkPossibleDuplicates,
  previewCitizenMerge,
  mergeCitizens,
  getCitizenMerges,
  previewCitizenUnmerge,
  undoCitizenMerge,
  importCitizens,
  createCitizen,
  updateCitizen,
  getLandlordLinks,
  getLandlordLink,
  getLandlordLinkSummary,
  getLandlordCandidates,
  confirmLandlordLink,
  dismissLandlordLink,
  restoreLandlordLink,
  getLandlordUnlinkPreview,
  unlinkLandlord,
  setCitizenActive,
  getDocumentViewUrl,
} from './api/citizens';
export * from './api/citizens';

export {
  getZones,
  getZone,
  createZone,
  updateZone,
  deleteZone,
  getZonesGeoJson,
} from './api/zones';
export * from './api/zones';

// Values are re-exported by name as well as by star: a test that mocks this module spreads its namespace, and a spread drops star re-exports.
export {
  getBuildings,
  getBuildingFilterOptions,
  getBuilding,
  invalidateCensus,
  getParcelBuildings,
  getBuildingCached,
  peekParcelBuildings,
  peekBuilding,
  getBuildingDamage,
  createBuilding,
  updateBuilding,
  getParcelCorrectionPreview,
  correctBuildingParcel,
  saveBuildingMatrix,
  deleteBuilding,
  generateUnits,
  addUnit,
  updateUnit,
  resizeUnitSpan,
  deleteUnit,
  recordOccupancy,
  linkOccupancyOwner,
  endOccupancy,
  isOwnershipResult,
  getOwnershipEndPreview,
  getOccupancyOwnershipPreview,
  endOwnership,
  getTenancyEndPreview,
  endTenancy,
  recordDamage,
  REPEAT_VISIT_WINDOW_MS,
  logUnitVisit,
  setUnitFeeExemption,
  getFeeExemptions,
  getFeeExemptionUnit,
  findFeeExemptionUnit,
  getCitizenFeeExemptionUnits,
  setOwnerBilling,
  confirmVacancy,
  settleAllUnitStatuses,
  endVacancy,
  getUnitVisits,
  getBuildingMapPins,
  getZoneParcelIndex,
  getCitizenProfile,
  getMySummary,
  getUnitCorrectionPreview,
  applyUnitCorrection,
  getDuplexMergePreview,
  applyDuplexMerge,
  unitCorrectionRefusal,
  getBuildingTypes,
  createBuildingType,
  updateBuildingType,
  getUnitTypes,
  createUnitType,
  updateUnitType,
} from './api/buildings';
export * from './api/buildings';

// Values are re-exported by name as well as by star: a test that mocks this module spreads its namespace, and a spread drops star re-exports.
export {
  getMunicipalitySettings,
  getCitizenPortalSettings,
  updateMunicipalitySettings,
  getFeeNotices,
  getParcelRoster,
  issueFeeNotice,
  cancelFeeNotice,
  getFeeNoticePeriods,
  previewFeeNotice,
  getFeeSummary,
  getPendingPayments,
  markPaymentAsSeen,
  markAllPendingPaymentsAsSeen,
  reviewPayment,
  getCorrectionAffectedBills,
  getParcelDues,
  billFigureKey,
  reviewBillBasis,
  getMyPayments,
  startWhishCheckout,
  declarePayment,
  loginByReference,
  openByReference,
  getFeeTitles,
  getFeeFilterOptions,
  getAllPayments,
  getPaymentById,
  chargeCitizen,
  settlePayment,
  cancelBill,
  writeOffBill,
  bulkSettlePayments,
  getPaymentSettlement,
  getPaymentTransactions,
  reversePaymentTransaction,
  runRecurringBilling,
  setNoticeActive,
} from './api/fees';
export * from './api/fees';

// Values are re-exported by name as well as by star: a test that mocks this module spreads its namespace, and a spread drops star re-exports.
export {
  API_URL,
  duplicateBuildingsOf,
  duplicateUnitsOf,
  houseGrowthQuestionOf,
  ApiRequestError,
  logApiError,
  timeoutSignal,
  withRefreshLock,
  exchangeStaffToken,
  ANSWERED_401,
  apiFetch,
} from './api/core';
export * from './api/core';


// ─────────────────────────────  Endpoints  ─────────────────────────────

export interface PublicTenantConfig {
  slug: string;
  name: string;
  nameAr: string;
  enabledPropertyTypes: string[];
  requiredDocuments: string[];
  branding: { logoUrl?: string; primaryColor?: string; accentColor?: string };
  supportPhone?: string;
}

/**
 * The municipality's public branding and enabled property types.
 * Unauthenticated — the staff entry form reads it before a tenant is known.
 * Cached in localStorage for offline resiliency.
 */
export function getTenantConfig(tenant: string): Promise<PublicTenantConfig> {
  return cachedRequest(`tenant-config:${tenant}`, 5 * 60 * 1000, async () => {
    try {
      const config = await apiFetch<PublicTenantConfig>(tenant, '/tenant/config');
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem(`mechanization.tenant_config.${tenant}`, JSON.stringify(config));
        } catch {
          // Ignore quota / localStorage errors
        }
      }
      return config;
    } catch (caught) {
      if (typeof window !== 'undefined' && window.localStorage) {
        const stored = localStorage.getItem(`mechanization.tenant_config.${tenant}`);
        if (stored) {
          try {
            return JSON.parse(stored) as PublicTenantConfig;
          } catch {
            // Ignore parse errors
          }
        }
      }
      // If network error / offline, return a safe fallback so the offline form can still render
      if (caught instanceof ApiRequestError && caught.status === 0) {
        return {
          slug: tenant,
          name: tenant,
          nameAr: tenant,
          enabledPropertyTypes: ['BUILDING', 'HOUSE', 'LAND', 'TENT'],
          requiredDocuments: [],
          branding: {},
        };
      }
      throw caught;
    }
  });
}


export interface CitizenChoice {
  id: string;
  displayName: string;
  identityDocLastDigits: string;
}

export type VerifyOtpResponse =
  | Session
  | { status: 'CHOOSE_PROFILE'; phone: string; choices: CitizenChoice[] };

/**
 * Issues a login code. `attempt` is the resend counter: from the second
 * the server switches SMS route rather than retrying the one that failed.
 */
export function requestOtp(tenant: string, phone: string, attempt: number) {
  return apiFetch<{
    sent: boolean;
    /** False when the server has OTP switched off — skip straight to sign-in. */
    otpRequired: boolean;
    channel: string;
    expiresAt: string;
    resendAvailableAt: string;
    devCode?: string;
  }>(tenant, '/auth/citizen/otp/request', {
    method: 'POST',
    body: JSON.stringify({ phone, attempt }),
  });
}

/**
 * Exchanges the code for a session, or for a profile choice when one
 * phone belongs to several household members.
 */
export function verifyOtp(
  tenant: string,
  input: { phone: string; code?: string; citizenId?: string },
) {
  return apiFetch<VerifyOtpResponse>(tenant, '/auth/citizen/otp/verify', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * A session, or the second factor still owed.
 *
 * `status` is the discriminant, matching `verifyOtpResponseSchema`'s shape on
 * the citizen side. The server returns the challenge only after the password
 * has already been accepted, so reaching it means the credentials were right.
 */
export type StaffLoginResponse = Session | { status: 'TOTP_REQUIRED' };

/** Narrows the union above — a session has a token, a challenge does not. */
export function isTotpRequired(
  response: StaffLoginResponse,
): response is { status: 'TOTP_REQUIRED' } {
  return 'status' in response && response.status === 'TOTP_REQUIRED';
}

/**
 * Staff sign-in.
 *
 * `credentials: 'include'` is what lets the browser keep the refresh cookie the
 * response sets. The API is a different origin from the portal, and without it
 * a cross-origin response's `Set-Cookie` is silently dropped — the sign-in would
 * look fine, and the first expiry of the access token would sign the clerk out.
 * Held under the refresh lock so the new cookie does not land in the middle of
 * another tab's exchange of the old one.
 */
export function loginStaff(
  tenant: string,
  input: { email: string; password: string; totpToken?: string; remember?: boolean },
) {
  return withRefreshLock(tenant, () =>
    apiFetch<StaffLoginResponse>(tenant, '/auth/staff/login', {
      method: 'POST',
      body: JSON.stringify(input),
      credentials: 'include',
    }),
  );
}

/**
 * Ends this tab's staff session on the server: the refresh family behind it,
 * and with it the access token, which the API checks against its family on
 * every request.
 *
 * Sends the tab's own token as the binding, exactly as a refresh does — without
 * one the server cannot tell which account's cookie to read, and does nothing.
 * So with no token there is nothing to send. The timeout is short because a
 * clerk is waiting to be signed out, and the local sign-out happens regardless.
 *
 * **May throw** — a dropped connection, a timeout, or the 404 an API from before
 * this route answers with. Callers ignore it and clear the local session anyway;
 * the server-side session is then left to run out at its cap, which is all that
 * signing out did before this route existed.
 */
export async function logoutStaff(tenant: string, accessToken?: string): Promise<void> {
  if (!accessToken) return;

  await withRefreshLock(tenant, () =>
    apiFetch<{ signedOut: boolean }>(tenant, '/auth/staff/logout', {
      method: 'POST',
      token: accessToken,
      credentials: 'include',
      // A 401 here means there was nothing to end, never "exchange and retry".
      skipTokenRefresh: true,
      signal: timeoutSignal(5_000),
    }),
  );
}

/**
 * A citizen's «خروج», ended on the server (task S14 of the 2026-11-14
 * security audit): every session the citizen holds stops working, not only
 * the one in this browser — a citizen token otherwise lives seven days.
 *
 * **May throw**, like `logoutStaff`: callers clear the local session anyway
 * (`signOutCitizen` in `lib/citizen-sign-out.ts`), and a session this could
 * not end runs out at its cap, which is all signing out did before.
 */
export async function logoutCitizen(tenant: string, accessToken?: string): Promise<void> {
  if (!accessToken) return;
  await apiFetch<{ signedOut: boolean }>(tenant, '/auth/citizen/logout', {
    method: 'POST',
    token: accessToken,
    // A 401 here means there was nothing to end, never "exchange and retry".
    skipTokenRefresh: true,
    signal: timeoutSignal(5_000),
  });
}

export interface DashboardCounters {
  total: number;
  byPropertyType: Record<string, number>;
  byResidentStatus: Record<string, number>;
  submittedLast7Days: number;
}

/** Headline totals for the dashboard cards. Cached. */
export function getDashboardCounters(tenant: string, token: string) {
  return cachedRequest(`dashboard-counters:${tenant}`, 30 * 1000, () =>
    apiFetch<DashboardCounters>(tenant, '/dashboard/counters', { token }),
  );
}

/** One month of the fee ledger, keyed by the month an invoice fell due. */
export interface MonthlyFees {
  /** `YYYY-MM`. */
  month: string;
  billed: number;
  collected: number;
  overdue: number;
}

/**
 * Everything the analytics dashboard plots, in one payload — so the KPI tiles
 * and the charts below them can never disagree.
 */
export interface DashboardAnalytics {
  /** Household records on file — one row per registered citizen. */
  citizenRecords: number;
  /**
   * العدد الفعلي لسكان البلدة — sum of every household's actual household
   * members, i.e. the real, deduplicated population as declared (excluding
   * married children counted under their own branched-off household).
   */
  populationTotal: number;
  /** إجمالي المسجلين في سجلات النفوس — sum of totalRegisteredMembers (gross). */
  grossRegisteredTotal: number;
  /**
   * Households with no declared actual household size. They contribute
   * nothing to `populationTotal`, so it is understated by at least this many
   * people — surfaced in the UI rather than silently rounded to zero.
   */
  householdsWithoutSize: number;
  familySizes: Array<{ size: number; households: number }>;

  /** Building stock by نوع العقار — مبنى / منزل / أرض / خيمة. */
  propertiesByType: Record<string, number>;
  propertyTotal: number;

  /**
   * Units by نوع الوحدة — شقة / عيادة / محل, counted across both places a
   * unit type is stored (a building's units, and properties registered as a
   * single unit). Counting only the first drops every standalone unit.
   */
  unitsByType: Record<string, number>;
  unitTotal: number;

  /**
   * The physical stock, from the building census — the same rows and the same
   * predicates as «سجل المباني», so the two screens cannot disagree.
   *
   * Everything above counts *filings*: a property card belongs to one
   * citizen's file, so a block of twelve registered households is twelve
   * «مبنى» cards and one structure. The dashboard's headline figures come
   * from here instead; the filing counts stay, named as what they are.
   */
  census: {
    /** Every structure on the register — matches «عدد المباني» on the ledger. */
    buildings: number;
    /** Units in structures that can hold households — the ledger's denominator. */
    unitsTotal: number;
    /** Of those, surveyed (COMPLETE or VACANT_CONFIRMED). */
    unitsSurveyed: number;
    /** The same units as `unitsTotal`, split by نوع الوحدة. Sums to it. */
    unitsByType: Record<string, number>;
    /**
     * Every structure by «نوع المبنى» (0106), keyed by the type's id — `NONE` for one
     * not typed yet. Optional on the wire for an answer from before it.
     */
    buildingsByType?: Record<string, number>;
    /** Census buildings at least one live property card points at. */
    buildingsWithFilings: number;
  };

  /**
   * How many property/unit rows were already excluded as duplicate filings —
   * a TENANT/FREE_OCCUPANT registration of a unit an OWNER already registered
   * under the same رقم العقار (the same apartment, filed twice).
   */
  duplicateFilingsExcluded: {
    properties: number;
    units: number;
  };

  billedTotal: number;
  collectedTotal: number;
  outstandingTotal: number;
  /** Unpaid and past its due date. */
  overdueTotal: number;
  overdueCount: number;
  pendingReviewCount: number;

  monthly: MonthlyFees[];
}

/** The analytics dashboard's whole dataset. Cached server-side. */
export function getDashboardAnalytics(tenant: string, token: string) {
  return apiFetch<DashboardAnalytics>(tenant, '/dashboard/analytics', { token });
}

export interface ParcelRegistrantFinancials {
  totalBilled: number;
  totalPaid: number;
  totalDue: number;
  paymentStatus: 'PAID' | 'PARTIALLY_PAID' | 'UNPAID' | 'NO_BILLS';
}

/** One structure/card registered against a parcel. */
export interface ParcelStructure {
  id: string;
  propertyType: string;
  occupancyType: string;
  buildingName: string | null;
  unitCount: number;
  unitType?: string | null;
  unitArea?: number | null;
}

/** One citizen registered against a parcel, as the map drawer lists them. */
export interface ParcelRegistrant {
  citizenId: string;
  registrationId: string;
  fullName: string;
  phone: string | null;
  /** «لا يملك رقم هاتف» — absent from an older backend. */
  hasNoPhone?: boolean;
  /** «رقم للتواصل» — a relative's number. */
  contactPhone?: string | null;
  occupancyType: string;
  propertyType: string;
  buildingName: string | null;
  status?: string;
  registeredAt: string;
  unitCount: number;
  financials?: ParcelRegistrantFinancials;
  /** All structures registered by this citizen on this parcel */
  structures?: ParcelStructure[];
}

export interface ParcelFinancials {
  totalBilled: number;
  totalPaid: number;
  totalDue: number;
  status: 'PAID' | 'PARTIALLY_PAID' | 'UNPAID' | 'NO_BILLS';
}

/**
 * A parcel with at least one registration. The fullscreen map places an
 * interactive marker only on these — every other cadastral parcel is drawn
 * from the static GeoJSON with no dot, so a dot always means there is
 * citizen data to open.
 */
/**
 * A parcel that has at least one registration, with everyone attached to it.
 *
 * **One row per رقم العقار.** P5-T5 split it per censused structure and P5-T7
 * put it back: the map already draws a census layer with a pin per building at
 * its own entrance, so a registration dot on each of those said the same thing
 * twice. This layer is about the plot — everyone on it, one dot, at the
 * parcel's own point.
 */
export interface RegisteredParcel {
  propertyNumber: string;
  latitude: number;
  longitude: number;
  registrants: ParcelRegistrant[];
  financials?: ParcelFinancials;
  structureCount?: number;
}

/**
 * Parcels that have at least one registration, grouped for the map — one
 * marker per cadastral number, with everyone registered on it.
 */
export function getRegisteredParcels(tenant: string, token: string) {
  return apiFetch<{ parcels: RegisteredParcel[] }>(tenant, '/dashboard/map/parcels', { token });
}

// ────────────────────────────────  Cases  ────────────────────────────────

/**
 * حالات — a field visit that could not become a citizen registration
 * (nobody home, gate locked, access refused…). Not linked to any citizen:
 * there is none to attach it to yet.
 */
export interface CaseSummary {
  id: string;
  notes: string;
  propertyNumber: string | null;
  neighborhood: string | null;
  propertyType: string | null;
  buildingName: string | null;
  floor: string | null;
  side: string | null;
  landType: string | null;
  tentLocation: string | null;
  /** «مجدولة» means a revisit date is already set — see `scheduledRevisitAt`. */
  status: CaseStatus;
  /** Why the visit did not complete. `GENERAL_NOTE` for anything logged before
   *  the column existed. There is deliberately no war-damage type (D6). */
  caseType: CaseType;
  /**
   * The resolved form of `buildingName`/`floor`, once the case can be pinned to
   * actual census rows. Both survive: the free text is what the officer wrote at
   * the door, and on a parcel with no surveyed buildings it is all there is.
   */
  buildingId: string | null;
  buildingCode: string | null;
  unitId: string | null;
  unitCode: string | null;
  /**
   * Who the census records on that unit now. Optional on the wire for an
   * older server. Non-empty means the flat is already somebody's — owned,
   * rented or lent — so the case is answered by linking it to them, and
   * «تسجيل المواطن» from the case is closed.
   */
  unitOccupants?: CaseUnitOccupant[];
  /** The unit's recorded status — `OWNER_OCCUPIED` when its recorded owner lives in it. */
  unitStatus?: string | null;
  /** The damage reading that prompted this case, if one did. A reference, not
   *  ownership — resolving the case says nothing about the damage (D6). */
  damageAssessmentId: string | null;
  /** When someone has agreed to go back. Meaningful under `SCHEDULED`. */
  scheduledRevisitAt: string | null;
  /** The citizen whose registration resolved this case, if any. */
  resolvedCitizenId: string | null;
  resolvedCitizenName: string | null;
  resolvedAt: string | null;
  createdById: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Who on a case's unit actually lives there, registered: a tenant, a free
 * occupant, or an owner on a flat recorded «يشغلها المالك». Non-empty means
 * the household the case was waiting for is on file, so «تسجيل المواطن» from
 * the case is closed and the case is answered by linking it to them.
 *
 * An owner alone on a flat recorded «مؤجرة» is not that: the owner lets it,
 * and the tenant the case is asking for is exactly who is missing.
 */
export function caseResidents(item: Pick<CaseSummary, 'unitOccupants' | 'unitStatus'>): CaseUnitOccupant[] {
  return (item.unitOccupants ?? []).filter(
    (person) => person.role !== 'OWNER' || item.unitStatus === 'OWNER_OCCUPIED',
  );
}

/** A registered citizen the census records on a case's unit. */
export interface CaseUnitOccupant {
  citizenId: string;
  name: string;
  role: 'OWNER' | 'TENANT' | 'FREE_OCCUPANT';
}

export interface CaseWriteInput {
  notes: string;
  propertyNumber?: string;
  neighborhood?: string;
  propertyType?: string;
  buildingName?: string;
  floor?: string;
  side?: string;
  landType?: string;
  tentLocation?: string;
  caseType?: CaseType;
  /** Pins the case to a censused structure — set when logged from the matrix. */
  buildingId?: string;
  unitId?: string;
  damageAssessmentId?: string;
  scheduledRevisitAt?: string;
}

export function getCases(
  tenant: string,
  token: string,
  filter: {
    propertyNumber?: string;
    status?: CaseStatus;
    caseType?: CaseType;
    /** Every case on this structure, however its units are spread. */
    buildingId?: string;
    unitId?: string;
    /** When the case was opened, inclusive. ISO instants. */
    from?: string;
    to?: string;
  } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filter.propertyNumber) query.set('propertyNumber', filter.propertyNumber);
  if (filter.status) query.set('status', filter.status);
  if (filter.caseType) query.set('caseType', filter.caseType);
  if (filter.buildingId) query.set('buildingId', filter.buildingId);
  if (filter.unitId) query.set('unitId', filter.unitId);
  if (filter.from) query.set('from', filter.from);
  if (filter.to) query.set('to', filter.to);
  const qs = query.toString();
  return apiFetch<{ cases: CaseSummary[] }>(tenant, `/cases${qs ? `?${qs}` : ''}`, {
    token,
    signal,
  });
}

export function getCase(tenant: string, token: string, id: string, signal?: AbortSignal) {
  return apiFetch<CaseSummary>(tenant, `/cases/${encodeURIComponent(id)}`, { token, signal });
}

export function createCase(tenant: string, token: string, input: CaseWriteInput) {
  return apiFetch<CaseSummary>(tenant, '/cases', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * The fields a case PATCH clears with `null` (`updateCaseSchema` takes null for
 * exactly these): the free-text place fields, and نوع العقار and نوع الأرض when
 * «غير معروف» is chosen. An omitted field is left as it is, so a field the
 * officer emptied has to be sent as `null` or it is never cleared.
 */
export type CaseClearableField =
  | 'propertyNumber'
  | 'neighborhood'
  | 'propertyType'
  | 'buildingName'
  | 'floor'
  | 'side'
  | 'landType'
  | 'tentLocation';

export type CaseUpdateInput = Omit<Partial<CaseWriteInput>, CaseClearableField> & {
  [K in CaseClearableField]?: string | null;
} & {
  status?: CaseStatus;
  /** Setting this always resolves the case server-side; `null` only clears the link. */
  resolvedCitizenId?: string | null;
};

export function updateCase(
  tenant: string,
  token: string,
  id: string,
  input: CaseUpdateInput,
) {
  return apiFetch<CaseSummary>(tenant, `/cases/${encodeURIComponent(id)}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

/** SUPER_ADMIN only, server-enforced. */
export function deleteCase(tenant: string, token: string, id: string) {
  return apiFetch<{ deleted: boolean }>(tenant, `/cases/${encodeURIComponent(id)}`, {
    token,
    method: 'DELETE',
  });
}

// ───────────────────────────  Staff accounts  ───────────────────────────

export interface StaffSummary {
  id: string;
  email: string;
  fullName: string;
  firstName: string;
  lastName: string;
  role: string;
  isActive: boolean;
  hasConfirmedTotp?: boolean;
  /** Performance & commission metrics for field inspectors */
  registeredCitizensCount?: number;
  registeredPropertiesCount?: number;
  totalEarnings?: number;
  paidBalance?: number;
  pendingBalance?: number;
  /** Paid over and above earned. `pendingBalance` clamps at zero and hides it. */
  overpaidBalance?: number;
  createdAt: string;
  lastLoginAt: string | null;
  /**
   * «آخر ظهور» — when this account last made a request, null if not since
   * migration 0070.
   *
   * A timestamp and not an `online` boolean, deliberately: the staff page
   * needs «آخر ظهور» for whoever is *not* here, and a server that answered
   * only yes/no would have thrown that away. `isStaffOnline` applies the
   * threshold. Older accounts and a backend before 0070 send null, which
   * reads as offline with nothing to say about when.
   */
  lastSeenAt?: string | null;
  /** Set only on a deleted account the earnings roster asked for. */
  deletedAt?: string | null;
}

/**
 * «متصل الآن» / «آخر ظهور» for every live staff account, with the server's own
 * clock (`now`) to compare against — `isStaffOnline` in
 * `@mechanization/shared-schemas` is the rule, and the browser's clock is never
 * used, so an office PC whose clock is off cannot flip the label.
 *
 * What the staff page polls once a minute, so it is light (no earnings
 * roster) and a background request: the poll itself must not keep the admin
 * reading it «متصل».
 */
export function getStaffPresence(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<StaffPresenceResponse>(tenant, '/staff/presence', { token, signal, background: true });
}

/**
 * Every staff account that has not been deleted. `includeDeletedEarners` adds
 * the deleted accounts that earned or were paid commission — the earnings
 * roster's totals are history and must not shrink when an account is hidden.
 */
export function getStaff(
  tenant: string,
  token: string,
  signal?: AbortSignal,
  options: { includeDeletedEarners?: boolean } = {},
) {
  const query = options.includeDeletedEarners ? '?include=deleted-earners' : '';
  return apiFetch<{ items: StaffSummary[] }>(tenant, `/staff${query}`, { token, signal });
}

/**
 * Creates an account. `confirmPassword` is deliberately not sent — it is a
 * typo guard for whoever is typing, not something the server can verify.
 */
export function createStaff(
  tenant: string,
  token: string,
  input: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    role: string;
  },
) {
  return apiFetch<{ id: string; totp?: { secret: string; keyUri: string } }>(tenant, '/staff', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Partial update. An omitted `password` leaves the current one alone. */
export function updateStaff(
  tenant: string,
  token: string,
  id: string,
  input: {
    email?: string;
    password?: string;
    firstName?: string;
    lastName?: string;
    role?: string;
  },
) {
  return apiFetch<{ updated: boolean }>(tenant, `/staff/${encodeURIComponent(id)}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

/** Soft delete and its undo. */
export function setStaffActive(tenant: string, token: string, id: string, isActive: boolean) {
  return apiFetch<{ isActive: boolean }>(tenant, `/staff/${encodeURIComponent(id)}/active`, {
    token,
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  });
}

/** Permanent — the server refuses it for any account that has already acted. */
export function deleteStaff(tenant: string, token: string, id: string) {
  return apiFetch<{ deleted: boolean }>(tenant, `/staff/${encodeURIComponent(id)}`, {
    token,
    method: 'DELETE',
  });
}

/** A staff account a super admin has deleted. */
export interface DeletedStaffSummary {
  id: string;
  email: string;
  fullName: string;
  role: string;
  deletedAt: string;
}

/** The deleted staff accounts, most recent first — what a restore is made from. */
export function getDeletedStaff(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<{ items: DeletedStaffSummary[] }>(tenant, '/staff/deleted', { token, signal });
}

/** Brings a deleted account back onto the staff list, still disabled. */
export function restoreStaff(tenant: string, token: string, id: string) {
  return apiFetch<{ restored: boolean }>(tenant, `/staff/${encodeURIComponent(id)}/restore`, {
    token,
    method: 'POST',
  });
}

/** Field Inspector self-service dashboard & performance summary */
export function getMyInspectorProfile(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<InspectorProfileResponse>(tenant, '/staff/inspector/me/profile', {
    token,
    signal,
  });
}

/** Super Admin (or Inspector) viewing an inspector profile dashboard */
export function getInspectorProfile(
  tenant: string,
  token: string,
  id: string,
  signal?: AbortSignal,
) {
  return apiFetch<InspectorProfileResponse>(
    tenant,
    `/staff/inspectors/${encodeURIComponent(id)}/profile`,
    {
      token,
      signal,
    },
  );
}

/** «صرف عمولة»: the manager pays an inspector's commission; `replayed` when a retried press found it already paid. */
export function recordInspectorPayout(
  tenant: string,
  token: string,
  id: string,
  input: RecordInspectorPayoutInput,
) {
  return apiFetch<RecordInspectorPayoutResult>(
    tenant,
    `/staff/inspectors/${encodeURIComponent(id)}/payouts`,
    {
      token,
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  actorType: string;
  actorRole: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  /** Sensitive values arrive already replaced with `[redacted]`. */
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  createdAt: string;
  /** Who did it, resolved by the server — a staff member's name, or «النظام». */
  actor?: {
    kind: 'STAFF' | 'CITIZEN' | 'SYSTEM';
    name: string | null;
    role: string | null;
    email: string | null;
  };
  /** What it was done to, as a person reads it, and where to open it. */
  target?: {
    type: string;
    id: string | null;
    label: string | null;
    secondary: string | null;
    link: { kind: 'citizen' | 'staff' | 'building' | 'case' | 'zone'; id: string } | null;
    missing: boolean;
  };
}

export interface AuditFacets {
  actions: string[];
  entityTypes: string[];
  actors: Array<{ id: string; name: string; role: string | null; isActive: boolean }>;
}

export function getAuditFacets(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<AuditFacets>(tenant, '/audit/facets', { token, signal });
}

/**
 * «سجل التعديلات» — one citizen's or building's own history: what was changed,
 * by whom, from what to what, and why. Open to everyone who can open the
 * record, unlike `getAuditLog`: the server leaves out who viewed it and how it
 * is being reviewed, and strips repair snapshots.
 */
export function getRecordHistory(
  tenant: string,
  token: string,
  record: { kind: 'citizen' | 'building'; id: string },
  page: { limit?: number; offset?: number } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({
    limit: String(page.limit ?? 30),
    offset: String(page.offset ?? 0),
  });
  const path = record.kind === 'citizen' ? 'citizens' : 'buildings';
  return apiFetch<{ items: AuditEntry[]; total: number }>(
    tenant,
    `/${path}/${encodeURIComponent(record.id)}/history?${query.toString()}`,
    { token, signal },
  );
}

/** SUPER_ADMIN/AUDITOR only, server-enforced. Omitting `actorId` returns
 * every administrative action; passing it (e.g. the signed-in user's own id)
 * narrows the trail down to one admin's activity. */
export function getAuditLog(
  tenant: string,
  token: string,
  filter: {
    /** A person's id, or `AUDIT_SYSTEM_ACTOR` for the entries no person made (no actor id). */
    actorId?: string;
    entityType?: string;
    /** One record's own trail. Pairs with `entityType`; the server indexes both. */
    entityId?: string;
    /** Any of these action codes. */
    actions?: string[];
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {},
  /** See `listCitizens`. */
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filter.actorId) query.set('actorId', filter.actorId);
  if (filter.entityType) query.set('entityType', filter.entityType);
  if (filter.entityId) query.set('entityId', filter.entityId);
  if (filter.actions?.length) query.set('action', filter.actions.join(','));
  if (filter.from) query.set('from', filter.from);
  if (filter.to) query.set('to', filter.to);
  query.set('limit', String(filter.limit ?? 50));
  query.set('offset', String(filter.offset ?? 0));

  return apiFetch<{ items: AuditEntry[]; total: number }>(tenant, `/audit?${query}`, {
    token,
    signal,
  });
}

/** One staff member's day in «التقرير اليومي». */
export interface AuditDaySummary {
  /** `YYYY-MM-DD`, bucketed in the zone this browser asked for. */
  day: string;
  actor: {
    id: string | null;
    kind: 'STAFF' | 'CITIZEN' | 'SYSTEM';
    name: string | null;
    role: string | null;
    email: string | null;
  };
  /** Commonest first. */
  actions: Array<{ action: string; count: number }>;
  total: number;
  lastAt: string;
}

/**
 * The same trail as `getAuditLog`, rolled up to one row per person per day.
 *
 * The day boundaries are the reader's, so the zone goes with the request —
 * grouping server-side in UTC would file an evening's work under the next
 * morning for everyone in Lebanon.
 */
export function getAuditDaily(
  tenant: string,
  token: string,
  filter: {
    actorId?: string;
    entityType?: string;
    actions?: string[];
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filter.actorId) query.set('actorId', filter.actorId);
  if (filter.entityType) query.set('entityType', filter.entityType);
  if (filter.actions?.length) query.set('action', filter.actions.join(','));
  if (filter.from) query.set('from', filter.from);
  if (filter.to) query.set('to', filter.to);
  query.set('timeZone', browserTimeZone());
  query.set('limit', String(filter.limit ?? 50));
  query.set('offset', String(filter.offset ?? 0));

  return apiFetch<{ items: AuditDaySummary[]; total: number }>(tenant, `/audit/daily?${query}`, {
    token,
    signal,
  });
}

/**
 * This browser's IANA zone, or nothing.
 *
 * The server falls back to Asia/Beirut on anything it does not recognise, so an
 * environment without `Intl` resolution loses an hour at the day boundary
 * rather than the screen.
 */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

export interface CadastreImportResult {
  parcelsImported: number;
  parcelsSkipped: number;
  linesImported: number;
}

/** The map layers `GET /cadastre/assets/:assetName` serves — the server refuses any other name. */
export type CadastreAssetName =
  | 'cadastre.geojson'
  | 'parcels.geojson'
  | 'parcel-polygons.geojson'
  | 'city-boundary.geojson';

/**
 * One of the municipality's cadastre map layers, from the API.
 *
 * Signed in like every other read: the route is not public, and a bare `fetch`
 * of it was a 401 wherever `public/tenants/<slug>/` lacks the file. `version`
 * only busts the browser's cache after an import (the response is cached
 * privately for an hour); the server ignores it. The static-first lookup the
 * maps use is `fetchCadastreAsset` (`lib/cadastre-assets.ts`).
 */
export function getCadastreAsset(
  tenant: string,
  token: string,
  args: { asset: CadastreAssetName; version?: string | number },
  signal?: AbortSignal,
) {
  const query = args.version ? `?v=${encodeURIComponent(String(args.version))}` : '';
  return apiFetch<GeoJSON.FeatureCollection>(
    tenant,
    `/cadastre/assets/${encodeURIComponent(args.asset)}${query}`,
    { token, signal },
  );
}

/** SUPER_ADMIN only — rebuilds the parcel registry and the map's static
 * cartography layer from an uploaded GeoJSON file. */
export function importCadastre(tenant: string, token: string, file: File) {
  const form = new FormData();
  form.append('file', file);
  return apiFetch<CadastreImportResult>(tenant, '/cadastre/import', {
    method: 'POST',
    token,
    body: form,
  });
}

// ─────────────────────────  Backup and restore  ─────────────────────────

export interface SnapshotManifest {
  version: number;
  tenantSlug: string;
  createdAt: string;
  migrations: string[];
  counts: Record<string, number>;
}

export interface RestoreReport {
  dryRun: boolean;
  manifest: SnapshotManifest;
  deleted: Record<string, number>;
  written: Record<string, number>;
}

/**
 * Downloads the restorable snapshot — real table rows, gzipped JSON.
 *
 * Not `apiFetch`, which parses every response as JSON: this one is a binary
 * file the municipality keeps on disk. SUPER_ADMIN only, server-enforced.
 */
export async function exportSnapshot(tenant: string, token: string): Promise<Blob> {
  const response = await fetch(`${API_URL}/t/${encodeURIComponent(tenant)}/backup/export`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({
      code: 'UNKNOWN',
      message: 'تعذّر إنشاء النسخة الاحتياطية.',
    }))) as ApiError;
    throw new ApiRequestError(response.status, payload);
  }
  return response.blob();
}

/**
 * Puts a snapshot back.
 *
 * `dryRun` defaults to true here as well as on the server. Two defaults for one
 * decision is deliberate: this is the call that replaces a municipality's
 * register, and a caller that forgets the flag should rehearse, not destroy.
 */
export async function restoreSnapshot(
  tenant: string,
  token: string,
  snapshot: Blob,
  options: { confirmTenantSlug: string; dryRun?: boolean },
): Promise<RestoreReport> {
  const query = new URLSearchParams({
    confirm: options.confirmTenantSlug,
    dryRun: String(options.dryRun !== false),
  });
  const response = await fetch(
    `${API_URL}/t/${encodeURIComponent(tenant)}/backup/restore?${query}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        // Anything but application/json, so no body parser consumes the stream
        // before the controller reads it.
        'Content-Type': 'application/gzip',
      },
      body: snapshot,
    },
  );

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      (payload as ApiError) ?? { code: 'UNKNOWN', message: 'تعذّرت الاستعادة.' },
    );
  }
  return payload as RestoreReport;
}

/**
 * «أمان الحساب»: the signed-in staff member's own account (email, role, whether
 * a second factor is confirmed). Every staff role may read its own; `getStaff`
 * is the administrator's roster and refuses everyone else.
 */
export function getStaffSelf(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<StaffSelf>(tenant, '/auth/staff/me', { token, signal });
}

/**
 * Ends every session of the account, this one included: the server bumps its
 * token version. After a success the caller signs out (`logoutStaff`,
 * `clearSession`) and sends the user to the sign-in page.
 */
export async function changeStaffPassword(
  tenant: string,
  token: string,
  input: { currentPassword: string; newPassword: string },
): Promise<{ changed: boolean }> {
  return apiFetch<{ changed: boolean }>(tenant, '/auth/staff/change-password', {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}

export async function changeStaffEmail(
  tenant: string,
  token: string,
  input: { newEmail: string; currentPassword: string },
): Promise<{ email: string }> {
  return apiFetch<{ email: string }>(tenant, '/auth/staff/change-email', {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}

export async function sendStaffPasswordResetEmail(
  tenant: string,
  token: string,
  redirectTo?: string,
): Promise<{ message: string }> {
  return apiFetch<{ message: string }>(tenant, '/auth/staff/send-reset-password-email', {
    method: 'POST',
    token,
    body: JSON.stringify({ redirectTo }),
  });
}

/**
 * Public — reached from the reset-password landing page before any session
 * exists. `accessToken` is the Supabase recovery token the email link's own
 * redirect appends to that page's URL, not this app's session token.
 */
export async function confirmStaffPasswordReset(
  tenant: string,
  accessToken: string,
  newPassword: string,
): Promise<{ confirmed: boolean }> {
  return apiFetch<{ confirmed: boolean }>(tenant, '/auth/staff/confirm-password-reset', {
    method: 'POST',
    body: JSON.stringify({ accessToken, newPassword }),
  });
}

export async function beginStaffTotpEnrolment(
  tenant: string,
  token: string,
): Promise<{ secret: string; keyUri: string }> {
  return apiFetch<{ secret: string; keyUri: string }>(tenant, '/auth/staff/totp/enrol', {
    method: 'POST',
    token,
  });
}

export async function confirmStaffTotpEnrolment(
  tenant: string,
  token: string,
  input: { token: string },
): Promise<{ confirmed: boolean }> {
  return apiFetch<{ confirmed: boolean }>(tenant, '/auth/staff/totp/confirm', {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}

export async function disableStaffTotp(
  tenant: string,
  token: string,
  input: { currentPassword?: string },
): Promise<{ disabled: boolean }> {
  return apiFetch<{ disabled: boolean }>(tenant, '/auth/staff/totp/disable', {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}


// ── الخزينة (stage 1) ───────────────────────────────────────────────────────

import type {
  ActivateTreasuryInput,
  ActivateTreasuryResult,
  TreasuryOverview,
  TreasuryStatement,
  CreateExpenseCategoryInput,
  ExpenseCategoryView,
  ExpenseListResult,
  ExpenseRequestListResult,
  ExpenseRequestStatus,
  ExpenseRequestView,
  ExpenseVoucherView,
  RecordExpenseInput,
  RecordExpenseResult,
  RejectExpenseRequestInput,
  RequestExpenseInput,
  RequestExpenseResult,
  RecordStaffSalaryInput,
  UpdateExpenseCategoryInput,
  VoidExpenseInput,
  CreateIncomeCategoryInput,
  IncomeCategoryView,
  IncomeVoucherView,
  RecordIncomeVoucherInput,
  RecordIncomeVoucherResult,
  TreasuryMovementDirection,
  TreasuryMovementsResult,
  UpdateIncomeCategoryInput,
  VoidIncomeVoucherInput,
  CollectorCollectionsResult,
  CollectorCustodyView,
  CollectorRoundView,
  ReceiveCustodyInput,
  ReceiveCustodyResult,
  TransferView,
  VoidTransferInput,
  CreateTransferInput,
  CreateTransferResult,
  ListTransfersQuery,
  ReviewTransferInput,
  TransferListResult,
  CreateTreasuryAccountInput,
  TreasuryAccountView,
} from '@mechanization/shared-schemas';

export type {
  ActivateTreasuryInput,
  ActivateTreasuryResult,
  TreasuryAccountView,
  TreasuryOverview,
  TreasuryRate,
  TreasuryStatement,
  TreasuryStatementEntry,
  CreateExpenseCategoryInput,
  ExpenseCategoryView,
  ExpenseListResult,
  ExpenseOrderStatus,
  ExpenseRequestListResult,
  ExpenseRequestStatus,
  ExpenseRequestView,
  ExpenseStatus,
  UpdateExpenseCategoryInput,
  ExpenseVoucherView,
  RecordExpenseInput,
  RecordExpenseResult,
  RejectExpenseRequestInput,
  RequestExpenseInput,
  RequestExpenseResult,
  RecordStaffSalaryInput,
  VoidExpenseInput,
  CreateIncomeCategoryInput,
  IncomeCategoryView,
  IncomeListResult,
  IncomeStatus,
  UpdateIncomeCategoryInput,
  IncomeVoucherView,
  RecordIncomeVoucherInput,
  RecordIncomeVoucherResult,
  VoidIncomeVoucherInput,
  TreasuryMovement,
  TreasuryMovementDay,
  TreasuryMovementDirection,
  TreasuryMovementTotal,
  TreasuryMovementsResult,
  CollectorCollectionRow,
  CollectorCollectionsResult,
  CollectorCustodyView,
  CollectorRoundCurrency,
  CollectorRoundRow,
  CollectorRoundView,
  ReceiveCustodyInput,
  ReceiveCustodyResult,
  TransferView,
  VoidTransferInput,
  CreateTransferInput,
  CreateTransferResult,
  ListTransfersQuery,
  ReviewTransferInput,
  TransferListResult,
  TransferKind,
  CreateTreasuryAccountInput,
} from '@mechanization/shared-schemas';

/** Every wallet with its balance, whether the treasury is live, and the rate to convert with. `GET /treasury`. */
export function getTreasuryOverview(tenant: string, token: string, _args?: undefined, signal?: AbortSignal) {
  return apiFetch<TreasuryOverview>(tenant, '/treasury', { token, signal });
}

/**
 * One wallet's movements inside a range, each with the balance after it.
 * `from` and `to` are dates (`YYYY-MM-DD`) on the municipality's calendar, and a date-only `to` runs to the end of
 * that day in Beirut. `limit` caps the rows at the NEWEST ones in the range, with the opening balance worked out for
 * the rows shown; the answer says when it cut the list short.
 */
export function getTreasuryStatement(
  tenant: string,
  token: string,
  args: { accountId: string; from?: string; to?: string; limit?: number },
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (args.from) query.set('from', args.from);
  if (args.to) query.set('to', args.to);
  if (args.limit !== undefined) query.set('limit', String(args.limit));
  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch<TreasuryStatement>(
    tenant,
    `/treasury/accounts/${encodeURIComponent(args.accountId)}/statement${suffix}`,
    { token, signal },
  );
}

/** «إضافة حساب» — a bank account or a petty-cash fund, opened empty. SUPER_ADMIN. `POST /treasury/accounts`. */
export function createTreasuryAccount(
  tenant: string,
  token: string,
  args: CreateTreasuryAccountInput,
  signal?: AbortSignal,
) {
  return apiFetch<TreasuryAccountView>(tenant, '/treasury/accounts', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/** «تفعيل الخزينة» — the counted opening balances, posted once. SUPER_ADMIN only. `POST /treasury/activate`. */
export function activateTreasury(
  tenant: string,
  token: string,
  args: ActivateTreasuryInput,
  signal?: AbortSignal,
) {
  return apiFetch<ActivateTreasuryResult>(tenant, '/treasury/activate', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/** «ما بعهدة الجباة» — what each collector is still carrying. `GET /treasury/transfers/custody`. */
export function getCollectorCustody(tenant: string, token: string, _args?: undefined, signal?: AbortSignal) {
  return apiFetch<CollectorCustodyView[]>(tenant, '/treasury/transfers/custody', { token, signal });
}

/**
 * «من حصّل الجابي» — the receipts behind one collector's custody balance.
 * `GET /treasury/transfers/custody/:collectorId/collections`.
 */
export function getCollectorCollections(
  tenant: string,
  token: string,
  args: { collectorId: string; limit?: number },
  signal?: AbortSignal,
) {
  const suffix = args.limit === undefined ? '' : `?limit=${args.limit}`;
  return apiFetch<CollectorCollectionsResult>(
    tenant,
    `/treasury/transfers/custody/${encodeURIComponent(args.collectorId)}/collections${suffix}`,
    { token, signal },
  );
}

/**
 * «جولتي» — the signed-in collector's own round: what is in his pocket, and
 * which doors it came from. `GET /treasury/transfers/custody/mine`.
 *
 * No id in the path on purpose — the server scopes it by the session, so there
 * is nothing here for a client to tamper with.
 */
export function getMyRound(tenant: string, token: string, _args?: undefined, signal?: AbortSignal) {
  return apiFetch<CollectorRoundView>(tenant, '/treasury/transfers/custody/mine', { token, signal });
}

/**
 * «سجل المناقلات» — newest first, filtered, with the count waiting for review.
 * `GET /treasury/transfers`.
 */
export function getTransfers(
  tenant: string,
  token: string,
  args: Partial<Omit<ListTransfersQuery, 'includeVoid'>> & { includeVoid?: boolean } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (args.kind) query.set('kind', args.kind);
  if (args.review) query.set('review', args.review);
  if (args.from) query.set('from', args.from);
  if (args.to) query.set('to', args.to);
  if (args.includeVoid) query.set('includeVoid', 'true');
  if (args.page) query.set('page', String(args.page));
  if (args.pageSize) query.set('pageSize', String(args.pageSize));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch<TransferListResult>(tenant, `/treasury/transfers${suffix}`, { token, signal });
}

/** One transfer, for its printed «سند». `GET /treasury/transfers/:id`. */
export function getTransfer(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<TransferView>(tenant, `/treasury/transfers/${encodeURIComponent(args.id)}`, { token, signal });
}

/**
 * «تحويل داخلي» or «مصارفة» — both legs and any fee, in one call.
 * ACCOUNTANT or SUPER_ADMIN. `POST /treasury/transfers`.
 */
export function createTransfer(tenant: string, token: string, args: CreateTransferInput, signal?: AbortSignal) {
  return apiFetch<CreateTransferResult>(tenant, '/treasury/transfers', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/** «اعتماد المراجعة». AUDITOR or SUPER_ADMIN. `POST /treasury/transfers/:id/review`. */
export function reviewTransfer(
  tenant: string,
  token: string,
  args: { id: string } & ReviewTransferInput,
  signal?: AbortSignal,
) {
  const { id, ...body } = args;
  return apiFetch<TransferView>(tenant, `/treasury/transfers/${encodeURIComponent(id)}/review`, {
    method: 'POST',
    token,
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * «استلام صندوق الجابي» — the counted cash leaves custody and reaches the safe.
 * ACCOUNTANT or SUPER_ADMIN. `POST /treasury/transfers/custody/receive`.
 */
export function receiveCollectorCustody(
  tenant: string,
  token: string,
  args: ReceiveCustodyInput,
  signal?: AbortSignal,
) {
  return apiFetch<ReceiveCustodyResult>(tenant, '/treasury/transfers/custody/receive', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/** Cancels a transfer and puts both legs back. SUPER_ADMIN only. `POST /treasury/transfers/:id/void`. */
export function voidTransfer(
  tenant: string,
  token: string,
  args: { id: string } & VoidTransferInput,
  signal?: AbortSignal,
) {
  const { id, ...body } = args;
  return apiFetch<TransferView>(tenant, `/treasury/transfers/${encodeURIComponent(id)}/void`, {
    method: 'POST',
    token,
    body: JSON.stringify(body),
    signal,
  });
}

/** The bands money may be spent under. `GET /treasury/expenses/categories`. */
export function getExpenseCategories(
  tenant: string,
  token: string,
  args?: { includeInactive?: boolean },
  signal?: AbortSignal,
) {
  const suffix = args?.includeInactive ? '?includeInactive=true' : '';
  return apiFetch<ExpenseCategoryView[]>(tenant, `/treasury/expenses/categories${suffix}`, { token, signal });
}

/** «بند صرف جديد». SUPER_ADMIN only. `POST /treasury/expenses/categories`. */
export function createExpenseCategory(
  tenant: string,
  token: string,
  args: CreateExpenseCategoryInput,
  signal?: AbortSignal,
) {
  return apiFetch<ExpenseCategoryView>(tenant, '/treasury/expenses/categories', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/**
 * Renames a band, re-codes it, or takes it out of use. Never deletes one.
 * SUPER_ADMIN only. `PATCH /treasury/expenses/categories/:id`.
 */
export function updateExpenseCategory(
  tenant: string,
  token: string,
  args: { id: string } & UpdateExpenseCategoryInput,
  signal?: AbortSignal,
) {
  const { id, ...body } = args;
  return apiFetch<ExpenseCategoryView>(
    tenant,
    `/treasury/expenses/categories/${encodeURIComponent(id)}`,
    { method: 'PATCH', token, body: JSON.stringify(body), signal },
  );
}

/**
 * The expense register, newest first. `GET /treasury/expenses`.
 *
 * `totals` covers the whole filtered set rather than the page, so «كم صرفنا على
 * المحروقات» is answered by the figure beside the table and not by adding up
 * what happens to be on screen.
 */
export function getExpenses(
  tenant: string,
  token: string,
  args: {
    from?: string;
    to?: string;
    categoryId?: string;
    accountId?: string;
    includeVoid?: boolean;
    /** Only paid vouchers still waiting for their payment order (an urgent payment, art. 35); never a cancelled one. */
    awaitingOrder?: boolean;
    page?: number;
    pageSize?: number;
  } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (args.from) query.set('from', args.from);
  if (args.to) query.set('to', args.to);
  if (args.categoryId) query.set('categoryId', args.categoryId);
  if (args.accountId) query.set('accountId', args.accountId);
  if (args.includeVoid) query.set('includeVoid', 'true');
  if (args.awaitingOrder) query.set('awaitingOrder', 'true');
  if (args.page !== undefined) query.set('page', String(args.page));
  if (args.pageSize !== undefined) query.set('pageSize', String(args.pageSize));
  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch<ExpenseListResult>(tenant, `/treasury/expenses${suffix}`, { token, signal });
}

/** One voucher. `GET /treasury/expenses/:id`. */
export function getExpense(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<ExpenseVoucherView>(tenant, `/treasury/expenses/${encodeURIComponent(args.id)}`, {
    token,
    signal,
  });
}

/**
 * «سجّل النفقة» — records the voucher and takes the money out, in one call.
 * ACCOUNTANT or SUPER_ADMIN. `POST /treasury/expenses`.
 *
 * The manager's recording is the payment order, so the voucher carries it. An
 * accountant is refused (`EXPENSE_ORDER_REQUIRED`) unless the input states an
 * `urgentReason` (art. 35); then it pays now and the voucher waits for the
 * manager's order (`orderStatus: 'AWAITING_ORDER'`). Anything else the
 * accountant prepares goes through `requestExpense`.
 */
export function recordExpense(tenant: string, token: string, args: RecordExpenseInput, signal?: AbortSignal) {
  return apiFetch<RecordExpenseResult>(tenant, '/treasury/expenses', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/**
 * «صرف راتب / أجر» to one staff member. `POST /treasury/expenses/salaries/:staffId`.
 * The server sets the payee and the category; the body cannot.
 */
export function recordStaffSalary(
  tenant: string,
  token: string,
  staffId: string,
  args: RecordStaffSalaryInput,
  signal?: AbortSignal,
) {
  return apiFetch<RecordExpenseResult>(tenant, `/treasury/expenses/salaries/${encodeURIComponent(staffId)}`, {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/** «إلغاء سند الصرف» — cancels it and puts the money back. SUPER_ADMIN only. `POST /treasury/expenses/:id/void`. */
export function voidExpense(
  tenant: string,
  token: string,
  args: { id: string } & VoidExpenseInput,
  signal?: AbortSignal,
) {
  const { id, ...body } = args;
  return apiFetch<ExpenseVoucherView>(tenant, `/treasury/expenses/${encodeURIComponent(id)}/void`, {
    method: 'POST',
    token,
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * «طلب أمر صرف» — the accountant prepares an expense for the manager's order.
 * Nothing leaves a wallet, so there is no date: the money leaves on the day of
 * the order. ACCOUNTANT or SUPER_ADMIN. `POST /treasury/expenses/requests`.
 */
export function requestExpense(tenant: string, token: string, args: RequestExpenseInput, signal?: AbortSignal) {
  return apiFetch<RequestExpenseResult>(tenant, '/treasury/expenses/requests', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/**
 * The requests for a payment order, newest first; by default only those still
 * waiting for the manager. `page` is 1-based. `GET /treasury/expenses/requests`.
 */
export function getExpenseRequests(
  tenant: string,
  token: string,
  args: { status?: ExpenseRequestStatus; page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (args.status) query.set('status', args.status);
  if (args.page !== undefined) query.set('page', String(args.page));
  if (args.pageSize !== undefined) query.set('pageSize', String(args.pageSize));
  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch<ExpenseRequestListResult>(tenant, `/treasury/expenses/requests${suffix}`, { token, signal });
}

/**
 * «أمر بالصرف» — the manager orders a request and the money leaves, in one
 * transaction. Refused with `TREASURY_INSUFFICIENT_FUNDS` when the wallet falls
 * short, and the request then stays waiting. SUPER_ADMIN only.
 * `POST /treasury/expenses/requests/:id/order`.
 */
export function orderExpenseRequest(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<RecordExpenseResult>(
    tenant,
    `/treasury/expenses/requests/${encodeURIComponent(args.id)}/order`,
    { method: 'POST', token, signal },
  );
}

/** «رفض الطلب» — declines a request, with the reason its author will read. SUPER_ADMIN only. `POST /treasury/expenses/requests/:id/reject`. */
export function rejectExpenseRequest(
  tenant: string,
  token: string,
  args: { id: string } & RejectExpenseRequestInput,
  signal?: AbortSignal,
) {
  const { id, ...body } = args;
  return apiFetch<ExpenseRequestView>(tenant, `/treasury/expenses/requests/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    token,
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * «سحب الطلب» — takes back a request that is still waiting. Its author or the
 * manager; anyone else is refused (`EXPENSE_REQUEST_NOT_YOURS`).
 * `POST /treasury/expenses/requests/:id/withdraw`.
 */
export function withdrawExpenseRequest(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<ExpenseRequestView>(
    tenant,
    `/treasury/expenses/requests/${encodeURIComponent(args.id)}/withdraw`,
    { method: 'POST', token, signal },
  );
}

/**
 * «إصدار أمر الصرف» for an urgent payment already made (art. 35): stamps the
 * manager's order on the voucher, once. The money has moved already, so no
 * balance changes. SUPER_ADMIN only. `POST /treasury/expenses/:id/order`.
 */
export function regularizeExpense(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<ExpenseVoucherView>(tenant, `/treasury/expenses/${encodeURIComponent(args.id)}/order`, {
    method: 'POST',
    token,
    signal,
  });
}

// ── الإيرادات العامة (stage 2) ──────────────────────────────────────────────

/** Where income may be filed. `GET /treasury/income/categories`. */
export function getIncomeCategories(
  tenant: string,
  token: string,
  args?: { includeInactive?: boolean },
  signal?: AbortSignal,
) {
  const suffix = args?.includeInactive ? '?includeInactive=true' : '';
  return apiFetch<IncomeCategoryView[]>(tenant, `/treasury/income/categories${suffix}`, { token, signal });
}

/** «بند إيراد جديد». SUPER_ADMIN only. `POST /treasury/income/categories`. */
export function createIncomeCategory(
  tenant: string,
  token: string,
  args: CreateIncomeCategoryInput,
  signal?: AbortSignal,
) {
  return apiFetch<IncomeCategoryView>(tenant, '/treasury/income/categories', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/**
 * Renames an income category, re-codes it, or stops or restarts it. Never
 * deletes one. SUPER_ADMIN only. `PATCH /treasury/income/categories/:id`.
 */
export function updateIncomeCategory(
  tenant: string,
  token: string,
  args: { id: string } & UpdateIncomeCategoryInput,
  signal?: AbortSignal,
) {
  const { id, ...body } = args;
  return apiFetch<IncomeCategoryView>(tenant, `/treasury/income/categories/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    token,
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * «الحركات المالية» — the income and the expense vouchers in one register,
 * newest first. `GET /treasury/movements`, on `TREASURY_READ_ROLES`.
 *
 * `from` and `to` are days on the municipality's calendar, both inclusive.
 * `categoryId` needs `direction`: an income category and an expense band are
 * rows of two tables. `totals` and `days` cover the whole filtered set, not the
 * page, so a day split over two pages still reads whole.
 */
export function getTreasuryMovements(
  tenant: string,
  token: string,
  args: {
    direction?: TreasuryMovementDirection;
    from?: string;
    to?: string;
    accountId?: string;
    categoryId?: string;
    currency?: string;
    search?: string;
    includeVoid?: boolean;
    page?: number;
    pageSize?: number;
  } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (args.direction) query.set('direction', args.direction);
  if (args.from) query.set('from', args.from);
  if (args.to) query.set('to', args.to);
  if (args.accountId) query.set('accountId', args.accountId);
  if (args.categoryId) query.set('categoryId', args.categoryId);
  if (args.currency) query.set('currency', args.currency);
  if (args.search) query.set('search', args.search);
  if (args.includeVoid) query.set('includeVoid', 'true');
  if (args.page !== undefined) query.set('page', String(args.page));
  if (args.pageSize !== undefined) query.set('pageSize', String(args.pageSize));
  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch<TreasuryMovementsResult>(tenant, `/treasury/movements${suffix}`, { token, signal });
}

/** One voucher. `GET /treasury/income/:id`. */
export function getIncomeVoucher(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<IncomeVoucherView>(tenant, `/treasury/income/${encodeURIComponent(args.id)}`, {
    token,
    signal,
  });
}

/**
 * «سجّل الإيراد» — records the voucher and credits the wallet, in one call.
 * ACCOUNTANT or SUPER_ADMIN. `POST /treasury/income`.
 */
export function recordIncomeVoucher(
  tenant: string,
  token: string,
  args: RecordIncomeVoucherInput,
  signal?: AbortSignal,
) {
  return apiFetch<RecordIncomeVoucherResult>(tenant, '/treasury/income', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/**
 * «إلغاء سند القبض» — cancels it and takes the money back out; refused when the
 * wallet has spent it since. SUPER_ADMIN only. `POST /treasury/income/:id/void`.
 */
export function voidIncomeVoucher(
  tenant: string,
  token: string,
  args: { id: string } & VoidIncomeVoucherInput,
  signal?: AbortSignal,
) {
  const { id, ...body } = args;
  return apiFetch<IncomeVoucherView>(tenant, `/treasury/income/${encodeURIComponent(id)}/void`, {
    method: 'POST',
    token,
    body: JSON.stringify(body),
    signal,
  });
}

// ── جرد الصندوق وإقفال اليومية (stage 5) ────────────────────────────────────

import type {
  CloseDayInput,
  CloseDayResult,
  DailyCashReport,
  DailyCountSheet,
  RecordDailyCountInput,
  ReopenDayInput,
  TreasuryDayClosureView,
  TreasuryDayState,
} from '@mechanization/shared-schemas';

export type {
  CloseDayInput,
  CloseDayResult,
  CountedWalletView,
  DailyCashReport,
  DailyCashReportCustody,
  DailyCashReportTotal,
  DailyCashReportWallet,
  DailyCountLineView,
  DailyCountSheet,
  DailyCountView,
  DayClosureVerdict,
  RecordDailyCountInput,
  ReopenDayInput,
  TreasuryDayClosureView,
  TreasuryDayEvent,
  TreasuryDayState,
  TreasuryDayStatus,
} from '@mechanization/shared-schemas';

/**
 * «جرد وإقفال اليومية» for one day — or, with no `date`, for the day that needs
 * closing next. `GET /treasury/counts`.
 */
export function getDailyCountSheet(
  tenant: string,
  token: string,
  args: { date?: string } = {},
  signal?: AbortSignal,
) {
  const suffix = args.date ? `?date=${encodeURIComponent(args.date)}` : '';
  return apiFetch<DailyCountSheet>(tenant, `/treasury/counts${suffix}`, { token, signal });
}

/**
 * «سجّل الجرد» — one or more wallets counted for one day; answers with the sheet
 * as it now stands. ACCOUNTANT or SUPER_ADMIN. `POST /treasury/counts`.
 */
export function recordDailyCount(tenant: string, token: string, args: RecordDailyCountInput, signal?: AbortSignal) {
  return apiFetch<DailyCountSheet>(tenant, '/treasury/counts', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/** «أقفل اليومية». ACCOUNTANT or SUPER_ADMIN. `POST /treasury/closures`. */
export function closeTreasuryDay(tenant: string, token: string, args: CloseDayInput, signal?: AbortSignal) {
  return apiFetch<CloseDayResult>(tenant, '/treasury/closures', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/** «أعد فتح اليومية» — the latest closed day, with a reason. SUPER_ADMIN only. `POST /treasury/closures/reopen`. */
export function reopenTreasuryDay(tenant: string, token: string, args: ReopenDayInput, signal?: AbortSignal) {
  return apiFetch<TreasuryDayState>(tenant, '/treasury/closures/reopen', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/** The closed and reopened days, latest first. `GET /treasury/closures`. */
export function getTreasuryClosures(
  tenant: string,
  token: string,
  args: { limit?: number } = {},
  signal?: AbortSignal,
) {
  const suffix = args.limit === undefined ? '' : `?limit=${args.limit}`;
  return apiFetch<TreasuryDayClosureView[]>(tenant, `/treasury/closures${suffix}`, { token, signal });
}

/** «تقرير الصندوق اليومي». `GET /treasury/reports/daily`. */
export function getDailyCashReport(tenant: string, token: string, args: { date: string }, signal?: AbortSignal) {
  return apiFetch<DailyCashReport>(tenant, `/treasury/reports/daily?date=${encodeURIComponent(args.date)}`, {
    token,
    signal,
  });
}

// ─────────────────────────────  «الأخبار» on Day3ati: categories and publishers  ─────────────────────────────

/**
 * The language Day3ati writes its own messages in (a refused form's field
 * errors): the page's, `ar` or `en`. The names themselves come in all of
 * their languages.
 */
const newsLang = (locale: string): string => `?lang=${locale === 'en' ? 'en' : 'ar'}`;

/** Every category, switched-off ones included (`GET news/categories`, `NEWS_EDITOR_ROLES`). */
export async function getNewsCategories(
  tenant: string,
  token: string,
  locale: string,
  signal?: AbortSignal,
): Promise<NewsCategoryView[]> {
  return apiFetch<NewsCategoryView[]>(tenant, `/news/categories${newsLang(locale)}`, { token, signal });
}

/** Adds a category, whose key is fixed from then on. */
export async function createNewsCategory(
  tenant: string,
  token: string,
  locale: string,
  input: CreateNewsCategoryInput,
  signal?: AbortSignal,
): Promise<NewsCategoryView> {
  return apiFetch<NewsCategoryView>(tenant, `/news/categories${newsLang(locale)}`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

/** Edits a category. It replaces the whole record, so every field is sent. */
export async function updateNewsCategory(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  input: UpdateNewsCategoryInput,
  signal?: AbortSignal,
): Promise<NewsCategoryView> {
  return apiFetch<NewsCategoryView>(tenant, `/news/categories/${encodeURIComponent(id)}${newsLang(locale)}`, {
    token,
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  });
}

/** Every publisher, switched-off ones included (`GET news/publishers`). */
export async function getNewsPublishers(
  tenant: string,
  token: string,
  locale: string,
  signal?: AbortSignal,
): Promise<NewsPublisherView[]> {
  return apiFetch<NewsPublisherView[]>(tenant, `/news/publishers${newsLang(locale)}`, { token, signal });
}

/** Adds a publisher: who an article is published as. */
export async function createNewsPublisher(
  tenant: string,
  token: string,
  locale: string,
  input: CreateNewsPublisherInput,
  signal?: AbortSignal,
): Promise<NewsPublisherView> {
  return apiFetch<NewsPublisherView>(tenant, `/news/publishers${newsLang(locale)}`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

/** Edits a publisher. It replaces the whole record, so every field is sent. */
export async function updateNewsPublisher(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  input: UpdateNewsPublisherInput,
  signal?: AbortSignal,
): Promise<NewsPublisherView> {
  return apiFetch<NewsPublisherView>(tenant, `/news/publishers/${encodeURIComponent(id)}${newsLang(locale)}`, {
    token,
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  });
}

// ─────────────────────────────  «الأخبار» on Day3ati: articles  ─────────────────────────────

const newsArticlePath = (id: string): string => `/news/articles/${encodeURIComponent(id)}`;

/**
 * One page of articles, newest edit first (`GET news/articles`). Day3ati pages
 * with a cursor: pass the last page's `nextCursor`; a page without one is the last.
 */
export async function getNewsArticles(
  tenant: string,
  token: string,
  locale: string,
  options: { status?: NewsArticleStatus; cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<NewsArticlePage> {
  const query = new URLSearchParams({ lang: locale === 'en' ? 'en' : 'ar' });
  if (options.status) query.set('status', options.status);
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.limit) query.set('limit', String(options.limit));
  return apiFetch<NewsArticlePage>(tenant, `/news/articles?${query.toString()}`, { token, signal });
}

/**
 * One article in full. `background` marks a read the screen makes by itself (the
 * poll that follows a photo being processed), so it does not count as the staff
 * member being at the system.
 */
export async function getNewsArticle(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  signal?: AbortSignal,
  options: { background?: boolean } = {},
): Promise<NewsArticleView> {
  return apiFetch<NewsArticleView>(tenant, `${newsArticlePath(id)}${newsLang(locale)}`, {
    token,
    signal,
    background: options.background,
  });
}

/** A new draft. */
export async function createNewsArticle(
  tenant: string,
  token: string,
  locale: string,
  input: SaveNewsArticleInput,
  signal?: AbortSignal,
): Promise<NewsArticleView> {
  return apiFetch<NewsArticleView>(tenant, `/news/articles${newsLang(locale)}`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

/** Saves an article. It replaces the content, so a language left out is removed. */
export async function updateNewsArticle(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  input: SaveNewsArticleInput,
  signal?: AbortSignal,
): Promise<NewsArticleView> {
  return apiFetch<NewsArticleView>(tenant, `${newsArticlePath(id)}${newsLang(locale)}`, {
    token,
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  });
}

/** Publishes now (`publishAt` null) or at a time. */
export async function publishNewsArticle(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  input: PublishNewsArticleInput,
  signal?: AbortSignal,
): Promise<NewsArticleView> {
  return apiFetch<NewsArticleView>(tenant, `${newsArticlePath(id)}/publish${newsLang(locale)}`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

/** Out of the feed; it can be published again. */
export async function archiveNewsArticle(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  signal?: AbortSignal,
): Promise<NewsArticleView> {
  return apiFetch<NewsArticleView>(tenant, `${newsArticlePath(id)}/archive${newsLang(locale)}`, {
    token,
    method: 'POST',
    signal,
  });
}

/** Cancels a schedule: the article goes back to a draft. */
export async function cancelNewsArticleSchedule(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  signal?: AbortSignal,
): Promise<NewsArticleView> {
  return apiFetch<NewsArticleView>(tenant, `${newsArticlePath(id)}/draft${newsLang(locale)}`, {
    token,
    method: 'POST',
    signal,
  });
}

/** Deletes an article for good. */
export async function deleteNewsArticle(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  await apiFetch<void>(tenant, `${newsArticlePath(id)}${newsLang(locale)}`, { token, method: 'DELETE', signal });
}

/** Pins an article on top of the feed, and/or features it in the carousel until a time. */
export async function setNewsArticlePlacement(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  input: NewsPlacementInput,
  signal?: AbortSignal,
): Promise<NewsArticleView> {
  return apiFetch<NewsArticleView>(tenant, `${newsArticlePath(id)}/placement${newsLang(locale)}`, {
    token,
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  });
}

// ─────────────────────────────  «الأخبار»: photos and PDFs of an article  ─────────────────────────────

/** The body of an upload that could not be read: the refusal a screen shows is the generic one. */
const UNREADABLE_REFUSAL = { code: 'UNKNOWN', message: 'تعذّر إتمام الطلب. حاول مرة أخرى.' } as const;

/**
 * Sends one photo or PDF of an article and reports how much of it has gone
 * (`onProgress`, 0 to 1). It is `XMLHttpRequest` and not `fetch` because `fetch`
 * cannot say how far an upload has got, and a ten-megabyte photo over a village
 * connection is a minute of nothing without it.
 *
 * It renews the session the way `apiFetch` does: a 401 that is not an answer
 * exchanges the token and sends the file once more with the new one. A form
 * can go twice. Photos are accepted at once and prepared in the background by
 * Day3ati: the answer says `processing`, and the article is read again until
 * the photo is `ready` or `failed`.
 *
 * `form` holds `file` and, optionally, `isCover`, `captionAr`, `captionEn`,
 * `captionFr` and `replacesMediaId` (the failed photo this one replaces).
 */
export function uploadNewsMedia(
  tenant: string,
  token: string,
  locale: string,
  articleId: string,
  form: FormData,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<NewsMediaView> {
  const url = `${API_URL}/t/${tenant}${newsArticlePath(articleId)}/media${newsLang(locale)}`;

  const attempt = (bearer: string, exchangesLeft: number): Promise<NewsMediaView> =>
    new Promise<NewsMediaView>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', url);
      request.setRequestHeader('Authorization', `Bearer ${bearer}`);
      request.responseType = 'text';

      request.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) options.onProgress?.(event.loaded / event.total);
      };
      request.onerror = () =>
        reject(new ApiRequestError(0, { code: 'NETWORK_ERROR', message: 'تعذّر الاتصال. تحقّق من الشبكة وحاول مرة أخرى.' }));
      request.onabort = () => reject(new DOMException('The upload was cancelled', 'AbortError'));
      request.onload = () => {
        let body: unknown;
        try {
          body = JSON.parse(request.responseText);
        } catch {
          body = undefined;
        }

        if (request.status >= 200 && request.status < 300) {
          resolve(body as NewsMediaView);
          return;
        }

        const refusal = (body as ApiError | undefined) ?? UNREADABLE_REFUSAL;
        if (request.status === 401 && exchangesLeft > 0 && !(refusal.code && ANSWERED_401.has(refusal.code))) {
          exchangeStaffToken(tenant, bearer).then(
            (fresh) =>
              fresh && fresh.token !== bearer
                ? resolve(attempt(fresh.token, 0))
                : reject(new ApiRequestError(request.status, refusal)),
            reject,
          );
          return;
        }
        reject(new ApiRequestError(request.status, refusal));
      };

      options.signal?.addEventListener('abort', () => request.abort(), { once: true });
      request.send(form);
    });

  return attempt(token, 1);
}

/** Makes a ready photo the cover of its article. */
export async function setNewsMediaCover(
  tenant: string,
  token: string,
  locale: string,
  articleId: string,
  mediaId: string,
  signal?: AbortSignal,
): Promise<NewsMediaView> {
  return apiFetch<NewsMediaView>(
    tenant,
    `${newsArticlePath(articleId)}/media/${encodeURIComponent(mediaId)}/cover${newsLang(locale)}`,
    { token, method: 'PUT', signal },
  );
}

/** Removes a photo or PDF from its article. */
export async function deleteNewsMedia(
  tenant: string,
  token: string,
  locale: string,
  articleId: string,
  mediaId: string,
  signal?: AbortSignal,
): Promise<void> {
  await apiFetch<void>(
    tenant,
    `${newsArticlePath(articleId)}/media/${encodeURIComponent(mediaId)}${newsLang(locale)}`,
    { token, method: 'DELETE', signal },
  );
}

/**
 * Whether News is on for this municipality (`GET news/availability`): its Day3ati
 * village lists the news module. `NEWS_EDITOR_ROLES` only. What hides the News
 * screens from a municipality that has not got it.
 */
export async function getNewsAvailability(tenant: string, token: string, signal?: AbortSignal): Promise<NewsAvailability> {
  return apiFetch<NewsAvailability>(tenant, '/news/availability', { token, signal });
}

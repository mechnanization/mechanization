import {
  cachedRequest,
} from './request-cache';
import {
  ApiRequestError,
  apiFetch,
  timeoutSignal,
  withRefreshLock,
  type Session,
} from './api/core';

export {
  caseResidents,
  getCases,
  getCase,
  createCase,
  updateCase,
  deleteCase,
} from './api/cases';
export * from './api/cases';

export {
  getStaffPresence,
  getStaff,
  createStaff,
  updateStaff,
  setStaffActive,
  deleteStaff,
  getDeletedStaff,
  restoreStaff,
  getMyInspectorProfile,
  getInspectorProfile,
  recordInspectorPayout,
  getAuditFacets,
  getRecordHistory,
  getAuditLog,
  getAuditDaily,
  getCadastreAsset,
  importCadastre,
  exportSnapshot,
  restoreSnapshot,
  getStaffSelf,
  changeStaffPassword,
  changeStaffEmail,
  sendStaffPasswordResetEmail,
  confirmStaffPasswordReset,
  beginStaffTotpEnrolment,
  confirmStaffTotpEnrolment,
  disableStaffTotp,
} from './api/staff';
export * from './api/staff';

export {
  getTreasuryOverview,
  getTreasuryStatement,
  createTreasuryAccount,
  activateTreasury,
  getCollectorCustody,
  getCollectorCollections,
  getMyRound,
  getTransfers,
  getTransfer,
  createTransfer,
  reviewTransfer,
  receiveCollectorCustody,
  voidTransfer,
  getExpenseCategories,
  createExpenseCategory,
  updateExpenseCategory,
  getExpenses,
  getExpense,
  recordExpense,
  recordStaffSalary,
  voidExpense,
  requestExpense,
  getExpenseRequests,
  orderExpenseRequest,
  rejectExpenseRequest,
  withdrawExpenseRequest,
  regularizeExpense,
  getIncomeCategories,
  createIncomeCategory,
  updateIncomeCategory,
  getTreasuryMovements,
  getIncomeVoucher,
  recordIncomeVoucher,
  voidIncomeVoucher,
  getDailyCountSheet,
  recordDailyCount,
  closeTreasuryDay,
  reopenTreasuryDay,
  getTreasuryClosures,
  getDailyCashReport,
} from './api/treasury';
export * from './api/treasury';

export {
  getNewsCategories,
  createNewsCategory,
  updateNewsCategory,
  getNewsPublishers,
  createNewsPublisher,
  updateNewsPublisher,
  getNewsArticles,
  getNewsArticle,
  createNewsArticle,
  updateNewsArticle,
  publishNewsArticle,
  archiveNewsArticle,
  cancelNewsArticleSchedule,
  deleteNewsArticle,
  setNewsArticlePlacement,
  uploadNewsMedia,
  setNewsMediaCover,
  deleteNewsMedia,
  getNewsAvailability,
} from './api/news';
export * from './api/news';

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


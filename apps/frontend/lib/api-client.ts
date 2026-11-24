import {
  IMPORT_BATCH_SIZE,
  type HouseGrowth,
  type OwnerBillingFallback,
  type ReinspectionsPage,
  type StaffPresenceResponse,
  type StaffSelf,
  type CitizenImportResult,
  type CitizenMergePreview,
  type CitizenMergeRecord,
  type CitizenMergeResult,
  type CitizenUnmergePreview,
  type CaseStatus,
  type CaseType,
  type CitizenRecordStatus,
  type CitizenResidence,
  type DamageLevel,
  type DamageSource,
  type DuplicateMatchedOn,
  type FeeAssessment,
  type BuildingTypeView,
  type UnitTypeView,
  type CreateUnitTypeInput,
  type UpdateUnitTypeInput,
  type CreateBuildingTypeInput,
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
  type FeeExemptionCitizenUnits,
  type FeeExemptionListQuery,
  type FeeExemptionListResult,
  type FeeExemptionReason,
  type FeeExemptionUnitView,
  type FieldFlag,
  type SharedUnitBillView,
  type ImportRow,
  type InspectorProfileResponse,
  type OccupancyEndReason,
  type OccupancyRole,
  type OwnerBillingMode,
  type OwnerBillingState,
  type PossibleDuplicateMatch,
  type PossibleDuplicatesQuery,
  type RecordInspectorPayoutInput,
  type RecordInspectorPayoutResult,
  type RequestStatus,
  type RequestType,
  type SetOwnerBillingInput,
  type SetUnitFeeExemptionInput,
  type UpdateBuildingTypeInput,
  type BuildingLifecycle,
  type StructureType,
  type SurveyStatus,
  type UnitStatus,
  type UnitType,
  type VacancyBasis,
  type VacancyEndReason,
  type BillArrearsView,
  type BillWriteOffView,
} from '@mechanization/shared-schemas';
import {
  cachedRequest,
  invalidateRequests,
  peekCachedRequest,
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
  type DuplicateBuildingCandidate,
  type Session,
} from './api/core';

export * from './api/fees';

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

// ───────────────────────────  Zones (القطاعات)  ───────────────────────────

/** A sector as the list and legend show it — membership summarised to a count. */
export interface ZoneSummary {
  id: string;
  name: string;
  code: string;
  color: string;
  description: string | null;
  parcelCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A sector opened for editing, carrying the parcel numbers it owns. */
export interface ZoneDetail extends ZoneSummary {
  parcelNumbers: string[];
}

export interface ZoneWriteInput {
  name: string;
  code: string;
  color: string;
  description?: string;
  parcelNumbers: string[];
}

/** Every sector with its parcel count, for the list and the map legend. */
export function getZones(tenant: string, token: string) {
  return cachedRequest(`zones:${tenant}`, 60 * 1000, () =>
    apiFetch<{ zones: ZoneSummary[] }>(tenant, '/zones', { token }),
  );
}

/** One sector including the parcel numbers it owns, for the editor. */
export function getZone(tenant: string, token: string, id: string) {
  return apiFetch<ZoneDetail>(tenant, `/zones/${encodeURIComponent(id)}`, { token });
}

/** SUPER_ADMIN only, server-enforced. */
export async function createZone(tenant: string, token: string, input: ZoneWriteInput) {
  const result = await apiFetch<ZoneDetail>(tenant, '/zones', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  invalidateRequests(`zones:${tenant}`);
  return result;
}

/** SUPER_ADMIN only. Omitted fields are left as they are. */
export async function updateZone(
  tenant: string,
  token: string,
  id: string,
  input: Partial<ZoneWriteInput>,
) {
  const result = await apiFetch<ZoneDetail>(tenant, `/zones/${encodeURIComponent(id)}`, {
    token,
    method: 'PUT',
    body: JSON.stringify(input),
  });
  invalidateRequests(`zones:${tenant}`);
  return result;
}

/** SUPER_ADMIN only. Releases the sector's parcels rather than altering them. */
export async function deleteZone(tenant: string, token: string, id: string) {
  const result = await apiFetch<{ deleted: boolean }>(tenant, `/zones/${encodeURIComponent(id)}`, {
    token,
    method: 'DELETE',
  });
  invalidateRequests(`zones:${tenant}`);
  return result;
}

/**
 * The zone overlay both maps draw, as dissolved polygons.
 *
 * Served from the API rather than as a static file like the cadastre layers,
 * because zone membership changes whenever an admin saves the editor.
 */
export function getZonesGeoJson(tenant: string, token: string) {
  return apiFetch<GeoJSON.FeatureCollection>(tenant, '/zones/geojson', { token });
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

// ─────────────────────────  Buildings (سجل المباني)  ─────────────────────────

/**
 * The census, as the browser sees it.
 *
 * Every shape here is the server's own row with its `Date`s read back as the
 * ISO strings JSON actually carries — `createdAt` is typed `string` rather than
 * `Date` because that is what arrives, and typing it otherwise would have
 * `formatDate` handed something that only looks like a date until it is used.
 *
 * The rule that governs all of them: **the id is the identity and the code is
 * derived** (D9). Nothing here ever sends a `code`, a `unitCode` or a
 * `codeSuffix` — the server allocates them, and a client that could assert one
 * could assert one that contradicts the parcel it names.
 */
export interface BuildingSummary {
  id: string;
  parcelNumber: string;
  codeSuffix: string;
  /** `ZONE-PARCEL-SUFFIX` — `A-1042-B`. Display only; recomputed server-side. */
  code: string;
  name: string | null;
  /** What is painted on the building. Trusted over `code` in the field (D14). */
  postedNumber: string | null;
  /**
   * «هل الوحدة مفروزة على عقار» — whether the structure is legally partitioned.
   *
   * Three states: `true` مفروزة, `false` غير مفروزة, `null` nobody asked.
   * Optional on the wire as well, so a response cached from a build before the
   * column existed reads as «لم يُسأل» rather than leaking `undefined` into a
   * control that would render it as a definite «لا».
   */
  isPartitioned?: boolean | null;
  /**
   * أرقام الأقسام the فرز produced, each with its own صحيفة عقارية.
   *
   * Empty unless `isPartitioned` is true — the server keeps the two in step,
   * because أقسام under a structure with no recorded فرز is a contradiction a
   * deed search would later read as fact.
   */
  partitionNumbers?: string[];
  /**
   * The *other* عقارات this structure stands on, beside `parcelNumber`.
   *
   * Optional for the same reason, and empty for the overwhelming majority of
   * buildings, which stand on exactly one parcel.
   */
  sharedParcelNumbers?: string[];
  structureType: StructureType;
  /**
   * «نوع المبنى» (0106): the municipality's type it was filed as; `structureType`
   * is set from it. Optional on the wire for an answer from before it.
   */
  buildingTypeId?: string | null;
  /**
   * Where the structure is in its own life — permitted, going up, standing,
   * abandoned, gone. The third axis beside *what it is* (`structureType`) and
   * *what happened to it* (its damage level).
   */
  lifecycleStatus: BuildingLifecycle;
  latitude: number | null;
  longitude: number | null;
  floorsCount: number;
  /**
   * How far the structure goes down, as a depth: 2 means B1 and B2.
   *
   * Optional on the wire so a response cached from a build before the column
   * existed reads as "no basement" rather than `undefined` leaking into a
   * floor count.
   */
  basementsCount?: number;
  /** Maintained by a database trigger — never written from the client. */
  unitsTotal: number;
  unitsSurveyed: number;
  notes: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A census ledger row — the building plus the two derived columns it shows. */
export interface BuildingLedgerRow extends BuildingSummary {
  zoneCode: string | null;
  zoneName: string | null;
  /** The *current* level, i.e. the newest assessment. Null = never assessed. */
  damageLevel: DamageLevel | null;
  /** With a search: the retired code the term matched — «كان Z-1-45-A». */
  matchedPreviousCode?: string;
}

/** One occupant of a unit. A `toDate` of null means they are there now (D2). */
export interface UnitOccupant {
  id: string;
  unitId: string;
  citizenId: string;
  citizenName: string | null;
  /** Their phone, shown on the unit. Optional for a server from before it. */
  citizenPhone?: string | null;
  /**
   * Whether their file is open. An archived owner is never billed, so co-owner
   * billing leaves them out of the division. Optional on the wire: absent reads
   * as open.
   */
  citizenActive?: boolean;
  role: OccupancyRole;
  /** أسهم out of 2400 — owners only. */
  shares: number | null;
  fromDate: string;
  toDate: string | null;
  /**
   * Why the spell ended, when an officer said so. `RECORDED_IN_ERROR` spells
   * are kept on the record and left out of the unit's visible history.
   * Optional on the wire for responses from before the field existed.
   */
  endReason?: OccupancyEndReason | null;
  registrationId: string | null;
  /**
   * Whether the citizen's own file claims this flat.
   *
   * `false` means the census records them here but their registration does
   * not name the property — the half-finished state «ربط شخص بالوحدة» can produce,
   * which is legitimate at the doorstep and needs finishing afterwards.
   * Billing reads the file, not this row, so an unbacked occupancy is a flat
   * nobody is charged for.
   *
   * Optional on the wire so a cached response from a build before the field
   * existed reads as "backed" rather than lighting up every occupant in the
   * matrix with a warning.
   */
  backedByFile?: boolean;
  /**
   * When the spell was entered in the register (not `fromDate`, which may be
   * back-dated). A tenant may be linked by picking only to an owner recorded
   * before them. Optional on the wire for responses from before it existed.
   */
  recordedAt?: string;
  /** Who a current tenant holds the flat from, per their own card. Null otherwise. */
  ownerLink?: OccupantOwnerLink | null;
}

/**
 * The tenancy card behind a current tenant's spell, and whether it names an
 * owner of this flat — see `OccupancyOwnerLink` on the server.
 */
export interface OccupantOwnerLink {
  state: 'LINKED' | 'LINKED_ELSEWHERE' | 'UNLINKED' | 'NO_CARD';
  propertyEntryId: string | null;
  ownerId: string | null;
  ownerName: string | null;
  typedName: string | null;
}

/** One canonical unit. It exists whether or not anybody has been surveyed in it. */
export interface UnitRow {
  id: string;
  buildingId: string;
  /** Signed: basement negative, ground 0. `unitCode` is derived from it (D8). */
  floor: number;
  sequence: number;
  /** 1-based inclusive column span this unit was painted on, or both null if
   *  it was never painted on a grid (the blueprint generator, a hand-added
   *  single unit) — see `unit-grid-picker.tsx`'s `GridUnitDraft`. */
  startCol: number | null;
  endCol: number | null;
  unitCode: string;
  postedNumber: string | null;
  unitType: UnitType;
  /**
   * «نوع الوحدة» (0109): the type it was filed as; `unitType` is that type's
   * base. Null on a floor block, and absent on a response from before 0109.
   */
  unitTypeId?: string | null;
  side: string | null;
  unitArea: number | null;
  unitStatus: UnitStatus | null;
  surveyStatus: SurveyStatus;
  /**
   * «مسكن موسمي» — the months (1–12) its owners are usually present, when they
   * last stayed, and when a تصريح بالشغور was filed. Recorded for the council's
   * billing decision; nothing bills from them. Optional on the wire for
   * responses from before migration 0040.
   */
  presenceMonths?: number[];
  ownerLastStayAt?: string | null;
  vacancyDeclaredAt?: string | null;
  /**
   * «توزيع الرسم على المالكين» (migration 0075): how a flat with several
   * owners is billed. Null means nobody chose — split equally. Optional on the
   * wire for responses from before it existed. Each owner's part is computed
   * with the shared `ownerSharesPreview`, the rule billing applies.
   */
  ownerBillingMode?: OwnerBillingMode | null;
  responsibleOwnerId?: string | null;
  /**
   * «معفاة من الرسوم» (0077): why the unit is charged nothing, the reason in
   * words, when and who granted it. Optional on the wire for older responses.
   */
  feeExemption?: FeeExemptionReason | null;
  feeExemptionNote?: string | null;
  feeExemptedAt?: string | null;
  feeExemptedByName?: string | null;
  /**
   * The exemption's last day, `YYYY-MM-DD`, or null for none (0104). Past it the
   * unit is billed again although `feeExemption` is still set (`isFeeExemptOn`).
   */
  feeExemptionValidUntil?: string | null;
  /**
   * How many levels this one home spans upward from `floor` (0095, D28): 2 is
   * a «دوبلكس». Optional on the wire for older responses, where it is 1.
   */
  levels?: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One «تأكيد الشغور» — that a unit was found empty, on what basis, and by whom.
 *
 * `endedAt` null is the one standing: it is why the unit reads «شاغرة» and why
 * its owner is exempt from the occupancy fee. The rest are closed history, kept
 * rather than deleted — a vacancy withdrawn still records what the municipality
 * believed and for how long.
 *
 * `previousUnitStatus` / `previousSurveyStatus` are what the flat said before,
 * carried so the undo can state what it will restore *before* it is pressed.
 * Both null on a row migration 0043 backfilled, where nobody recorded either.
 */
export interface UnitVacancyConfirmation {
  id: string;
  unitId: string;
  /** Null only on a backfilled row — the question did not exist then. */
  basis: VacancyBasis | null;
  observedAt: string;
  notes: string | null;
  confirmedById: string | null;
  confirmedByName: string | null;
  previousUnitStatus: UnitStatus | null;
  previousSurveyStatus: SurveyStatus | null;
  endedAt: string | null;
  endReason: VacancyEndReason | null;
  endNotes: string | null;
  endedById: string | null;
  endedByName: string | null;
  createdAt: string;
}

/** A unit as the matrix draws it — with whoever is, and was, inside it. */
export interface UnitWithOccupants extends UnitRow {
  occupants: UnitOccupant[];
  /** The most recent attempts, newest first. Capped server-side at ten. */
  visits: UnitVisitRow[];
  /** Every attempt ever made, uncapped — this is «٣ محاولات» on the cell. */
  visitCount: number;
  /**
   * حالة الوحدة as the owner's own card states it, sent only when `unitStatus`
   * is unset. The unit's value wins where it has one — the order billing reads
   * them in — so the matrix shows `unitStatus ?? ownerDeclaredStatus`.
   */
  ownerDeclaredStatus?: UnitStatus | null;
  /**
   * «تأكيد الشغور» on this unit, newest first and capped server-side at five.
   *
   * Optional on the wire so a cached response from a build before migration
   * 0043 reads as "none" rather than throwing — a unit with no confirmations is
   * the ordinary case anyway.
   */
  vacancies?: UnitVacancyConfirmation[];
}

/** One building opened in the matrix drawer. */
export interface BuildingDetail extends BuildingSummary {
  /** Resolved from `Zone.parcelNumbers` at read time — never stored (D13). */
  zoneCode: string | null;
  zoneName: string | null;
  /**
   * Codes this building carried before «تصحيح رقم العقار», newest first —
   * still found by search, never given to another building. Absent from a
   * server older than the correction.
   */
  previousCodes?: Array<{ code: string; parcelNumber: string; reason: string; retiredAt: string }>;
  units: UnitWithOccupants[];
}

/** One observation of a structure's condition. Append-only (D3). */
export interface DamageAssessmentRow {
  id: string;
  buildingId: string | null;
  unitId: string | null;
  level: DamageLevel;
  source: DamageSource;
  observations: string | null;
  /** When the visit happened, not when it was typed up — see the schema. */
  assessedAt: string;
  /**
   * «صالحة للسكن؟» — the second axis beside the level (0071): true / false as
   * answered, null on a reading from before the question. Optional for an
   * older server. Read it with `isUninhabitableReading`.
   */
  habitable?: boolean | null;
  /** «موعد إعادة الكشف» — only on a «غير صالحة للسكن» reading. Optional for an older server. */
  reinspectAt?: string | null;
  assessedById: string | null;
  assessedByName: string | null;
  createdAt: string;
}

/**
 * The census totals for whatever the filters currently select — computed by the
 * server over the whole filtered set, not over the page on screen.
 */
export interface CensusSummary {
  /** Every building the filters select, whatever its lifecycle state. */
  buildings: number;
  /**
   * Units in structures that can hold households only — a shell under
   * construction has matrix rows and no doors to knock on.
   */
  unitsTotal: number;
  unitsSurveyed: number;
  unitsUnsurveyed: number;
  /** Units the lifecycle exclusion removed from the three figures above. */
  unitsOutOfScope: number;
  /** Restricted-use, unsafe-evacuate or total-collapse, at the current level. */
  damaged: number;
  /**
   * Structures with no entrance pin — a queue of doors, not an error.
   *
   * A building may be created from a desk, and one created from the
   * registration form always is: no entrance is guessed for it (D19), because
   * the parcel centroid is the middle of a plot where no building stands and is
   * the same point for every structure on it.
   */
  withoutEntrance: number;
}

/**
 * What saving a citizen changed in the building census.
 *
 * Returned by both write paths so the form can say what it linked — an officer
 * who registered a household into a flat has no other way to tell the census
 * heard about it, and "did that work?" is what sends somebody to enter a record
 * a second time.
 *
 * `null` on the citizen response means the census write failed. The citizen is
 * saved either way; the link can be made from the ledger.
 */
export interface CensusSyncResult {
  occupanciesCreated: number;
  occupanciesRefreshed: number;
  /** Spells this registration used to claim and no longer does. */
  occupanciesEnded: number;
  /** Units lifted out of «غير ممسوحة» / «زيارة بلا رد» / «بيانات ناقصة». */
  unitsSurveyed: number;
  casesResolved: number;
  /**
   * Units whose confirmed vacancy this registration lifted, because it recorded
   * a household in a flat the municipality had called empty. Optional on the
   * wire for responses from before migration 0043.
   */
  vacanciesEnded?: number;
  /** Structures that had no name until this card supplied one. */
  buildingsNamed: number;
}

/** Every filter the ledger composes. All optional; any subset is valid. */
export interface BuildingListFilter {
  parcelNumber?: string;
  zoneId?: string;
  structureType?: StructureType;
  /** «نوع المبنى» (0106). */
  buildingTypeId?: string;
  lifecycleStatus?: BuildingLifecycle;
  surveyStatus?: SurveyStatus;
  damageLevel?: DamageLevel;
  /** Matches code, name, posted number or parcel number. */
  search?: string;
  /** `false` selects the structures with no entrance recorded. */
  hasEntrance?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateBuildingInput {
  parcelNumber: string;
  name?: string;
  postedNumber?: string;
  /**
   * «هل الوحدة مفروزة على عقار» — omitted entirely when nobody established it.
   *
   * Absent and `null` are the same answer on a creation, so the wizard sends
   * the key only when the officer actually answered. The column is nullable and
   * the absence is the third state — see the schema.
   */
  isPartitioned?: boolean;
  /**
   * أرقام الأقسام, sent only alongside `isPartitioned: true`.
   *
   * The server drops them otherwise rather than refusing the request — a form
   * whose checkbox was ticked, filled in and then cleared is a correction, and
   * failing the save over the rows somebody abandoned would punish them for
   * changing their mind.
   */
  partitionNumbers?: string[];
  /**
   * The *other* عقارات this structure stands on.
   *
   * `parcelNumber` above names one and cannot name more: the code and the
   * per-parcel suffix derive from it (D9). The server drops the building's own
   * parcel from this list if it appears, so a structure can never be recorded
   * as straddling itself.
   */
  sharedParcelNumbers?: string[];
  /** Sent beside the type for an older server and the offline queue; the server takes the type's. */
  structureType: StructureType;
  /** «نوع المبنى» (0106): an inactive type is refused on a new building. */
  buildingTypeId?: string;
  /** Defaults to `IN_USE` server-side — what an officer is looking at most days. */
  lifecycleStatus?: BuildingLifecycle;
  latitude?: number;
  longitude?: number;
  floorsCount?: number;
  /** Levels below ground, as a depth: 2 means B1 and B2. Omitted means none. */
  basementsCount?: number;
  notes?: string;
  /**
   * The suffix a phone showed while offline. Never trusted — the server
   * re-allocates under a lock (§4.4) and the response says whether the code the
   * officer has been quoting changed.
   */
  provisionalSuffix?: string;
  /** The browser's own id for this creation, which is also the row's id. */
  clientSubmissionId?: string;
  /**
   * «نعم، هذه منشأة مختلفة» — the officer has seen what already stands on this
   * parcel and is asserting this is not one of them.
   *
   * The server refuses a second structure on an occupied parcel without it, and
   * answers the refusal with the candidates (`duplicateBuildingsOf`). Never set
   * by default: the answer is always allowed to be yes, but it has to be given.
   */
  acknowledgedDuplicates?: boolean;
  /**
   * The officer's sentence behind `acknowledgedDuplicates` — what makes this a
   * separate structure. Written into the creation's audit row beside the
   * neighbours and their distances. The editor requires it; the server accepts
   * its absence so that creations already queued on phones still land.
   */
  duplicateReason?: string;
  /** Why the building is created with no entrance pin. See the schema. */
  noPinReason?: string;
  /**
   * The matrix, created in the same transaction as the shell.
   *
   * For the registration form, which creates a structure the officer is
   * standing in front of and must attach a household to it in the same save. A
   * shell alone would be worse than nothing there: the census claims a flat
   * only where the card line carries a `unitId`, so a building with no units
   * links the card and records no occupancy at all.
   *
   * Each unit may carry the id the browser minted, for the same reason the
   * building does — a phone with no signal has to put a `unitId` on a card
   * before the row exists. `sequence` is omitted and allocated server-side.
   */
  units?: Array<{
    id?: string;
    floor: number;
    sequence?: number;
    startCol?: number;
    endCol?: number;
    unitType: UnitType;
    postedNumber?: string;
    side?: string;
    unitArea?: number;
    unitStatus?: UnitStatus;
    surveyStatus?: SurveyStatus;
    notes?: string;
  }>;
}

export type UpdateBuildingInput = Partial<{
  /** The building's `updatedAt` as the editor loaded it — see the schema. */
  expectedUpdatedAt: string;
  name: string | null;
  postedNumber: string | null;
  /**
   * «هل الوحدة مفروزة على عقار» — nullable here, unlike on a creation.
   *
   * An absent key leaves the column as it is; `null` unsets it back to
   * «غير محدد». Both are needed: an officer has to be able to withdraw a فرز
   * they ticked by mistake, and an edit that could only ever set it would make
   * the answer one-way.
   */
  isPartitioned: boolean | null;
  /**
   * Replaces the stored أقسام wholesale, and is cleared outright whenever the
   * فرز flag is not `true` — sending either field makes the server re-resolve
   * both, so a PATCH that unsets the flag cannot leave the numbers behind.
   */
  partitionNumbers: string[];
  /** Replaces the stored list wholesale — an empty array clears it. */
  sharedParcelNumbers: string[];
  structureType: StructureType;
  /** «نوع المبنى» (0106): decides `structureType`; an inactive one is kept only if the building has it. */
  buildingTypeId: string;
  lifecycleStatus: BuildingLifecycle;
  latitude: number | null;
  longitude: number | null;
  floorsCount: number;
  basementsCount: number;
  notes: string | null;
}>;

/**
 * How to fill a matrix. Two shapes, because officers arrive with two different
 * amounts of knowledge — "six floors, four flats each" from the pavement, or a
 * row per floor from someone who has walked the stairwell.
 */
export type UnitBlueprintInput = (
  | {
      kind: 'uniform';
      fromFloor: number;
      toFloor: number;
      unitsPerFloor: number;
      unitType: UnitType;
    }
  | {
      kind: 'explicit';
      floors: Array<{ floor: number; unitCount: number; unitType: UnitType }>;
    }
) & {
  /** See `UpsertUnitInput.houseGrowth`; a blueprint takes only `SEPARATE_UNIT`. */
  houseGrowth?: HouseGrowth;
};

export interface UpsertUnitInput {
  floor: number;
  /** Omitted on create: the server takes the next free spot on the floor. */
  sequence?: number;
  startCol?: number;
  endCol?: number;
  unitType: UnitType;
  postedNumber?: string;
  side?: string;
  unitArea?: number;
  unitStatus?: UnitStatus;
  surveyStatus?: SurveyStatus;
  notes?: string;
  /**
   * «نعم، هذه وحدة مختلفة» — the officer has seen what is already on this
   * floor and is asserting the unit they are adding is not one of them. The
   * server refuses a same-type addition without it; see `upsertUnitSchema`.
   */
  acknowledgedDuplicates?: boolean;
  /**
   * The answer to «هذا المنزل يصبح مبنى» (D28): another level of the same home,
   * or a separate unit. Sent only after the server asked (`houseGrowthQuestionOf`).
   */
  houseGrowth?: HouseGrowth;
}

export interface RecordOccupancyInput {
  unitId: string;
  citizenId: string;
  role: OccupancyRole;
  /** Owners only — the server refuses shares on a tenant. */
  shares?: number;
  /**
   * حالة الوحدة — owners only, for the same reason shares are.
   *
   * A tenant or a شاغل بتسامح *is* the occupant of what is being recorded,
   * so their capacity settles the unit’s state and the server derives it. An
   * owner’s does not: they may live there, let it, lend it, or hold it empty,
   * and those are four different bills.
   */
  unitStatus?: UnitStatus;
  /**
   * «نعم، الوحدة لم تعد شاغرة».
   *
   * Recording somebody in a unit whose vacancy is standing is refused without
   * this — the server answers with the confirmation itself so the officer can
   * see when the flat was called empty and on what basis before overriding it.
   * With it, the vacancy is lifted as «لم تعد شاغرة» in the same request.
   *
   * Not needed to record an owner, who contradicts nothing by holding a deed.
   */
  endsVacancy?: boolean;
  /**
   * مساحة الوحدة — offered only where the census has none.
   *
   * The area belongs to the unit, not to the spell, and the server writes it
   * onto the `Unit` and only where that column is still null: a measured flat
   * is never overwritten by a side effect of recording who lives in it. It is
   * accepted *here* because this is the first moment anyone has been inside —
   * the matrix is painted from the street, so `generateUnits` and the grid both
   * create flats with no area at all, and the card `claimOnFile` then mints for
   * the citizen inherited that absence.
   */
  unitArea?: number;
  /** Why no area is being given for a unit the census has none for. See the schema. */
  unitAreaMissingReason?: string;
  /** Owners: why «ومن يشغلها؟» is left unanswered. See the schema. */
  unitStatusMissingReason?: string;
  fromDate?: string;
  toDate?: string;
  /**
   * «المالك» — non-owners only. One of the owners already recorded on this
   * unit, linked in the same request; among co-owners, the one the tenant deals
   * with. The server refuses an owner recorded after the tenant.
   */
  landlordCitizenId?: string;
  /** The owner as the tenant names them, when not recorded on the unit. */
  landlordName?: string;
  landlordPhone?: string;
}

/** What linking the picked owner did — see `LandlordLinkService.linkRecordedOwner`. */
export interface RecordedOwnerLink {
  linked: boolean;
  alreadyLinked: boolean;
  /** The flat moved onto a tenancy card of its own to carry this owner. */
  split: boolean;
  propertyEntryId: string | null;
  reason: 'TENANT_NO_FILE' | 'UNLINKABLE_STRUCTURE' | null;
}

/**
 * What recording the occupant did to that citizen’s own file.
 *
 * The server now links the two halves by default, so `backed` is true for
 * every citizen who has a file at all. `outcome` is what the officer is told
 * when it is not — and `'NO_FILE'` is the only ordinary way that happens.
 */
export interface OccupancyFileLink {
  backed: boolean;
  outcome:
    | 'ENTRY_CREATED'
    | 'UNIT_ADDED'
    | 'ALREADY_CLAIMED'
    | 'NO_FILE'
    | 'UNLINKABLE_STRUCTURE'
    | 'NO_BUILDING';
}

export interface RecordDamageInput {
  /** Exactly one of these two. Both, or neither, is refused server-side. */
  buildingId?: string;
  unitId?: string;
  level: DamageLevel;
  source?: DamageSource;
  observations?: string;
  assessedAt?: string;
  /** «صالحة للسكن؟» — see `habitabilityFor` for what the level decides and what it leaves to the inspector. */
  habitable?: boolean;
  /** «موعد إعادة الكشف», "YYYY-MM-DD" — only on a «غير صالحة للسكن» reading; refused otherwise. */
  reinspectAt?: string;
}

/**
 * What «سجل المباني»'s selects may offer — every list is the set of values the
 * census actually holds, so choosing one can never return an empty table for
 * the reason that nothing was ever filed under it.
 */
export interface BuildingFilterOptions {
  structureTypes: StructureType[];
  /** The types buildings are filed under (0106). Optional on the wire for an answer from before it. */
  buildingTypeIds?: string[];
  lifecycleStatuses: BuildingLifecycle[];
  surveyStatuses: SurveyStatus[];
  damageLevels: DamageLevel[];
}

/**
 * Every building matching the filters, with the totals for that same set.
 *
 * Not cached: this is what an officer reloads after creating a building from
 * the map, and a stale ledger is how the same structure gets entered twice.
 */
export function getBuildings(
  tenant: string,
  token: string,
  filter: BuildingListFilter = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const qs = query.toString();
  return apiFetch<{
    buildings: BuildingLedgerRow[];
    total: number;
    summary: CensusSummary;
    /**
     * With a `parcelNumber` filter: suffixes «تصحيح رقم العقار» retired on
     * that parcel, which a new building there never gets.
     */
    retiredSuffixes?: string[];
  }>(tenant, `/buildings${qs ? `?${qs}` : ''}`, { token, signal });
}

/**
 * The values «سجل المباني»'s filters may offer, as found in the census.
 *
 * A *reference* read, not a data read: it describes the municipality's
 * vocabulary — which kinds of structure it has entered, which conditions it
 * has assessed — rather than the rows on screen. It changes when somebody
 * records the first building of a kind, which is a handful of times in a
 * register's life, so the caller reads it once per session (see
 * `useStaffQuery`'s `reference` option) instead of on every visit to the page.
 */
export function getBuildingFilterOptions(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<BuildingFilterOptions>(tenant, '/buildings/filter-options', { token, signal });
}

/** One building with its whole unit matrix and each unit's occupants. */
export function getBuilding(tenant: string, token: string, id: string, signal?: AbortSignal) {
  return apiFetch<BuildingDetail>(tenant, `/buildings/${encodeURIComponent(id)}`, {
    token,
    signal,
  });
}

/*
  ── The census as a *form control* reads it ──────────────────────────

  The two readers below answer the same questions as `getBuildings` and
  `getBuilding` above, and differ only in that they remember the answer.

  The ledger screen must not: an officer reloads it precisely to see what a
  colleague just entered, and a stale ledger is how one structure gets created
  twice. `BuildingUnitPicker` is the opposite case. It asks the same two
  questions — "what stands on عقار 403" and "what flats are in this one" —
  every time it mounts, and it mounts far more often than anything changes:
  each card of a multi-property household, each fold and unfold, each open of
  the edit form on a record whose parcel was read a minute ago. Every one of
  those re-asks was a spinner over an answer the tab already had.

  Memory-only and dropped by any census write (see `invalidateCensus`), so the
  window in which this can be wrong is one officer's own tab, between their own
  changes — and a hard reload still goes to the network, which is what makes
  reloading the honest way to demand fresh data.
*/
const CENSUS_TTL_MS = 5 * 60 * 1000;

const parcelKey = (tenant: string, parcelNumber: string) =>
  `census:${tenant}:parcel:${parcelNumber}`;
const buildingKey = (tenant: string, id: string) => `census:${tenant}:building:${id}`;

/**
 * Dropped wholesale rather than surgically.
 *
 * A unit added to one building changes that building's matrix, the parcel
 * listing that counts its units, and — once occupancy is recorded — the
 * occupants on a unit two screens away. Working out which keys a given write
 * touched is a rule that has to be re-derived every time an endpoint grows a
 * field, and the failure mode of getting it wrong is a form showing an officer
 * their own edit as though it had not saved. The prefix is per-tenant, the map
 * holds a handful of entries, and re-reading is one request.
 */
function invalidateCensus(tenant: string): void {
  invalidateRequests(`census:${tenant}:`);
}

/**
 * Structures standing on one عقار, remembered for the life of the tab.
 *
 * «Standing on» includes a building filed under another parcel that lists this
 * one among its `sharedParcelNumbers` — the server matches both. A caller that
 * needs only the buildings *filed* here (the code-suffix preview) filters on
 * `row.parcelNumber` itself.
 */
export function getParcelBuildings(tenant: string, token: string, parcelNumber: string) {
  return cachedRequest(parcelKey(tenant, parcelNumber), CENSUS_TTL_MS, () =>
    getBuildings(tenant, token, { parcelNumber, limit: 50 }),
  );
}

/** `getBuilding`, remembered — the matrix a picker re-reads on every mount. */
export function getBuildingCached(tenant: string, token: string, id: string) {
  return cachedRequest(buildingKey(tenant, id), CENSUS_TTL_MS, () =>
    getBuilding(tenant, token, id),
  );
}

/**
 * What is already known, for a control seeding its first render.
 *
 * Without these a re-mount renders one frame of «جاري مراجعة سجل المباني…»
 * before the cached promise settles in the next microtask — brief, but it is
 * the frame the officer reads as the work being redone.
 */
export function peekParcelBuildings(tenant: string, parcelNumber: string) {
  return peekCachedRequest<{ buildings: BuildingLedgerRow[]; total: number; summary: CensusSummary }>(
    parcelKey(tenant, parcelNumber),
  );
}

export function peekBuilding(tenant: string, id: string) {
  return peekCachedRequest<BuildingDetail>(buildingKey(tenant, id));
}

/**
 * The condition log for one structure, newest first, plus the current level.
 *
 * Includes its units' own readings: "top three floors gone, ground floor shop
 * still trading" is two rows about one building.
 */
export function getBuildingDamage(
  tenant: string,
  token: string,
  id: string,
  signal?: AbortSignal,
) {
  return apiFetch<{ current: DamageLevel | null; history: DamageAssessmentRow[] }>(
    tenant,
    `/buildings/${encodeURIComponent(id)}/damage`,
    { token, signal },
  );
}

/**
 * Creates the shell. The suffix is allocated server-side, under a lock.
 *
 * `reconciled: true` means the provisional code the phone was showing is not
 * the one it got, and the officer has to be told — they will otherwise keep
 * quoting a code that names nothing. `deduplicated: true` means this exact
 * creation had already been delivered, so nothing new was made.
 */
export async function createBuilding(
  tenant: string,
  token: string,
  input: CreateBuildingInput,
) {
  const result = await apiFetch<{
    building: BuildingSummary;
    reconciled: boolean;
    deduplicated: boolean;
  }>(tenant, '/buildings', { token, method: 'POST', body: JSON.stringify(input) });
  invalidateCensus(tenant);
  return result;
}

/** Omitted fields are left alone. `parcelNumber` cannot be changed — see the schema. */
export async function updateBuilding(
  tenant: string,
  token: string,
  id: string,
  input: UpdateBuildingInput,
) {
  const result = await apiFetch<BuildingSummary>(tenant, `/buildings/${encodeURIComponent(id)}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  invalidateCensus(tenant);
  return result;
}

// ─────────────────────────────  «تصحيح رقم العقار»  ─────────────────────────────

/** What correcting a building's parcel would do — read before anything is asked. */
export interface ParcelCorrectionPreview {
  building: {
    id: string;
    code: string;
    parcelNumber: string;
    sharedParcelNumbers: string[];
    zoneCode: string | null;
    zoneName: string | null;
    hasPin: boolean;
    updatedAt: string;
  };
  next: {
    parcelNumber: string;
    /** Predicted: allocated under the parcel lock on save. */
    codeSuffix: string;
    code: string;
    zoneCode: string | null;
    zoneName: string | null;
    zoneChanged: boolean;
    /** Corrected back to a parcel it had left: it takes its own old code back. */
    reclaimsOwnCode: boolean;
    wasSharedParcel: boolean;
  };
  cadastre: {
    /** null: this municipality has no cadastre loaded. */
    known: boolean | null;
    point: { latitude: number; longitude: number } | null;
    /** null: no pin, or no outline known for the parcel. */
    pinInside: boolean | null;
  };
  neighbours: DuplicateBuildingCandidate[];
  cards: {
    toRewrite: number;
    current: number;
    citizenCount: number;
    citizens: Array<{ citizenId: string; name: string }>;
    underSharedParcel: number;
    otherNumber: number;
  };
  unlinkedOnOldParcel: number;
  unlinkedOnNewParcel: number;
  cases: number;
}

export interface ParcelCorrectionResult {
  building: {
    id: string;
    parcelNumber: string;
    codeSuffix: string;
    code: string;
    sharedParcelNumbers: string[];
    updatedAt: string;
  };
  previousCode: string;
  reclaimedOwnCode: boolean;
  cardsCorrected: number;
  citizensAffected: number;
  casesCorrected: number;
  pinInsideNewParcel: boolean | null;
}

export function getParcelCorrectionPreview(
  tenant: string,
  token: string,
  buildingId: string,
  parcelNumber: string,
  signal?: AbortSignal,
) {
  return apiFetch<ParcelCorrectionPreview>(
    tenant,
    `/buildings/${encodeURIComponent(buildingId)}/parcel-correction?parcelNumber=${encodeURIComponent(parcelNumber)}`,
    { token, signal },
  );
}

/** «تصحيح رقم العقار». Refused with the candidates when the right parcel already carries a structure. */
export async function correctBuildingParcel(
  tenant: string,
  token: string,
  buildingId: string,
  input: {
    parcelNumber: string;
    reason: string;
    acknowledgedDuplicates?: boolean;
    keepOldAsShared?: boolean;
    expectedUpdatedAt?: string;
  },
) {
  const result = await apiFetch<ParcelCorrectionResult>(
    tenant,
    `/buildings/${encodeURIComponent(buildingId)}/parcel-correction`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/** The building editor's save: the shell and the matrix difference, all or nothing. */
export interface BuildingMatrixSave {
  building: Omit<UpdateBuildingInput, 'expectedUpdatedAt'>;
  remove: string[];
  update: Array<{ id: string; floor: number; startCol?: number; endCol?: number; unitType: string }>;
  add: Array<{ floor: number; startCol?: number; endCol?: number; unitType: string }>;
  /** See `UpsertUnitInput.houseGrowth`; forwarded to every unit the save adds. */
  houseGrowth?: HouseGrowth;
  expectedUpdatedAt?: string;
  /** Do it all and roll back — what a save would do, or why it would be refused. */
  dryRun?: boolean;
}

export interface BuildingMatrixSaveResult {
  dryRun: boolean;
  building: BuildingSummary;
  /** Unit codes as they were. */
  removed: string[];
  /** Unit codes after the save. */
  updated: string[];
  added: string[];
}

export async function saveBuildingMatrix(tenant: string, token: string, id: string, input: BuildingMatrixSave) {
  const result = await apiFetch<BuildingMatrixSaveResult>(
    tenant,
    `/buildings/${encodeURIComponent(id)}/matrix-save`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  if (!input.dryRun) invalidateCensus(tenant);
  return result;
}

/** SUPER_ADMIN only. Refused server-side once anyone is recorded as living in it. */
export async function deleteBuilding(tenant: string, token: string, id: string) {
  const result = await apiFetch<{ deleted: boolean }>(
    tenant,
    `/buildings/${encodeURIComponent(id)}`,
    { token, method: 'DELETE' },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Fills the matrix from a blueprint. Additive and idempotent — a floor that
 * already holds the requested number of units is topped up, never doubled, so a
 * re-tap on a slow connection cannot invent flats.
 */
export async function generateUnits(
  tenant: string,
  token: string,
  buildingId: string,
  blueprint: UnitBlueprintInput,
) {
  const result = await apiFetch<{ created: number; skipped: number; units: UnitRow[] }>(
    tenant,
    `/buildings/${encodeURIComponent(buildingId)}/units/generate`,
    { token, method: 'POST', body: JSON.stringify(blueprint) },
  );
  invalidateCensus(tenant);
  return result;
}

/** Adds one unit by hand. Without a `sequence` the server takes the next free one. */
export async function addUnit(
  tenant: string,
  token: string,
  buildingId: string,
  input: UpsertUnitInput,
) {
  const result = await apiFetch<UnitRow>(
    tenant,
    `/buildings/${encodeURIComponent(buildingId)}/units`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Corrects one unit. Not nested under its building — a unit id is unique on its
 * own, and a path carrying both would let the two disagree.
 */
export async function updateUnit(
  tenant: string,
  token: string,
  unitId: string,
  input: Partial<UpsertUnitInput> & {
    /** «عدد طوابق المسكن» — see `UnitRow.levels`. */
    levels?: number;
    /** «مسكن موسمي» facts — see `UnitRow.presenceMonths`. */
    presenceMonths?: number[];
    ownerLastStayAt?: string | null;
    vacancyDeclaredAt?: string | null;
  },
) {
  const result = await apiFetch<UnitRow>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}`,
    { token, method: 'PATCH', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * «تعديل عرض الوحدة» — a unit's new edges on its floor's grid. The server
 * refuses drawing over a neighbour and pins the floor's unpositioned units
 * where the matrix drew them.
 */
export async function resizeUnitSpan(
  tenant: string,
  token: string,
  unitId: string,
  span: { startCol: number; endCol: number },
) {
  const result = await apiFetch<UnitRow>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}/span`,
    { token, method: 'PATCH', body: JSON.stringify(span) },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Removes a flat the matrix says exists and the street does not — a blueprint
 * that overshot a floor, or a محل counted twice.
 *
 * Refused server-side the moment anything has been recorded against the unit:
 * an occupancy current or past, a field visit, a damage assessment, or a
 * citizen's card naming it. Those refusals arrive as a `ConflictError` whose
 * message names the remedy, so callers should surface it verbatim rather than
 * replacing it with a generic failure.
 */
export async function deleteUnit(tenant: string, token: string, unitId: string) {
  const result = await apiFetch<{ deleted: true }>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}`,
    { token, method: 'DELETE' },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Records who is in a unit — and closes whatever case was waiting to find out.
 *
 * `casesResolved` is why this returns anything at all: silently closing
 * somebody else's dispatch item is how a case list stops being believed, so the
 * number is surfaced to the officer who caused it.
 */
export async function recordOccupancy(
  tenant: string,
  token: string,
  input: RecordOccupancyInput,
) {
  const result = await apiFetch<{
    occupancy: UnitOccupant;
    casesResolved: number;
    fileLink: OccupancyFileLink;
    /** Null when no owner was picked. Optional for a server from before it. */
    ownerLink?: RecordedOwnerLink | null;
  }>(
    tenant,
    '/buildings/occupancies',
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * «ربط بالمالك» — links a tenant already on the unit to one of its recorded
 * owners. `confirmRecordedAfter` is required when that owner was recorded on the
 * unit after the tenant, and is sent only once the officer confirmed it.
 */
export async function linkOccupancyOwner(
  tenant: string,
  token: string,
  occupancyId: string,
  landlordCitizenId: string,
  confirmRecordedAfter = false,
) {
  const result = await apiFetch<RecordedOwnerLink>(
    tenant,
    `/buildings/occupancies/${encodeURIComponent(occupancyId)}/owner-link`,
    {
      token,
      method: 'POST',
      body: JSON.stringify({ landlordCitizenId, ...(confirmRecordedAfter ? { confirmRecordedAfter } : {}) }),
    },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * What a flat is once its tenant has gone — asked with the ending, because
 * «مؤجرة» with nobody in it charges nobody. See `AFTER_TENANCY_STATUS`.
 */
export type AfterTenancyStatus = 'OWNER_OCCUPIED' | 'VACANT' | 'RENTED_TO_OTHER' | 'UNKNOWN';

export interface AfterTenancyAnswer {
  afterStatus?: AfterTenancyStatus;
  vacancyBasis?: VacancyBasis;
  vacancyNotes?: string;
}

/** What ending a tenancy changed. */
export interface EndTenancyResult {
  occupanciesEnded: number;
  rowsEnded: number;
  /** The card rows this ending closed. Optional for a server from before it. */
  endedRowIds?: string[];
  cardsEnded: number;
  statusApplied: AfterTenancyStatus | null;
  casesOpened: number;
  vacanciesConfirmed: number;
  link: Array<{ propertyEntryId: string; ownerId: string; kept: boolean }>;
}

/**
 * Ends a spell without deleting it — the history is the point (D2).
 *
 * A tenant's spell ends their tenancy: their card is kept as an ended tenancy,
 * the owner stays owner, and the flat gets `afterStatus` when nobody else is
 * still recorded living there.
 */
export async function endOccupancy(
  tenant: string,
  token: string,
  occupancyId: string,
  input: { reason: OccupancyEndReason; toDate?: string; newOwnerId?: string } & AfterTenancyAnswer,
) {
  const { toDate, ...rest } = input;
  // An owner's spell ends an ownership — `EndOwnershipResult`; anyone else's, a tenancy.
  const result = await apiFetch<EndTenancyResult | EndOwnershipResult>(
    tenant,
    `/buildings/occupancies/${encodeURIComponent(occupancyId)}/end`,
    {
      token,
      method: 'PATCH',
      body: JSON.stringify(toDate ? { ...rest, toDate } : rest),
    },
  );
  invalidateCensus(tenant);
  return result;
}

// ─────────────────────────────  «إنهاء الملكية»  ─────────────────────────────

/** A tenant whose card names this owner as the landlord of a flat. */
export interface OwnershipLinkedTenant {
  citizenId: string;
  name: string;
  propertyEntryId: string;
}

/**
 * What ending an ownership would touch — read before the dialog asks anything,
 * so it asks only what applies to these flats.
 */
export interface OwnershipPreview {
  owner: { id: string; name: string; nonResident: boolean };
  propertyType: string | null;
  propertyNumber: string | null;
  /** When the ownership was recorded — a sale cannot be dated before it. */
  startedAt: string | null;
  units: Array<{
    unitId: string;
    unitCode: string;
    buildingCode: string;
    /** Co-owners keep the flat, and its status. */
    otherOwners: string[];
    /** A buyer among these already owns the flat, and keeps that ownership as it is. */
    otherOwnerIds: string[];
    /** A buyer among these rents the flat: the sale ends that tenancy and records them living there. */
    occupantIds: string[];
    /** «يسكنها المالك» or «مسكن موسمي» — a status about this owner. */
    ownerLivedThere: boolean;
    /** On a sale, what the flat is now has to be said. */
    needsStatus: boolean;
    dwelling: boolean;
    linkedTenants: OwnershipLinkedTenant[];
  }>;
  /** Every current row on the card, in the form's order — what the dialog chooses from. */
  rows: Array<{
    rowId: string;
    unitId: string | null;
    unitCode: string | null;
    unitType: string | null;
    floor: string | null;
    unitArea: number | null;
    needsStatus: boolean;
    otherOwners: string[];
    linkedTenants: OwnershipLinkedTenant[];
  }>;
}

/** What ending an ownership changed. */
export interface EndOwnershipResult {
  reason: 'OWNERSHIP_TRANSFERRED' | 'RECORDED_IN_ERROR';
  endedAt: string;
  occupanciesEnded: number;
  rowsEnded: number;
  endedRowIds: string[];
  cardsEnded: number;
  statusApplied: AfterTenancyStatus | null;
  newOwnerRecorded: boolean;
  casesOpened: number;
  vacanciesConfirmed: number;
  tenantsReleased: Array<{
    tenantId: string;
    tenantName: string;
    propertyEntryId: string;
    mode: 'RELEASED' | 'SPLIT';
  }>;
  /**
   * The flats the buyer rented until the sale — their tenancy ended there, as
   * history. Absent from a server older than the one-step purchase: the
   * frontend and the API deploy separately.
   */
  buyerTenancyEndedOn?: string[];
  /** The flats whose ownership ended — for «سجِّل المالك الجديد الآن». */
  units: Array<{ unitId: string; unitCode: string; buildingId: string }>;
}

export type EndOwnershipAnswer = {
  reason: 'OWNERSHIP_TRANSFERRED' | 'RECORDED_IN_ERROR';
  endedAt?: string;
  rowIds?: string[];
  newOwnerId?: string;
} & AfterTenancyAnswer;

/** Whether a result is an ownership's — the matrix's end returns either kind. */
export function isOwnershipResult(result: EndTenancyResult | EndOwnershipResult): result is EndOwnershipResult {
  return 'tenantsReleased' in result;
}

export function getOwnershipEndPreview(tenant: string, token: string, propertyEntryId: string) {
  return apiFetch<OwnershipPreview>(
    tenant,
    `/citizens/ownerships/${encodeURIComponent(propertyEntryId)}/end-preview`,
    { token },
  );
}

export function getOccupancyOwnershipPreview(tenant: string, token: string, occupancyId: string) {
  return apiFetch<OwnershipPreview>(
    tenant,
    `/buildings/occupancies/${encodeURIComponent(occupancyId)}/ownership-preview`,
    { token },
  );
}

/** «إنهاء الملكية» on an owner's card — the same operation the unit matrix runs for an owner. */
export async function endOwnership(
  tenant: string,
  token: string,
  propertyEntryId: string,
  input: EndOwnershipAnswer,
) {
  const result = await apiFetch<EndOwnershipResult>(
    tenant,
    `/citizens/ownerships/${encodeURIComponent(propertyEntryId)}/end`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/** What ending a tenancy card would touch — for the dialog's questions. */
export interface TenancyPreview {
  tenant: { id: string; name: string };
  occupancyType: string;
  propertyType?: string;
  landlordName: string | null;
  startedAt: string | null;
  /** The card's flats linked to سجل المباني. */
  units: Array<{
    unitId: string;
    unitCode: string;
    /** Nobody else lives there, so what it is now has to be said. */
    needsStatus: boolean;
    othersRemain: boolean;
    ownerNames: string[];
    ownerNonResident: boolean;
    dwelling: boolean;
  }>;
  /**
   * Every current row on the card, in the form's order — linked flats and
   * lines never linked to one alike. What the dialog chooses from. Optional for
   * a server from before it.
   */
  rows?: TenancyPreviewRow[];
}

export interface TenancyPreviewRow {
  rowId: string;
  unitId: string | null;
  unitCode: string | null;
  unitType: string | null;
  floor: string | null;
  side: string | null;
  unitArea: number | null;
  needsStatus: boolean;
  othersRemain: boolean;
  ownerNames: string[];
  ownerNonResident: boolean;
  dwelling: boolean;
}

export function getTenancyEndPreview(tenant: string, token: string, propertyEntryId: string) {
  return apiFetch<TenancyPreview>(
    tenant,
    `/citizens/tenancies/${encodeURIComponent(propertyEntryId)}/end-preview`,
    { token },
  );
}

/** «إنهاء الإيجار» on a card — the same operation the unit matrix runs. */
export async function endTenancy(
  tenant: string,
  token: string,
  propertyEntryId: string,
  input: {
    reason: 'MOVED_OUT' | 'RECORDED_IN_ERROR';
    endedAt?: string;
    /** Exactly the rows left. Required by the server once a card has more than one. */
    rowIds?: string[];
    unitIds?: string[];
  } & AfterTenancyAnswer,
) {
  const result = await apiFetch<EndTenancyResult>(
    tenant,
    `/citizens/tenancies/${encodeURIComponent(propertyEntryId)}/end`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Appends one observation. There is no update and no delete: a building that
 * was unsafe in 2024 and repaired in 2026 is two facts, and the first is what a
 * compensation claim rests on (D3).
 */
export async function recordDamage(tenant: string, token: string, input: RecordDamageInput) {
  const result = await apiFetch<DamageAssessmentRow>(tenant, '/buildings/damage', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  invalidateCensus(tenant);
  return result;
}

/**
 * One logged attempt to survey a unit (P4-T1, D10).
 *
 * `outcome` is a `SurveyStatus` because every state a visit can produce is
 * already in that enum — never `NOT_SURVEYED`, which means nobody went.
 */
export interface UnitVisitRow {
  id: string;
  unitId: string;
  officerId: string | null;
  officerName: string | null;
  visitedAt: string;
  outcome: SurveyStatus;
  notes: string | null;
  createdAt: string;
}

export interface LogVisitInput {
  unitId: string;
  outcome: SurveyStatus;
  visitedAt?: string;
  notes?: string;
  /** This officer already logged this unit in the last twelve hours, and means to again. */
  acknowledgedRepeat?: boolean;
}

/** How recently an officer's own visit makes another one worth a question — the server's window. */
export const REPEAT_VISIT_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Logs one attempt and moves the unit to what it found — two facts, one action.
 *
 * `visitCount` comes back because it is the number the matrix shows: «٣
 * محاولات» is the difference between assigning a door and escalating it.
 */
export async function logUnitVisit(tenant: string, token: string, input: LogVisitInput) {
  const result = await apiFetch<{
    visit: UnitVisitRow;
    visitCount: number;
    /**
     * The unit's confirmed vacancy was left standing, so its حالة المسح did
     * *not* move to this visit's outcome. A locked door on a flat already
     * confirmed empty is not news; a visit that found somebody home means the
     * confirmation needs lifting, and only a person can decide that.
     */
    vacancyStands?: boolean;
  }>(tenant, '/buildings/visits', { token, method: 'POST', body: JSON.stringify(input) });
  invalidateCensus(tenant);
  return result;
}

/**
 * «معفاة من الرسوم» — grants (`reason` set), amends, or lifts (`reason` null,
 * with `liftReason`) a unit's exemption from every fee. SUPER_ADMIN only.
 * Answers the unit as the whitelist shows it (0104).
 */
export async function setUnitFeeExemption(
  tenant: string,
  token: string,
  unitId: string,
  input: SetUnitFeeExemptionInput,
  signal?: AbortSignal,
): Promise<FeeExemptionUnitView> {
  const result = await apiFetch<FeeExemptionUnitView>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}/fee-exemption`,
    { token, method: 'PUT', body: JSON.stringify(input), signal },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * «قائمة الإعفاء من الرسوم» — the exemption periods standing or lifted, searched
 * and paged on the server (`GET fee-exemptions`, `FEE_EXEMPTION_READ_ROLES`).
 */
export async function getFeeExemptions(
  tenant: string,
  token: string,
  query: Partial<FeeExemptionListQuery>,
  signal?: AbortSignal,
): Promise<FeeExemptionListResult> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.reason) params.set('reason', query.reason);
  if (query.status) params.set('status', query.status);
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  const search = params.toString();
  return apiFetch<FeeExemptionListResult>(tenant, `/fee-exemptions${search ? `?${search}` : ''}`, { token, signal });
}

/** One unit with its holders, its standing exemption and every period. */
export async function getFeeExemptionUnit(
  tenant: string,
  token: string,
  unitId: string,
  signal?: AbortSignal,
): Promise<FeeExemptionUnitView> {
  return apiFetch<FeeExemptionUnitView>(tenant, `/fee-exemptions/units/${encodeURIComponent(unitId)}`, { token, signal });
}

/** One unit by its full reference, «<building code>-<unit code>». */
export async function findFeeExemptionUnit(
  tenant: string,
  token: string,
  reference: string,
  signal?: AbortSignal,
): Promise<FeeExemptionUnitView> {
  return apiFetch<FeeExemptionUnitView>(
    tenant,
    `/fee-exemptions/units?reference=${encodeURIComponent(reference)}`,
    { token, signal },
  );
}

/** Every unit one person holds now, structural floors left out, each with its exemption. */
export async function getCitizenFeeExemptionUnits(
  tenant: string,
  token: string,
  citizenId: string,
  signal?: AbortSignal,
): Promise<FeeExemptionCitizenUnits> {
  return apiFetch<FeeExemptionCitizenUnits>(
    tenant,
    `/fee-exemptions/citizens/${encodeURIComponent(citizenId)}/units`,
    { token, signal },
  );
}

/**
 * «توزيع الرسم على المالكين» — saves how a co-owned flat is billed, and the
 * owners' أسهم with it. `mode: null` withdraws a choice (back to the equal split).
 */
export async function setOwnerBilling(
  tenant: string,
  token: string,
  unitId: string,
  input: SetOwnerBillingInput,
  signal?: AbortSignal,
): Promise<OwnerBillingState> {
  const result = await apiFetch<OwnerBillingState>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}/owner-billing`,
    { token, method: 'PUT', body: JSON.stringify(input), signal },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Records that a unit was found empty, with what says so.
 *
 * Its own call rather than a `updateUnit({ unitStatus: 'VACANT', surveyStatus:
 * 'VACANT_CONFIRMED' })`, which is what this was and which the server now
 * refuses: a confirmed vacancy exempts the owner from the occupancy fee, so it
 * is recorded as a row carrying its basis, its date and whoever decided it —
 * and it can be lifted again at any time by `endVacancy`.
 *
 * Refused while a مستأجر or شاغل بتسامح is recorded in the unit, while the flat
 * is a مسكن موسمي, and while another confirmation is already standing. Each
 * refusal names its own remedy, so callers should surface it verbatim.
 */
export async function confirmVacancy(
  tenant: string,
  token: string,
  unitId: string,
  input: { basis: VacancyBasis; observedAt?: string; notes?: string },
) {
  const result = await apiFetch<{
    vacancy: UnitVacancyConfirmation;
    unit: UnitRow;
    /** «شاغرة قيد التحقق» cases this answered and closed. */
    casesResolved: number;
  }>(tenant, `/buildings/units/${encodeURIComponent(unitId)}/vacancy`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  invalidateCensus(tenant);
  return result;
}

/**
 * Lifts the vacancy standing on a unit — the undo, available at any time.
 *
 * `reason` decides what the flat goes back to: «سُجِّل بالخطأ» restores the
 * حالة the confirmation replaced, «لم تعد شاغرة» leaves it occupied by somebody
 * not yet recorded, which is what bills the owner again until they are.
 */
/**
 * «مراجعة حالة الوحدات» — SUPER_ADMIN. Applies the one status rule to every
 * flat whose records disagree, and opens a «تعارض في حالة الوحدة» case on each
 * one a person has to decide. Safe to run again.
 */
export async function settleAllUnitStatuses(tenant: string, token: string) {
  const result = await apiFetch<{
    unitsChecked: number;
    statusesChanged: number;
    casesOpened: number;
    casesResolved: number;
    stillUnderReview: number;
  }>(tenant, '/buildings/units/status-review', { token, method: 'POST' });
  invalidateCensus(tenant);
  return result;
}

export async function endVacancy(
  tenant: string,
  token: string,
  unitId: string,
  input: { reason: VacancyEndReason; endedAt?: string; notes?: string },
) {
  const result = await apiFetch<{ vacancy: UnitVacancyConfirmation; unit: UnitRow }>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}/vacancy/end`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/** Every attempt on one unit, newest first — the panel behind the count. */
export function getUnitVisits(tenant: string, token: string, unitId: string) {
  return apiFetch<{ visits: UnitVisitRow[] }>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}/visits`,
    { token },
  );
}

/**
 * One building pin as the map draws it — three visual channels in one row: icon
 * from `structureType`, fill from `surveyRollup`, ring from `worstDamageLevel`.
 * Only buildings that have been given a location appear.
 */
export interface BuildingMapPin {
  id: string;
  code: string;
  name: string | null;
  latitude: number;
  longitude: number;
  parcelNumber: string;
  structureType: StructureType;
  /** «نوع المبنى» (0106), for the map's type filter and legend. */
  buildingTypeId?: string | null;
  lifecycleStatus: BuildingLifecycle;
  unitsTotal: number;
  unitsSurveyed: number;
  /**
   * The **worst** survey status among the units, never the majority (D11).
   *
   * Null for a structure nobody can be inside. Its units really are
   * `NOT_SURVEYED`, and painting them in that colour would put "send an officer
   * here" on a building with no doors hung yet — so the server withholds the
   * channel and the map draws the lifecycle instead.
   */
  surveyRollup: SurveyStatus | null;
  worstDamageLevel: DamageLevel | null;
}

/** Building pins with their rollups, for the fullscreen map (P3-T5). */
export function getBuildingMapPins(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<{ buildings: BuildingMapPin[] }>(tenant, '/dashboard/map/buildings', {
    token,
    signal,
  });
}

/**
 * Which sector owns which parcel, keyed by parcel number.
 *
 * Built from the sector list plus one read per sector, because membership is
 * `Zone.parcelNumbers` and there is no parcel→sector endpoint to ask (D13). The
 * building editor needs it to preview a code before the building exists: the
 * zone half of `ZONE-PARCEL-SUFFIX` is the only part of that code the client
 * cannot derive from what it already has.
 *
 * Cached for five minutes. Sector membership changes when an administrator
 * saves the zone editor, which is not something that happens between two
 * keystrokes in a parcel field.
 */
export function getZoneParcelIndex(tenant: string, token: string) {
  return cachedRequest(`zone-parcels:${tenant}`, 5 * 60 * 1000, async () => {
    const { zones } = await getZones(tenant, token);
    const details = await Promise.all(zones.map((zone) => getZone(tenant, token, zone.id)));

    const index: Record<string, { id: string; code: string; name: string; color: string }> = {};
    for (const zone of details) {
      for (const parcelNumber of zone.parcelNumbers) {
        // First sector wins, matching the server's own `findFirst`.
        index[parcelNumber] ??= {
          id: zone.id,
          code: zone.code,
          name: zone.name,
          color: zone.color,
        };
      }
    }
    return index;
  });
}

/** One unit inside a BUILDING — شقة, عيادة or محل. */
/**
 * One «تأكيد الشغور» still standing on a unit — that the municipality found
 * this flat empty, when, and on what basis.
 *
 * Shown because it is the reason an owner is not being billed for the unit,
 * and therefore the row a person disputing that — in either direction — is
 * entitled to read. Optional on the wire so a response cached from before
 * migration 0043 reads as "none".
 */
export interface CitizenProfileVacancy {
  id: string;
  /** Null only on a row 0043 backfilled — the question did not exist then. */
  basis: VacancyBasis | null;
  observedAt: string;
}

export interface CitizenProfileUnit {
  id: string;
  /** This flat left the tenancy (migration 0046) — history, billed for nothing. */
  endedAt?: string | null;
  endReason?: string | null;
  /** The canonical `Unit` this line was linked to, if any. */
  unitId?: string | null;
  unitCode?: string | null;
  unitPostedNumber?: string | null;
  /**
   * Nullable since migration 0031: a per-unit «غير مؤكَّد» flag blanks the
   * field it excuses, so a flat the officer could not fully describe arrives
   * with no type, no floor and no area. Every reader has to render that as an
   * absence — «الطابق » with nothing after it is what the previous types,
   * which promised a value here, produced on screen.
   */
  unitType: string | null;
  floor: string | null;
  side: string | null;
  /**
   * م², or null where nobody has measured the flat.
   *
   * Nullable since `BuildingUnit.unitArea` became nullable (migration 0031),
   * and typed `number` here long after it stopped being one — the server was
   * coercing with `Number()`, which turns `null` into `0`, so an unmeasured
   * flat arrived claiming a measurement of zero. The commonest way to get one
   * is `claimOnFile`: linking an existing owner to a flat from the unit matrix
   * mints a card line from the canonical unit, which for a matrix painted from
   * the street has no area either.
   */
  unitArea: number | null;
  sharedRights: string[];
  /** حالة الوحدة as the owner's card states it. Null means nobody was asked. */
  unitStatus: string | null;
  /**
   * حالة الوحدة as سجل المباني holds it — which billing reads *first*.
   *
   * Reported alongside the card's own so a disagreement between them can be
   * seen rather than silently resolved: «مشغولة من المالك» on a card over
   * «شاغرة» in the census is either a vacancy to lift or a card to correct.
   * Null when this line was never linked to a censused unit.
   */
  censusUnitStatus?: string | null;
  /**
   * «مسكن موسمي» facts — the months (1–12) the owners are usually present,
   * when they last stayed, and when a تصريح بالشغور was filed.
   *
   * The owner bears the occupancy fee on a seasonal home anyway
   * (`OWNER_BILLED_WHILE_ABSENT`); these are the facts the council weighs when
   * deciding to shorten it. Empty and null on every other unit.
   */
  presenceMonths?: number[];
  ownerLastStayAt?: string | null;
  vacancyDeclaredAt?: string | null;
  /** The «تأكيد الشغور» standing on the censused unit, if one is. */
  vacancy?: CitizenProfileVacancy | null;
  /**
   * Everyone سجل المباني records as a current owner of the linked flat, with
   * their أسهم. On a tenancy card: the flat's whole ownership beside the one
   * co-owner the card is linked to. `citizenId` and every number are absent on
   * the citizen's own portal view.
   */
  owners?: Array<{
    citizenId?: string;
    name: string;
    phone?: string | null;
    /** «لا يملك رقم هاتف». */
    hasNoPhone?: boolean;
    /** «رقم للتواصل» — a relative's number. */
    contactPhone?: string | null;
    shares: number | null;
  }>;
  /**
   * «معفاة من الرسوم» (0077): why the linked unit is charged nothing, or null —
   * as of today: an exemption past its last day reads as none (0104).
   */
  feeExemption?: FeeExemptionReason | null;
  /** Its last day, `YYYY-MM-DD`, or null for none (0104). Optional for a profile cached before it. */
  feeExemptionValidUntil?: string | null;
  /**
   * «توزيع الرسم على المالكين» (0075) when the linked flat has several current
   * owners; null otherwise. `share` is this file's owner's part — under «مالك
   * مسؤول», 1/1 for the owner who pays for all and 0/1 for the others. On the
   * citizen's own portal view `responsibleOwnerId` and `fallback` are absent.
   * Worded by `ownerBillingWording` (`lib/owner-billing.ts`).
   */
  ownerBilling?: {
    mode: OwnerBillingMode | null;
    effectiveMode: OwnerBillingMode;
    responsibleOwnerId?: string | null;
    fallback?: OwnerBillingFallback | null;
    share: { numerator: number; denominator: number } | null;
  } | null;
}

export interface CitizenProfileProperty {
  id: string;
  /**
   * When this tenancy ended, and why (migration 0046). An ended card is kept on
   * the file as history, with its lease, and bills nothing. Optional on the wire
   * for a profile cached before it existed.
   */
  endedAt?: string | null;
  endReason?: string | null;
  /** Null when the officer recorded it as «غير مؤكَّد» — see the registration's flags. */
  neighborhood: string | null;
  propertyNumber: string | null;
  propertyType: string;
  occupancyType: string;
  /**
   * Non-owner occupancies. The phone is required of a tenant only.
   *
   * The confirmed owner's registered name while a link stands — resolved on the
   * server so every screen printing it shows the same person — and what the
   * tenant said otherwise. `landlordNameAsTyped` is always the tenant's words.
   */
  landlordName: string | null;
  landlordNameAsTyped?: string | null;
  landlordPhone: string | null;
  /**
   * The registered citizen this card's owner was confirmed to be, if anyone.
   *
   * Read back so an edit opens with the standing link showing — otherwise the
   * form asks «هل هو المالك؟» about a question somebody already answered, over
   * a name field it has left unlocked and editable.
   */
  landlordCitizenId?: string | null;
  landlordReferenceNumber?: string | null;
  /** HOUSE only, owner only. A BUILDING keeps this per unit. */
  unitStatus: string | null;
  buildingName: string | null;
  /** HOUSE/LAND carry these directly; a BUILDING keeps them per unit. */
  unitType: string | null;
  landType: string | null;
  floor: string | null;
  side: string | null;
  tentLocation: string | null;
  unitArea: number | null;
  /** LAND only — أسهم out of the cadastre's standard 2400-share parcel. */
  shares: number | null;
  sharedRights: string[];
  latitude: number | null;
  longitude: number | null;
  /**
   * The censused structure behind this card, when one was linked.
   *
   * Two codes, and they are not interchangeable (D14): `buildingCode` is the
   * municipality's own `ZONE-PARCEL-SUFFIX`; `buildingPostedNumber` is what is
   * painted on the building. A notice prints both, because where they disagree
   * the collector in the street trusts the paint.
   */
  buildingId: string | null;
  buildingCode: string | null;
  buildingPostedNumber: string | null;
  /**
   * حالة المبنى, and the value this is here for is `WAR_DAMAGED_UNINHABITED`:
   * a structure still standing, war-damaged and established as empty. Its units
   * are recorded like any building's, so without this nothing on the card tells
   * a flat in it from a flat somebody lives in. Optional on the wire; null on a
   * card never linked to a censused building.
   */
  buildingLifecycleStatus?: string | null;
  unitCount: number;
  units: CitizenProfileUnit[];
  /**
   * The census flats a card with no unit lines is billed through — a منزل's
   * one flat, or the flats a مبنى card's holder is recorded on — with what
   * changes their bill. Optional on the wire for a profile cached before it.
   */
  heldUnits?: Array<
    { unitId: string; unitCode: string } & Pick<CitizenProfileUnit, 'feeExemption' | 'feeExemptionValidUntil' | 'ownerBilling'>
  >;
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
  /**
   * Fields the officer could not establish, with the reason given for each.
   *
   * Shown on the profile, not only on the edit form: this is the page a
   * collector opens before setting out, and "no phone number, and here is
   * why" is something to know before knocking rather than to discover by
   * opening the record for editing.
   */
  flags: FieldFlag[];
  /**
   * «ملاحظات» — free text from the visit, or null.
   *
   * Beside the flags rather than among them, because it is a different kind of
   * statement. A flag says a required value is missing and why; a note says
   * something no field asked about, flags nothing, and changes no status.
   */
  notes: string | null;
  properties: CitizenProfileProperty[];
  documents: CitizenProfileDocument[];
}

/** One invoice on the citizen's profile. */
export interface CitizenProfilePayment {
  id: string;
  title: string;
  amount: number;
  /** Received so far — below `amount` on a part-settled invoice. */
  paidAmount: number;
  /** `amount - paidAmount`, floored at zero: what is still owed. */
  remaining: number;
  currency: string;
  dueDate: string;
  /** `OVERDUE` is derived server-side from the due date, never stored. */
  paymentStatus: string;
  paymentMethod: string | null;
  /**
   * «INV-2610-0001» — the number on the bill itself (migration 0079).
   *
   * Null on every bill raised before that migration, which is why the receipt
   * falls back to a reference derived from the id: those documents were issued
   * without a number and inventing one now would be a lie on a printed page.
   */
  invoiceNumber: string | null;
  whishTransactionRef: string | null;
  paidAt: string | null;
  reviewNote: string | null;
  /** Why the manager cancelled the bill (0091); null unless `paymentStatus` is CANCELLED. */
  cancellationReason?: string | null;
  /** «شطب» (0107): when, how much, why and on which decision; null unless WRITTEN_OFF. Optional for an older API. */
  writeOff?: BillWriteOffView | null;
  /**
   * «متأخرات سنوات سابقة»: the year, the fee and the رقم العقار of an «ARR-» bill, with the old books'
   * reference on a staff read (the portal's is null); null on any other bill. Optional for an older API.
   */
  arrears?: BillArrearsView | null;
  /**
   * The municipal request whose fee this bill is (0092), or null. Cancelling the
   * bill cancels the request while it is still open (AWAITING_PAYMENT or
   * IN_REVIEW). Optional: a profile cached before the field existed has none.
   */
  request?: { id: string; requestNumber: string; requestType: RequestType; status: RequestStatus } | null;
  frequency: string | null;
  /**
   * How this amount was arrived at, when it was not simply the notice's own.
   *
   * The answer to «ليش عليّ هالمبلغ؟» — null on a flat charge, which explains
   * itself, and on every invoice raised before per-unit billing existed.
   */
  assessment?: FeeAssessment | null;
  /**
   * On a shared unit bill (0099) this citizen owes with others: the unit and
   * how many may pay it, never who. Null or absent on their own bill.
   */
  sharedUnit?: SharedUnitBillView | null;
}

/**
 * Where a citizen stands with the municipality's fees.
 *
 * `overdueTotal` is the unpaid amount past its due date. The system levies no
 * penalty on top, so a late fee *is* the unpaid fee — it is reported as its own
 * total because "owes 400,000" and "owes 400,000, all of it late" are different
 * conversations at the counter.
 */
export interface CitizenFeeTotals {
  feesTotal: number;
  paidTotal: number;
  outstandingTotal: number;
  overdueTotal: number;
  overdueCount: number;
  pendingReviewCount: number;
}

export interface CitizenProfile {
  id: string;
  fullName: string;
  /**
   * اسم الأم وشهرتها.
   *
   * Optional on the wire and null on households filed before migration 0044 —
   * both mean «لم يُسأل», which every reader must render as such rather than as
   * a difference between two people.
   */
  motherName?: string | null;
  phone: string | null;
  whatsapp: string | null;
  /** «لا يملك رقم هاتف» — a finished answer, not a gap. Absent from an older backend. */
  hasNoPhone?: boolean;
  /** «رقم للتواصل» — a relative's number, never the citizen's own. */
  contactPhone?: string | null;
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
  maritalStatus: string | null;
  bloodType: string | null;
  referenceNumber: string | null;
  /** نوع الملف. Optional on the wire for cached responses from before 0040. */
  residence?: CitizenResidence;
  residencePlace?: string | null;
  localContactName?: string | null;
  localContactPhone?: string | null;
  registeredAt: string;
  /** False for a deactivated record — kept for its history, refused a session. */
  isActive: boolean;
  registrations: CitizenProfileRegistration[];
  /**
   * Tenancy cards other households filed that were confirmed as naming this
   * citizen as their landlord — the owner's side of every link. Optional on the
   * wire for a profile cached before it existed.
   */
  landlordOf?: CitizenProfileLandlordOf[];
  payments: CitizenProfilePayment[];
  fees: CitizenFeeTotals;
}

/** One card naming this citizen as its confirmed landlord. */
export interface CitizenProfileLandlordOf {
  propertyEntryId: string;
  occupancyType: string;
  tenant: { id: string; name: string; referenceNumber: string | null };
  buildingName: string | null;
  buildingCode: string | null;
  propertyNumber: string | null;
  unitCodes: string[];
  linkedAt: string | null;
  /** Set when the tenancy ended — the link is then the record of who the landlord was. */
  endedAt?: string | null;
}

/**
 * One citizen and everything they have filed. Staff-only: the response
 * carries identity-document numbers and residency status.
 */
export function getCitizenProfile(tenant: string, token: string, citizenId: string) {
  return apiFetch<CitizenProfile>(tenant, `/citizens/${encodeURIComponent(citizenId)}`, { token });
}

/**
 * The signed-in citizen's own record: what they own and what they owe.
 *
 * Replaces `listMyRegistrations`, which reported the review status of each
 * طلب. Properties arrive flattened across filings — a citizen has no reason to
 * care that their four properties were entered in two sittings, which was an
 * artefact of the submission workflow rather than anything about the property.
 */
export interface MyCitizenSummary {
  fullName: string;
  referenceNumber: string | null;
  registeredAt: string;
  isActive: boolean;

  phone: string | null;
  whatsapp: string | null;
  gender: string | null;
  nationality: string | null;
  isLebanese: boolean | null;
  residentStatus: string | null;
  maritalStatus: string | null;
  bloodType: string | null;
  totalRegisteredMembers: number | null;
  actualHouseholdMembers: number | null;
  identityDocType: string | null;
  /**
   * Tail only — `•••567`. The full number is never sent to this route; see the
   * note on `CitizenController.mySummary` for why.
   */
  identityDocNumberMasked: string | null;
  civilRecordNumberMasked: string | null;

  /**
   * اسم الأم وشهرتها — theirs to check, since it is now the register's only
   * identifying answer for a Lebanese household. Null means «لم يُسأل».
   */
  motherName?: string | null;
  /** نوع الملف, and what a «غير مقيم في البلدة» record holds instead of a household. */
  residence?: CitizenResidence;
  residencePlace?: string | null;
  localContactName?: string | null;
  localContactPhone?: string | null;
  /**
   * Field paths the register could not establish — «رقم الهاتف»,
   * «properties.0.propertyNumber». Paths only: the officer's reason for each
   * stays staff-side. Absent on a response from before this was sent.
   */
  unestablishedFields?: string[];

  properties: CitizenProfileProperty[];
  payments: CitizenProfilePayment[];
  fees: CitizenFeeTotals;
}

export function getMySummary(tenant: string, token: string) {
  return apiFetch<MyCitizenSummary>(tenant, '/citizens/me/summary', { token });
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


// ── «حذف تصحيحي» (SUPER_ADMIN) ──────────────────────────────────────────────

import type {
  DuplexMergeInput,
  DuplexMergePreview,
  DuplexMergeResult,
  UnitCorrectionDeleteInput,
  UnitCorrectionPreview,
  UnitCorrectionResult,
} from '@mechanization/shared-schemas';

export type {
  DuplexMergeBlocker,
  DuplexMergeInput,
  DuplexMergePreview,
  DuplexMergeResult,
  ParcelDues,
  ParcelDuesBill,
  UnitCorrectionBlocker,
  UnitCorrectionDeleteInput,
  UnitCorrectionPreview,
  UnitCorrectionResult,
} from '@mechanization/shared-schemas';

/** What deleting this unit would remove, close and change. Its `fingerprint` is what the delete must quote. */
export function getUnitCorrectionPreview(tenant: string, token: string, unitId: string, signal?: AbortSignal) {
  return apiFetch<UnitCorrectionPreview>(
    tenant,
    `/corrections/units/${encodeURIComponent(unitId)}`,
    { token, signal },
  );
}

/**
 * Deletes the unit exactly as previewed, or changes nothing. Refused with
 * `details.reason` — see `unitCorrectionRefusal` — when the preview is stale,
 * a blocker appeared, or somebody else is writing the same records.
 */
export async function applyUnitCorrection(
  tenant: string,
  token: string,
  unitId: string,
  input: UnitCorrectionDeleteInput,
) {
  const result = await apiFetch<UnitCorrectionResult>(
    tenant,
    `/corrections/units/${encodeURIComponent(unitId)}`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/** «دمج كدوبلكس» (D28): what folding the flat above `lowerUnitId` into it would do. SUPER_ADMIN only. */
export function getDuplexMergePreview(tenant: string, token: string, lowerUnitId: string, signal?: AbortSignal) {
  return apiFetch<DuplexMergePreview>(
    tenant,
    `/corrections/units/${encodeURIComponent(lowerUnitId)}/merge-upper`,
    { token, signal },
  );
}

/** Folds the flat above into this one exactly as previewed, or changes nothing (refusals as `unitCorrectionRefusal`). */
export async function applyDuplexMerge(tenant: string, token: string, lowerUnitId: string, input: DuplexMergeInput) {
  const result = await apiFetch<DuplexMergeResult>(
    tenant,
    `/corrections/units/${encodeURIComponent(lowerUnitId)}/merge-upper`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/** Why a correction delete was refused, when the server said in a way the dialog can act on. */
export function unitCorrectionRefusal(
  caught: unknown,
): 'PREVIEW_STALE' | 'BLOCKED' | 'BUSY' | 'UNVERIFIED' | 'CONFIRM_CODE' | null {
  if (!(caught instanceof ApiRequestError)) return null;
  const details = caught.payload.details as { reason?: unknown; confirmCode?: unknown } | undefined;
  if (caught.kind === 'VALIDATION_FAILED' && details && 'confirmCode' in details) return 'CONFIRM_CODE';
  const reason = details?.reason;
  return reason === 'PREVIEW_STALE' || reason === 'BLOCKED' || reason === 'BUSY' || reason === 'UNVERIFIED'
    ? reason
    : null;
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

// ─────────────────────────────  «أنواع المباني» (0106)  ─────────────────────────────

/**
 * The municipality's building types, system types first (`GET building-types`,
 * every staff role). `includeInactive` for the screen that edits the list.
 * Read through `useBuildingTypes`, which keeps it for offline use.
 */
export async function getBuildingTypes(
  tenant: string,
  token: string,
  options: { includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<BuildingTypeView[]> {
  return apiFetch<BuildingTypeView[]>(
    tenant,
    `/building-types${options.includeInactive ? '?includeInactive=true' : ''}`,
    { token, signal },
  );
}

/** Adds a custom type. The manager's (`BUILDING_TYPE_ADMIN_ROLES`). */
export async function createBuildingType(
  tenant: string,
  token: string,
  input: CreateBuildingTypeInput,
  signal?: AbortSignal,
): Promise<BuildingTypeView> {
  return apiFetch<BuildingTypeView>(tenant, '/building-types', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

/** Renames, reorders, switches off or on, or moves a type unused by any building. The manager's. */
export async function updateBuildingType(
  tenant: string,
  token: string,
  id: string,
  input: UpdateBuildingTypeInput,
  signal?: AbortSignal,
): Promise<BuildingTypeView> {
  return apiFetch<BuildingTypeView>(tenant, `/building-types/${encodeURIComponent(id)}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify(input),
    signal,
  });
}

/**
 * The municipality's unit types, system types first (`GET unit-types`, 0109).
 * Every staff role reads it: the matrix and the building editor offer it, and
 * an inspector keeps it for offline use. Read through `useUnitTypes`.
 */
export async function getUnitTypes(
  tenant: string,
  token: string,
  options: { includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<UnitTypeView[]> {
  return apiFetch<UnitTypeView[]>(tenant, `/unit-types${options.includeInactive ? '?includeInactive=true' : ''}`, {
    token,
    signal,
  });
}

/** Adds a custom unit type. The manager's (`UNIT_TYPE_ADMIN_ROLES`). */
export async function createUnitType(
  tenant: string,
  token: string,
  input: CreateUnitTypeInput,
  signal?: AbortSignal,
): Promise<UnitTypeView> {
  return apiFetch<UnitTypeView>(tenant, '/unit-types', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

/** Renames, reorders, switches off or on, or moves a type unused by any unit. The manager's. */
export async function updateUnitType(
  tenant: string,
  token: string,
  id: string,
  input: UpdateUnitTypeInput,
  signal?: AbortSignal,
): Promise<UnitTypeView> {
  return apiFetch<UnitTypeView>(tenant, `/unit-types/${encodeURIComponent(id)}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify(input),
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

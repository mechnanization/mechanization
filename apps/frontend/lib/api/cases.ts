import { type CaseStatus, type CaseType } from '@mechanization/shared-schemas';
import { apiFetch } from './core';

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


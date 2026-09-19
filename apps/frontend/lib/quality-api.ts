import type {
  CheckDifference,
  QualityFindingKind,
  ReviewField,
} from '@mechanization/shared-schemas';
import { apiFetch } from './api-client';

/**
 * «مراجعة الجودة» — the second pair of eyes on field records.
 *
 * Its own module rather than more of `api-client.ts`: the screens that use it
 * are new, and nothing else in the portal needs these shapes.
 */

export type ReviewTab = 'TO_REVIEW' | 'RETURNED' | 'APPROVED';
export type ReviewState = 'NEW' | 'CORRECTED' | 'CHANGED' | 'RETURNED' | 'APPROVED';

export interface ReviewHistoryEntry {
  id: string;
  outcome: 'APPROVED' | 'RETURNED';
  reason: string | null;
  fields: ReviewField[];
  at: string;
  by: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface ReviewQueueItem {
  registrationId: string;
  referenceNumber: string;
  submittedAt: string;
  updatedAt: string;
  state: ReviewState;
  requiresReview: boolean;
  flags: Array<{ path: string; reason: string; kind: 'UNESTABLISHED' | 'UNVERIFIED' }>;
  notes: string | null;
  officer: { id: string; name: string } | null;
  citizen: {
    id: string;
    name: string;
    motherName: string | null;
    referenceNumber: string | null;
    residence: string;
    householdMembers: number | null;
  };
  properties: Array<{
    propertyType: string;
    occupancyType: string | null;
    propertyNumber: string | null;
    buildingName: string | null;
    buildingCode: string | null;
    buildingId: string | null;
    unitCount: number;
    unitArea: number | null;
  }>;
  history: ReviewHistoryEntry[];
}

export interface ReviewQueue {
  items: ReviewQueueItem[];
  total: number;
  counts: Record<ReviewState, number>;
}

export function getReviewQueue(
  tenant: string,
  token: string,
  filter: { tab: ReviewTab; officerId?: string; flaggedOnly?: boolean; limit?: number; offset?: number },
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ state: filter.tab });
  if (filter.officerId) query.set('officerId', filter.officerId);
  if (filter.flaggedOnly) query.set('flaggedOnly', 'true');
  query.set('limit', String(filter.limit ?? 20));
  query.set('offset', String(filter.offset ?? 0));
  return apiFetch<ReviewQueue>(tenant, `/quality/reviews?${query}`, { token, signal });
}

export function approveRecord(tenant: string, token: string, registrationId: string) {
  return apiFetch<{ id: string; outcome: 'APPROVED'; at: string }>(
    tenant,
    `/quality/reviews/${encodeURIComponent(registrationId)}/approve`,
    { token, method: 'POST' },
  );
}

export function returnRecord(
  tenant: string,
  token: string,
  registrationId: string,
  input: { reason: string; fields: ReviewField[] },
) {
  return apiFetch<{ id: string; outcome: 'RETURNED'; at: string }>(
    tenant,
    `/quality/reviews/${encodeURIComponent(registrationId)}/return`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
}

export interface OpenReturn {
  reason: string | null;
  fields: ReviewField[];
  at: string;
  by: string | null;
}

export function getOpenReturn(tenant: string, token: string, citizenId: string, signal?: AbortSignal) {
  return apiFetch<{ openReturn: OpenReturn | null }>(
    tenant,
    `/quality/citizens/${encodeURIComponent(citizenId)}/open-return`,
    { token, signal },
  );
}

export interface FindingSubject {
  kind: 'citizen' | 'building';
  id: string;
  label: string;
  secondary: string | null;
}

export interface QualityFinding {
  kind: QualityFindingKind;
  subjectKey: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  detail: string;
  subjects: FindingSubject[];
  officers: Array<{ id: string; name: string }>;
  at: string | null;
  dismissable: boolean;
  dismissal: { reason: string; by: string | null; at: string } | null;
}

export function getFindings(
  tenant: string,
  token: string,
  filter: { includeDismissed?: boolean; officerId?: string } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filter.includeDismissed) query.set('includeDismissed', 'true');
  if (filter.officerId) query.set('officerId', filter.officerId);
  return apiFetch<{
    items: QualityFinding[];
    counts: Partial<Record<QualityFindingKind, { open: number; dismissed: number }>>;
  }>(tenant, `/quality/findings?${query}`, { token, signal });
}

export function dismissFinding(
  tenant: string,
  token: string,
  input: { kind: QualityFindingKind; subjectKey: string; reason: string },
) {
  return apiFetch<{ dismissed: true }>(tenant, '/quality/findings/dismiss', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function restoreFinding(
  tenant: string,
  token: string,
  input: { kind: QualityFindingKind; subjectKey: string },
) {
  return apiFetch<{ restored: true }>(tenant, '/quality/findings/restore', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface OfficerQuality {
  id: string;
  name: string;
  role: string | null;
  isActive: boolean;
  filed: number;
  flaggedRecords: number;
  buildingsCreated: number;
  buildingsWithoutPin: number;
  reviews: { approved: number; returned: number; waitingOnOfficer: number };
  checks: { done: number; differs: number; differsRate: number | null };
  findings: {
    open: number;
    duplicateCitizens: number;
    landlordPhoneCopies: number;
    nearDuplicateBuildings: number;
    statusContradictions: number;
  };
  acknowledgedDuplicateBuildings: { count: number; nearestMetres: number | null };
}

export function getOfficerQuality(
  tenant: string,
  token: string,
  filter: { officerId?: string; from?: string; to?: string } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filter.officerId) query.set('officerId', filter.officerId);
  if (filter.from) query.set('from', filter.from);
  if (filter.to) query.set('to', filter.to);
  return apiFetch<{ officers: OfficerQuality[] }>(tenant, `/quality/officers?${query}`, { token, signal });
}

export interface QualityCheck {
  id: string;
  status: 'OPEN' | 'DONE';
  result: 'MATCHES' | 'DIFFERS' | null;
  differences: CheckDifference[];
  notes: string | null;
  sampledAt: string;
  checkedAt: string | null;
  originalOfficer: { id: string | null; name: string } | null;
  assignedTo: { id: string | null; name: string } | null;
  checkedBy: string | null;
  citizen: { id: string; name: string; householdMembers: number | null };
  referenceNumber: string;
  filedAt: string;
  properties: Array<{
    propertyType: string;
    occupancyType: string | null;
    propertyNumber: string | null;
    buildingName: string | null;
    buildingCode: string | null;
    units: string[];
  }>;
}

export interface MyQualityTasks {
  returned: Array<{
    citizenId: string;
    citizenName: string;
    referenceNumber: string;
    reason: string | null;
    fields: ReviewField[];
    at: string;
    by: string | null;
  }>;
  checks: QualityCheck[];
}

export function getMyQualityTasks(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<MyQualityTasks>(tenant, '/quality/tasks/mine', { token, signal });
}

export function getQualityChecks(
  tenant: string,
  token: string,
  filter: { status?: 'OPEN' | 'DONE'; officerId?: string } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (filter.status) query.set('status', filter.status);
  if (filter.officerId) query.set('officerId', filter.officerId);
  return apiFetch<{ items: QualityCheck[] }>(tenant, `/quality/checks?${query}`, { token, signal });
}

export function drawQualitySample(
  tenant: string,
  token: string,
  input: { from: string; to: string; percent: number },
) {
  return apiFetch<{
    sampled: number;
    perOfficer: Array<{ officerId: string; filed: number; sampled: number; inSample: number }>;
  }>(tenant, '/quality/checks/sample', { token, method: 'POST', body: JSON.stringify(input) });
}

export function assignQualityCheck(tenant: string, token: string, checkId: string, assignedToId: string | null) {
  return apiFetch<{ id: string; assignedToId: string | null }>(
    tenant,
    `/quality/checks/${encodeURIComponent(checkId)}/assign`,
    { token, method: 'PATCH', body: JSON.stringify({ assignedToId }) },
  );
}

export function completeQualityCheck(
  tenant: string,
  token: string,
  checkId: string,
  input: { result: 'MATCHES' | 'DIFFERS'; differences: CheckDifference[]; notes?: string },
) {
  return apiFetch<{ id: string; status: 'DONE'; result: 'MATCHES' | 'DIFFERS'; checkedAt: string }>(
    tenant,
    `/quality/checks/${encodeURIComponent(checkId)}/complete`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
}

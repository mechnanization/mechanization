import { type StaffPresenceResponse, type StaffSelf, type InspectorProfileResponse, type RecordInspectorPayoutInput, type RecordInspectorPayoutResult } from '@mechanization/shared-schemas';
import { ApiRequestError, apiFetch, API_URL, type ApiError } from './core';

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



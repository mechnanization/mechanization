import { cachedRequest, invalidateRequests } from '../request-cache';
import { apiFetch } from './core';

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


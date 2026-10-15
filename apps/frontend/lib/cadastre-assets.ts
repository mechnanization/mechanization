import type { FeatureCollection } from 'geojson';
import { getCadastreAsset, type CadastreAssetName } from './api-client';

/**
 * A cadastre map layer, from wherever this deployment has it.
 *
 * The portal's own copy first (`public/tenants/<slug>/`, same origin, no trip
 * through the API), then the API's (`getCadastreAsset`), signed in with the
 * session token and renewed by `apiFetch` like any other read. A municipality
 * whose files were never committed to the portal (Zahle has only
 * `cadastre.geojson` there) is served by the API alone, which is not public:
 * fetched without the token, its parcels and outlines never reached the map.
 *
 * `null` when neither answers: no cadastre imported, or no token yet to ask
 * the API with. Never throws: a map without a parcel layer still works, and
 * every caller draws what it has.
 */
export async function fetchCadastreAsset(
  tenant: string,
  token: string | null | undefined,
  asset: CadastreAssetName,
  version?: string | number,
): Promise<FeatureCollection | null> {
  const bust = version ? `?v=${encodeURIComponent(String(version))}` : '';
  try {
    const response = await fetch(`/tenants/${encodeURIComponent(tenant)}/${asset}${bust}`);
    if (response.ok) return (await response.json()) as FeatureCollection;
  } catch {
    // Not deployed with this municipality's files, or not JSON: ask the API.
  }

  if (!token) return null;
  try {
    return await getCadastreAsset(tenant, token, { asset, version });
  } catch {
    return null;
  }
}

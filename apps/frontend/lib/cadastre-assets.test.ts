import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The cadastre layers reach the map signed in.
 *
 * `GET /cadastre/assets/:assetName` is not a public route, and the maps used to
 * fall back to it with a bare `fetch` whenever the portal had no static copy:
 * a 401 every time, so a municipality served only by the API (Zahle has
 * `cadastre.geojson` in `public/tenants/` and nothing else) drew no parcels and
 * no outlines. These pin that the fallback carries the session token and that
 * the static copy still answers first.
 */

vi.mock('./session', () => ({
  loadSession: vi.fn(() => null),
  updateSession: vi.fn(),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
}));

const { fetchCadastreAsset } = await import('./cadastre-assets');

const COLLECTION = { type: 'FeatureCollection', features: [] };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The `Authorization` header a call was made with, if any. */
const authorizationOf = (call: unknown[]) =>
  ((call[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.Authorization;

describe('fetchCadastreAsset', () => {
  it('asks the API with the bearer token when the portal has no static copy', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(json(200, COLLECTION));

    const result = await fetchCadastreAsset('zahle', 'staff-token', 'parcels.geojson');

    expect(result).toEqual(COLLECTION);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe('/tenants/zahle/parcels.geojson');
    expect(String(fetchMock.mock.calls[1]![0])).toMatch(/\/t\/zahle\/cadastre\/assets\/parcels\.geojson$/);
    expect(authorizationOf(fetchMock.mock.calls[1]!)).toBe('Bearer staff-token');
  });

  it('carries the cache-busting version to both sources', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(json(200, COLLECTION));

    await fetchCadastreAsset('zahle', 'staff-token', 'cadastre.geojson', 7);

    expect(fetchMock.mock.calls[0]![0]).toBe('/tenants/zahle/cadastre.geojson?v=7');
    expect(String(fetchMock.mock.calls[1]![0])).toMatch(/\/cadastre\/assets\/cadastre\.geojson\?v=7$/);
  });

  it('answers from the static copy without calling the API', async () => {
    fetchMock.mockResolvedValueOnce(json(200, COLLECTION));

    await expect(fetchCadastreAsset('albazourieh', 'staff-token', 'parcel-polygons.geojson')).resolves.toEqual(
      COLLECTION,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not ask the API without a token, and says so with null', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));

    await expect(fetchCadastreAsset('zahle', null, 'parcels.geojson')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads a refusal from the API as no layer rather than throwing', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(json(404, { code: 'HTTP_ERROR', message: 'Asset file not found' }));

    await expect(fetchCadastreAsset('zahle', 'staff-token', 'city-boundary.geojson')).resolves.toBeNull();
  });
});

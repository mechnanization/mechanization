/**
 * The build-time `NEXT_PUBLIC_*` values, read once (DRY-13).
 *
 * Seven files each read `NEXT_PUBLIC_API_URL` with a fallback of their own, and
 * three more read the Mapbox token. Next inlines a `NEXT_PUBLIC_*` variable where
 * it sees the literal `process.env.NEXT_PUBLIC_NAME`, so each is read here by
 * that exact spelling, never through a computed key. This module has no imports,
 * so the middleware (edge), the server layouts and the browser bundle can all
 * take it.
 */

/** The API's base, `…/api/v1`. Falls back to the local API only when the variable is unset. */
export const API_URL: string = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

/**
 * The Mapbox token, or undefined. The maps say so (`failure: 'token'`) rather than
 * fall back to a token, since this repository is committed: set
 * `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` in `.env.local`.
 */
export const MAPBOX_ACCESS_TOKEN: string | undefined = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

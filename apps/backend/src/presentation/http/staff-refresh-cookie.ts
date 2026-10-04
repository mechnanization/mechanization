import type { Request, Response } from 'express';

/**
 * The staff refresh cookie, written and read by hand.
 *
 * By hand because Express 4's `res.cookie` and `res.clearCookie` always add
 * `Path=/`, and the path is the one attribute this cookie must not have. With
 * no `Path`, the browser scopes the cookie to the directory of the URL that set
 * it — `/api/v1/t/<slug>/auth/staff` — so it is sent only to this
 * municipality's staff auth routes and never rides along on the hundreds of
 * other requests a session makes. There is no cookie-parser in this app either,
 * and one header is not worth a dependency.
 *
 * The other `/auth/staff/*` routes do receive it, because they share that
 * directory. None of them reads it, and none should: only refresh and logout
 * are built to treat it as the credential it is.
 *
 * - **HttpOnly** — page script never sees the refresh token. Whatever reads
 *   storage (an injected script, an extension) gets at most the access token,
 *   which is short-lived and, since `sid`, ends with the session.
 * - **Secure**, always. Chrome and Firefox accept a Secure cookie from
 *   `http://localhost`, which is what local development runs on.
 * - **SameSite=Strict** — the portal and the API are the same site in every
 *   deployment (`baladyia.com` / `api.baladyia.com`, and `localhost` on two
 *   ports), so Strict costs nothing and keeps the cookie off every request
 *   another site starts.
 * - **No `Domain`** — host-only, on the API host.
 *
 * «تذكّرني» makes it persistent (`Max-Age` and `Expires` at the session cap);
 * otherwise it is a browser-session cookie. Safari's tracking prevention may
 * cap a persistent cookie set by a server on a different IP from the page at
 * seven days — the same as «تذكّرني»'s own default since 2026-10-04.
 */

/** The shape `StaffRefreshTokenService` mints, loosely. Anything else is not ours. */
const VALUE_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;

const ATTRIBUTES = 'HttpOnly; Secure; SameSite=Strict';

/**
 * The value of cookie `name`, or undefined — including when the value is not
 * shaped like a token we minted, so nothing malformed reaches a hash or a query.
 *
 * The first occurrence wins. Browsers list cookies with longer paths first, so
 * ours comes ahead of any same-named cookie set for `/` — and a same-named
 * cookie at all needs the name, which is keyed per account.
 */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.header('cookie');
  if (!header) return undefined;

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== name) continue;

    const value = pair.slice(separator + 1).trim();
    return VALUE_SHAPE.test(value) ? value : undefined;
  }

  return undefined;
}

export function setStaffRefreshCookie(
  response: Response,
  name: string,
  cookie: { token: string; persistent: boolean; expiresAt: Date },
  now: Date = new Date(),
): void {
  const parts = [`${name}=${cookie.token}`, ATTRIBUTES];

  if (cookie.persistent) {
    const maxAge = Math.max(0, Math.floor((cookie.expiresAt.getTime() - now.getTime()) / 1000));
    // Both: `Max-Age` wins where it is understood, `Expires` covers the rest.
    parts.push(`Max-Age=${maxAge}`, `Expires=${cookie.expiresAt.toUTCString()}`);
  }

  // `append`, not `setHeader`: a response may carry other cookies, and a
  // refused refresh may already have queued a clear.
  response.append('Set-Cookie', parts.join('; '));
}

/**
 * Tells the browser to drop cookie `name`. The attributes match the ones it
 * was set with, and it is sent without a `Path` for the same reason — a clear
 * with a different path would name a different cookie and remove nothing.
 */
export function clearStaffRefreshCookie(response: Response, name: string): void {
  response.append(
    'Set-Cookie',
    `${name}=; ${ATTRIBUTES}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  );
}

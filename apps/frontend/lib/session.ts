'use client';

import type { Session } from './api-client';
import { clearTabSearches } from './tab-search';
export type { Session };

/**
 * Session storage, namespaced per municipality.
 *
 * The tenant is part of the key because a staff member may legitimately hold
 * accounts in two municipalities, and one overwriting the other would look like
 * a random logout. It also means a token can never be replayed against a tenant
 * it was not issued for — the backend rejects that anyway, but not sending it is
 * better than being rejected.
 *
 * `sessionStorage` by default — these tokens open citizen records, and
 * municipality computers are shared, so closing the tab ends the session.
 * "Remember me" is an explicit opt-in to `localStorage` instead, for a staff
 * member on their own machine who would rather not sign in every session; the
 * safer default is unaffected for everyone who doesn't check it.
 *
 * For staff, what is stored here is only the short-lived access token
 * (`JWT_STAFF_IDLE_TTL`, 30 minutes by default). The credential that renews it
 * is an httpOnly cookie, one per account, that no script on this page can read
 * — and a refresh needs both: the cookie, and this tab's own access token to
 * say which account the tab belongs to. That is why closing the tab still ends
 * a session signed in without «تذكّرني»: the token goes with `sessionStorage`,
 * and the cookie on its own renews nothing. Two staff accounts in one browser
 * each get their own cookie, but a «تذكّرني» session is still one per
 * municipality in `localStorage` — the last sign-in wins, as it always has.
 */
const key = (tenant: string) => `mechanization.session.${tenant}`;

/**
 * Stores the session, in `localStorage` when "remember me" was ticked and
 * `sessionStorage` otherwise — see the note above on shared municipal PCs.
 */
export function saveSession(tenant: string, session: Session, remember = false): void {
  const store = remember ? localStorage : sessionStorage;
  const other = remember ? sessionStorage : localStorage;
  try {
    store.setItem(key(tenant), JSON.stringify(session));
    // Clears a copy left in the other storage by an earlier sign-in with the
    // opposite choice — otherwise loadSession could resurrect it later.
    other.removeItem(key(tenant));
  } catch {
    // Private-browsing modes reject writes. The session still works for this
    // page load; the user simply signs in again after a reload.
  }
}

/**
 * Replaces a stored session **without** changing which store holds it.
 *
 * For the token exchange in `api-client`, which has no idea whether the clerk
 * ticked "تذكّرني" — that choice was made at login and is encoded in *where*
 * the session lives, not in the session itself. Calling `saveSession` with a
 * guessed `remember` would silently move a session between `localStorage` and
 * `sessionStorage`: guess `false` and a staff member who asked to be remembered
 * is signed out by closing the tab; guess `true` and a session on a shared
 * municipal PC outlives the person sitting at it — the worse of the two by far.
 *
 * Writes nothing when neither store holds a session for this tenant. That means
 * the user signed out (or another tab did) between the request and its refresh,
 * and re-creating the session here would undo their sign-out.
 */
export function updateSession(tenant: string, session: Session): void {
  try {
    const store = sessionStorage.getItem(key(tenant))
      ? sessionStorage
      : localStorage.getItem(key(tenant))
        ? localStorage
        : null;

    store?.setItem(key(tenant), JSON.stringify(session));
  } catch {
    // Same as `saveSession`: a private-browsing mode that rejects writes. The
    // refreshed token still serves this page load, held in memory by the caller.
  }
}

/** Reads whichever store holds this tenant's session, session-scoped first. */
export function loadSession(tenant: string): Session | null {
  try {
    const raw = sessionStorage.getItem(key(tenant)) ?? localStorage.getItem(key(tenant));
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

/**
 * Signs out of this tenant by clearing both stores — and the lists' saved
 * search terms, which are a previous clerk's searches for citizens.
 *
 * The local half only. For staff, the refresh cookie and the session behind it
 * live on the API, and `logoutStaff` is what ends them; the header's sign-out
 * calls it before this.
 */
export function clearSession(tenant: string): void {
  try {
    sessionStorage.removeItem(key(tenant));
    localStorage.removeItem(key(tenant));
  } catch {
    /* nothing to clean up */
  }
  clearTabSearches(tenant);
}

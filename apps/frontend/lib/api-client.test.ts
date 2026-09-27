import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './session';

/**
 * The staff token exchange inside `apiFetch`.
 *
 * Staff sessions used to be one long-lived token: eight hours, or thirty days
 * with "تذكّرني", and when it ran out the next request came back 401 and the
 * screen sent the clerk to the login page with whatever they had typed still on
 * it. The token is short now and exchanged as it ages, so that 401 is supposed
 * to be invisible.
 *
 * "Supposed to be invisible" is the problem with testing this by hand: a broken
 * exchange looks exactly like the old behaviour, which is a thing everyone is
 * used to seeing. The cases below are the ones where it fails quietly —
 * concurrent reads racing each other into a logout, an exchange recursing on
 * its own 401, a citizen token being sent to a staff-only route, a tab quietly
 * adopting another account's stored session, a dropped connection read as the
 * end of a session.
 *
 * The refresh credential is an httpOnly cookie, so none of it is visible here:
 * what these tests can see is that every refresh and sign-in asks the browser to
 * carry cookies (`credentials: 'include'`), and that the refresh names the
 * failing token — never storage's — as the tab's binding.
 */

/** A JWT-shaped token for `sub`. Only the payload matters: nothing here verifies it. */
function tokenFor(sub: string, tag: string): string {
  const part = (value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    return btoa(String.fromCharCode(...bytes))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  };
  // The Arabic name puts multi-byte UTF-8 in the payload, as real tokens can.
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub, kind: 'STAFF', name: 'موظف', tag })}.sig`;
}

const OLD = tokenFor('staff-1', 'old');
const NEW = tokenFor('staff-1', 'new');
const NEWER = tokenFor('staff-1', 'newer');
const STALE = tokenFor('staff-1', 'stale');
const SOMEONE_ELSE = tokenFor('staff-2', 'other');

const TENANT = 'zahle';

const STAFF_SESSION: Session = {
  accessToken: OLD,
  expiresIn: '1800s',
  user: { id: 'staff-1', name: 'Clerk', kind: 'STAFF', role: 'ADMINISTRATIVE_OFFICER' },
};

/** A session for `staff-1` holding `token`, as a refresh or another tab would leave it. */
const sessionWith = (token: string): Session => ({ ...STAFF_SESSION, accessToken: token });

/*
  Storage, in memory — with `updateSession`'s real rule that it never creates a
  session where there is none. A mock that ignored the write would let an
  exchange that has already happened look as though it had not, and the
  second-exchange and single-flight cases below depend on the difference.
*/
let stored: Session | null = null;
const loadSession = vi.fn(() => stored);
const updateSession = vi.fn((_tenant: string, session: Session) => {
  if (stored) stored = session;
});
const clearSession = vi.fn(() => {
  stored = null;
});

vi.mock('./session', () => ({
  loadSession: (...args: unknown[]) => loadSession(...(args as [])),
  updateSession: (...args: unknown[]) => updateSession(...(args as [string, Session])),
  saveSession: vi.fn(),
  clearSession: (...args: unknown[]) => clearSession(...(args as [])),
}));

const { apiFetch, ApiRequestError, loginStaff, logoutStaff } = await import('./api-client');

/** A `fetch` reply, shaped the way `apiFetch` reads one. */
function reply(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const unauthorised = () => reply(401, { code: 'UNAUTHORIZED', message: 'expired' });

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  stored = STAFF_SESSION;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

type SentInit = RequestInit & { headers?: Record<string, string> };

/** The URL and init of the nth `fetch` call. */
function call(n: number): { url: string; init: SentInit } {
  const [url, init] = fetchMock.mock.calls[n] ?? [];
  return { url: String(url), init: (init ?? {}) as SentInit };
}

/** The Authorization header of the nth `fetch` call. */
function authOf(n: number): string | undefined {
  return call(n).init.headers?.Authorization;
}

const refreshCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/staff/refresh'));

/**
 * A server where exactly one token is alive: requests carrying `live` succeed,
 * everything else 401s, and a refresh answers with `next`.
 */
function serverAccepting(live: string, next = NEW) {
  fetchMock.mockImplementation(async (url: string, init: SentInit) => {
    if (String(url).includes('/auth/staff/refresh')) return reply(200, sessionWith(next));
    return init.headers?.Authorization === `Bearer ${live}` ? reply(200, { ok: true }) : unauthorised();
  });
}

describe('apiFetch — exchanging an aged-out staff token', () => {
  it('exchanges the token and replays the request', async () => {
    fetchMock
      // The original read, meeting an expired token.
      .mockResolvedValueOnce(unauthorised())
      // The exchange.
      .mockResolvedValueOnce(reply(200, sessionWith(NEW)))
      // The replay, which is what the caller actually receives.
      .mockResolvedValueOnce(reply(200, { items: ['a'] }));

    const result = await apiFetch<{ items: string[] }>(TENANT, '/citizens', { token: OLD });

    expect(result).toEqual({ items: ['a'] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The replay carries the new token, not the one that just failed.
    expect(authOf(2)).toBe(`Bearer ${NEW}`);
  });

  it('sends the refresh cookie, with the failing token as the binding', async () => {
    /*
      Both halves, or the server refuses. `credentials: 'include'` is what puts
      the httpOnly cookie on a cross-origin request at all; the bearer tells the
      server whose cookie to read. An expired token is exactly what is expected
      there — it is the token that just failed.
    */
    fetchMock
      .mockResolvedValueOnce(unauthorised())
      .mockResolvedValueOnce(reply(200, sessionWith(NEW)))
      .mockResolvedValueOnce(reply(200, {}));

    await apiFetch(TENANT, '/citizens', { token: OLD });

    const refresh = call(1);
    expect(refresh.url).toContain(`/t/${TENANT}/auth/staff/refresh`);
    expect(refresh.init.method).toBe('POST');
    expect(refresh.init.credentials).toBe('include');
    expect(refresh.init.headers?.Authorization).toBe(`Bearer ${OLD}`);
    // Bounded: a refresh that hangs must end as "unavailable", not as a spinner.
    expect(refresh.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('stores the refreshed session without moving which store holds it', async () => {
    /*
      `updateSession`, never `saveSession`. The choice between `localStorage`
      and `sessionStorage` was made by the "تذكّرني" checkbox at login and is
      encoded in *where* the session lives; an exchange that guessed would
      either sign out someone who asked to be remembered, or leave a session on
      a shared municipal PC after the clerk walked away.
    */
    fetchMock
      .mockResolvedValueOnce(unauthorised())
      .mockResolvedValueOnce(reply(200, sessionWith(NEW)))
      .mockResolvedValueOnce(reply(200, {}));

    await apiFetch(TENANT, '/citizens', { token: OLD });

    expect(updateSession).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ accessToken: NEW }),
    );
  });

  it('exchanges once for several reads that expire together', async () => {
    /*
      The race that costs a session.

      A staff screen fires the header badge, the table and the filter options at
      once, so they all meet the expiry in the same tick. Without the in-flight
      map each would exchange separately — each rotating the refresh cookie the
      others were about to present.
    */
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/auth/staff/refresh') ? reply(200, sessionWith(NEW)) : unauthorised(),
    );

    // Every replay 401s too, so all three end up failing — what is under test
    // is how many exchanges were attempted, not the outcome.
    await Promise.allSettled([
      apiFetch(TENANT, '/a', { token: OLD }),
      apiFetch(TENANT, '/b', { token: OLD }),
      apiFetch(TENANT, '/c', { token: OLD }),
    ]);

    expect(refreshCalls()).toHaveLength(1);
  });

  it('shares the exchange between a stale token and the current one', async () => {
    /*
      Keyed by failing token, so two different tokens are two questions — but
      they must still converge on one rotation. `/b` carries a token older than
      storage's: storage answers it, its replay meets the same expiry `/a` did,
      and its second exchange joins `/a`'s (or reads what `/a` stored). Never a
      second refresh.
    */
    serverAccepting(NEW);

    const [a, b] = await Promise.all([
      apiFetch(TENANT, '/a', { token: OLD }),
      apiFetch(TENANT, '/b', { token: STALE }),
    ]);

    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(refreshCalls()).toHaveLength(1);
  });

  it.each([401, 403])('lets the original 401 through when the refresh answers %i', async (status) => {
    // The cap has passed, the account was dismissed, the session was signed
    // out. The two dozen existing 401 handlers are what should run, unchanged.
    fetchMock
      .mockResolvedValueOnce(unauthorised())
      .mockResolvedValueOnce(reply(status, { code: 'UNAUTHORIZED', message: 'session over' }));

    await expect(apiFetch(TENANT, '/citizens', { token: OLD })).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('replays only once after a network exchange, so a revoked session cannot loop', async () => {
    // A `tokenVersion` bump between the exchange and the replay. One replay,
    // then the error — not an exchange per attempt, for ever.
    fetchMock
      .mockResolvedValueOnce(unauthorised())
      .mockResolvedValueOnce(reply(200, sessionWith(NEW)))
      .mockResolvedValueOnce(reply(401, { code: 'UNAUTHORIZED', message: 'revoked' }));

    await expect(apiFetch(TENANT, '/citizens', { token: OLD })).rejects.toBeInstanceOf(
      ApiRequestError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('apiFetch — a session another tab has already renewed', () => {
  it('replays with the stored token without touching the network', async () => {
    /*
      Screens hold their token in React state, so after any renewal the next
      request still carries the old one. Storage already has the answer;
      exchanging again would rotate the cookie for nothing.
    */
    stored = sessionWith(NEW);
    serverAccepting(NEW);

    await expect(apiFetch(TENANT, '/citizens', { token: OLD })).resolves.toEqual({ ok: true });

    expect(refreshCalls()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authOf(1)).toBe(`Bearer ${NEW}`);
  });

  it('exchanges once more over the network when the stored token has died too', async () => {
    // The laptop slept past both. The second exchange presents the stored token
    // — the one storage and the tab now agree on — and goes to the server.
    stored = sessionWith(NEW);
    serverAccepting(NEWER, NEWER);

    await expect(apiFetch(TENANT, '/citizens', { token: OLD })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(authOf(1)).toBe(`Bearer ${NEW}`);
    expect(call(2).url).toContain('/auth/staff/refresh');
    expect(authOf(2)).toBe(`Bearer ${NEW}`);
    expect(authOf(3)).toBe(`Bearer ${NEWER}`);
    expect(stored?.accessToken).toBe(NEWER);
  });

  it('never spends more than two exchanges on one call', async () => {
    stored = sessionWith(NEW);
    // Nothing is accepted, not even what the refresh hands back.
    serverAccepting('nothing', NEWER);

    await expect(apiFetch(TENANT, '/citizens', { token: OLD })).rejects.toMatchObject({
      status: 401,
    });
    // Original, storage replay, one refresh, its replay — and stop.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(refreshCalls()).toHaveLength(1);
  });

  it("never adopts another account's stored session", async () => {
    /*
      Another clerk signed in to this municipality with «تذكّرني» while this tab
      was open. Storage now holds *their* session; replaying this tab's request
      with it would quietly act as them. Neither a short-circuit nor a refresh —
      the 401 goes to the screen.
    */
    stored = {
      ...STAFF_SESSION,
      accessToken: SOMEONE_ELSE,
      user: { ...STAFF_SESSION.user, id: 'staff-2', name: 'Another clerk' },
    };
    serverAccepting(SOMEONE_ELSE);

    await expect(apiFetch(TENANT, '/citizens', { token: OLD })).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('does not store a refreshed session that names a different account', async () => {
    // The server binds the refresh to the tab's account, so this should be
    // impossible. If it ever happens, writing it to storage is what must not.
    fetchMock
      .mockResolvedValueOnce(unauthorised())
      .mockResolvedValueOnce(
        reply(200, { ...sessionWith(SOMEONE_ELSE), user: { ...STAFF_SESSION.user, id: 'staff-2' } }),
      );

    await expect(apiFetch(TENANT, '/citizens', { token: OLD })).rejects.toMatchObject({
      status: 401,
    });
    expect(updateSession).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not exchange a token it cannot read', async () => {
    // No `sub`, no way to tell whose session storage holds — so no exchange.
    fetchMock.mockResolvedValueOnce(unauthorised());

    await expect(apiFetch(TENANT, '/citizens', { token: 'not-a-jwt' })).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('apiFetch — a refresh that cannot be reached', () => {
  it.each([
    ['the network is down', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['the API throttles it', () => Promise.resolve(reply(429, { code: 'TOO_MANY_REQUESTS', message: 'slow' }))],
    ['the API fails', () => Promise.resolve(reply(500, { code: 'INTERNAL', message: 'boom' }))],
    ['the API is restarting', () => Promise.resolve(reply(503, { code: 'UNAVAILABLE', message: 'later' }))],
  ])('reports "unavailable", not an ended session, when %s', async (_case, refresh) => {
    /*
      None of these says anything about the session. A 401 here would have
      every screen clear storage and send the clerk to sign in because the API
      was restarting; status 0 is what they already read as "no connection".
    */
    fetchMock.mockResolvedValueOnce(unauthorised()).mockImplementationOnce(refresh);

    const caught = await apiFetch(TENANT, '/citizens', { token: OLD }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ApiRequestError);
    expect(caught).toMatchObject({
      status: 0,
      payload: { code: 'SESSION_REFRESH_UNAVAILABLE' },
    });
    expect(clearSession).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(stored).toEqual(STAFF_SESSION);
  });
});

describe('apiFetch — the cross-tab refresh lock', () => {
  /** A Web Locks stub that runs callbacks immediately and records whether one is held. */
  function stubLocks() {
    const state = { held: false };
    const request = vi.fn(
      async (name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => {
        state.held = true;
        try {
          return await callback({ name, mode: 'exclusive' });
        } finally {
          state.held = false;
        }
      },
    );
    vi.stubGlobal('navigator', { onLine: true, locks: { request } });
    return { request, state };
  }

  it('refreshes while holding the lock, when the browser has one', async () => {
    const { request, state } = stubLocks();
    const heldDuringRefresh: boolean[] = [];
    fetchMock.mockImplementation(async (url: string, init: SentInit) => {
      if (String(url).includes('/auth/staff/refresh')) {
        heldDuringRefresh.push(state.held);
        return reply(200, sessionWith(NEW));
      }
      return init.headers?.Authorization === `Bearer ${NEW}` ? reply(200, {}) : unauthorised();
    });

    await apiFetch(TENANT, '/citizens', { token: OLD });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe(`mechanization.refresh.${TENANT}`);
    expect((request.mock.calls[0]?.[1] as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
    expect(heldDuringRefresh).toEqual([true]);
  });

  it('does not take the lock for an answer storage already has', async () => {
    const { request } = stubLocks();
    stored = sessionWith(NEW);
    serverAccepting(NEW);

    await apiFetch(TENANT, '/citizens', { token: OLD });

    expect(request).not.toHaveBeenCalled();
  });

  it('refreshes unlocked where the browser has no Web Locks', async () => {
    // `vitest.setup.ts`'s navigator has no `locks` — an insecure origin, or an
    // older browser. The exchange must still happen.
    serverAccepting(NEW);

    await expect(apiFetch(TENANT, '/citizens', { token: OLD })).resolves.toEqual({ ok: true });
    expect(refreshCalls()).toHaveLength(1);
  });

  it('reports "unavailable" when the lock cannot be had in time, and sends nothing', async () => {
    // A tab frozen mid-exchange holds the lock. The wait gives up rather than
    // hang the screen — and gives up as a connection problem, not a sign-out.
    const request = vi.fn(async () => {
      throw new DOMException('The lock request was aborted.', 'TimeoutError');
    });
    vi.stubGlobal('navigator', { onLine: true, locks: { request } });
    fetchMock.mockResolvedValueOnce(unauthorised());

    await expect(apiFetch(TENANT, '/citizens', { token: OLD })).rejects.toMatchObject({
      status: 0,
      payload: { code: 'SESSION_REFRESH_UNAVAILABLE' },
    });
    expect(refreshCalls()).toHaveLength(0);
    expect(stored).toEqual(STAFF_SESSION);
  });

  it('holds the lock for sign-in and sign-out as well', async () => {
    const { request } = stubLocks();
    fetchMock.mockResolvedValue(reply(200, { signedOut: true }));

    await loginStaff(TENANT, { email: 'clerk@example.com', password: 'secret' });
    await logoutStaff(TENANT, OLD);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([name]) => name === `mechanization.refresh.${TENANT}`)).toBe(
      true,
    );
  });

  it('passes through what the locked call threw, once the lock was granted', async () => {
    // Only a lock that could not be had is "unavailable". A wrong password
    // under the lock is still a wrong password — reporting it as a connection
    // problem would leave the clerk retrying a login that can never succeed.
    stubLocks();
    fetchMock.mockResolvedValueOnce(reply(401, { code: 'UNAUTHORIZED', message: 'bad password' }));

    await expect(
      loginStaff(TENANT, { email: 'clerk@example.com', password: 'wrong' }),
    ).rejects.toMatchObject({ status: 401, payload: { code: 'UNAUTHORIZED' } });
  });
});

describe('apiFetch — when the exchange must not be attempted', () => {
  it('does not exchange for a citizen session', async () => {
    // The server refuses citizen tokens on the staff route; not asking is both
    // faster and one fewer way to get a confusing answer.
    stored = { ...STAFF_SESSION, user: { ...STAFF_SESSION.user, kind: 'CITIZEN' } };
    fetchMock.mockResolvedValueOnce(unauthorised());

    await expect(apiFetch(TENANT, '/me/payments', { token: OLD })).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not exchange when there is no stored session', async () => {
    // Another tab signed out between the request and its reply. Re-creating a
    // session here would undo that sign-out.
    stored = null;
    fetchMock.mockResolvedValueOnce(unauthorised());

    await expect(apiFetch(TENANT, '/citizens', { token: OLD })).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not exchange for an unauthenticated request', async () => {
    // A public route answering 401 has no session behind it to extend.
    fetchMock.mockResolvedValueOnce(reply(401, { code: 'UNAUTHORIZED', message: 'nope' }));

    await expect(apiFetch(TENANT, '/config')).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not exchange when a login is refused', async () => {
    /*
      A 401 from the login route means the password was wrong. Treating it as an
      expiry would fire an exchange on every mistyped password — and, worse,
      would replay the failed login a second time against the throttle that
      exists to slow exactly that down.
    */
    fetchMock.mockResolvedValueOnce(reply(401, { code: 'UNAUTHORIZED', message: 'bad password' }));

    await expect(
      apiFetch(TENANT, '/auth/staff/login', { method: 'POST', token: OLD }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves non-401 failures completely alone', async () => {
    fetchMock.mockResolvedValueOnce(reply(409, { code: 'CONFLICT', message: 'مكرر' }));

    await expect(apiFetch(TENANT, '/citizens', { token: OLD })).rejects.toMatchObject({
      status: 409,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('loginStaff', () => {
  it('asks the browser to keep the refresh cookie the response sets', async () => {
    // Without `credentials: 'include'` a cross-origin `Set-Cookie` is dropped,
    // and the sign-in would look fine until the first expiry signed them out.
    fetchMock.mockResolvedValueOnce(reply(200, sessionWith(NEW)));

    await loginStaff(TENANT, { email: 'clerk@example.com', password: 'secret', remember: true });

    expect(call(0).url).toContain(`/t/${TENANT}/auth/staff/login`);
    expect(call(0).init.credentials).toBe('include');
  });

  it('does not exchange on a wrong password', async () => {
    fetchMock.mockResolvedValueOnce(reply(401, { code: 'UNAUTHORIZED', message: 'bad password' }));

    await expect(
      loginStaff(TENANT, { email: 'clerk@example.com', password: 'wrong' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('logoutStaff', () => {
  it("ends the session with the cookie and this tab's own token", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { signedOut: true }));

    await logoutStaff(TENANT, OLD);

    expect(call(0).url).toContain(`/t/${TENANT}/auth/staff/logout`);
    expect(call(0).init.method).toBe('POST');
    expect(call(0).init.credentials).toBe('include');
    expect(authOf(0)).toBe(`Bearer ${OLD}`);
  });

  it('never triggers an exchange', async () => {
    /*
      Signing out with an expired token is the ordinary case — the clerk came
      back after lunch and pressed «تسجيل الخروج». Renewing the session in
      order to end it would rotate a cookie for nothing, and a 401 here means
      there was nothing left to end.
    */
    fetchMock.mockResolvedValueOnce(unauthorised());

    await expect(logoutStaff(TENANT, OLD)).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshCalls()).toHaveLength(0);
  });

  it('surfaces the 404 of an API from before the route, for the caller to ignore', async () => {
    // The portal ships first, so for a while the route does not exist yet.
    fetchMock.mockResolvedValueOnce(reply(404, { code: 'NOT_FOUND', message: 'Cannot POST' }));

    await expect(logoutStaff(TENANT, OLD)).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing without a token to bind it to', async () => {
    // The server cannot tell which account's cookie to read, and does nothing.
    await logoutStaff(TENANT, undefined);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

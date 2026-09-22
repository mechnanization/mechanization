import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
 * its own 401, a citizen token being sent to a staff-only route.
 */

const loadSession = vi.fn();
const updateSession = vi.fn();

vi.mock('./session', () => ({
  loadSession: (...args: unknown[]) => loadSession(...args),
  updateSession: (...args: unknown[]) => updateSession(...args),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
}));

const { apiFetch, ApiRequestError } = await import('./api-client');

const TENANT = 'zahle';

const STAFF_SESSION = {
  accessToken: 'old-token',
  expiresIn: '1800s',
  user: { id: 'staff-1', name: 'Clerk', kind: 'STAFF' as const, role: 'ADMINISTRATIVE_OFFICER' },
};

/** A `fetch` reply, shaped the way `apiFetch` reads one. */
function reply(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  loadSession.mockReturnValue(STAFF_SESSION);
  updateSession.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** The Authorization header of the nth `fetch` call. */
function authOf(call: number): string | undefined {
  const init = fetchMock.mock.calls[call]?.[1] as { headers?: Record<string, string> };
  return init?.headers?.Authorization;
}

describe('apiFetch — exchanging an aged-out staff token', () => {
  it('exchanges the token and replays the request', async () => {
    fetchMock
      // The original read, meeting an expired token.
      .mockResolvedValueOnce(reply(401, { code: 'UNAUTHORIZED', message: 'expired' }))
      // The exchange.
      .mockResolvedValueOnce(reply(200, { ...STAFF_SESSION, accessToken: 'new-token' }))
      // The replay, which is what the caller actually receives.
      .mockResolvedValueOnce(reply(200, { items: ['a'] }));

    const result = await apiFetch<{ items: string[] }>(TENANT, '/citizens', {
      token: 'old-token',
    });

    expect(result).toEqual({ items: ['a'] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The replay carries the new token, not the one that just failed.
    expect(authOf(2)).toBe('Bearer new-token');
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
      .mockResolvedValueOnce(reply(401, { code: 'UNAUTHORIZED', message: 'expired' }))
      .mockResolvedValueOnce(reply(200, { ...STAFF_SESSION, accessToken: 'new-token' }))
      .mockResolvedValueOnce(reply(200, {}));

    await apiFetch(TENANT, '/citizens', { token: 'old-token' });

    expect(updateSession).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ accessToken: 'new-token' }),
    );
  });

  it('exchanges once for several reads that expire together', async () => {
    /*
      The race that costs a session.

      A staff screen fires the header badge, the table and the filter options at
      once, so they all meet the expiry in the same tick. Without the in-flight
      map each would exchange separately, and the slowest reply would overwrite
      the stored session with a token the others had already replaced — a logout
      on a session that was perfectly valid.
    */
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/auth/staff/refresh')) {
        return reply(200, { ...STAFF_SESSION, accessToken: 'new-token' });
      }
      const auth = 'old';
      void auth;
      return reply(401, { code: 'UNAUTHORIZED', message: 'expired' });
    });

    // Every replay 401s too, so all three end up failing — what is under test
    // is how many exchanges were attempted, not the outcome.
    await Promise.allSettled([
      apiFetch(TENANT, '/a', { token: 'old-token' }),
      apiFetch(TENANT, '/b', { token: 'old-token' }),
      apiFetch(TENANT, '/c', { token: 'old-token' }),
    ]);

    const exchanges = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/auth/staff/refresh'),
    );
    expect(exchanges).toHaveLength(1);
  });

  it('lets the original 401 through when the session cannot be extended', async () => {
    // The cap has passed, or the account was dismissed. The two dozen existing
    // 401 handlers are what should run, unchanged.
    fetchMock
      .mockResolvedValueOnce(reply(401, { code: 'UNAUTHORIZED', message: 'expired' }))
      .mockResolvedValueOnce(reply(401, { code: 'UNAUTHORIZED', message: 'session over' }));

    await expect(apiFetch(TENANT, '/citizens', { token: 'old-token' })).rejects.toMatchObject({
      status: 401,
    });
  });

  it('replays only once, so a genuinely revoked session cannot loop', async () => {
    // A `tokenVersion` bump lets the exchange succeed and the replay fail. One
    // replay, then the error — not an exchange per attempt, for ever.
    fetchMock
      .mockResolvedValueOnce(reply(401, { code: 'UNAUTHORIZED', message: 'expired' }))
      .mockResolvedValueOnce(reply(200, { ...STAFF_SESSION, accessToken: 'new-token' }))
      .mockResolvedValueOnce(reply(401, { code: 'UNAUTHORIZED', message: 'revoked' }));

    await expect(apiFetch(TENANT, '/citizens', { token: 'old-token' })).rejects.toBeInstanceOf(
      ApiRequestError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('apiFetch — when the exchange must not be attempted', () => {
  it('does not exchange for a citizen session', async () => {
    // The server refuses citizen tokens on the staff route; not asking is both
    // faster and one fewer way to get a confusing answer.
    loadSession.mockReturnValue({
      ...STAFF_SESSION,
      user: { ...STAFF_SESSION.user, kind: 'CITIZEN' as const },
    });
    fetchMock.mockResolvedValueOnce(reply(401, { code: 'UNAUTHORIZED', message: 'expired' }));

    await expect(apiFetch(TENANT, '/me/payments', { token: 'old-token' })).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not exchange when there is no stored session', async () => {
    // Another tab signed out between the request and its reply. Re-creating a
    // session here would undo that sign-out.
    loadSession.mockReturnValue(null);
    fetchMock.mockResolvedValueOnce(reply(401, { code: 'UNAUTHORIZED', message: 'expired' }));

    await expect(apiFetch(TENANT, '/citizens', { token: 'old-token' })).rejects.toMatchObject({
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
      apiFetch(TENANT, '/auth/staff/login', { method: 'POST', token: 'old-token' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves non-401 failures completely alone', async () => {
    fetchMock.mockResolvedValueOnce(reply(409, { code: 'CONFLICT', message: 'مكرر' }));

    await expect(apiFetch(TENANT, '/citizens', { token: 'old-token' })).rejects.toMatchObject({
      status: 409,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

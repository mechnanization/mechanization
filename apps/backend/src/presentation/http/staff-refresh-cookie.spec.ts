import type { Request, Response } from 'express';
import {
  clearStaffRefreshCookie,
  readCookie,
  setStaffRefreshCookie,
} from './staff-refresh-cookie';

/**
 * The refresh cookie's header, written and read by hand.
 *
 * By hand because Express 4's `res.cookie` always adds `Path=/`, and the path
 * is the attribute this cookie must not have: without one the browser scopes
 * it to `/api/v1/t/<slug>/auth/staff`, and it never rides along on the rest of
 * a session's requests. So the exact header string is the contract, and these
 * tests compare whole strings — an attribute that appears or goes missing is
 * a change someone has to make on purpose.
 */

const NAME = 'mz_sr_0123456789abcdef01234567';
const TOKEN = 'Zm9vYmFyYmF6cXV4LXRva2VuLXZhbHVlLTMyYnl0ZXM';

/** Just enough of a response: `append`, accumulating the way Express's does. */
function response() {
  const cookies: string[] = [];
  const res = {
    append: jest.fn((field: string, value: string): void => {
      if (field !== 'Set-Cookie') throw new Error(`unexpected header ${field}`);
      cookies.push(value);
    }),
    setHeader: jest.fn(() => {
      throw new Error('setHeader would replace a Set-Cookie already queued');
    }),
  };
  return { res: res as unknown as Response, cookies };
}

function request(cookie?: string): Request {
  return {
    header: (name: string) => (name.toLowerCase() === 'cookie' ? cookie : undefined),
  } as unknown as Request;
}

describe('setStaffRefreshCookie', () => {
  const NOW = new Date('2026-09-26T08:00:00.000Z');

  it('writes a browser-session cookie when «تذكّرني» was not ticked', () => {
    const { res, cookies } = response();

    setStaffRefreshCookie(
      res,
      NAME,
      { token: TOKEN, persistent: false, expiresAt: new Date('2026-09-26T16:00:00.000Z') },
      NOW,
    );

    // No Max-Age and no Expires: it dies with the browser session.
    expect(cookies).toEqual([`${NAME}=${TOKEN}; HttpOnly; Secure; SameSite=Strict`]);
  });

  it('writes a persistent cookie that lasts exactly to the session cap', () => {
    const { res, cookies } = response();

    setStaffRefreshCookie(
      res,
      NAME,
      { token: TOKEN, persistent: true, expiresAt: new Date('2026-10-26T08:00:00.000Z') },
      NOW,
    );

    expect(cookies).toEqual([
      `${NAME}=${TOKEN}; HttpOnly; Secure; SameSite=Strict; ` +
        'Max-Age=2592000; Expires=Mon, 26 Oct 2026 08:00:00 GMT',
    ]);
  });

  it('never sets a Path or a Domain', () => {
    // A Path would widen the cookie to every request under it; a Domain would
    // share it with every subdomain. Host-only, directory-scoped is the point.
    const { res, cookies } = response();

    setStaffRefreshCookie(res, NAME, { token: TOKEN, persistent: true, expiresAt: NOW }, NOW);
    setStaffRefreshCookie(res, NAME, { token: TOKEN, persistent: false, expiresAt: NOW }, NOW);
    clearStaffRefreshCookie(res, NAME);

    for (const header of cookies) {
      expect(header).not.toMatch(/;\s*path=/i);
      expect(header).not.toMatch(/;\s*domain=/i);
    }
  });

  it('rounds Max-Age down, so the cookie never outlives the cap', () => {
    const { res, cookies } = response();

    setStaffRefreshCookie(
      res,
      NAME,
      { token: TOKEN, persistent: true, expiresAt: new Date(NOW.getTime() + 90_999) },
      NOW,
    );

    expect(cookies[0]).toContain('; Max-Age=90;');
  });

  it('never writes a negative Max-Age for a cap already behind it', () => {
    const { res, cookies } = response();

    setStaffRefreshCookie(
      res,
      NAME,
      { token: TOKEN, persistent: true, expiresAt: new Date(NOW.getTime() - 60_000) },
      NOW,
    );

    expect(cookies[0]).toContain('; Max-Age=0;');
  });

  it('appends rather than replacing, so a queued clear and a new cookie both survive', () => {
    const { res, cookies } = response();

    clearStaffRefreshCookie(res, 'mz_sr_other');
    setStaffRefreshCookie(res, NAME, { token: TOKEN, persistent: false, expiresAt: NOW }, NOW);

    expect(cookies).toHaveLength(2);
  });
});

describe('clearStaffRefreshCookie', () => {
  it('expires the cookie with the attributes it was set with', () => {
    // A clear whose attributes differ (a Path, above all) names a different
    // cookie and removes nothing.
    const { res, cookies } = response();

    clearStaffRefreshCookie(res, NAME);

    expect(cookies).toEqual([
      `${NAME}=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    ]);
  });
});

describe('readCookie', () => {
  it('finds the named cookie among others, whatever the spacing', () => {
    expect(readCookie(request(`theme=dark; ${NAME}=${TOKEN};lang=ar`), NAME)).toBe(TOKEN);
    expect(readCookie(request(`${NAME}=${TOKEN}`), NAME)).toBe(TOKEN);
    expect(readCookie(request(`a=b;   ${NAME} = ${TOKEN}  `), NAME)).toBe(TOKEN);
  });

  it('answers undefined when there is no Cookie header or no such cookie', () => {
    expect(readCookie(request(undefined), NAME)).toBeUndefined();
    expect(readCookie(request(''), NAME)).toBeUndefined();
    expect(readCookie(request(`theme=dark; lang=ar`), NAME)).toBeUndefined();
  });

  it('matches the whole name, never a prefix or an extension of it', () => {
    // Per-account names share their `mz_sr_` prefix; reading another
    // account's cookie because its name began the same way would hand one
    // tab another account's credential.
    expect(readCookie(request(`${NAME}9=${TOKEN}`), NAME)).toBeUndefined();
    expect(readCookie(request(`${NAME.slice(0, -1)}=${TOKEN}`), NAME)).toBeUndefined();
  });

  it('takes the first occurrence of a repeated name', () => {
    // Browsers list the longer path first, so ours precedes a same-named
    // cookie planted at `/`.
    const second = 'b'.repeat(43);
    expect(readCookie(request(`${NAME}=${TOKEN}; ${NAME}=${second}`), NAME)).toBe(TOKEN);
  });

  it('refuses a value that cannot be a token this service minted', () => {
    const malformed = [
      '',
      'x'.repeat(19),
      'x'.repeat(201),
      `"${TOKEN}"`,
      `${TOKEN}=`,
      `${TOKEN.slice(0, 20)} ${TOKEN.slice(20)}`,
      `${TOKEN}%00`,
    ];

    for (const value of malformed) {
      expect(readCookie(request(`${NAME}=${value}`), NAME)).toBeUndefined();
    }
  });

  it('does not fall through to a later copy when the first is malformed', () => {
    // First match decides. Skipping a bad value to try the next would let
    // whoever can add cookies choose which one is read.
    expect(readCookie(request(`${NAME}=bad; ${NAME}=${TOKEN}`), NAME)).toBeUndefined();
  });

  it('accepts the bounds of the token shape', () => {
    expect(readCookie(request(`${NAME}=${'a'.repeat(20)}`), NAME)).toBe('a'.repeat(20));
    expect(readCookie(request(`${NAME}=${'a'.repeat(200)}`), NAME)).toBe('a'.repeat(200));
  });

  it('skips a pair with no "=" rather than misreading it', () => {
    expect(readCookie(request(`${NAME}; ${NAME}=${TOKEN}`), NAME)).toBe(TOKEN);
  });
});

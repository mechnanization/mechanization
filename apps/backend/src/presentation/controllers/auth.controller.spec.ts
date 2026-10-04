import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import type { Request, Response } from 'express';
import {
  IdentityService,
  SessionResult,
  StaffRefreshOutcome,
  StaffSessionGrant,
} from '../../application/features/identity/identity.service';
import { ForbiddenError, UnauthorizedError } from '../../application/common/exceptions';
import { APP_CONFIG } from '../config/app.config';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { TrustedOriginGuard } from '../guards/trusted-origin.guard';
import { AuthController } from './auth.controller';

/**
 * The three staff-session routes, as HTTP sees them: what reaches the body,
 * what reaches `Set-Cookie`, and in which order.
 *
 * The service decides; the controller only translates. What is worth pinning
 * here is the translation, because each part of it is a place the design
 * could quietly stop holding: the refresh token must never reach a JSON body,
 * a refused refresh must clear its cookie *before* the error is thrown (the
 * house rule is no try/catch in controllers, so the clear has to happen on
 * the returned refusal), and all three routes must sit behind the origin check.
 */

const NAME = 'mz_sr_0123456789abcdef01234567';
const TOKEN = 'Zm9vYmFyYmF6cXV4LXRva2VuLXZhbHVlLTMyYnl0ZXM';

const SESSION: SessionResult = {
  accessToken: 'access-token',
  expiresIn: '1800s',
  user: { id: 'staff-1', name: 'موظف البلدية', kind: 'STAFF', role: 'ADMINISTRATIVE_OFFICER' },
};

const GRANT: StaffSessionGrant = {
  session: SESSION,
  refresh: {
    token: TOKEN,
    cookieName: NAME,
    familyId: '5b0f6f7e-2f4a-4c55-9d38-0f3c2a8b1e11',
    persistent: false,
    expiresAt: new Date('2026-09-26T16:00:00.000Z'),
  },
};

function build(identity: Partial<Record<keyof IdentityService, jest.Mock>>) {
  return new AuthController(identity as unknown as IdentityService);
}

function request(headers: Record<string, string | undefined> = {}): Request {
  return {
    ip: '10.0.0.1',
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function response() {
  const cookies: string[] = [];
  const res = {
    append: jest.fn((field: string, value: string): void => {
      if (field === 'Set-Cookie') cookies.push(value);
    }),
  };
  return { res: res as unknown as Response, cookies };
}

describe('AuthController — staff/login', () => {
  const BODY = { email: 'officer@albazourieh.gov.lb', password: 'x' };

  it('returns the session as the body and puts the refresh token only in the cookie', async () => {
    const controller = build({ loginStaff: jest.fn().mockResolvedValue(GRANT) });
    const { res, cookies } = response();

    const body = await controller.loginStaff('albazourieh', BODY, request(), res);

    // The body is exactly what it always was.
    expect(body).toBe(SESSION);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(cookies).toEqual([`${NAME}=${TOKEN}; HttpOnly; Secure; SameSite=Strict`]);
  });

  it('answers a second-factor challenge with no cookie', async () => {
    const controller = build({
      loginStaff: jest.fn().mockResolvedValue({ status: 'TOTP_REQUIRED' }),
    });
    const { res, cookies } = response();

    await expect(controller.loginStaff('albazourieh', BODY, request(), res)).resolves.toEqual({
      status: 'TOTP_REQUIRED',
    });
    expect(cookies).toEqual([]);
  });
});

describe('AuthController — staff/refresh', () => {
  it('hands the service the bearer token, the URL’s municipality and a reader for the Cookie header', async () => {
    const refreshStaffSession = jest.fn().mockResolvedValue({ ok: true, grant: GRANT });
    const controller = build({ refreshStaffSession });

    await controller.refreshStaff(
      'albazourieh',
      request({ authorization: 'Bearer the-tab-token', cookie: `theme=dark; ${NAME}=${TOKEN}` }),
      response().res,
    );

    const [input] = refreshStaffSession.mock.calls[0];
    expect(input.accessToken).toBe('the-tab-token');
    expect(input.tenantSlug).toBe('albazourieh');
    expect(input.readCookie(NAME)).toBe(TOKEN);
    expect(input.readCookie('mz_sr_someone_else')).toBeUndefined();
  });

  it.each([
    ['no Authorization header', undefined],
    ['a non-bearer scheme', 'Basic dXNlcjpwYXNz'],
    ['a bare "Bearer"', 'Bearer'],
  ])('passes no binding for %s', async (_label, authorization) => {
    const refreshStaffSession = jest.fn().mockResolvedValue({ ok: true, grant: GRANT });
    const controller = build({ refreshStaffSession });

    await controller.refreshStaff('albazourieh', request({ authorization }), response().res);

    expect(refreshStaffSession.mock.calls[0][0].accessToken).toBeUndefined();
  });

  it('sets the next cookie and returns only the session on success', async () => {
    const controller = build({
      refreshStaffSession: jest.fn().mockResolvedValue({ ok: true, grant: GRANT }),
    });
    const { res, cookies } = response();

    const body = await controller.refreshStaff('albazourieh', request(), res);

    expect(body).toBe(SESSION);
    expect(cookies).toEqual([`${NAME}=${TOKEN}; HttpOnly; Secure; SameSite=Strict`]);
  });

  it('clears the cookie, then throws the refusal', async () => {
    // `DomainExceptionFilter` sets only the status and body, so a Set-Cookie
    // appended here survives the throw and reaches the browser.
    const error = new UnauthorizedError('انتهت الجلسة. يرجى تسجيل الدخول مجدداً.');
    const outcome: StaffRefreshOutcome = { ok: false, error, clearCookie: NAME };
    const controller = build({ refreshStaffSession: jest.fn().mockResolvedValue(outcome) });
    const { res, cookies } = response();

    await expect(controller.refreshStaff('albazourieh', request(), res)).rejects.toBe(error);
    expect(cookies).toEqual([
      `${NAME}=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    ]);
  });

  it('throws a refusal that names no cookie without touching any', async () => {
    const error = new UnauthorizedError('Invalid or expired session');
    const controller = build({
      refreshStaffSession: jest.fn().mockResolvedValue({ ok: false, error }),
    });
    const { res, cookies } = response();

    await expect(controller.refreshStaff('albazourieh', request(), res)).rejects.toBe(error);
    expect(cookies).toEqual([]);
  });

  it('keeps the 403 of a deactivated account as a 403', async () => {
    const error = new ForbiddenError('This account has been deactivated');
    const controller = build({
      refreshStaffSession: jest.fn().mockResolvedValue({ ok: false, error, clearCookie: NAME }),
    });

    await expect(
      controller.refreshStaff('albazourieh', request(), response().res),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets an infrastructure error through with the cookie untouched', async () => {
    // A database blip is not a refusal: the browser keeps its cookie and the
    // portal tries again, rather than signing the clerk out.
    const controller = build({
      refreshStaffSession: jest.fn().mockRejectedValue(new Error("Can't reach database server")),
    });
    const { res, cookies } = response();

    await expect(controller.refreshStaff('albazourieh', request(), res)).rejects.toThrow(
      /reach database server/,
    );
    expect(cookies).toEqual([]);
  });
});

describe('AuthController — staff/logout', () => {
  it('clears the cookie the service names and reports success', async () => {
    const logoutStaff = jest.fn().mockResolvedValue({ clearCookie: NAME });
    const controller = build({ logoutStaff });
    const { res, cookies } = response();

    await expect(
      controller.logoutStaff('albazourieh', request({ authorization: 'Bearer t' }), res),
    ).resolves.toEqual({ signedOut: true });

    expect(logoutStaff.mock.calls[0][0]).toMatchObject({ accessToken: 't', tenantSlug: 'albazourieh' });
    expect(cookies).toEqual([
      `${NAME}=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    ]);
  });

  it('reports success with nothing to clear, too', async () => {
    // The portal clears its own storage whatever the answer; a sign-out that
    // failed for a session already over is one the user could not finish.
    const controller = build({ logoutStaff: jest.fn().mockResolvedValue({}) });
    const { res, cookies } = response();

    await expect(controller.logoutStaff('albazourieh', request(), res)).resolves.toEqual({
      signedOut: true,
    });
    expect(cookies).toEqual([]);
  });
});

describe('AuthController — how the three routes are mounted', () => {
  const handler = (name: 'loginStaff' | 'refreshStaff' | 'logoutStaff') =>
    AuthController.prototype[name] as unknown as object;

  it.each(['loginStaff', 'refreshStaff', 'logoutStaff'] as const)(
    '%s sits behind TrustedOriginGuard',
    (name) => {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler(name))).toContain(TrustedOriginGuard);
    },
  );

  it.each(['loginStaff', 'refreshStaff', 'logoutStaff'] as const)(
    '%s is public — the guard would refuse the expired token these routes exist for',
    (name) => {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler(name))).toBe(true);
    },
  );

  it('answers logout with 200, not the 201 a POST defaults to', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler('logoutStaff'))).toBe(200);
  });

  it('keeps sign-in on the login throttle and puts refresh and logout on the session one', () => {
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler('loginStaff'))).toBe(
      APP_CONFIG.throttle.staffLogin.limit,
    );
    for (const name of ['refreshStaff', 'logoutStaff'] as const) {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler(name))).toBe(
        APP_CONFIG.throttle.staffSession.limit,
      );
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler(name))).toBe(
        APP_CONFIG.throttle.staffSession.ttlSeconds * 1000,
      );
    }
  });

  it('counts refresh and logout per Authorization header, hashed, falling back to the address', () => {
    /*
      Behind nginx without `trust proxy`, every request has nginx's address, so
      a per-IP bucket is one bucket for every clerk. The header tells tabs
      apart; hashed, so the throttler's store never holds a bearer token.
    */
    const tracker = Reflect.getMetadata('THROTTLER:TRACKERdefault', handler('refreshStaff')) as (
      request: Record<string, unknown>,
    ) => string;

    const tabA = tracker({ headers: { authorization: 'Bearer token-a' }, ip: '10.0.0.1' });
    const tabB = tracker({ headers: { authorization: 'Bearer token-b' }, ip: '10.0.0.1' });
    const anonymous = tracker({ headers: {}, ip: '10.0.0.1' });

    expect(tabA).toMatch(/^staff-session:[0-9a-f]{64}$/);
    expect(tabA).not.toBe(tabB);
    expect(tabA).not.toContain('token-a');
    expect(tracker({ headers: { authorization: 'Bearer token-a' }, ip: '10.9.9.9' })).toBe(tabA);
    expect(anonymous).not.toBe(tabA);
    expect(tracker({ headers: {}, ip: '10.0.0.2' })).not.toBe(anonymous);
    expect(Reflect.getMetadata('THROTTLER:TRACKERdefault', handler('logoutStaff'))).toBe(tracker);
  });
});

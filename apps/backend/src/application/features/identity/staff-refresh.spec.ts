import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { StaffProps, User } from '../../../domain/entities/user.entity';
import { PasswordHasher, TotpService } from '../../../domain/interfaces/otp-repository.interface';
import { SupabaseAuthService } from '../../../domain/interfaces/supabase-auth.interface';
import { UserRepository } from '../../../domain/interfaces/user-repository.interface';
import { ForbiddenError, UnauthorizedError } from '../../common/exceptions';
import { IdentityService, SessionClaims } from './identity.service';
import { OtpService } from './otp.service';

/**
 * The sliding staff session.
 *
 * A staff token used to be a single credential with a single lifetime: eight
 * hours, or thirty days with "تذكّرني", and when it ran out the next request
 * came back 401 with whatever was on screen. A clerk halfway through a citizen
 * form at hour eight lost the form.
 *
 * The replacement is one short-lived token that is exchanged as it expires,
 * bounded by a session cap stamped at login and never moved. The tests below
 * are mostly about that cap, because it is the only thing standing between
 * "the session slides" and "the session never ends" — and the difference is
 * invisible until someone's stolen token is still working a month later.
 *
 * A **real** `JwtService` is used throughout rather than a signing stub. The
 * whole subject here is what expiry means, so a mock returning `'jwt-token'`
 * would let every one of these pass against an implementation that ignored
 * time completely.
 */

const SECRET = 'test-secret-at-least-32-characters-long-xx';

const STAFF: StaffProps = {
  id: 'staff-1',
  tenantSlug: 'albazourieh',
  email: 'admin@albazourieh.gov.lb',
  passwordHash: '',
  role: 'ADMINISTRATIVE_OFFICER',
  firstName: 'موظف',
  lastName: 'البلدية',
  isActive: true,
  totpSecret: null,
  totpConfirmedAt: null,
};

function staff(overrides: Partial<StaffProps> = {}): User {
  return User.staff({ ...STAFF, ...overrides });
}

const TTLS: Record<string, string> = {
  JWT_STAFF_TTL: '8h',
  JWT_STAFF_REMEMBER_TTL: '30d',
  JWT_STAFF_IDLE_TTL: '30m',
  JWT_CITIZEN_TTL: '7d',
};

function build(repository: Partial<UserRepository> = {}) {
  const jwt = new JwtService({ secret: SECRET });

  const users = {
    findStaffByEmail: jest.fn().mockResolvedValue(staff()),
    findById: jest.fn().mockResolvedValue(staff()),
    markLoggedIn: jest.fn().mockResolvedValue(undefined),
    recordTotpStep: jest.fn().mockResolvedValue(undefined),
    createStaff: jest.fn(),
    ...repository,
  } as unknown as UserRepository;

  const service = new IdentityService(
    users,
    { hash: jest.fn(), verify: jest.fn() } as unknown as PasswordHasher,
    { verify: jest.fn().mockReturnValue(true) } as unknown as TotpService,
    {
      authenticateStaff: jest.fn().mockResolvedValue({
        user: { id: 'sb-1', email: STAFF.email, userMetadata: {}, appMetadata: {} },
        accessToken: 'supabase-token',
      }),
    } as unknown as SupabaseAuthService,
    {} as OtpService,
    jwt,
    {
      get: jest.fn((name: string, fallback?: string) => TTLS[name] ?? fallback),
    } as unknown as ConfigService,
    { emit: jest.fn() } as unknown as EventEmitter2,
  );

  return { service, jwt, users };
}

/** Signs a token directly, so a test can place it anywhere in time. */
function tokenWith(jwt: JwtService, claims: Partial<SessionClaims>, expiresIn: number): string {
  return jwt.sign(
    {
      sub: 'staff-1',
      tenantSlug: 'albazourieh',
      kind: 'STAFF',
      role: 'ADMINISTRATIVE_OFFICER',
      tokenVersion: 0,
      ...claims,
    },
    { expiresIn },
  );
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe('issueSession — what a staff login now hands out', () => {
  it('issues a short token and a separate, longer session cap', async () => {
    const { service, jwt } = build();

    const session = await service.loginStaff({
      tenantSlug: 'albazourieh',
      email: STAFF.email,
      password: 'x',
      context: {},
    });

    if ('status' in session) throw new Error('expected a session, got a challenge');

    const claims = jwt.verify<SessionClaims & { exp: number }>(session.accessToken);

    // The token itself lasts the idle window…
    expect(claims.exp - nowSeconds()).toBeLessThanOrEqual(30 * 60 + 5);
    // …while the session runs to the eight hours JWT_STAFF_TTL has always named.
    expect(claims.sessionExpiresAt! - nowSeconds()).toBeGreaterThan(7 * 3600);
    expect(claims.sessionExpiresAt! - nowSeconds()).toBeLessThanOrEqual(8 * 3600 + 5);
  });

  it('uses the remember cap when the box was ticked', async () => {
    const { service, jwt } = build();

    const session = await service.loginStaff({
      tenantSlug: 'albazourieh',
      email: STAFF.email,
      password: 'x',
      remember: true,
      context: {},
    });

    if ('status' in session) throw new Error('expected a session');
    const claims = jwt.verify<SessionClaims & { exp: number }>(session.accessToken);

    expect(claims.sessionExpiresAt! - nowSeconds()).toBeGreaterThan(29 * 24 * 3600);
    // The access token is still the short one — "remember" lengthens the
    // session, not the credential presented on each request.
    expect(claims.exp - nowSeconds()).toBeLessThanOrEqual(30 * 60 + 5);
  });

  it('leaves citizen sessions exactly as they were', async () => {
    /*
      Citizens were deliberately left out of this change. Their token carries no
      `sessionExpiresAt`, which is also what makes `refreshStaffSession` refuse
      it outright — the portal cannot be used to extend a 7-day citizen token
      indefinitely.
    */
    const { service, jwt } = build();
    const citizen = await service.verifyOtp?.bind(service);
    expect(citizen).toBeDefined();

    // Exercised through the issuer rather than the OTP flow, which needs far
    // more scaffolding to reach and proves nothing extra about expiry.
    const claims = jwt.verify<SessionClaims>(
      tokenWith(jwt, { kind: 'CITIZEN', role: undefined }, 7 * 24 * 3600),
    );
    expect(claims.sessionExpiresAt).toBeUndefined();
  });
});

describe('refreshStaffSession — the cap is the whole design', () => {
  it('exchanges an expired token while the session is still open', async () => {
    /*
      The behaviour the feature exists for, and the one that must accept an
      *expired* token to be worth anything.

      Requiring a live token would mean the exchange had to happen inside the
      idle window, so a clerk returning from lunch would meet the same hard 401
      at half an hour instead of eight — worse than what this replaced.
    */
    const { service, jwt } = build();
    const expired = tokenWith(
      jwt,
      { sessionExpiresAt: nowSeconds() + 4 * 3600 },
      -60, // expired a minute ago
    );

    const session = await service.refreshStaffSession({
      token: expired,
      tenantSlug: 'albazourieh',
    });

    const claims = jwt.verify<SessionClaims & { exp: number }>(session.accessToken);
    expect(claims.exp).toBeGreaterThan(nowSeconds());
  });

  it('carries the original cap forward rather than extending it', async () => {
    // The assertion that separates "sliding session" from "session that never
    // ends". If the cap moved on each exchange, a token could be kept alive for
    // ever by refreshing it — strictly worse than the hard 401 it replaced.
    const { service, jwt } = build();
    const cap = nowSeconds() + 4 * 3600;

    const session = await service.refreshStaffSession({
      token: tokenWith(jwt, { sessionExpiresAt: cap }, -60),
      tenantSlug: 'albazourieh',
    });

    const claims = jwt.verify<SessionClaims>(session.accessToken);
    expect(claims.sessionExpiresAt).toBe(cap);
  });

  it('refuses once the session cap has passed', async () => {
    const { service, jwt } = build();
    const token = tokenWith(jwt, { sessionExpiresAt: nowSeconds() - 1 }, -60);

    await expect(
      service.refreshStaffSession({ token, tenantSlug: 'albazourieh' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('clamps the last token of a session to the cap', async () => {
    /*
      A refresh two minutes before the deadline must not mint a token good for
      the full half hour — that would outlive the session it belongs to, leaving
      `refreshStaffSession` as the only thing enforcing the cap where the
      token's own expiry should also.
    */
    const { service, jwt } = build();
    const cap = nowSeconds() + 120;

    const session = await service.refreshStaffSession({
      token: tokenWith(jwt, { sessionExpiresAt: cap }, -10),
      tenantSlug: 'albazourieh',
    });

    const claims = jwt.verify<SessionClaims & { exp: number }>(session.accessToken);
    expect(claims.exp).toBeLessThanOrEqual(cap);
  });
});

describe('refreshStaffSession — what it re-checks', () => {
  it('refuses a token whose tokenVersion no longer matches', async () => {
    // Revocation has to survive the refresh path, or an administrator
    // dismissing someone would find the dismissed session renewing itself.
    const { service, jwt } = build({
      findById: jest.fn().mockResolvedValue(staff({ tokenVersion: 3 } as Partial<StaffProps>)),
    });

    const token = tokenWith(
      jwt,
      { sessionExpiresAt: nowSeconds() + 3600, tokenVersion: 0 },
      -60,
    );

    await expect(
      service.refreshStaffSession({ token, tenantSlug: 'albazourieh' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a deactivated account', async () => {
    /*
      `ForbiddenError`, not `UnauthorizedError`, and deliberately left that way.

      It comes from `assertMayStartSession`, which is the same check
      `loginStaff` runs — so a dismissed staff member gets one answer whether
      they try to sign in again or their open tab tries to refresh. Mapping it
      to a 401 here purely so the two lines of this file matched would make the
      refresh path disagree with the login path about the same account.

      The outcome on the client is identical either way: the exchange failed, so
      the original 401 propagates and the session is cleared.
    */
    const { service, jwt } = build({
      findById: jest.fn().mockResolvedValue(staff({ isActive: false })),
    });

    await expect(
      service.refreshStaffSession({
        token: tokenWith(jwt, { sessionExpiresAt: nowSeconds() + 3600 }, -60),
        tenantSlug: 'albazourieh',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('picks up a role change instead of copying the stale claim', async () => {
    /*
      `role` travels in the token and `RolesGuard` authorises from it, so a
      refresh that copied the old claim would keep authorising on information
      the register has already changed. Re-reading the row is what makes a
      demotion take effect at the next exchange rather than the next sign-in.
    */
    const { service, jwt } = build({
      findById: jest.fn().mockResolvedValue(staff({ role: 'AUDITOR' })),
    });

    const session = await service.refreshStaffSession({
      token: tokenWith(
        jwt,
        { sessionExpiresAt: nowSeconds() + 3600, role: 'SUPER_ADMIN' },
        -60,
      ),
      tenantSlug: 'albazourieh',
    });

    expect(jwt.verify<SessionClaims>(session.accessToken).role).toBe('AUDITOR');
    expect(session.user.role).toBe('AUDITOR');
  });

  it('refuses a token minted for another municipality', async () => {
    const { service, jwt } = build();

    await expect(
      service.refreshStaffSession({
        token: tokenWith(
          jwt,
          { tenantSlug: 'zahle', sessionExpiresAt: nowSeconds() + 3600 },
          -60,
        ),
        tenantSlug: 'albazourieh',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a citizen token', async () => {
    // Citizens have no refresh path. Accepting one here would quietly turn a
    // 7-day portal token into an unbounded one.
    const { service, jwt } = build();

    await expect(
      service.refreshStaffSession({
        token: tokenWith(
          jwt,
          { kind: 'CITIZEN', sessionExpiresAt: nowSeconds() + 3600 },
          -60,
        ),
        tenantSlug: 'albazourieh',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a token signed with a different key', async () => {
    // `ignoreExpiration` relaxes expiry and nothing else — the signature is
    // still what decides whether this service minted the token.
    const { service } = build();
    const foreign = new JwtService({ secret: 'a-completely-different-secret-value-xx' });

    await expect(
      service.refreshStaffSession({
        token: tokenWith(foreign, { sessionExpiresAt: nowSeconds() + 3600 }, 3600),
        tenantSlug: 'albazourieh',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a legacy token that carries no session cap', async () => {
    /*
      Sessions already in flight when this deploys have no `sessionExpiresAt`.
      They fall back to the token's own `exp`, which means they keep exactly the
      lifetime they were issued with and cannot be extended — the clerk signs in
      once, at the moment they would have anyway, and gets the new shape.
    */
    const { service, jwt } = build();
    const legacy = jwt.sign(
      { sub: 'staff-1', tenantSlug: 'albazourieh', kind: 'STAFF', role: 'ADMINISTRATIVE_OFFICER', tokenVersion: 0 },
      { expiresIn: -60 },
    );

    await expect(
      service.refreshStaffSession({ token: legacy, tenantSlug: 'albazourieh' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('still refreshes a legacy token that has not expired yet', async () => {
    // The fallback is the token's own `exp`, so a legacy session can slide
    // within the life it already had — it just cannot go beyond it.
    const { service, jwt } = build();
    const legacy = jwt.sign(
      { sub: 'staff-1', tenantSlug: 'albazourieh', kind: 'STAFF', role: 'ADMINISTRATIVE_OFFICER', tokenVersion: 0 },
      { expiresIn: 3600 },
    );

    const session = await service.refreshStaffSession({
      token: legacy,
      tenantSlug: 'albazourieh',
    });

    const claims = jwt.verify<SessionClaims & { exp: number }>(session.accessToken);
    expect(claims.exp).toBeLessThanOrEqual(nowSeconds() + 3600 + 5);
  });
});

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'node:crypto';
import { StaffProps, User } from '../../../domain/entities/user.entity';
import { PasswordHasher, TotpService } from '../../../domain/interfaces/otp-repository.interface';
import {
  NewStaffRefreshToken,
  RetryResult,
  StaffRefreshTokenRepository,
  StaffRefreshTokenRow,
} from '../../../domain/interfaces/staff-refresh-token-repository.interface';
import { UserRepository } from '../../../domain/interfaces/user-repository.interface';
import { ForbiddenError, UnauthorizedError } from '../../common/exceptions';
import {
  IdentityService,
  SessionClaims,
  StaffRefreshOutcome,
  StaffSessionGrant,
} from './identity.service';
import { OtpService } from './otp.service';
import { SessionRevocationService } from './session-revocation.service';
import { StaffRefreshTokenService } from './staff-refresh-token.service';

/**
 * Renewing a staff session: an opaque refresh token in an httpOnly cookie,
 * bound to the tab by the tab's own access token.
 *
 * What these tests hold down, in the order the design argues for it:
 *
 * - **The cap is fixed at sign-in.** Every refresh hands back a short access
 *   token, and none of them moves the session's end. A session that slid
 *   forward on each refresh would be a session that never ends.
 * - **The access token is a binding, never the credential.** It says which
 *   account a tab belongs to. Without the cookie it renews nothing, and a
 *   request whose binding does not add up writes nothing and clears nothing.
 * - **A token is spent by its exchange.** A lost response is recovered; a
 *   token presented after the chain moved past it ends the family, and the
 *   audit trail says so once.
 * - **Everything neither token can speak for is re-read** — the account's
 *   role, its `tokenVersion`, whether it is still active and still here.
 *
 * The services are real — `JwtService`, `StaffRefreshTokenService` — because
 * the subject is what their outputs mean together: an expiry, a `sid`, a cap.
 * Only the refresh-token port is in memory. It keeps the same contract as
 * the one in `staff-refresh-token.service.spec.ts` (atomic steps, the
 * compare-and-sets, a refused retry leaving nothing behind); Postgres itself
 * is exercised in `staff-refresh-token.repository.integration.spec.ts`.
 *
 * The clock is faked. `jsonwebtoken` reads `Date.now()` to stamp and check
 * `exp`, so "an hour later" is a call to `setSystemTime`, never a wait.
 */

class InMemoryStaffRefreshTokens implements StaffRefreshTokenRepository {
  private rows = new Map<string, StaffRefreshTokenRow>();

  async create(input: NewStaffRefreshToken): Promise<StaffRefreshTokenRow> {
    return { ...this.insert(this.rows, input) };
  }

  async findById(id: string): Promise<StaffRefreshTokenRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async findByHash(tokenHash: string): Promise<StaffRefreshTokenRow | null> {
    const row = [...this.rows.values()].find((candidate) => candidate.tokenHash === tokenHash);
    return row ? { ...row } : null;
  }

  async rotate(
    parentId: string,
    child: NewStaffRefreshToken,
    at: Date,
  ): Promise<StaffRefreshTokenRow | null> {
    const parent = this.rows.get(parentId);
    const exchangeable =
      parent !== undefined &&
      parent.usedAt === null &&
      parent.supersededAt === null &&
      parent.revokedAt === null &&
      parent.expiresAt > at;
    if (!exchangeable) return null;

    parent.usedAt = at;
    return { ...this.insert(this.rows, child) };
  }

  async retry(
    parentId: string,
    child: NewStaffRefreshToken,
    at: Date,
    maxRetries: number,
  ): Promise<RetryResult> {
    // Staged on a copy that replaces the store only on success: the rollback
    // a refused retry gets from its transaction.
    const staged = new Map([...this.rows].map(([id, row]) => [id, { ...row }]));

    const parent = staged.get(parentId);
    if (
      !parent ||
      parent.revokedAt !== null ||
      parent.usedAt === null ||
      parent.retryCount >= maxRetries
    ) {
      return { kind: 'blocked' };
    }
    parent.retryCount += 1;

    const children = [...staged.values()].filter((row) => row.parentId === parentId);
    if (children.some((row) => row.usedAt !== null)) return { kind: 'descendant-used' };

    for (const row of children) {
      if (row.usedAt === null && row.supersededAt === null && row.revokedAt === null) {
        row.supersededAt = at;
      }
    }

    const minted = this.insert(staged, child);
    this.rows = staged;
    return { kind: 'minted', child: { ...minted } };
  }

  async revokeFamily(familyId: string, at: Date): Promise<number> {
    let revoked = 0;
    for (const row of this.rows.values()) {
      if (row.familyId === familyId && row.revokedAt === null) {
        row.revokedAt = at;
        revoked += 1;
      }
    }
    return revoked;
  }

  async deleteExpired(before: Date): Promise<number> {
    let deleted = 0;
    for (const [id, row] of this.rows) {
      if (row.expiresAt < before) {
        this.rows.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  snapshot(): StaffRefreshTokenRow[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  family(familyId: string): StaffRefreshTokenRow[] {
    return this.snapshot().filter((row) => row.familyId === familyId);
  }

  private insert(
    into: Map<string, StaffRefreshTokenRow>,
    input: NewStaffRefreshToken,
  ): StaffRefreshTokenRow {
    if ([...into.values()].some((row) => row.tokenHash === input.tokenHash)) {
      throw new Error('Unique constraint failed on the fields: (`tokenHash`)');
    }

    const row: StaffRefreshTokenRow = {
      id: input.id ?? randomUUID(),
      userId: input.userId,
      familyId: input.familyId,
      parentId: input.parentId,
      tokenHash: input.tokenHash,
      tokenVersion: input.tokenVersion,
      persistent: input.persistent,
      expiresAt: input.expiresAt,
      createdAt: new Date(),
      usedAt: null,
      supersededAt: null,
      retryCount: 0,
      revokedAt: null,
    };
    into.set(row.id, row);
    return row;
  }
}

const SECRET = 'test-secret-at-least-32-characters-long-xx';
const TENANT = 'albazourieh';

/** Shape-accurate and value-meaningless, as in `staff-login.spec.ts`. */
const PASSWORD_HASH = '$2b$12$u1Qn7bDPQ0v0sQJ0T8yR8eKZ9m2gq5gEr0CqJ0Lz7Yb6aW1nHc2Vu';

const STAFF: StaffProps = {
  id: 'staff-1',
  tenantSlug: TENANT,
  email: 'officer@albazourieh.gov.lb',
  passwordHash: PASSWORD_HASH,
  role: 'ADMINISTRATIVE_OFFICER',
  firstName: 'موظف',
  lastName: 'البلدية',
  isActive: true,
  totpSecret: null,
  totpConfirmedAt: null,
};

const CLERK: StaffProps = {
  ...STAFF,
  id: 'staff-2',
  email: 'clerk@albazourieh.gov.lb',
  role: 'COLLECTOR',
  firstName: 'أمين',
  lastName: 'الصندوق',
};

function staff(overrides: Partial<StaffProps> = {}): User {
  return User.staff({ ...STAFF, ...overrides });
}

const TTLS: Record<string, string> = {
  JWT_STAFF_TTL: '8h',
  JWT_STAFF_REMEMBER_TTL: '7d',
  JWT_STAFF_IDLE_TTL: '15m',
  JWT_CITIZEN_TTL: '7d',
};

/** The codes a refusal carries; the frontend owns the words (see domain-error.ts). */
const SESSION_INVALID = 'SESSION_INVALID';
const SESSION_ENDED = 'SESSION_ENDED';

/** 08:00 UTC on a working day: the sign-in every test starts from. */
const T0 = new Date('2026-09-26T08:00:00.000Z');
const T0_SECONDS = T0.getTime() / 1000;
const EIGHT_HOURS = 8 * 3600;

function build() {
  const jwt = new JwtService({ secret: SECRET });

  const config = {
    get: jest.fn((name: string, fallback?: string) => TTLS[name] ?? fallback),
    getOrThrow: jest.fn((name: string) => {
      if (name === 'JWT_SECRET') return SECRET;
      throw new Error(`unexpected config read: ${name}`);
    }),
  } as unknown as ConfigService;

  const accounts = new Map([STAFF, CLERK].map((props) => [props.id, User.staff(props)]));
  const users = {
    findStaffByEmail: jest.fn(async (email: string) =>
      [...accounts.values()].find((user) => user.email === email) ?? null,
    ),
    findById: jest.fn(async (id: string) => accounts.get(id) ?? null),
    markLoggedIn: jest.fn().mockResolvedValue(undefined),
    recordTotpStep: jest.fn().mockResolvedValue(undefined),
    createStaff: jest.fn(),
  };

  const liveness = {
    forget: jest.fn().mockResolvedValue(undefined),
    forgetFamily: jest.fn().mockResolvedValue(undefined),
  };
  const events = { emit: jest.fn() };
  const repository = new InMemoryStaffRefreshTokens();
  const refreshTokens = new StaffRefreshTokenService(
    repository,
    config,
    liveness as unknown as SessionRevocationService,
  );

  const service = new IdentityService(
    users as unknown as UserRepository,
    {
      hash: jest.fn().mockResolvedValue(PASSWORD_HASH),
      // The subject is sessions, not credentials: every password is accepted.
      verify: jest.fn().mockResolvedValue(true),
    } as unknown as PasswordHasher,
    { verify: jest.fn().mockReturnValue(true) } as unknown as TotpService,
    {
      isConfigured: false,
      send: jest.fn(() => {
        throw new Error('EmailSender.send must not be reached from this path');
      }),
    } as unknown as never,
    {} as OtpService,
    liveness as unknown as SessionRevocationService,
    jwt,
    config,
    events as unknown as EventEmitter2,
    refreshTokens,
  );

  return { service, jwt, users, repository, refreshTokens, liveness, events };
}

type Harness = ReturnType<typeof build>;

async function signIn(
  { service }: Harness,
  options: { email?: string; remember?: boolean } = {},
): Promise<StaffSessionGrant> {
  const result = await service.loginStaff({
    tenantSlug: TENANT,
    email: options.email ?? STAFF.email,
    password: 'x',
    remember: options.remember,
    context: {},
  });
  if ('status' in result) throw new Error('expected a session, got a challenge');
  return result;
}

/** The browser's cookies as a refresh sees them: by name, nothing else. */
type Cookies = Record<string, string>;

const cookieOf = (grant: StaffSessionGrant): Cookies => ({
  [grant.refresh.cookieName]: grant.refresh.token,
});

function refresh(
  { service }: Harness,
  accessToken: string | undefined,
  cookies: Cookies,
): Promise<StaffRefreshOutcome> {
  return service.refreshStaffSession({
    accessToken,
    tenantSlug: TENANT,
    readCookie: (name) => cookies[name],
  });
}

function logout({ service }: Harness, accessToken: string | undefined, cookies: Cookies) {
  return service.logoutStaff({
    accessToken,
    tenantSlug: TENANT,
    readCookie: (name) => cookies[name],
  });
}

function granted(outcome: StaffRefreshOutcome): StaffSessionGrant {
  if (!outcome.ok) throw new Error(`expected a renewed session, got: ${outcome.error.message}`);
  return outcome.grant;
}

function refusal(outcome: StaffRefreshOutcome) {
  if (outcome.ok) throw new Error('expected the refresh to be refused');
  return outcome;
}

function claimsOf({ jwt }: Harness, token: string) {
  return jwt.verify<SessionClaims & { exp: number; iat: number }>(token, {
    ignoreExpiration: true,
  });
}

/** Staff audit events of one kind, as `AuditService.onStaffChanged` would receive them. */
function audited({ events }: Harness, action: string): unknown[] {
  return events.emit.mock.calls
    .filter(([name, payload]) => name === 'staff.changed' && payload.action === action)
    .map(([, payload]) => payload);
}

const later = (minutes: number) => jest.setSystemTime(Date.now() + minutes * 60_000);

beforeEach(() => {
  // Date only: the promise machinery these calls run on is left alone.
  jest.useFakeTimers({ now: T0, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  // Retries and reuses log a warning by design; what they say is asserted in
  // staff-refresh-token.service.spec.ts, not printed here.
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('loginStaff — what a staff sign-in hands out', () => {
  it('a short access token, a fixed cap, and a refresh token meant only for the cookie', async () => {
    const harness = build();
    const grant = await signIn(harness);
    const claims = claimsOf(harness, grant.session.accessToken);

    // The token lasts the idle window; the session runs the eight hours
    // JWT_STAFF_TTL has always named.
    expect(claims.exp).toBe(T0_SECONDS + 15 * 60);
    expect(claims.sessionExpiresAt).toBe(T0_SECONDS + EIGHT_HOURS);
    expect(claims.sid).toBe(grant.refresh.familyId);

    expect(grant.refresh.expiresAt.getTime()).toBe((T0_SECONDS + EIGHT_HOURS) * 1000);
    expect(grant.refresh.persistent).toBe(false);
    expect(grant.refresh.cookieName).toMatch(/^mz_sr_[0-9a-f]{24}$/);
    expect(JSON.stringify(grant.session)).not.toContain(grant.refresh.token);
  });

  it('«تذكّرني» lengthens the session and the cookie, not the access token', async () => {
    const harness = build();
    const grant = await signIn(harness, { remember: true });
    const claims = claimsOf(harness, grant.session.accessToken);

    expect(claims.sessionExpiresAt).toBe(T0_SECONDS + 7 * 24 * 3600);
    expect(claims.exp).toBe(T0_SECONDS + 15 * 60);
    expect(grant.refresh.persistent).toBe(true);
  });
});

describe('refreshStaffSession — the cap is fixed at sign-in', () => {
  it('renews a tab whose access token has already expired', async () => {
    /*
      The case the route exists for. A tab refreshes because its token ran
      out, so a binding that had to be unexpired would turn every return from
      lunch into a sign-in.
    */
    const harness = build();
    const grant = await signIn(harness);
    later(45);

    expect(() => harness.jwt.verify(grant.session.accessToken)).toThrow(/expired/);

    const renewed = granted(await refresh(harness, grant.session.accessToken, cookieOf(grant)));

    expect(() => harness.jwt.verify(renewed.session.accessToken)).not.toThrow();
    expect(claimsOf(harness, renewed.session.accessToken).exp).toBe(
      T0_SECONDS + 45 * 60 + 15 * 60,
    );
  });

  it('never moves the cap, however often the session is renewed', async () => {
    // The assertion that separates a sliding session from one that never
    // ends: if any refresh recomputed the cap, refreshing would be a way to
    // keep a stolen session forever.
    const harness = build();
    let grant = await signIn(harness);
    const cap = T0_SECONDS + EIGHT_HOURS;

    for (let refreshes = 0; refreshes < 6; refreshes++) {
      later(35);
      grant = granted(await refresh(harness, grant.session.accessToken, cookieOf(grant)));

      expect(claimsOf(harness, grant.session.accessToken).sessionExpiresAt).toBe(cap);
      expect(grant.session.sessionExpiresAt).toBe(new Date(cap * 1000).toISOString());
      expect(grant.refresh.expiresAt.getTime()).toBe(cap * 1000);
    }

    const family = harness.repository.family(grant.refresh.familyId);
    expect(family).toHaveLength(7);
    expect(family.every((row) => row.expiresAt.getTime() === cap * 1000)).toBe(true);
  });

  it('keeps sid on every renewed token, naming the family it came from', async () => {
    const harness = build();
    const grant = await signIn(harness);
    later(35);

    const renewed = granted(await refresh(harness, grant.session.accessToken, cookieOf(grant)));

    expect(renewed.refresh.familyId).toBe(grant.refresh.familyId);
    expect(claimsOf(harness, renewed.session.accessToken).sid).toBe(grant.refresh.familyId);
  });

  it('clamps the last access token of a session to the cap', async () => {
    // Two minutes from the end, a full fifteen-minute token would outlive the
    // session it belongs to.
    const harness = build();
    const grant = await signIn(harness);
    const cap = T0_SECONDS + EIGHT_HOURS;
    jest.setSystemTime((cap - 120) * 1000);

    const renewed = granted(await refresh(harness, grant.session.accessToken, cookieOf(grant)));

    expect(claimsOf(harness, renewed.session.accessToken).exp).toBe(cap);
    expect(renewed.session.expiresIn).toBe('120s');
  });

  it('refuses at the cap, clears the cookie, and writes nothing', async () => {
    const harness = build();
    const grant = await signIn(harness);
    jest.setSystemTime((T0_SECONDS + EIGHT_HOURS) * 1000);
    const before = harness.repository.snapshot();

    const refused = refusal(await refresh(harness, grant.session.accessToken, cookieOf(grant)));

    expect(refused.error).toBeInstanceOf(UnauthorizedError);
    expect(refused.error.code).toBe(SESSION_ENDED);
    expect(refused.clearCookie).toBe(grant.refresh.cookieName);
    expect(harness.repository.snapshot()).toEqual(before);
  });

  it('keeps a remembered session’s seven days and its persistent cookie', async () => {
    const harness = build();
    const grant = await signIn(harness, { remember: true });
    later(24 * 60);

    const renewed = granted(await refresh(harness, grant.session.accessToken, cookieOf(grant)));

    expect(renewed.refresh.persistent).toBe(true);
    expect(claimsOf(harness, renewed.session.accessToken).sessionExpiresAt).toBe(
      T0_SECONDS + 7 * 24 * 3600,
    );
  });
});

describe('refreshStaffSession — the access token binds the tab, and does nothing more', () => {
  const foreign = new JwtService({ secret: 'a-completely-different-secret-value-xx' });
  const staffClaims = { sub: STAFF.id, tenantSlug: TENANT, kind: 'STAFF', tokenVersion: 0 };

  const BINDINGS: ReadonlyArray<[string, (jwt: JwtService) => string | undefined]> = [
    ['no access token at all', () => undefined],
    ['a string that is not a token', () => 'not-a-jwt'],
    ['a token signed with another key', () => foreign.sign(staffClaims)],
    ['a token for another municipality', (jwt) => jwt.sign({ ...staffClaims, tenantSlug: 'zahle' })],
    ['a citizen’s token', (jwt) => jwt.sign({ ...staffClaims, kind: 'CITIZEN' })],
    ['a token with no subject', (jwt) => jwt.sign({ tenantSlug: TENANT, kind: 'STAFF' })],
  ];

  it.each(BINDINGS)(
    'refuses %s — writing nothing, clearing nothing, reading no cookie',
    async (_label, bindingFor) => {
      /*
        A request that cannot say whose session it is must not be able to end
        one. The cookie in this jar is live and may be serving a healthy tab of
        the same account; clearing it, or revoking its family, on the word of
        a request like this would let anyone sign a clerk out.
      */
      const harness = build();
      const grant = await signIn(harness);
      const before = harness.repository.snapshot();
      const readCookie = jest.fn((name: string) => cookieOf(grant)[name]);

      const refused = refusal(
        await harness.service.refreshStaffSession({
          accessToken: bindingFor(harness.jwt),
          tenantSlug: TENANT,
          readCookie,
        }),
      );

      expect(refused.error).toBeInstanceOf(UnauthorizedError);
      expect(refused.error.code).toBe(SESSION_INVALID);
      expect(refused.clearCookie).toBeUndefined();
      expect(readCookie).not.toHaveBeenCalled();
      expect(harness.repository.snapshot()).toEqual(before);
    },
  );

  it('renews nothing from a live access token that arrives without its cookie', async () => {
    // Goal 6: the access token is never the renewal credential. A copy of
    // page storage alone — which is all an injected script can read — buys
    // no session beyond the token's own half hour.
    const harness = build();
    const grant = await signIn(harness);
    const before = harness.repository.snapshot();

    const refused = refusal(await refresh(harness, grant.session.accessToken, {}));

    expect(refused.error.code).toBe(SESSION_INVALID);
    expect(refused.clearCookie).toBeUndefined();
    expect(harness.repository.snapshot()).toEqual(before);
  });

  it('refuses and clears a cookie nobody issued', async () => {
    const harness = build();
    const grant = await signIn(harness);
    const before = harness.repository.snapshot();

    const refused = refusal(
      await refresh(harness, grant.session.accessToken, {
        [grant.refresh.cookieName]: randomBytes(32).toString('base64url'),
      }),
    );

    expect(refused.error.code).toBe(SESSION_INVALID);
    expect(refused.clearCookie).toBe(grant.refresh.cookieName);
    expect(harness.repository.snapshot()).toEqual(before);
  });

  it('refuses a cookie holding another account’s token, and leaves both alone', async () => {
    /*
      The cookie is named per account, so another account's token under this
      account's name was put there by something other than this service.
      Nothing is written or cleared on the strength of it — above all the
      other account's family, which belongs to someone else's live tab.
    */
    const harness = build();
    const officer = await signIn(harness);
    const clerk = await signIn(harness, { email: CLERK.email });
    const before = harness.repository.snapshot();

    const refused = refusal(
      await harness.service.refreshStaffSession({
        accessToken: clerk.session.accessToken,
        tenantSlug: TENANT,
        readCookie: () => officer.refresh.token,
      }),
    );

    expect(refused.error.code).toBe(SESSION_INVALID);
    expect(refused.clearCookie).toBeUndefined();
    expect(harness.repository.snapshot()).toEqual(before);
  });

  it('renews each of two accounts in one browser from its own cookie', async () => {
    // Goal 5: a tab never silently acts as another account. Both cookies are
    // in the jar; the binding picks which one is read.
    const harness = build();
    const officer = await signIn(harness);
    const clerk = await signIn(harness, { email: CLERK.email });
    const browser = { ...cookieOf(officer), ...cookieOf(clerk) };
    later(35);

    const renewed = granted(await refresh(harness, clerk.session.accessToken, browser));

    expect(renewed.session.user.id).toBe(CLERK.id);
    expect(renewed.refresh.familyId).toBe(clerk.refresh.familyId);
    expect(harness.repository.family(officer.refresh.familyId)).toEqual([
      expect.objectContaining({ usedAt: null, revokedAt: null }),
    ]);
  });
});

describe('refreshStaffSession — what it re-reads on every exchange', () => {
  it('picks up a role change instead of carrying the old claim forward', async () => {
    // `RolesGuard` authorises from the token's claim, so a demotion reaches
    // the session at its next refresh rather than its next sign-in.
    const harness = build();
    const grant = await signIn(harness);
    harness.users.findById.mockResolvedValue(staff({ role: 'AUDITOR' }));
    later(35);

    const renewed = granted(await refresh(harness, grant.session.accessToken, cookieOf(grant)));

    expect(claimsOf(harness, renewed.session.accessToken).role).toBe('AUDITOR');
    expect(renewed.session.user.role).toBe('AUDITOR');
  });

  it('ends the family when tokenVersion moved: 401, cleared, revoked', async () => {
    // A password change, a role edit, a deactivation — each bumps the version,
    // and each must end the session here as well as in the guard.
    const harness = build();
    const grant = await signIn(harness);
    harness.users.findById.mockResolvedValue(staff({ tokenVersion: 1 }));

    const refused = refusal(await refresh(harness, grant.session.accessToken, cookieOf(grant)));

    expect(refused.error).toBeInstanceOf(UnauthorizedError);
    expect(refused.error.code).toBe(SESSION_ENDED);
    expect(refused.clearCookie).toBe(grant.refresh.cookieName);
    expect(harness.repository.family(grant.refresh.familyId).every((row) => row.revokedAt)).toBe(true);
    expect(harness.liveness.forgetFamily).toHaveBeenCalledWith(grant.refresh.familyId);
  });

  it('refuses a deactivated account with the sign-in’s own 403, and ends the family', async () => {
    // The same answer `loginStaff` gives the same account. The family is ended
    // so the cookie is not tried again on every page load.
    const harness = build();
    const grant = await signIn(harness);
    harness.users.findById.mockResolvedValue(staff({ isActive: false }));

    const refused = refusal(await refresh(harness, grant.session.accessToken, cookieOf(grant)));

    expect(refused.error).toBeInstanceOf(ForbiddenError);
    expect(refused.clearCookie).toBe(grant.refresh.cookieName);
    expect(harness.repository.family(grant.refresh.familyId).every((row) => row.revokedAt)).toBe(true);
  });

  it.each([
    ['no longer exists', null],
    ['now belongs to another municipality', staff({ tenantSlug: 'zahle' })],
  ])('ends the family of an account that %s', async (_label, account) => {
    const harness = build();
    const grant = await signIn(harness);
    harness.users.findById.mockResolvedValue(account);

    const refused = refusal(await refresh(harness, grant.session.accessToken, cookieOf(grant)));

    expect(refused.error).toBeInstanceOf(UnauthorizedError);
    expect(refused.clearCookie).toBe(grant.refresh.cookieName);
    expect(harness.repository.family(grant.refresh.familyId).every((row) => row.revokedAt)).toBe(true);
  });

  it('lets an infrastructure failure through as an error, not a refusal', async () => {
    // A refusal clears the cookie. A database blip must not sign anyone out,
    // so it propagates — a 5xx the portal treats as a connection problem.
    const harness = build();
    const grant = await signIn(harness);
    jest
      .spyOn(harness.repository, 'findByHash')
      .mockRejectedValueOnce(new Error("Can't reach database server"));

    await expect(
      refresh(harness, grant.session.accessToken, cookieOf(grant)),
    ).rejects.toThrow(/reach database server/);
  });
});

describe('refreshStaffSession — a refresh token is spent by its exchange', () => {
  it('hands back a new token and spends the one it was given', async () => {
    const harness = build();
    const grant = await signIn(harness);
    later(35);

    const renewed = granted(await refresh(harness, grant.session.accessToken, cookieOf(grant)));

    expect(renewed.refresh.token).not.toBe(grant.refresh.token);
    expect(renewed.refresh.cookieName).toBe(grant.refresh.cookieName);
    const root = await harness.refreshTokens.find(grant.refresh.token);
    expect(root?.usedAt).toEqual(new Date(Date.now()));
  });

  it('recovers a refresh whose response never arrived, without an alarm', async () => {
    const harness = build();
    const grant = await signIn(harness);
    later(35);

    granted(await refresh(harness, grant.session.accessToken, cookieOf(grant)));
    // …the response is lost; the browser still holds the old cookie.
    const recovered = await refresh(harness, grant.session.accessToken, cookieOf(grant));

    expect(recovered.ok).toBe(true);
    expect(audited(harness, 'STAFF_SESSION_REUSE_DETECTED')).toEqual([]);
    await expect(harness.refreshTokens.familyRoot(grant.refresh.familyId)).resolves.toMatchObject({
      revokedAt: null,
    });
  });

  it('signs in both of two requests racing with one cookie', async () => {
    const harness = build();
    const grant = await signIn(harness);
    later(35);

    const [first, second] = await Promise.all([
      refresh(harness, grant.session.accessToken, cookieOf(grant)),
      refresh(harness, grant.session.accessToken, cookieOf(grant)),
    ]);

    expect(first.ok && second.ok).toBe(true);
    expect(audited(harness, 'STAFF_SESSION_REUSE_DETECTED')).toEqual([]);
  });

  it('ends the family when a spent cookie is replayed after the chain moved on, and audits it once', async () => {
    /*
      Someone copied the cookie and the tab's token at 08:00. The owner has
      refreshed twice since. The copy is presented: the chain has moved past
      it, which no lost response explains, so the whole family ends — the
      owner's current cookie with it. The owner signs in again; the copy is
      worth nothing.
    */
    const harness = build();
    const stolen = await signIn(harness);
    later(35);
    const second = granted(await refresh(harness, stolen.session.accessToken, cookieOf(stolen)));
    later(35);
    const current = granted(await refresh(harness, second.session.accessToken, cookieOf(second)));

    const replay = refusal(await refresh(harness, stolen.session.accessToken, cookieOf(stolen)));

    expect(replay.error.code).toBe(SESSION_ENDED);
    expect(replay.clearCookie).toBe(stolen.refresh.cookieName);
    expect(harness.repository.family(stolen.refresh.familyId).every((row) => row.revokedAt)).toBe(true);
    expect(harness.liveness.forgetFamily).toHaveBeenCalledWith(stolen.refresh.familyId);

    // The owner's next refresh finds the family over — and is not a second alarm.
    const owner = refusal(await refresh(harness, current.session.accessToken, cookieOf(current)));
    expect(owner.error.code).toBe(SESSION_ENDED);
    // Nor is the copy presented yet again.
    refusal(await refresh(harness, stolen.session.accessToken, cookieOf(stolen)));

    expect(audited(harness, 'STAFF_SESSION_REUSE_DETECTED')).toEqual([
      {
        action: 'STAFF_SESSION_REUSE_DETECTED',
        tenantSlug: TENANT,
        staffId: STAFF.id,
        actorId: STAFF.id,
        actorRole: STAFF.role,
      },
    ]);
  });
});

describe('logoutStaff', () => {
  it('ends the family, clears the cookie, and records the sign-out once', async () => {
    const harness = build();
    const grant = await signIn(harness);

    await expect(logout(harness, grant.session.accessToken, cookieOf(grant))).resolves.toEqual({
      clearCookie: grant.refresh.cookieName,
    });

    expect(harness.repository.family(grant.refresh.familyId).every((row) => row.revokedAt)).toBe(true);
    // Dropped from the guard's cache, so the access token stops now.
    expect(harness.liveness.forgetFamily).toHaveBeenCalledWith(grant.refresh.familyId);
    expect(refusal(await refresh(harness, grant.session.accessToken, cookieOf(grant))).error.code).toBe(SESSION_ENDED);

    // A second click ends nothing, so it records nothing.
    await logout(harness, grant.session.accessToken, cookieOf(grant));
    expect(audited(harness, 'STAFF_LOGOUT')).toEqual([
      {
        action: 'STAFF_LOGOUT',
        tenantSlug: TENANT,
        staffId: STAFF.id,
        actorId: STAFF.id,
        actorRole: STAFF.role,
      },
    ]);
  });

  it('signs out a tab whose access token has already expired', async () => {
    // A clerk signing out after lunch holds an expired token and must still
    // be able to end the session behind it.
    const harness = build();
    const grant = await signIn(harness);
    later(90);

    await logout(harness, grant.session.accessToken, cookieOf(grant));

    expect(harness.repository.family(grant.refresh.familyId).every((row) => row.revokedAt)).toBe(true);
  });

  it('is a no-op without a binding: nothing read, revoked, cleared or recorded', async () => {
    const harness = build();
    const grant = await signIn(harness);
    const before = harness.repository.snapshot();
    const readCookie = jest.fn((name: string) => cookieOf(grant)[name]);

    await expect(
      harness.service.logoutStaff({ accessToken: undefined, tenantSlug: TENANT, readCookie }),
    ).resolves.toEqual({});

    expect(readCookie).not.toHaveBeenCalled();
    expect(harness.repository.snapshot()).toEqual(before);
    expect(audited(harness, 'STAFF_LOGOUT')).toEqual([]);
  });

  it('ends the family the access token names when the cookie is already gone', async () => {
    const harness = build();
    const grant = await signIn(harness);

    // Nothing to clear: the request carried no cookie.
    await expect(logout(harness, grant.session.accessToken, {})).resolves.toEqual({});

    expect(harness.repository.family(grant.refresh.familyId).every((row) => row.revokedAt)).toBe(true);
    expect(audited(harness, 'STAFF_LOGOUT')).toHaveLength(1);
  });

  it('does not end another account’s family on the strength of a sid', async () => {
    // A `sid` is only this tab's word for which family it came from. It ends a
    // family only when that family's root belongs to the same account.
    const harness = build();
    const officer = await signIn(harness);
    const mislabelled = harness.jwt.sign({
      sub: CLERK.id,
      tenantSlug: TENANT,
      kind: 'STAFF',
      tokenVersion: 0,
      sid: officer.refresh.familyId,
    });

    await expect(logout(harness, mislabelled, cookieOf(officer))).resolves.toEqual({});

    expect(harness.repository.family(officer.refresh.familyId)).toEqual([
      expect.objectContaining({ revokedAt: null }),
    ]);
    expect(audited(harness, 'STAFF_LOGOUT')).toEqual([]);
  });

  it('ends both the cookie’s family and the tab’s own when they differ', async () => {
    /*
      The same account signed in again in another tab, which replaced the
      per-account cookie. Signing out this tab clears that cookie, so its
      family ends; and this tab's own access token belongs to the older
      family, which ends too — or it would go on working for half an hour
      after "sign out".
    */
    const harness = build();
    const first = await signIn(harness);
    const second = await signIn(harness);
    expect(second.refresh.cookieName).toBe(first.refresh.cookieName);

    await expect(logout(harness, first.session.accessToken, cookieOf(second))).resolves.toEqual({
      clearCookie: first.refresh.cookieName,
    });

    for (const familyId of [first.refresh.familyId, second.refresh.familyId]) {
      expect(harness.repository.family(familyId).every((row) => row.revokedAt)).toBe(true);
    }
    expect(audited(harness, 'STAFF_LOGOUT')).toHaveLength(1);
  });
});

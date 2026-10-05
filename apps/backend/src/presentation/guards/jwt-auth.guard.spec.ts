import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedError } from '../../application/common/exceptions';
import { SessionClaims } from '../../application/features/identity/identity.service';
import { SessionRevocationService } from '../../application/features/identity/session-revocation.service';
import { StaffPresenceService } from '../../application/features/identity/staff-presence.service';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * The guard's check on `sid`: the sign-in, not only the account.
 *
 * A staff access token names the refresh-token family it was minted from.
 * Signing out, or a refresh token presented after its chain moved on, revokes
 * that family — and without this check the access token already in the tab
 * would keep working until it expired, so "sign out" would mean "stop
 * refreshing" rather than "stop". The tenant boundary has its own suite
 * (`tenant-isolation.spec.ts`); this one is only about the family.
 */

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const FAMILY = '5b0f6f7e-2f4a-4c55-9d38-0f3c2a8b1e11';

function contextFor(authorization: string) {
  const request: { header: (name: string) => string | undefined; tenant: { slug: string }; user?: SessionClaims } = {
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
    tenant: { slug: 'albazourieh' },
  };

  class StubController {}
  const stubHandler = function handler() {};

  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => stubHandler,
    getClass: () => StubController,
  } as unknown as ExecutionContext;

  return { context, request };
}

function build(options: { current?: boolean; familyLive?: boolean } = {}) {
  const jwt = new JwtService({ secret: SECRET });
  const revocation = {
    isCurrent: jest.fn().mockResolvedValue(options.current ?? true),
    isFamilyLive: jest.fn().mockResolvedValue(options.familyLive ?? true),
  };
  /*
    Presence is best-effort and nothing in this file asserts on it — but it is
    handed in as a real stub rather than `undefined` so a guard that stopped
    awaiting it, or started letting it throw, fails here.
  */
  const presence = { touch: jest.fn().mockResolvedValue(undefined) };
  const guard = new JwtAuthGuard(
    jwt,
    new Reflector(),
    revocation as unknown as SessionRevocationService,
    presence as unknown as StaffPresenceService,
  );

  const bearer = (claims: Partial<SessionClaims>) =>
    `Bearer ${jwt.sign({
      sub: 'staff-1',
      kind: 'STAFF',
      tenantSlug: 'albazourieh',
      role: 'ADMINISTRATIVE_OFFICER',
      tokenVersion: 0,
      ...claims,
    })}`;

  return { guard, revocation, presence, bearer };
}

describe('JwtAuthGuard — the sign-in a staff token belongs to', () => {
  it('admits a token whose family is live, and asks about that family', async () => {
    const { guard, revocation, bearer } = build({ familyLive: true });
    const { context, request } = contextFor(bearer({ sid: FAMILY }));

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(revocation.isFamilyLive).toHaveBeenCalledWith(FAMILY);
    expect(request.user?.sid).toBe(FAMILY);
  });

  it('refuses a token whose family has ended, with the expired-session sentence', async () => {
    // Same words as an expired token: from the caller's side that is exactly
    // what happened, and saying more tells a copier their token was noticed.
    const { guard, bearer } = build({ familyLive: false });
    const { context, request } = contextFor(bearer({ sid: FAMILY }));

    const refusal = guard.canActivate(context);

    await expect(refusal).rejects.toThrow(UnauthorizedError);
    await expect(refusal).rejects.toThrow('Invalid or expired session');
    expect(request.user).toBeUndefined();
  });

  it('leaves a token without sid alone — citizens, and staff tokens from before families', async () => {
    const { guard, revocation, bearer } = build({ familyLive: false });

    await expect(guard.canActivate(contextFor(bearer({})).context)).resolves.toBe(true);
    await expect(
      guard.canActivate(
        contextFor(bearer({ kind: 'CITIZEN', role: undefined, sub: 'citizen-1' })).context,
      ),
    ).resolves.toBe(true);

    expect(revocation.isFamilyLive).not.toHaveBeenCalled();
  });

  it('does not reach the family check for a token the version check already refused', async () => {
    // Order: account first, then sign-in. A revoked account needs no second
    // round trip to be refused.
    const { guard, revocation, bearer } = build({ current: false, familyLive: true });

    await expect(guard.canActivate(contextFor(bearer({ sid: FAMILY })).context)).rejects.toThrow(
      UnauthorizedError,
    );
    expect(revocation.isFamilyLive).not.toHaveBeenCalled();
  });
});

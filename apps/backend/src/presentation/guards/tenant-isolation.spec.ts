import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SessionRevocationService } from '../../application/features/identity/session-revocation.service';
import { StaffPresenceService } from '../../application/features/identity/staff-presence.service';
import { RolesGuard } from './roles.guard';
import {
  ForbiddenError,
  TenantMismatchError,
  UnauthorizedError,
} from '../../application/common/exceptions';
import { SessionClaims } from '../../application/features/identity/identity.service';

/**
 * The isolation test the architecture doc calls for: a valid token for one
 * municipality must not act on another, and the client cache must never hand a
 * schema's client to a different schema.
 *
 * This is the single most consequential property of the whole system — the data
 * is national ID numbers and refugee status — so it is tested at both layers
 * that enforce it rather than assumed from the design.
 */
const SECRET = 'test-secret-that-is-at-least-32-characters-long';

function contextFor(options: {
  authorization?: string;
  tenantSlug?: string;
  user?: SessionClaims;
}): ExecutionContext {
  const request = {
    header: (name: string) =>
      name.toLowerCase() === 'authorization' ? options.authorization : undefined,
    tenant: options.tenantSlug ? { slug: options.tenantSlug } : undefined,
    user: options.user,
  };

  // Reflector reads metadata off the handler and class, so these must be real
  // objects — `undefined` makes Reflect.getMetadata throw rather than miss.
  class StubController {}
  const stubHandler = function handler() {};

  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => stubHandler,
    getClass: () => StubController,
  } as unknown as ExecutionContext;
}

/**
 * Every session in these tests is a live one. Revocation has its own suite
 * (`session-revocation.spec.ts`); here the point is the tenant boundary, and a
 * stub that always says "current" keeps that the only variable.
 */
function liveSessions(): SessionRevocationService {
  return { isCurrent: jest.fn().mockResolvedValue(true) } as unknown as SessionRevocationService;
}

/** Presence is best-effort and asserted nowhere here; it must not refuse a request. */
function presence(): StaffPresenceService {
  return { touch: jest.fn().mockResolvedValue(undefined) } as unknown as StaffPresenceService;
}

describe('JwtAuthGuard — cross-tenant rejection', () => {
  const jwt = new JwtService({ secret: SECRET });
  const reflector = new Reflector();
  const guard = new JwtAuthGuard(jwt, reflector, liveSessions(), presence());

  const tokenFor = (claims: Partial<SessionClaims>): string =>
    jwt.sign({ sub: 'u1', kind: 'STAFF', tenantSlug: 'albazourieh', ...claims });

  it('admits a token whose tenant matches the URL', async () => {
    const context = contextFor({
      authorization: `Bearer ${tokenFor({ tenantSlug: 'albazourieh' })}`,
      tenantSlug: 'albazourieh',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("rejects tenant A's token on tenant B's URL", async () => {
    // The exact scenario the spec names: a perfectly valid, correctly signed,
    // unexpired token — used against another municipality.
    const context = contextFor({
      authorization: `Bearer ${tokenFor({ tenantSlug: 'albazourieh' })}`,
      tenantSlug: 'zahle',
    });

    await expect(guard.canActivate(context)).rejects.toThrow(TenantMismatchError);
  });

  it('rejects a citizen token across tenants too, not just staff', async () => {
    const context = contextFor({
      authorization: `Bearer ${tokenFor({ kind: 'CITIZEN', tenantSlug: 'zahle' })}`,
      tenantSlug: 'albazourieh',
    });

    await expect(guard.canActivate(context)).rejects.toThrow(TenantMismatchError);
  });

  it('rejects a token when no tenant was resolved from the URL', async () => {
    // Guards against a route being mounted outside TenantMiddleware and
    // therefore skipping the comparison entirely.
    const context = contextFor({
      authorization: `Bearer ${tokenFor({})}`,
      tenantSlug: undefined,
    });

    await expect(guard.canActivate(context)).rejects.toThrow(TenantMismatchError);
  });

  it('rejects a token signed with another key', async () => {
    const foreign = new JwtService({ secret: 'a-completely-different-secret-value-32ch' });
    const context = contextFor({
      authorization: `Bearer ${foreign.sign({ sub: 'u1', kind: 'STAFF', tenantSlug: 'albazourieh' })}`,
      tenantSlug: 'albazourieh',
    });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedError);
  });

  it('rejects a missing or non-bearer authorization header', async () => {
    await expect(
      guard.canActivate(contextFor({ tenantSlug: 'albazourieh' })),
    ).rejects.toThrow(UnauthorizedError);
    await expect(
      guard.canActivate(contextFor({ authorization: 'Basic abc', tenantSlug: 'albazourieh' })),
    ).rejects.toThrow(UnauthorizedError);
  });
});

describe('RolesGuard — citizen tokens cannot reach staff routes', () => {
  it('rejects a citizen even though the token is valid for this tenant', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['SUPER_ADMIN']);
    const guard = new RolesGuard(reflector);

    const context = contextFor({
      tenantSlug: 'albazourieh',
      user: { sub: 'c1', kind: 'CITIZEN', tenantSlug: 'albazourieh' },
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenError);
  });

  it('rejects a staff member whose role is not permitted', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['SUPER_ADMIN']);
    const guard = new RolesGuard(reflector);

    const context = contextFor({
      tenantSlug: 'albazourieh',
      user: {
        sub: 's1',
        kind: 'STAFF',
        tenantSlug: 'albazourieh',
        role: 'FIELD_INSPECTOR',
      },
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenError);
  });

  it('admits a staff member holding a permitted role', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['SUPER_ADMIN', 'AUDITOR']);
    const guard = new RolesGuard(reflector);

    const context = contextFor({
      tenantSlug: 'albazourieh',
      user: { sub: 's1', kind: 'STAFF', tenantSlug: 'albazourieh', role: 'AUDITOR' },
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('admits requests to public routes without authentication', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === 'isPublic') return true;
      return undefined;
    });
    const guard = new RolesGuard(reflector);

    const context = contextFor({
      tenantSlug: 'albazourieh',
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('admits requests to routes without role restrictions', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const guard = new RolesGuard(reflector);

    const context = contextFor({
      tenantSlug: 'albazourieh',
      user: { sub: 'c1', kind: 'CITIZEN', tenantSlug: 'albazourieh' },
    });

    expect(guard.canActivate(context)).toBe(true);
  });
});

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { SessionClaims } from '../../application/features/identity/identity.service';
import { SessionRevocationService } from '../../application/features/identity/session-revocation.service';
import { StaffPresenceService } from '../../application/features/identity/staff-presence.service';
import {
  TenantMismatchError,
  UnauthorizedError,
} from '../../application/common/exceptions';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * The single authentication guard, for citizens and staff alike.
 *
 * v1 had `StaffAuthGuard` and `CitizenAuthGuard` verifying two different token
 * formats issued by two different systems, which meant the tenant-match check
 * below existed twice — and a check written twice is one refactor away from
 * existing once. Here `kind` is the only branch, and it only decides *what the
 * token is allowed to reach*, never whether it was verified.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly revocation: SessionRevocationService,
    private readonly presence: StaffPresenceService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedError({ code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' });
    }

    let claims: SessionClaims;
    try {
      claims = this.jwt.verify<SessionClaims>(token);
    } catch {
      // Expired, wrong signature, malformed — all the same answer. Saying which
      // tells an attacker whether they have a real token to work with.
      throw new UnauthorizedError({ code: 'SESSION_INVALID', message: 'Invalid or expired session' });
    }

    /**
     * The check that matters most in a multi-tenant system: a perfectly valid
     * token for municipality A must not act on municipality B. The URL's tenant
     * was already resolved by TenantMiddleware; the token's is compared to it
     * here, before any handler runs.
     */
    const urlTenant = request.tenant?.slug;
    if (!urlTenant || claims.tenantSlug !== urlTenant) {
      throw new TenantMismatchError();
    }

    /**
     * A valid signature is not the same thing as a live session.
     *
     * Everything above this point was true of a dismissed staff member's token
     * too: it is correctly signed, unexpired, and names the right municipality.
     * `role` travels inside it and `RolesGuard` authorises from that claim, so
     * without this comparison a demotion or a dismissal took effect only when
     * the token expired — up to thirty days for "تذكّرني على هذا الجهاز".
     *
     * The lookup is cached for a short window; see `SessionRevocationService`
     * for why that bound is the one to argue about rather than the check
     * itself.
     */
    if (!(await this.revocation.isCurrent(claims.sub, claims.tokenVersion))) {
      // Same sentence an expired token gets. From the caller's side that is
      // exactly what has happened — the session is over.
      throw new UnauthorizedError({ code: 'SESSION_INVALID', message: 'Invalid or expired session' });
    }

    /**
     * The sign-in, not only the account.
     *
     * A staff token carries `sid`, the refresh-token family it was minted
     * from. Signing out, or a refresh token being presented after the chain had
     * moved past it, revokes that family — and without this check the access
     * token already in the tab would go on working until it expired, so
     * "sign out" would mean "stop refreshing" rather than "stop". Scoped to one
     * family, so it ends this sign-in and leaves the same account's others on
     * other devices alone, which bumping `tokenVersion` could not.
     *
     * Tokens without `sid` — citizens, and staff tokens minted before refresh
     * families existed — are unaffected.
     */
    if (claims.sid && !(await this.revocation.isFamilyLive(claims.sid))) {
      throw new UnauthorizedError({ code: 'SESSION_INVALID', message: 'Invalid or expired session' });
    }

    /**
     * «آخر ظهور» — this account was here, now.
     *
     * Stamped after every check has passed, so a rejected token never marks
     * anybody present, and awaited rather than left dangling: an unawaited
     * promise here would be an unhandled rejection on the one path that must
     * never throw. It costs a cache lookup on all but one request a minute
     * (`StaffPresenceService`), it swallows its own failures, and it is a
     * no-op for a citizen token.
     */
    await this.presence.touch(claims.sub, claims.kind);

    request.user = claims;
    return true;
  }

  private extractToken(request: Request): string | undefined {
    const header = request.header('authorization');
    if (!header) return undefined;

    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' ? value : undefined;
  }
}

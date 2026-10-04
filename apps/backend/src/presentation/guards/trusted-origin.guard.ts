import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { ForbiddenError } from '../../application/common/exceptions';

/**
 * Refuses a browser request whose `Origin` is not the portal's.
 *
 * On the routes that set, read or clear the staff refresh cookie — sign-in,
 * refresh, sign-out — and only there. CORS does not do this job: it decides
 * whether page script may *read* a response, not whether the request is made,
 * and a plain cross-site form POST is made, cookies and all, before any CORS
 * check could object. `SameSite=Strict` already keeps the refresh cookie off
 * such a request; this closes the two attacks that need no cookie of ours to
 * work — a login form on another site signing the victim's browser into the
 * attacker's account, and a page quietly signing a clerk out.
 *
 * The list is `CORS_ORIGINS`, read the way `bootstrap.ts` reads it, so there is
 * one place an operator names the portal. No `Origin` at all is let through:
 * browsers send one on every cross-origin request and on every POST, so its
 * absence means a client that is not a browser — a script, a health probe —
 * and those carry no ambient cookie to abuse.
 */
@Injectable()
export class TrustedOriginGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const origin = context.switchToHttp().getRequest<Request>().header('origin');
    if (origin === undefined) return true;

    const trusted = this.config.get<string[]>('CORS_ORIGINS') ?? ['http://localhost:3000'];
    if (!trusted.includes(origin)) {
      throw new ForbiddenError('Request origin is not allowed');
    }

    return true;
  }
}

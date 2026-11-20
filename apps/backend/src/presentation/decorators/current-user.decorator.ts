import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';
import { SessionClaims } from '../../application/features/identity/identity.service';

/**
 * The verified session claims. Only ever populated by JwtAuthGuard, so a handler
 * receiving this has already had its token verified and its tenant matched.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionClaims => {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.user) {
      // Reaching a handler without claims means the route was marked @Public
      // but still asks for a user — a wiring bug, not a client error.
      throw new Error('CurrentUser used on a route that is not behind JwtAuthGuard');
    }
    return request.user;
  },
);

/** What `CurrentTenant` yields: the municipality as TenantMiddleware resolved it. */
export interface RequestTenant {
  id: string;
  slug: string;
  schemaName: string;
  adminPathSegment: string;
}

/**
 * The municipality resolved from the URL by TenantMiddleware.
 *
 * Handlers read this rather than `@Param('tenantSlug')` (task S11 of the
 * 2026-11-14 security audit, N-7): the param is whatever spelling the URL
 * carried, while this is the registry's own row — resolved, case-folded and
 * guaranteed provisioned, on public routes too, since the middleware runs
 * before any guard. One source of truth, not two.
 */
export const CurrentTenant = createParamDecorator(
  /** With a field (`@CurrentTenant('slug')`), that field alone; without one, the whole tenant. */
  (field: keyof RequestTenant | undefined, context: ExecutionContext): RequestTenant | string => {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.tenant) {
      throw new Error('CurrentTenant used on a route that is not behind TenantMiddleware');
    }
    return field ? request.tenant[field] : request.tenant;
  },
);

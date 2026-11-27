import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TenantService } from '../../application/features/tenant/tenant.service';
import { TenantRunner } from '../../infrastructure/context/tenant-runner';
import { NotFoundError } from '../../application/common/exceptions';

/**
 * Resolves `/api/v1/t/:tenantSlug/...` into a municipality, opens the
 * AsyncLocalStorage scope, and puts that municipality's Prisma client inside it.
 *
 * This is where tenant isolation is actually established. Everything downstream
 * — guards, services, repositories — reads the client from the scope, so no
 * handler can act on a tenant supplied in a request body, and no repository has
 * a tenant parameter to get wrong.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly tenants: TenantService,
    private readonly runner: TenantRunner,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const slug = this.extractSlug(req);
    if (!slug) {
      next(new NotFoundError('Municipality'));
      return;
    }

    try {
      // Throws if the tenant is unknown, inactive, or registered but never
      // provisioned — so a half-onboarded municipality fails clearly instead of
      // producing "relation does not exist" from deep inside Prisma.
      const tenant = await this.tenants.resolve(slug);

      /**
       * `require-atomic-updates` reads this as a value assigned after an await
       * from state read before it. That is the shape it warns about, and here
       * it is not a race: `req` belongs to exactly one in-flight request and no
       * other execution can reach this object. The rule cannot see that, and
       * the alternative — restructuring the assignment to satisfy it — would
       * make the middleware harder to read for no safety gained.
       */
      // eslint-disable-next-line require-atomic-updates
      req.tenant = {
        id: tenant.id,
        slug: tenant.slug,
        schemaName: tenant.schemaName,
        adminPathSegment: tenant.adminPathSegment,
      };

      this.runner.runAsTenant(tenant, () => next());
    } catch (error) {
      next(error);
    }
  }

  private extractSlug(req: Request): string | undefined {
    const fromParams = (req.params as Record<string, string | undefined>)?.tenantSlug;
    if (fromParams) return fromParams;

    // Route params are not populated for middleware mounted by path pattern, so
    // fall back to reading the segment straight out of the URL.
    const match = `${req.baseUrl}${req.path}`.match(/\/t\/([a-z0-9][a-z0-9-]*)/i);
    return match?.[1]?.toLowerCase();
  }
}

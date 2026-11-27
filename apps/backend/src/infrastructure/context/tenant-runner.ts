import { Injectable } from '@nestjs/common';
import type { PrismaClient as TenantPrismaClient } from '../../generated/tenant-client';
import { TenantPrismaFactory } from '../prisma/tenant-prisma.factory';
import { TenantContextService } from './tenant-context.service';

/** The registry's three facts a tenant scope is built from. */
export interface TenantRef {
  id: string;
  slug: string;
  schemaName: string;
}

/**
 * Runs a function as one municipality: its schema's client, inside its scope.
 *
 * The one place a tenant scope is built (DRY-09). `TenantMiddleware` uses it for
 * a request and every cross-tenant job for each municipality it walks; building
 * the scope by hand in four places was four chances to pair one tenant's slug
 * with another's client. Outside a request there is no current tenant, so a
 * job has nothing to inherit and must come through here.
 */
@Injectable()
export class TenantRunner {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly clients: TenantPrismaFactory,
  ) {}

  /**
   * `fn` gets the schema's client, which is also the scope's `prisma`. Whatever
   * `fn` returns (a promise included) is returned unchanged, so the middleware's
   * synchronous `next()` stays synchronous.
   */
  runAsTenant<T>(tenant: TenantRef, fn: (prisma: TenantPrismaClient) => T): T {
    const prisma = this.clients.forSchema(tenant.schemaName);
    return this.tenantContext.run(
      { tenantId: tenant.id, tenantSlug: tenant.slug, schemaName: tenant.schemaName, prisma },
      () => fn(prisma),
    );
  }
}

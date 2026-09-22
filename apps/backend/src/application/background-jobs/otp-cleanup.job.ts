import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TENANT_REPOSITORY } from '../../domain/interfaces/base-repository.interface';
import { TenantRepository } from '../../domain/interfaces/tenant-repository.interface';
import { TenantContextService } from '../../infrastructure/context/tenant-context.service';
import { TenantPrismaFactory } from '../../infrastructure/prisma/tenant-prisma.factory';

/**
 * Prunes expired OTP challenges in every tenant schema.
 *
 * Background jobs have no HTTP request, so nothing has opened a tenant scope for
 * them — they must iterate the registry and open one per municipality
 * explicitly. That is the shape of every cross-tenant job in this codebase, and
 * the reason none of them can accidentally run against "the current tenant":
 * outside a request there is no current tenant.
 */
@Injectable()
export class OtpCleanupJob {
  private readonly logger = new Logger(OtpCleanupJob.name);

  constructor(
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepository,
    private readonly tenantContext: TenantContextService,
    private readonly clients: TenantPrismaFactory,
  ) {}

  /**
   * `timeZone` is named rather than inherited: without it the hour boundary is
   * whatever `TZ` the process happens to have, which differs between a
   * developer's machine, a container and a VM. It matters less here than it
   * does for billing — an hourly prune is an hourly prune in any zone — but
   * the two jobs should not be reasoned about differently.
   */
  @Cron(CronExpression.EVERY_HOUR, { timeZone: 'UTC' })
  async pruneExpiredChallenges(): Promise<void> {
    const tenants = await this.tenants.listActive();
    let removed = 0;

    for (const tenant of tenants) {
      const prisma = this.clients.forSchema(tenant.schemaName);

      try {
        await this.tenantContext.run(
          {
            tenantId: tenant.id,
            tenantSlug: tenant.slug,
            schemaName: tenant.schemaName,
            prisma,
          },
          async () => {
            const result = await prisma.otpChallenge.deleteMany({
              where: { expiresAt: { lt: new Date() } },
            });
            removed += result.count;
          },
        );
      } catch (error) {
        // One municipality's failure must not stop the rest: a schema mid
        // migration, or a transient pooler timeout, should cost that tenant an
        // hour of pruning rather than costing every tenant after it in slug
        // order — which is what an unguarded loop did, silently, because the
        // rejection propagated out of the @Cron handler and nothing was left to
        // report which tenants had been skipped.
        this.logger.error(
          `OTP prune failed for '${tenant.slug}': ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }

    if (removed > 0) {
      this.logger.log(`Pruned ${removed} expired OTP challenge(s) across ${tenants.length} tenant(s)`);
    }
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TENANT_REPOSITORY } from '../../domain/interfaces/base-repository.interface';
import { TenantRepository } from '../../domain/interfaces/tenant-repository.interface';
import { TenantContextService } from '../../infrastructure/context/tenant-context.service';
import { TenantPrismaFactory } from '../../infrastructure/prisma/tenant-prisma.factory';

/**
 * Prunes staff refresh-token families past their session cap, in every tenant
 * schema.
 *
 * An expired row is already useless — the refresh refuses a family past its
 * root's `expiresAt`, and the guard's family check does too — so this is
 * housekeeping, not a control. Without it the table grows by a row per refresh
 * forever: a clerk refreshing every half hour for a working day leaves around
 * sixteen. Every row of a family shares one `expiresAt`, so a family is always
 * removed whole.
 *
 * The same shape as `OtpCleanupJob`, for the reason given there: outside a
 * request there is no current tenant, so the job walks the registry and opens
 * a scope per municipality.
 */
@Injectable()
export class StaffRefreshTokenCleanupJob {
  private readonly logger = new Logger(StaffRefreshTokenCleanupJob.name);

  constructor(
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepository,
    private readonly tenantContext: TenantContextService,
    private readonly clients: TenantPrismaFactory,
  ) {}

  /**
   * Daily is plenty: nothing depends on the rows being gone, and the longest
   * family lives thirty days. 03:00 UTC is early morning in Lebanon, away from
   * the working day's refreshes.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { timeZone: 'UTC' })
  async pruneExpired(): Promise<void> {
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
            const result = await prisma.staffRefreshToken.deleteMany({
              where: { expiresAt: { lt: new Date() } },
            });
            removed += result.count;
          },
        );
      } catch (error) {
        // One municipality's failure must not stop the rest — see
        // `OtpCleanupJob` for the incident that made this the house pattern.
        // A schema 0059 has not reached yet lands here too, harmlessly.
        this.logger.error(
          `Staff refresh-token prune failed for '${tenant.slug}': ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }

    if (removed > 0) {
      this.logger.log(
        `Pruned ${removed} expired staff refresh token(s) across ${tenants.length} tenant(s)`,
      );
    }
  }
}

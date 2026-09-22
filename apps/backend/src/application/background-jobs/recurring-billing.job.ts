import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TENANT_REPOSITORY } from '../../domain/interfaces/base-repository.interface';
import { TenantRepository } from '../../domain/interfaces/tenant-repository.interface';
import { TenantContextService } from '../../infrastructure/context/tenant-context.service';
import { TenantPrismaFactory } from '../../infrastructure/prisma/tenant-prisma.factory';
import { FeesService } from '../features/fees/fees.service';

/**
 * Re-issues recurring fees for every municipality, once a day.
 *
 * Daily rather than monthly, and that is deliberate: a monthly schedule has to
 * fire on one specific day, and a deploy, restart or outage on that day would
 * silently skip a municipality's entire billing cycle. Running daily makes the
 * job idempotent-by-repetition — the unique (citizen, notice, period) index
 * turns every run after the first in a period into a no-op, so the only cost
 * of running it 30 times a month is 29 cheap queries, and the benefit is that
 * missing a day costs nothing at all.
 *
 * Like every cross-tenant job here, it has no HTTP request behind it and so no
 * tenant scope: it walks the registry and opens one per municipality.
 */
@Injectable()
export class RecurringBillingJob {
  private readonly logger = new Logger(RecurringBillingJob.name);

  constructor(
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepository,
    private readonly tenantContext: TenantContextService,
    private readonly clients: TenantPrismaFactory,
    private readonly fees: FeesService,
  ) {}

  /**
   * 02:00 **UTC** — after midnight so a fee due "on the 1st" is raised on the
   * 1st, and late enough that it is not competing with whatever else runs at
   * exactly midnight.
   *
   * The zone is named, not inherited from `TZ`, and that is the whole point:
   * `periodKeyFor` derives the period from `getUTCFullYear` / `getUTCMonth`,
   * so a run at 02:00 *Beirut* on the 1st happens at 23:00 UTC on the last day
   * of the month before and computes the **previous** period's key. The job is
   * idempotent by repetition, so that showed up as a month's invoices landing a
   * day late rather than as an error — the kind of thing nobody reports.
   * Matching the decorator's zone to the key's zone removes the boundary
   * entirely, on any host, whatever `TZ` is set to.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { timeZone: 'UTC' })
  async issueDueFees(): Promise<void> {
    await this.runForAllTenants();
  }

  /**
   * Every municipality, in one pass.
   *
   * Driven by the schedule and by `InternalCronController` — **not** by the
   * admin "run now" button. That endpoint used to call this, on a route mounted
   * under `t/:tenantSlug`, so one municipality's accountant issued invoices in
   * all the others. It now runs `FeesService.runRecurringBilling` inside its own
   * tenant scope; a job that crosses tenants does not belong behind a staff role.
   */
  async runForAllTenants(): Promise<{
    tenants: number;
    invoicesCreated: number;
    /**
     * Municipalities whose whole run threw, plus notices that failed inside a
     * run that otherwise succeeded. Non-zero means this pass did **not** cover
     * everything, whatever `invoicesCreated` says — `billing_run_entries` holds
     * which notice and which period.
     */
    failures: number;
  }> {
    const tenants = await this.tenants.listActive();
    let invoicesCreated = 0;
    let failures = 0;

    for (const tenant of tenants) {
      const prisma = this.clients.forSchema(tenant.schemaName);

      try {
        const result = await this.tenantContext.run(
          {
            tenantId: tenant.id,
            tenantSlug: tenant.slug,
            schemaName: tenant.schemaName,
            prisma,
          },
          () => this.fees.runRecurringBilling(),
        );
        invoicesCreated += result.invoicesCreated;
        // Notices that threw inside a run that otherwise completed. Counted
        // here so a partial pass cannot be reported as a clean one.
        failures += result.noticesFailed;
      } catch (error) {
        // One municipality's failure must not stop the rest: a schema mid
        // migration, or a transient pooler timeout, should cost that tenant a
        // day of billing rather than costing every tenant one.
        failures += 1;
        this.logger.error(
          `Recurring billing failed for '${tenant.slug}': ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }

    if (invoicesCreated > 0) {
      this.logger.log(
        `Recurring billing raised ${invoicesCreated} invoice(s) across ${tenants.length} municipality(ies)`,
      );
    }

    /*
      Said out loud, because "0 invoices" and "0 invoices because it broke" look
      identical in a log and mean opposite things. A period the biller never
      covered is not retried — the next run computes the next period — so this
      line is the prompt to go and read `billing_run_entries` while the gap is
      still recent.
    */
    if (failures > 0) {
      this.logger.warn(
        `Recurring billing did not cover everything: ${failures} failure(s). ` +
          'See billing_run_entries for which notice and which period. Nothing is back-billed automatically.',
      );
    }

    return { tenants: tenants.length, invoicesCreated, failures };
  }
}

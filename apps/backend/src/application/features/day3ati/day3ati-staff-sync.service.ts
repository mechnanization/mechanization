import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  DAY3ATI_INTEGRATION,
  type Day3atiIntegration,
} from '../../../domain/interfaces/day3ati-integration.interface';
import { USER_REPOSITORY } from '../../../domain/interfaces/base-repository.interface';
import type { UserRepository } from '../../../domain/interfaces/user-repository.interface';
import { applyStaffSync, planStaffSync } from './staff-sync';

interface StaffChangedEvent {
  tenantSlug: string;
  staffId: string;
  action: string;
  changed?: string[];
}

/**
 * Creates, updates and removes a user's Day3ati staff account as their account
 * here changes (`staff.changed`, the event `StaffService` already emits).
 *
 * - **Never in the way of the save.** The listener starts the work and returns;
 *   a Day3ati that is down, slow or refusing is logged by its code (never a
 *   name or a token) and the staff change stands. The next change to that user,
 *   or the backfill, puts it right.
 * - **Read the row, not the event.** What is sent comes from the account as it
 *   is when the work runs (`planStaffSync`), so a burst of changes ends in the
 *   state of the last.
 * - **One at a time per user.** Two quick changes to the same account are
 *   sent in the order they happened, never racing each other.
 * - **A municipality with no village on Day3ati is left alone** after the first
 *   `integration.tenant_not_mapped`, until the process restarts.
 * - Off, and silent, until the four `DAY3ATI_*` settings are set.
 */
@Injectable()
export class Day3atiStaffSyncService {
  private readonly logger = new Logger(Day3atiStaffSyncService.name);
  private readonly lastWork = new Map<string, Promise<void>>();
  private readonly unmappedTenants = new Set<string>();

  constructor(
    @Inject(DAY3ATI_INTEGRATION) private readonly integration: Day3atiIntegration,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {}

  @OnEvent('staff.changed')
  onStaffChanged(event: StaffChangedEvent): Promise<void> {
    return this.sync(event);
  }

  /** Queues the work and resolves when it is done. The emitter does not wait for it; tests do. */
  sync(event: StaffChangedEvent): Promise<void> {
    if (!this.integration.isConfigured || this.unmappedTenants.has(event.tenantSlug)) return Promise.resolve();

    const key = `${event.tenantSlug}:${event.staffId}`;
    const work = (this.lastWork.get(key) ?? Promise.resolve())
      .then(() => this.run(event))
      .catch((error: unknown) => {
        // Reading the account failed (a database blip). Same rule: log it, never throw into the save.
        this.logger.error(`Day3ati staff sync could not read an account (${describe(error)})`);
      })
      .finally(() => {
        if (this.lastWork.get(key) === work) this.lastWork.delete(key);
      });
    this.lastWork.set(key, work);
    return work;
  }

  private async run(event: StaffChangedEvent): Promise<void> {
    const user = await this.users.findById(event.staffId);
    const plan = planStaffSync({
      action: event.action,
      changed: event.changed,
      user:
        user && user.kind === 'STAFF'
          ? { role: user.role, isActive: user.isActive, fullName: user.fullName }
          : null,
    });

    const result = await applyStaffSync(this.integration, event.tenantSlug, event.staffId, plan);

    if (result.outcome === 'tenant_not_mapped') {
      this.unmappedTenants.add(event.tenantSlug);
      this.logger.warn(
        `Day3ati has no village for the municipality ${event.tenantSlug} (integration.tenant_not_mapped): ` +
          'its staff are not synced until the process restarts.',
      );
    } else if (result.outcome === 'failed') {
      this.logger.error(
        `Day3ati staff sync failed for ${event.action} on ${event.tenantSlug}/${event.staffId} (${result.code}); ` +
          'the next change to this account, or the backfill, will retry.',
      );
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

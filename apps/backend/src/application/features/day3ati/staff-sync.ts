import { hasStaffRole, NEWS_EDITOR_ROLES } from '@mechanization/shared-schemas';
import {
  Day3atiApiError,
  type Day3atiIntegration,
  type Day3atiStaffAccount,
} from '../../../domain/interfaces/day3ati-integration.interface';

/**
 * Keeping Day3ati's staff accounts in step with ours (the News integration).
 *
 * Who has one is decided here, once: a staff account that is active, not
 * deleted, and in `NEWS_EDITOR_ROLES` has a `news_editor` account in Day3ati;
 * everyone else has none. `planStaffSync` reads the account as it is now and
 * says what Day3ati must be told, so a repeated or out-of-order event cannot
 * leave it wrong: the plan never depends on what the event said happened, only
 * on the row.
 */

/** The staff actions that can change who has a Day3ati account. A restore stays disabled, so it changes nothing. */
const SYNCED_ACTIONS: ReadonlySet<string> = new Set([
  'STAFF_CREATED',
  'STAFF_UPDATED',
  'STAFF_DEACTIVATED',
  'STAFF_REACTIVATED',
  'STAFF_DELETED',
]);

/** The fields of an update that Day3ati holds a copy of (the rest, an email or a password, it never sees). */
const SYNCED_FIELDS = ['role', 'firstName', 'lastName'] as const;

/** Our staff have no language of their own yet, and Arabic is the one Day3ati requires. */
export const DAY3ATI_STAFF_LANGUAGE = 'ar' as const;

export interface StaffSyncUser {
  role?: string | null;
  /** False once the account is deactivated or deleted (a delete deactivates it too). */
  isActive: boolean;
  /** «first last», as every screen names a staff member. */
  fullName: string;
}

export type StaffSyncPlan =
  | { kind: 'upsert'; account: Day3atiStaffAccount }
  | { kind: 'remove' }
  | { kind: 'none' };

export function planStaffSync(input: {
  action: string;
  /** For an update: which fields moved. */
  changed?: readonly string[];
  /** The account as it is now; `null` when it cannot be read. */
  user: StaffSyncUser | null;
}): StaffSyncPlan {
  const none: StaffSyncPlan = { kind: 'none' };
  if (!input.user || !SYNCED_ACTIONS.has(input.action)) return none;

  const changed = input.changed ?? [];
  if (input.action === 'STAFF_UPDATED' && !SYNCED_FIELDS.some((field) => changed.includes(field))) return none;

  const isNewsRole = hasStaffRole(NEWS_EDITOR_ROLES, input.user.role);
  const displayName = input.user.fullName.trim();

  if (input.user.isActive && isNewsRole) {
    return displayName ? { kind: 'upsert', account: { displayName, role: 'news_editor', language: DAY3ATI_STAFF_LANGUAGE } } : none;
  }

  // Not (or no longer) an editor. Remove when they were one that stopped (switched off, deleted), or when
  // their role was just changed away from one; a name change on someone who never had an account is no news.
  const mayHaveHadAnAccount = isNewsRole || (input.action === 'STAFF_UPDATED' && changed.includes('role'));
  return mayHaveHadAnAccount ? { kind: 'remove' } : none;
}

export type StaffSyncOutcome =
  | { outcome: 'upserted' | 'removed' | 'skipped' }
  | { outcome: 'tenant_not_mapped' }
  | { outcome: 'failed'; code: string };

/** Pauses between tries when Day3ati did not answer or failed on its side: three tries in all. */
export const STAFF_SYNC_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Tells Day3ati what the plan says. Never throws: a sync that fails is logged
 * by the caller and put right by the next change or the backfill (a PUT and a
 * DELETE are both safe to repeat), and it must never fail the staff save that
 * caused it.
 */
export async function applyStaffSync(
  integration: Day3atiIntegration,
  tenantSlug: string,
  staffId: string,
  plan: StaffSyncPlan,
  pause: (ms: number) => Promise<void> = sleep,
): Promise<StaffSyncOutcome> {
  if (plan.kind === 'none' || !integration.isConfigured) return { outcome: 'skipped' };

  for (let attempt = 0; ; attempt++) {
    try {
      if (plan.kind === 'upsert') {
        await integration.upsertStaff(tenantSlug, staffId, plan.account);
        return { outcome: 'upserted' };
      }
      await integration.removeStaff(tenantSlug, staffId);
      return { outcome: 'removed' };
    } catch (error) {
      if (!(error instanceof Day3atiApiError)) return { outcome: 'failed', code: 'day3ati.unexpected' };
      if (error.isTenantNotMapped) return { outcome: 'tenant_not_mapped' };

      const delay = STAFF_SYNC_RETRY_DELAYS_MS[attempt];
      if (!error.isTransient || delay === undefined) return { outcome: 'failed', code: error.code };
      await pause(delay);
    }
  }
}

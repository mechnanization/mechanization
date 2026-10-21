import type { TransferView } from '@mechanization/shared-schemas';
import { planExpenseDate } from './expenses.plan';

/**
 * The pure rules of المناقلات, apart from the service so they are tested
 * without a database. The exchange's own arithmetic is shared with the form
 * and lives in `exchange-policy.ts`.
 */

export type TransferDateVerdict =
  | { ok: true; transferredOn: string; backdatedDays: number }
  | { ok: false; code: 'TRANSFER_DATE_IN_FUTURE' }
  | { ok: false; code: 'TRANSFER_DATE_BEFORE_GO_LIVE'; goLiveOn: string }
  | { ok: false; code: 'TRANSFER_BACKDATE_REASON_REQUIRED'; backdatedDays: number };

/**
 * The day a transfer is booked on: `planExpenseDate`'s three rules, delegated
 * and renamed rather than copied, as income does. Not in the future; not before
 * go-live, whose money is already in the opening balances; and a day before
 * today says why. A day that has been closed is refused further down, by the
 * ledger, with the day named — the same lock every other entry meets.
 */
export function planTransferDate(input: {
  transferredOn?: string;
  reason?: string | null;
  goLiveOn?: string;
  today?: string;
}): TransferDateVerdict {
  const verdict = planExpenseDate({
    paidOn: input.transferredOn,
    reason: input.reason,
    goLiveOn: input.goLiveOn,
    today: input.today,
  });
  if (verdict.ok) return { ok: true, transferredOn: verdict.paidOn, backdatedDays: verdict.backdatedDays };

  switch (verdict.code) {
    case 'EXPENSE_DATE_IN_FUTURE':
      return { ok: false, code: 'TRANSFER_DATE_IN_FUTURE' };
    case 'EXPENSE_DATE_BEFORE_GO_LIVE':
      return { ok: false, code: 'TRANSFER_DATE_BEFORE_GO_LIVE', goLiveOn: verdict.goLiveOn };
    case 'EXPENSE_BACKDATE_REASON_REQUIRED':
      return { ok: false, code: 'TRANSFER_BACKDATE_REASON_REQUIRED', backdatedDays: verdict.backdatedDays };
  }
}

/**
 * Which kind a transfer is, read from its two ends — never stored, so it can
 * never disagree with them. A handover leaves a collector's custody; an
 * exchange changes currency; anything else is an internal transfer.
 */
export function transferKindOf(
  from: { type: string; currency: string },
  to: { currency: string },
): TransferView['kind'] {
  if (from.type === 'COLLECTOR_CUSTODY') return 'HANDOVER';
  return from.currency === to.currency ? 'SAME_CURRENCY' : 'EXCHANGE';
}

/**
 * Whether this actor may change the exchange rule (docs/finance.md §6.3).
 *
 * The tolerance and the large-exchange threshold travel with the rest of the
 * finance settings (`PATCH fees/settings`), which the accountant may also save.
 * But the accountant books the exchanges these two decide the review of, so
 * moving them is the manager's alone: a change by anyone else is refused. An
 * unchanged value is not a change, so the accountant can still save the rest of
 * the section with the rule sent back as it was. Compared in hundredths, the
 * columns' own precision.
 */
export function exchangeRuleChangeAllowed(input: {
  role: string;
  current: { tolerancePercent: number; largeThreshold: number };
  requested: { tolerancePercent?: number; largeThreshold?: number };
}): boolean {
  if (input.role === 'SUPER_ADMIN') return true;
  const moved = (next: number | undefined, now: number) =>
    next !== undefined && Math.round(next * 100) !== Math.round(now * 100);
  return !(
    moved(input.requested.tolerancePercent, input.current.tolerancePercent) ||
    moved(input.requested.largeThreshold, input.current.largeThreshold)
  );
}

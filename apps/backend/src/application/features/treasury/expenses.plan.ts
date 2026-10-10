import { daysBetween, municipalToday } from '@mechanization/shared-schemas';

/**
 * When an expense may be dated, with no I/O. Design: docs/finance.md §5.
 *
 * Three rules, and each one exists because of what it would otherwise do to a
 * wallet balance:
 *
 * 1. **Not after today.** Money that has not left yet is not an expense, and a
 *    voucher dated forward would take the balance down before the cash moves,
 *    so the day's count would be short against a safe that is still full.
 * 2. **Not before the treasury went live.** The opening balance is a count of
 *    what was in the safe that day, so an expense paid before it is *already*
 *    subtracted. Recording it would take the same money out twice.
 * 3. **Back-dating says why.** Any earlier date is allowed — a collector's
 *    round, an invoice settled on Friday and entered on Monday — but it is a
 *    deliberate act, and the reason goes on the voucher where an auditor reads
 *    it. The same rule the cash counter already applies to a payment.
 */
export type ExpenseDateVerdict =
  | { ok: true; paidOn: string; backdatedDays: number }
  | { ok: false; code: 'EXPENSE_DATE_IN_FUTURE' }
  | { ok: false; code: 'EXPENSE_DATE_BEFORE_GO_LIVE'; goLiveOn: string }
  | { ok: false; code: 'EXPENSE_BACKDATE_REASON_REQUIRED'; backdatedDays: number };

export function planExpenseDate(input: {
  /** `YYYY-MM-DD`; absent means today on the municipality's calendar. */
  paidOn?: string;
  /** The reason the voucher carries, if any. */
  reason?: string | null;
  /** The go-live instant, as the municipality's date. Absent means not live. */
  goLiveOn?: string;
  /** Overridable for the spec; otherwise the municipality's own today. */
  today?: string;
}): ExpenseDateVerdict {
  const today = input.today ?? municipalToday();
  const paidOn = input.paidOn ?? today;

  if (paidOn > today) return { ok: false, code: 'EXPENSE_DATE_IN_FUTURE' };

  if (input.goLiveOn && paidOn < input.goLiveOn) {
    return { ok: false, code: 'EXPENSE_DATE_BEFORE_GO_LIVE', goLiveOn: input.goLiveOn };
  }

  const backdatedDays = paidOn < today ? daysBetween(paidOn, today) : 0;
  if (backdatedDays > 0 && !input.reason?.trim()) {
    return { ok: false, code: 'EXPENSE_BACKDATE_REASON_REQUIRED', backdatedDays };
  }

  return { ok: true, paidOn, backdatedDays };
}

/**
 * The instant a voucher dated `paidOn` is recorded at: midday UTC of that day.
 *
 * The same choice `occurredAtFor` makes for a payment, and for the same reason
 * — midday survives every zone the municipality's reports are read in, so a
 * back-dated voucher never slides onto the day before or after. A voucher for
 * today keeps the real clock time instead, so the day's movements stay in the
 * order they happened.
 */
export function expenseOccurredAt(paidOn: string, today: string, now: Date = new Date()): Date {
  return paidOn === today ? now : new Date(`${paidOn}T12:00:00.000Z`);
}

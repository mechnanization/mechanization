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
 * Whether an accountant's urgent payment is above the manager's ceiling, and
 * which ceiling it broke. Design: docs/finance.md §5.1, decision D6.
 *
 * Decree 5595/1982 art. 35 lets salaries, routine petty expenses and genuinely
 * urgent ones be paid before the payment order. A large purchase is neither
 * petty nor, usually, urgent, so the manager sets a ceiling per currency and
 * anything above it goes to him as a request. The ceiling is per voucher, and
 * an amount equal to it is still under it.
 *
 * Not consulted for the manager's own voucher (it is the order) or for a
 * salary (art. 35 names salaries); the caller decides that. A currency with no
 * ceiling column (anything but LBP and USD), or a ceiling left NULL, has none.
 */
export function urgentCeilingBreached(input: {
  amount: number;
  currency: string;
  ceilings: Partial<Record<string, { toNumber(): number } | null>>;
}): { ceiling: number; currency: string } | null {
  const ceiling = input.ceilings[input.currency];
  if (!ceiling) return null;
  const limit = ceiling.toNumber();
  return input.amount > limit ? { ceiling: limit, currency: input.currency } : null;
}

import { MUNICIPAL_TIME_ZONE } from '@mechanization/shared-schemas';
import { planExpenseDate } from './expenses.plan';

/**
 * When an income voucher may be dated, and which instants a register period
 * covers, with no I/O. Design: docs/finance.md §4.
 *
 * ## The date rules are the expense rules, mirrored
 *
 * The same three, for the same arithmetic run the other way:
 *
 * 1. **Not after today.** Money that has not arrived is not income, and a
 *    voucher dated forward would raise the balance before the cash is there,
 *    so the day's count would find the safe short.
 * 2. **Not before the treasury went live.** The opening balance is a count of
 *    what was in the wallet that day, so a transfer received before it is
 *    *already* in it. Recording it would add the same money twice.
 * 3. **Back-dating says why.** The Fund's transfer that landed on Friday and is
 *    entered on Monday is ordinary, but it is a deliberate act and the reason
 *    goes on the voucher where an auditor reads it.
 *
 * So this delegates to `planExpenseDate` rather than copying it, and only
 * renames the refusals: the rule lives once, and an income refusal still says
 * «إيراد» on the screen rather than «نفقة».
 */
export type IncomeDateVerdict =
  | { ok: true; receivedOn: string; backdatedDays: number }
  | { ok: false; code: 'INCOME_DATE_IN_FUTURE' }
  | { ok: false; code: 'INCOME_DATE_BEFORE_GO_LIVE'; goLiveOn: string }
  | { ok: false; code: 'INCOME_BACKDATE_REASON_REQUIRED'; backdatedDays: number };

export function planIncomeDate(input: {
  /** `YYYY-MM-DD`; absent means today on the municipality's calendar. */
  receivedOn?: string;
  /** The reason the voucher carries, if any. */
  reason?: string | null;
  /** The go-live instant, as the municipality's date. */
  goLiveOn?: string;
  /** Overridable for the spec; otherwise the municipality's own today. */
  today?: string;
}): IncomeDateVerdict {
  const verdict = planExpenseDate({
    paidOn: input.receivedOn,
    reason: input.reason,
    goLiveOn: input.goLiveOn,
    today: input.today,
  });
  if (verdict.ok) return { ok: true, receivedOn: verdict.paidOn, backdatedDays: verdict.backdatedDays };

  switch (verdict.code) {
    case 'EXPENSE_DATE_IN_FUTURE':
      return { ok: false, code: 'INCOME_DATE_IN_FUTURE' };
    case 'EXPENSE_DATE_BEFORE_GO_LIVE':
      return { ok: false, code: 'INCOME_DATE_BEFORE_GO_LIVE', goLiveOn: verdict.goLiveOn };
    case 'EXPENSE_BACKDATE_REASON_REQUIRED':
      return { ok: false, code: 'INCOME_BACKDATE_REASON_REQUIRED', backdatedDays: verdict.backdatedDays };
  }
}

/** Beirut's wall clock at `instant`, read as if it were UTC, minus the instant: the zone's offset then. */
function beirutOffsetMs(instant: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: MUNICIPAL_TIME_ZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return wall - instant;
}

/**
 * The instant `day` (`YYYY-MM-DD`) begins in Beirut.
 *
 * Lebanon is two hours ahead of UTC in winter and three in summer, so the
 * offset is read at the instant itself rather than assumed. Two passes: the
 * first guess uses the offset at UTC midnight, which is already the day's own
 * offset except on the two nights the clocks change, and the second corrects
 * those. On the night summer time starts the clocks jump from 00:00 to 01:00,
 * and the day begins at the first instant that exists — which is what the
 * second pass lands on.
 */
export function municipalDayStart(day: string): Date {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  const first = utcMidnight - beirutOffsetMs(utcMidnight);
  return new Date(utcMidnight - beirutOffsetMs(first));
}

/** `YYYY-MM-DD` plus one calendar day. */
function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * The instants a register period covers, both days inclusive, as a half-open
 * range: from the start of `from` up to — not including — the start of the day
 * after `to`. Half-open so a voucher recorded at 23:59 on the last day is in,
 * and one at 00:00 on the next is not, with nothing counted twice where two
 * consecutive months meet.
 */
export function incomePeriod(from?: string, to?: string): { gte?: Date; lt?: Date } {
  return {
    ...(from ? { gte: municipalDayStart(from) } : {}),
    ...(to ? { lt: municipalDayStart(nextDay(to)) } : {}),
  };
}

import {
  municipalToday,
  REOPEN_REASON_MIN,
  sameMoney,
  varianceOf,
  type DayClosureVerdict,
  type TreasuryAccountType,
  type TreasuryEntrySource,
} from '@mechanization/shared-schemas';

/**
 * «جرد الصندوق وإقفال اليومية», with no I/O. Design: docs/finance.md §7.
 *
 * ## What a closed day is
 *
 * A municipal business day — Beirut's calendar, `municipalToday` — that the
 * accountant has counted and signed off. From then on nothing is written into
 * it: no payment, no voucher, no transfer dated on it or on any day before it.
 * A late movement is dated on the day it is entered, which is open.
 *
 * ## The rules, and what each one protects
 *
 * 1. **Only a day that has ended closes** (decided 2026-10-10). Closing today
 *    would refuse every payment until midnight — the counter's and the Whish
 *    confirmations', which are stamped with the real clock. The count can be
 *    taken today; the close waits for tomorrow morning.
 * 2. **In date order, from go-live, with no gaps.** A day with movement on a
 *    counted wallet is closed by hand, after the one before it. A day on which
 *    none of the counted wallets moved — custody aside, decided 2026-10-10 — is
 *    closed with the next day that is closed by hand ("swept"): its count could
 *    only repeat the day before. Since nothing is ever left open behind a closed
 *    day, "locked" is simply "on or before the latest closed day".
 * 3. **Every counted wallet is counted, against the books as they stand.** A
 *    count recorded against a figure that has since moved explains a difference
 *    that no longer exists, so it is refused until it is recounted.
 * 4. **A difference changes nothing.** It is recorded with its reason; the
 *    books stay as they are (§7.2).
 * 5. **Reopening is the manager's, the latest closed day only, with a reason.**
 *    Reopening an older day would leave a closed day after an open one, and
 *    rule 2 would no longer mean anything.
 */

/** A closure as the rules read it. */
export interface ClosureRecord {
  businessDate: string;
  status: 'CLOSED' | 'REOPENED';
}

/** `YYYY-MM-DD` plus `n` calendar days (negative goes back). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** The days from `from` to `to`, both inclusive, oldest first. Empty when `to` is before `from`. */
export function daysFrom(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

/** The latest CLOSED day, or null. A REOPENED day is not closed. */
export function closedThrough(closures: readonly ClosureRecord[]): string | null {
  let latest: string | null = null;
  for (const closure of closures) {
    if (closure.status === 'CLOSED' && (latest === null || closure.businessDate > latest)) {
      latest = closure.businessDate;
    }
  }
  return latest;
}

/**
 * The closed day an instant falls in, or null when it is open.
 *
 * The application's half of the lock the 0082 triggers hold: refused here
 * first, with the day named, rather than by the database as a failed insert.
 */
export function closedDayFor(occurredAt: Date, through: string | null): string | null {
  if (through === null) return null;
  const day = municipalToday(occurredAt);
  return day <= through ? day : null;
}

/**
 * Whether a wallet is counted at the close. Everything but a collector's
 * custody: that cash is in his pocket, not the municipality's drawer, and is
 * reported beside the count rather than in it (§3.5).
 */
export function isCountedWallet(type: TreasuryAccountType | string): boolean {
  return type !== 'COLLECTOR_CUSTODY';
}

// ───────────────────────────────  counting  ────────────────────────────────

/** The difference rule lives in the shared package, so the screen shows what the server judges. */
export { varianceOf };

export type CountDateVerdict =
  | { ok: true }
  | { ok: false; code: 'TREASURY_NOT_ACTIVE' }
  | { ok: false; code: 'COUNT_DATE_IN_FUTURE' }
  | { ok: false; code: 'DAY_BEFORE_GO_LIVE'; goLiveOn: string }
  | { ok: false; code: 'DAY_ALREADY_CLOSED' };

/** Whether a day may be counted: begun, the treasury live by then, and not yet locked. */
export function planCountDate(input: {
  businessDate: string;
  today: string;
  /** Null while the treasury is not active. */
  goLiveOn: string | null;
  closedThrough: string | null;
}): CountDateVerdict {
  if (input.goLiveOn === null) return { ok: false, code: 'TREASURY_NOT_ACTIVE' };
  if (input.businessDate > input.today) return { ok: false, code: 'COUNT_DATE_IN_FUTURE' };
  if (input.businessDate < input.goLiveOn) {
    return { ok: false, code: 'DAY_BEFORE_GO_LIVE', goLiveOn: input.goLiveOn };
  }
  if (input.closedThrough !== null && input.businessDate <= input.closedThrough) {
    return { ok: false, code: 'DAY_ALREADY_CLOSED' };
  }
  return { ok: true };
}

export type CountLineVerdict =
  | { ok: true; difference: number; reason: string | null }
  | { ok: false; code: 'COUNT_EXPECTED_CHANGED'; shown: number; actual: number }
  | { ok: false; code: 'COUNT_VARIANCE_REASON_REQUIRED'; difference: number };

/**
 * One wallet's count, judged against the books.
 *
 * The figure the screen showed must still be the books' figure — otherwise the
 * reason typed beside it explains a different difference. Then any difference,
 * either way, needs a reason. A reason given with no difference is kept: «عُدّ
 * مرتين» is worth having on the record.
 */
export function planCountLine(input: {
  shownExpected: number;
  actualExpected: number;
  counted: number;
  reason?: string | null;
}): CountLineVerdict {
  if (!sameMoney(input.shownExpected, input.actualExpected)) {
    return { ok: false, code: 'COUNT_EXPECTED_CHANGED', shown: input.shownExpected, actual: input.actualExpected };
  }
  const difference = varianceOf(input.counted, input.actualExpected);
  const reason = input.reason?.trim() || null;
  if (difference !== 0 && reason === null) {
    return { ok: false, code: 'COUNT_VARIANCE_REASON_REQUIRED', difference };
  }
  return { ok: true, difference, reason };
}

// ───────────────────────────────  closing  ─────────────────────────────────

/**
 * Whether `businessDate` may be closed now, and which quiet days close with it.
 *
 * `activeDays` are the days with an entry on a counted wallet; only those
 * between the last closed day and this one are read. `counts` are this day's
 * recorded counts with the books' figure each was taken against;
 * `expectedNow` is the books' figure for each counted wallet as it stands now.
 * The checks run from the most basic to the most specific, so the refusal
 * names the first thing to fix.
 */
export function planClosure(input: {
  businessDate: string;
  today: string;
  goLiveOn: string | null;
  closures: readonly ClosureRecord[];
  activeDays: readonly string[];
  /** The wallets that must be counted for this day. */
  requiredAccountIds: readonly string[];
  counts: ReadonlyArray<{ accountId: string; expectedAmount: number }>;
  expectedNow: ReadonlyMap<string, number>;
}): DayClosureVerdict {
  const { businessDate, goLiveOn } = input;
  if (goLiveOn === null) return { ok: false, code: 'TREASURY_NOT_ACTIVE' };
  if (businessDate < goLiveOn) return { ok: false, code: 'DAY_BEFORE_GO_LIVE', day: goLiveOn };
  if (businessDate >= input.today) return { ok: false, code: 'DAY_NOT_OVER' };

  const through = closedThrough(input.closures);
  if (through !== null && businessDate <= through) return { ok: false, code: 'DAY_ALREADY_CLOSED' };

  // A day the manager reopened is closed again before anything after it.
  const reopened = input.closures
    .filter((closure) => closure.status === 'REOPENED' && closure.businessDate < businessDate)
    .map((closure) => closure.businessDate)
    .sort()[0];
  if (reopened !== undefined) {
    return { ok: false, code: 'CLOSURE_OUT_OF_CHRONOLOGICAL_ORDER', day: reopened };
  }

  const gap = daysFrom(through === null ? goLiveOn : addDays(through, 1), addDays(businessDate, -1));
  const active = new Set(input.activeDays);
  const unresolved = gap.filter((day) => active.has(day));
  if (unresolved.length > 0) {
    return { ok: false, code: 'UNRESOLVED_ACTIVE_DAYS_EXIST', day: unresolved[0], days: unresolved.length };
  }

  const counted = new Map(input.counts.map((count) => [count.accountId, count.expectedAmount]));
  const missing = input.requiredAccountIds.filter((id) => !counted.has(id));
  if (missing.length > 0) {
    return { ok: false, code: 'COUNT_MISSING_FOR_ACTIVE_ACCOUNTS', accounts: missing.length };
  }

  const stale = input.requiredAccountIds.filter(
    (id) => !sameMoney(counted.get(id)!, input.expectedNow.get(id) ?? 0),
  );
  if (stale.length > 0) return { ok: false, code: 'COUNT_EXPECTED_CHANGED', accounts: stale.length };

  return { ok: true, sweeps: gap };
}

/**
 * The day the count screen should open on when none is asked for: the one
 * standing in the way of everything after it.
 *
 * A reopened day first. Then the first day with movement after the last closed
 * one, if it has ended; then yesterday, whose close sweeps every quiet day
 * before it. While nothing has ended since the last close, today — which can
 * be counted, though not yet closed.
 */
export function nextDayToClose(input: {
  goLiveOn: string | null;
  today: string;
  closures: readonly ClosureRecord[];
  activeDays: readonly string[];
}): string | null {
  if (input.goLiveOn === null) return null;
  const reopened = input.closures
    .filter((closure) => closure.status === 'REOPENED')
    .map((closure) => closure.businessDate)
    .sort()[0];
  if (reopened !== undefined) return reopened;

  const through = closedThrough(input.closures);
  const start = through === null ? input.goLiveOn : addDays(through, 1);
  const yesterday = addDays(input.today, -1);
  if (start > yesterday) return input.today;

  const firstActive = [...input.activeDays].filter((day) => day >= start && day <= yesterday).sort()[0];
  return firstActive ?? yesterday;
}

// ───────────────────────────────  reopening  ───────────────────────────────

export type ReopenVerdict =
  | { ok: true }
  | { ok: false; code: 'REOPEN_REASON_REQUIRED' }
  | { ok: false; code: 'DAY_NOT_CLOSED' }
  | { ok: false; code: 'ONLY_LATEST_CLOSED_DAY_CAN_BE_REOPENED'; latest: string };

/** Whether the manager may reopen `businessDate`: closed, the latest closed, and a reason given. */
export function planReopen(input: {
  businessDate: string;
  closures: readonly ClosureRecord[];
  reason: string;
}): ReopenVerdict {
  if (input.reason.trim().length < REOPEN_REASON_MIN) return { ok: false, code: 'REOPEN_REASON_REQUIRED' };
  const closure = input.closures.find((row) => row.businessDate === input.businessDate);
  if (!closure || closure.status !== 'CLOSED') return { ok: false, code: 'DAY_NOT_CLOSED' };
  const latest = closedThrough(input.closures)!;
  if (latest !== input.businessDate) {
    return { ok: false, code: 'ONLY_LATEST_CLOSED_DAY_CAN_BE_REOPENED', latest };
  }
  return { ok: true };
}

// ─────────────────────────────  the day's report  ──────────────────────────

/** One entry of the day, as the report reads it. */
export interface DayEntry {
  accountId: string;
  amount: number;
  source: TreasuryEntrySource;
}

export interface WalletDay {
  receipts: number;
  payments: number;
  movements: number;
  bySource: Array<{ source: TreasuryEntrySource; receipts: number; payments: number }>;
}

/**
 * Each wallet's money in and out on the day, by where it came from.
 *
 * Gross, not netted: a payment taken and reversed the same afternoon is a
 * receipt and a payment, as the cash book would show it, so the report's
 * columns add up to the closing balance and also tell the reader the reversal
 * happened. Summed in cents, so a column of dollar figures does not drift.
 */
export function summariseDay(entries: readonly DayEntry[]): Map<string, WalletDay> {
  const cents = new Map<string, { receipts: number; payments: number; movements: number; bySource: Map<TreasuryEntrySource, { receipts: number; payments: number }> }>();
  for (const entry of entries) {
    const amount = Math.round(entry.amount * 100);
    let wallet = cents.get(entry.accountId);
    if (!wallet) {
      wallet = { receipts: 0, payments: 0, movements: 0, bySource: new Map() };
      cents.set(entry.accountId, wallet);
    }
    const source = wallet.bySource.get(entry.source) ?? { receipts: 0, payments: 0 };
    if (amount >= 0) {
      wallet.receipts += amount;
      source.receipts += amount;
    } else {
      wallet.payments -= amount;
      source.payments -= amount;
    }
    wallet.movements += 1;
    wallet.bySource.set(entry.source, source);
  }

  const result = new Map<string, WalletDay>();
  for (const [accountId, wallet] of cents) {
    result.set(accountId, {
      receipts: wallet.receipts / 100,
      payments: wallet.payments / 100,
      movements: wallet.movements,
      bySource: [...wallet.bySource.entries()]
        .map(([source, totals]) => ({ source, receipts: totals.receipts / 100, payments: totals.payments / 100 }))
        .sort((a, b) => a.source.localeCompare(b.source)),
    });
  }
  return result;
}

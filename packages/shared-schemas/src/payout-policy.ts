/**
 * When a field inspector may be paid, and how much.
 *
 * Nothing before their lifetime earnings reach $100 — once reached, it stays
 * reached. After that, at most $50 in any one week, where the weeks are counted
 * in sevens of days from the date of their very first payout: first paid on the
 * 1st, the weeks run 1st–7th, 8th–14th, and so on, and the allowance comes back
 * whole at the start of each. Never more than is still owed.
 *
 * One function for both sides of the wire. The server refuses a payout this
 * rejects — that is the check that protects the money — and the payout dialog
 * calls the same function to say, before anyone types an amount, what the
 * server will accept and why.
 */

/** Lifetime earnings an inspector must reach before any payout. */
export const PAYOUT_THRESHOLD = 100;
/** The most paid out within one payout week. */
export const PAYOUT_WEEKLY_CAP = 50;
/** A payout week, in days, counted from the first payout. */
export const PAYOUT_WEEK_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days, not instants. The dialog dates a payout at midday and the server
 * dates an undated one at the moment it is recorded; counting in days means a
 * payout at 3pm on the 1st and one at noon on the 8th still fall in different
 * weeks, as a reader counting on a calendar would expect. UTC days: Lebanon is
 * two or three hours ahead, so a payout dated in the dialog lands on its own
 * calendar day either way.
 */
function dayNumber(at: string | Date): number {
  const time = typeof at === 'string' ? Date.parse(at) : at.getTime();
  return Math.floor(time / DAY_MS);
}

/** Money in whole cents, so 0.1 + 0.2 never decides whether a payout goes through. */
function cents(amount: number): number {
  return Math.round(amount * 100);
}

export interface PayoutPolicyInput {
  /** Everything the inspector has earned, ever — paid or not. */
  totalEarnings: number;
  /** What is still owed. */
  pendingBalance: number;
  /** Every payout already recorded for them. */
  payouts: ReadonlyArray<{ amount: number; paidAt: string | Date }>;
  /** The date the new payout is recorded against. */
  paidAt: string | Date;
}

export type PayoutAllowance =
  | {
      allowed: false;
      reason: 'BELOW_THRESHOLD';
      /** How far their lifetime earnings still are from the threshold. */
      shortBy: number;
    }
  | {
      allowed: boolean;
      reason: 'OK' | 'WEEK_USED' | 'NOTHING_OWED';
      /** First and last day of the payout week `paidAt` falls in, as ISO dates. */
      weekStart: string;
      weekEnd: string;
      /** The day the next payout week begins, as an ISO date. */
      nextWeekStart: string;
      /** Already paid out within that week. */
      paidThisWeek: number;
      /** What is still owed. */
      owed: number;
      /** The largest payout accepted on that date: the week's remainder, capped by what is owed. */
      maxAmount: number;
    };

function isoDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/**
 * What may be paid to one inspector on one date.
 *
 * The week is anchored at the earliest payout on record — or at `paidAt`
 * itself when this is their first, or when it is backdated to before their
 * first. Only the week `paidAt` falls in is checked: payouts recorded before
 * this rule existed are history, and a week that was over-paid then must not
 * block every payout after it.
 */
export function payoutAllowance(input: PayoutPolicyInput): PayoutAllowance {
  const earned = cents(input.totalEarnings);
  if (earned < cents(PAYOUT_THRESHOLD)) {
    return {
      allowed: false,
      reason: 'BELOW_THRESHOLD',
      shortBy: (cents(PAYOUT_THRESHOLD) - earned) / 100,
    };
  }

  const day = dayNumber(input.paidAt);
  const anchor = Math.min(day, ...input.payouts.map((payout) => dayNumber(payout.paidAt)));
  const start = anchor + Math.floor((day - anchor) / PAYOUT_WEEK_DAYS) * PAYOUT_WEEK_DAYS;
  const end = start + PAYOUT_WEEK_DAYS;

  const paidThisWeek = input.payouts.reduce((sum, payout) => {
    const paidDay = dayNumber(payout.paidAt);
    return paidDay >= start && paidDay < end ? sum + cents(payout.amount) : sum;
  }, 0);
  const weekLeft = Math.max(0, cents(PAYOUT_WEEKLY_CAP) - paidThisWeek);
  const owed = Math.max(0, cents(input.pendingBalance));
  const maxAmount = Math.min(weekLeft, owed);

  return {
    allowed: maxAmount > 0,
    reason: owed === 0 ? 'NOTHING_OWED' : weekLeft === 0 ? 'WEEK_USED' : 'OK',
    weekStart: isoDay(start),
    weekEnd: isoDay(end - 1),
    nextWeekStart: isoDay(end),
    paidThisWeek: paidThisWeek / 100,
    owed: owed / 100,
    maxAmount: maxAmount / 100,
  };
}

/**
 * Why `amount` cannot be paid on the allowance's date, in the words the
 * dialog and the server both show — or null when it can.
 */
export function payoutRefusal(allowance: PayoutAllowance, amount: number): string | null {
  if (allowance.reason === 'BELOW_THRESHOLD') {
    return `لا يمكن صرف أي مبلغ قبل أن تبلغ أرباح المفتش ${PAYOUT_THRESHOLD}$ — المتبقي لبلوغها ${allowance.shortBy.toFixed(2)}$.`;
  }
  if (allowance.reason === 'NOTHING_OWED') {
    return 'لا يوجد رصيد مستحق لهذا المفتش.';
  }
  if (allowance.reason === 'WEEK_USED') {
    return `صُرف الحد الأسبوعي (${PAYOUT_WEEKLY_CAP}$) كاملاً في أسبوع ${allowance.weekStart} – ${allowance.weekEnd}. يمكن الصرف مجدداً ابتداءً من ${allowance.nextWeekStart}.`;
  }
  if (cents(amount) > cents(allowance.owed)) {
    return `المبلغ أكبر من الرصيد المستحق (${allowance.owed.toFixed(2)}$).`;
  }
  if (cents(amount) > cents(allowance.maxAmount)) {
    return `أقصى ما يمكن صرفه في هذا التاريخ ${allowance.maxAmount.toFixed(2)}$ — الحد الأسبوعي ${PAYOUT_WEEKLY_CAP}$، صُرف منه ${allowance.paidThisWeek.toFixed(2)}$ في أسبوع ${allowance.weekStart} – ${allowance.weekEnd}.`;
  }
  return null;
}

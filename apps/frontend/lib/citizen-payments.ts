import { formatLbp } from './currency';

/**
 * The citizen portal's figures for its own bills, from the server's per-bill
 * `paidAmount` and `remaining` (`GET fees/payments/mine`, and the bills in
 * `GET citizens/me/summary`). The per-bill rule — the figure a bill shows,
 * whether it is part-paid, «سدّدت X من Y» — has its one home here, for the
 * payments page, the pay dialog, «ملفّي» and «حسابي» alike.
 *
 * So do the totals: every portal page that says what the citizen owes sums it
 * with `citizenPaymentTotals`. A bill whose reported transfer waits for a clerk
 * (`isUnderReview`) is listed with its status and is not counted as owed. The
 * summary's own `outstandingTotal` counts it, and «ملفّي» and «حسابي», which
 * showed it, told the citizen another total than the payments page while a
 * transfer waited (review of PR #113).
 *
 * A bill can be part-paid: cash at the counter, a round, then the rest later.
 * Its face value (`amount`) is then not what is owed, and confirming a Whish
 * claim credits only what is outstanding — so a portal that showed or summed
 * `amount` told the citizen to transfer money already taken, and left the
 * part-payments out of what they had paid.
 */
interface CitizenBillFigures {
  paymentStatus: string;
  amount: number;
  paidAmount: number;
  remaining: number;
}

/** A bill is settled, or it is not — everything else is a shade of "not". */
export function isSettled(bill: Pick<CitizenBillFigures, 'paymentStatus'>): boolean {
  return bill.paymentStatus === 'PAID';
}

/** The bills the citizen can still pay: unpaid or overdue. A claimed one (PENDING_REVIEW) waits on a clerk. */
export function isPayable(bill: Pick<CitizenBillFigures, 'paymentStatus'>): boolean {
  return bill.paymentStatus === 'UNPAID' || bill.paymentStatus === 'OVERDUE';
}

/** A bill whose reported transfer waits for a clerk to confirm or reject it: neither payable nor owed meanwhile. */
export function isUnderReview(bill: Pick<CitizenBillFigures, 'paymentStatus'>): boolean {
  return bill.paymentStatus === 'PENDING_REVIEW';
}

/**
 * The two summary figures: what is still owed on the payable bills, and
 * everything paid so far — part-payments on open bills included. Every portal
 * page that shows them reads them here.
 */
export function citizenPaymentTotals(bills: readonly CitizenBillFigures[]): { outstanding: number; paid: number } {
  let outstanding = 0;
  let paid = 0;
  for (const bill of bills) {
    if (isPayable(bill)) outstanding += bill.remaining;
    paid += bill.paidAmount;
  }
  return { outstanding, paid };
}

/** The figure a bill shows: its face value once settled, otherwise what is left on it. */
export function billFigure(bill: CitizenBillFigures): number {
  return isSettled(bill) ? bill.amount : bill.remaining;
}

/** Part of an open bill is already paid — «سدّدت X من Y» (`citizen.partlyPaid`). */
export function isPartlyPaid(bill: Pick<CitizenBillFigures, 'paymentStatus' | 'paidAmount'>): boolean {
  return !isSettled(bill) && bill.paidAmount > 0;
}

/**
 * The two figures «سدّدت X من Y» names (`citizen.partlyPaid`), written for the
 * page's language: «ل.ل» on an Arabic page, «LBP» on an English one. The pay
 * dialog used to write «ل.ل» by hand, so `/en/` read «Paid 100,000 ل.ل of …»
 * (TXT-2).
 */
export function partlyPaidFigures(
  bill: Pick<CitizenBillFigures, 'paidAmount' | 'amount'>,
  locale: string,
): { paid: string; total: string } {
  return { paid: formatLbp(bill.paidAmount, locale), total: formatLbp(bill.amount, locale) };
}

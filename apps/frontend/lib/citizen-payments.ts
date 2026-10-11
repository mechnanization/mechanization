/**
 * The citizen portal's figures for its own bills, from the server's per-bill
 * `paidAmount` and `remaining` (`GET fees/payments/mine`).
 *
 * A bill can be part-paid: cash at the counter, a round, then the rest later.
 * Its face value (`amount`) is then not what is owed, and confirming a Whish
 * claim credits only what is outstanding — so a portal that showed or summed
 * `amount` told the citizen to transfer money already taken, and left the
 * part-payments out of what they had paid. «ملفّي» reads these figures the same
 * way (`my-file/page.tsx`).
 */
interface CitizenBillFigures {
  paymentStatus: string;
  amount: number;
  paidAmount: number;
  remaining: number;
}

/** The bills the citizen can still pay: unpaid or overdue. A claimed one (PENDING_REVIEW) waits on a clerk. */
export function isPayable(bill: Pick<CitizenBillFigures, 'paymentStatus'>): boolean {
  return bill.paymentStatus === 'UNPAID' || bill.paymentStatus === 'OVERDUE';
}

/**
 * The two summary figures: what is still owed on the payable bills, and
 * everything paid so far — part-payments on open bills included.
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
  return bill.paymentStatus === 'PAID' ? bill.amount : bill.remaining;
}

/** Part of an open bill is already paid — «سدّدت X من Y». */
export function isPartlyPaid(bill: Pick<CitizenBillFigures, 'paymentStatus' | 'paidAmount'>): boolean {
  return bill.paymentStatus !== 'PAID' && bill.paidAmount > 0;
}

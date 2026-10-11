/**
 * One row of an inspector's payout history, with the balance as it stood once
 * that payout was made.
 */
export interface PayoutHistoryRow<P> {
  payout: P;
  /** Commission on the registrations submitted up to the moment of this payout. */
  earnedToDate: number;
  /** Every payout up to and including this one. */
  paidToDate: number;
  /** Still owed after this payout; zero when it paid in full or more. */
  owedAfter: number;
  /** Paid beyond what had been earned by then; zero otherwise. */
  overpaidAfter: number;
}

/** Cents: a few hundred additions of floats must not leave dust on a ledger row. */
function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * «المتبقي بعدها» for every payout: what had been earned **by then**, less what
 * had been paid by then — not today's total earnings less the running paid sum,
 * which made an early payout look as if it left a debt that did not exist yet.
 *
 * Earned-to-date is the sum of `commissionEarned` over the registrations
 * submitted at or before the payout's `paidAt`. Every registration is in the
 * profile (`recentRegistrations` is not limited, `StaffService.getInspectorProfile`).
 *
 * Caveat: this is recomputed from today's records. A registration's credit is
 * what it earns now — after deduplication, merges and corrections made since —
 * so a past row can differ from the figure the screen showed on the day of the
 * payout. No snapshot of the balance is stored with a payout.
 *
 * Returned newest first, the order the page reads; computed oldest first,
 * because a running balance only means anything in the order money moved.
 */
export function payoutHistory<P extends { paidAt: string; amount: number }>(
  payouts: readonly P[],
  registrations: ReadonlyArray<{ submittedAt: string; commissionEarned: number }>,
): Array<PayoutHistoryRow<P>> {
  const earnings = registrations
    .map((registration) => ({ at: new Date(registration.submittedAt).getTime(), amount: registration.commissionEarned }))
    .sort((a, b) => a.at - b.at);
  const chronological = [...payouts].sort((a, b) => new Date(a.paidAt).getTime() - new Date(b.paidAt).getTime());

  let next = 0;
  let earned = 0;
  let paid = 0;
  const rows = chronological.map((payout) => {
    const at = new Date(payout.paidAt).getTime();
    for (let entry = earnings[next]; entry && entry.at <= at; entry = earnings[next]) {
      earned += entry.amount;
      next += 1;
    }
    paid += payout.amount;
    const earnedToDate = cents(earned);
    const paidToDate = cents(paid);
    return {
      payout,
      earnedToDate,
      paidToDate,
      owedAfter: Math.max(0, cents(earnedToDate - paidToDate)),
      overpaidAfter: Math.max(0, cents(paidToDate - earnedToDate)),
    };
  });
  return rows.reverse();
}

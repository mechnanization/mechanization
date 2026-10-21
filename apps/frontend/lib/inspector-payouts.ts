import { municipalToday } from '@mechanization/shared-schemas';

/**
 * One row of an inspector's payout history, with the balance as it stood once
 * that payout was made.
 */
export interface PayoutHistoryRow<P> {
  payout: P;
  /** Commission on the registrations that count as earned by this payout (`earnedBy`). */
  earnedToDate: number;
  /** Every payout up to and including this one, less those whose voucher was cancelled. */
  paidToDate: number;
  /** Still owed after this payout; zero when it paid in full or more. */
  owedAfter: number;
  /** Paid beyond what had been earned by then; zero otherwise. */
  overpaidAfter: number;
}

/** What a payout carries that decides its row (`InspectorPayoutItem` fits it). */
export interface PayoutForHistory {
  paidAt: string;
  amount: number;
  /** When the payout row was written: the moment a payout recorded the day it is dated was recorded. */
  createdAt: string;
  /** The «PV-» voucher that paid it once the treasury is live; null or absent for a payout recorded before. */
  voucher?: { voided: boolean } | null;
}

/** One registration's credit, read once: its moment and its day on the municipality's calendar. */
interface Credit {
  at: number;
  day: string;
  amount: number;
}

/** Cents: a few hundred additions of floats must not leave dust on a ledger row. */
function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Whether a registration counts as earned by the time of a payout.
 *
 * - A payout paid from a voucher carries the voucher's own moment (`paidAt` is
 *   its `occurredAt`: paid now, once the treasury is live), so it is compared
 *   instant to instant.
 * - A payout recorded before the treasury is a figure dated with a day picker,
 *   and `paidAt` is that day's local noon (`payoutRequest`) — no moment at all.
 *   Compared as an instant, the registrations filed that afternoon fell after
 *   it, and a payout of everything owed that day read as «زيادة» (review of
 *   PR #113). So it is judged by the municipality's calendar: what was filed on
 *   or before the day it is dated counts — and no later than the moment the row
 *   was written (`createdAt`), so a payout recorded in the morning does not
 *   claim the afternoon's work as earned by then. Recorded on a later day, the
 *   whole of its own day counts: its hour is not known.
 */
function earnedBy(payout: PayoutForHistory): (credit: Credit) => boolean {
  if (payout.voucher) {
    const paidAt = Date.parse(payout.paidAt);
    return (credit) => credit.at <= paidAt;
  }
  const day = municipalToday(new Date(payout.paidAt));
  const recordedAt = Date.parse(payout.createdAt);
  return (credit) => credit.day <= day && credit.at <= recordedAt;
}

/** Where a payout falls in the order the money moved (`byWhenPaid`). */
interface PayoutPlace {
  /** The municipal day it is dated. */
  day: string;
  /** A voucher's own moment; for a figure, when its row was written. */
  at: number;
  /** When its row was written (`createdAt`): the last word on a tie. */
  written: number;
}

function placeOf(payout: PayoutForHistory): PayoutPlace {
  const written = Date.parse(payout.createdAt);
  return {
    day: municipalToday(new Date(payout.paidAt)),
    at: payout.voucher ? Date.parse(payout.paidAt) : written,
    written,
  };
}

/**
 * The order the money moved — never `paidAt` alone (review of PR #113).
 *
 * Every figure-only payout of one day carries the same noon stamp, and the
 * server sends a tie in whatever order Postgres's plan returns it (newest
 * written first is common). Summed in that order, the earlier payout was
 * charged with the later one's money: «زيادة $15» on one row and $10 owed on
 * the other, for two payouts of exactly what was owed. So, first by the
 * municipal day a payout is dated, then by a moment it truly has: a voucher's
 * own, and for a figure the moment its row was written.
 *
 * - Go-live day orders itself: a figure can only be written before the
 *   treasury goes live and a voucher only after, so the figure comes first
 *   whatever its noon stamp says.
 * - A figure written up on a later day, whose hour on its own day is not
 *   known, comes after the payouts written on that day, and before any of the
 *   day it was written on.
 * - Two payouts on the same moment — two vouchers stamped alike — go in the
 *   order their rows were written (`createdAt`), so no tie is left to the
 *   order the server happened to send.
 */
function byWhenPaid(a: PayoutPlace, b: PayoutPlace): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  return a.at - b.at || a.written - b.written;
}

/**
 * «المتبقي بعدها» for every payout: what had been earned **by then** (`earnedBy`),
 * less what had been paid by then — not today's total earnings less the running
 * paid sum, which made an early payout look as if it left a debt that did not
 * exist yet.
 *
 * A payout whose voucher was cancelled («ملغى») is not money paid: the void put
 * it back into the wallet. It stays in the list and leaves the paid sum, as it
 * leaves `paidBalance` on the server (`StaffService.getInspectorProfile`), so the
 * newest row agrees with the summary above it.
 *
 * Earned-to-date sums `commissionEarned` over the registrations that count.
 * Every registration is in the profile (`recentRegistrations` is not limited).
 * Each counts from when it was earned (`creditedAt`): for a file another
 * officer registered and this one added a line to, that is when he added it,
 * not when the file was made. A server that does not send `creditedAt` yet is
 * read by `submittedAt`, as before.
 *
 * Recomputed from today's records, and the page says so under the table: a
 * registration's credit is what it earns now — after deduplication, merges and
 * corrections made since — so a past row can differ from the figure the screen
 * showed on the day of the payout. No snapshot of the balance is stored with a
 * payout.
 *
 * Returned newest first, the order the page reads; computed oldest first, in
 * the order the money moved (`byWhenPaid`), because a running balance only
 * means anything in that order.
 */
export function payoutHistory<P extends PayoutForHistory>(
  payouts: readonly P[],
  registrations: ReadonlyArray<{ submittedAt: string; creditedAt?: string; commissionEarned: number }>,
): Array<PayoutHistoryRow<P>> {
  const credits: Credit[] = registrations.map((registration) => {
    const at = new Date(registration.creditedAt ?? registration.submittedAt);
    return { at: at.getTime(), day: municipalToday(at), amount: registration.commissionEarned };
  });
  const chronological = payouts
    .map((payout) => ({ payout, place: placeOf(payout) }))
    .sort((a, b) => byWhenPaid(a.place, b.place))
    .map(({ payout }) => payout);

  let paid = 0;
  const rows = chronological.map((payout) => {
    const counts = earnedBy(payout);
    const earned = credits.reduce((sum, credit) => (counts(credit) ? sum + credit.amount : sum), 0);
    if (!payout.voucher?.voided) paid += payout.amount;
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

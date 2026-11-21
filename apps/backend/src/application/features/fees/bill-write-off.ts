/**
 * «شطب» (0107, docs/old-debts-plan.md decision 10; docs/finance.md §3.8): the
 * council forgives what is left on a bill — an amnesty, a debt too old to
 * collect, one that cannot be collected. Not a cancellation: the debt was real,
 * so the bill keeps what was paid on it and the rest is written off, with the
 * decision that forgave it. No money moves.
 */

import type { BillWriteOffView } from '@mechanization/shared-schemas';

/** Why a bill cannot be written off now, or null when it can. Asked of the bill's row behind its lock. */
export type BillWriteOffRefusal =
  | 'BILL_ALREADY_WRITTEN_OFF'
  | 'BILL_ALREADY_CANCELLED'
  | 'PAYMENT_CLAIM_UNDER_REVIEW'
  | 'BILL_WRITE_OFF_NOTHING_LEFT';

/**
 * In this order: already written off; cancelled (it owes nothing, and a
 * mistake is not forgiven); a citizen's claim waiting on it (decided first, as
 * for a cancellation, `PAYMENT_CLAIM_UNDER_REVIEW`); paid, or nothing left to
 * forgive. A part-paid bill is written off for its rest.
 */
export function billWriteOffRefusal(bill: {
  paymentStatus: string;
  amount: number;
  paidAmount: number;
}): BillWriteOffRefusal | null {
  if (bill.paymentStatus === 'WRITTEN_OFF') return 'BILL_ALREADY_WRITTEN_OFF';
  if (bill.paymentStatus === 'CANCELLED') return 'BILL_ALREADY_CANCELLED';
  if (bill.paymentStatus === 'PENDING_REVIEW') return 'PAYMENT_CLAIM_UNDER_REVIEW';
  if (bill.paymentStatus === 'PAID' || bill.amount - bill.paidAmount <= 0) return 'BILL_WRITE_OFF_NOTHING_LEFT';
  return null;
}

/** A council decision dated after today (`YYYY-MM-DD`, the municipality's calendar) is refused. */
export function writeOffDecisionInFuture(decisionDate: string, today: string): boolean {
  return decisionDate > today;
}

/** The write-off of a bill row as the screens read it, or null on one not written off. */
export function writeOffView(row: {
  writtenOffAt: Date | null;
  writeOffAmount: { toString(): string } | null;
  writeOffReason: string | null;
  writeOffDecisionRef: string | null;
  writeOffDecisionDate: Date | null;
}): BillWriteOffView | null {
  if (!row.writtenOffAt) return null;
  return {
    at: row.writtenOffAt.toISOString(),
    amount: Number(row.writeOffAmount ?? 0),
    reason: row.writeOffReason ?? '',
    decisionRef: row.writeOffDecisionRef ?? '',
    // A `@db.Date` reads back as midnight UTC of its day.
    decisionDate: row.writeOffDecisionDate ? row.writeOffDecisionDate.toISOString().slice(0, 10) : '',
  };
}

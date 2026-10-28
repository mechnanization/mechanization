import type { QueryState } from '@tanstack/react-query';
import { reverseTransactionSchema } from '@mechanization/shared-schemas';
import type { RecordedMovement } from '@/components/admin/payment-receipt';
import { ApiRequestError, type PaymentLedgerEntry } from './api-client';
import { outcomeInDoubt } from './request-id';
import { hasRole, PAYMENT_REVERSE_ROLES } from './staff-roles';

/**
 * Whether a citizen reported a transfer on the bill that no clerk has confirmed
 * or rejected yet (`PENDING_REVIEW`).
 *
 * Reversing a receipt on such a bill sets it back to unpaid and clears the
 * claim's Whish reference, so the claim leaves the review queue and a transfer
 * that did arrive is left with nothing on record. The owner decided that a
 * reversal waits for the clerk's answer (PR #120's D11, 2026-10-12), and #120
 * refuses it on the server under the bill's lock. This branch's server does not
 * refuse it yet, so the screen does not offer it (`mayReverseReceipt`).
 */
export function claimUnderReview(bill: { paymentStatus: string }): boolean {
  return bill.paymentStatus === 'PENDING_REVIEW';
}

/**
 * Whether a receipt on the bill page offers «عكس الوصل»: money taken in, still
 * standing, to the manager, on a bill with no claim under review.
 *
 * Not on the opposing row itself (`isReversal`) — the server refuses to reverse
 * a reversal (`TRANSACTION_IS_REVERSAL`) — not on a receipt already reversed
 * (`TRANSACTION_ALREADY_REVERSED`), and not while the bill's claim waits for a
 * clerk (`claimUnderReview`). The role mirrors `@Roles(...PAYMENT_REVERSE_ROLES)`
 * on `POST fees/transactions/:id/reverse`; the server is the enforcement
 * (CODE-4) for the role, and #120's for the claim.
 */
export function mayReverseReceipt(
  entry: { isReversal: boolean; reversed: boolean },
  role: string | null | undefined,
  bill: { paymentStatus: string },
): boolean {
  return hasRole(PAYMENT_REVERSE_ROLES, role) && !claimUnderReview(bill) && !entry.isReversal && !entry.reversed;
}

/**
 * Which link a bill's row on the citizen file shows to the bill's own page
 * (`citizens/[citizenId]/payments/[paymentId]`) — always one: «تسجيل دفعة
 * نقدية» while the bill is owed, «وصولات الفاتورة» once it is paid in full.
 * That page lists the bill's receipts, with «عكس الوصل» for the manager, under
 * the cash form or, on a paid bill, alone. A paid bill's row used to link
 * nowhere, so a receipt that wrongly paid a bill in full could be reversed only
 * by typing the address (review of PR #113).
 */
export function billPageLink(bill: { paymentStatus: string }): 'settle' | 'receipts' {
  // A cancelled bill (0090) takes no cash either: what is left to see is its receipts, if any.
  return bill.paymentStatus === 'PAID' || bill.paymentStatus === 'CANCELLED' ? 'receipts' : 'settle';
}

/**
 * Whether a receipt on the bill page offers «طباعة الوصل» of its own: a payment
 * on a shared unit bill (0099), which names the debtor who paid it, for what
 * they paid (decision D9, 2026-10-26). A shared bill is reprinted payment by
 * payment, never as the bill's total under one name: two brothers who each paid
 * part are each named for their own part. Not the opposing row of a reversal,
 * nor a receipt since reversed.
 */
export function mayPrintSharedReceipt(entry: {
  isReversal: boolean;
  reversed: boolean;
  paidByCitizenId?: string | null;
}): boolean {
  return Boolean(entry.paidByCitizenId) && !entry.isReversal && !entry.reversed;
}

/**
 * What one payment's receipt prints — its own RCP number, day, amount, notes
 * and method — and what the bill still owed right after it: the bill's amount
 * less every movement up to and including this one, reversals among them, in
 * the list's own order (oldest first). Null when the list does not hold it.
 */
export function receiptOfEntry(
  entries: readonly PaymentLedgerEntry[],
  entryId: string,
  billAmount: number,
): RecordedMovement | null {
  const index = entries.findIndex((entry) => entry.id === entryId);
  const entry = entries[index];
  if (!entry) return null;
  const paidThrough = entries.slice(0, index + 1).reduce((sum, row) => sum + row.amount, 0);
  const tendered = entry.tenderedLocal != null || entry.tenderedForeign != null;
  return {
    receiptNumber: entry.receiptNumber,
    occurredAt: entry.occurredAt,
    received: entry.amount,
    remaining: Math.max(0, Math.round((billAmount - paidThrough) * 100) / 100),
    changeGiven: entry.changeGiven ?? 0,
    tender: tendered
      ? {
          local: entry.tenderedLocal ?? 0,
          foreign: entry.tenderedForeign ?? 0,
          foreignCurrency: entry.tenderedForeignCurrency ?? 'USD',
          exchangeRate: entry.exchangeRate ?? 0,
          officialExchangeRate: entry.officialExchangeRate,
        }
      : null,
    method: entry.method,
  };
}

/** The longest reason the server takes, read off its own schema — the box's `maxLength`. */
export const REVERSAL_REASON_MAX = reverseTransactionSchema.shape.note.maxLength ?? undefined;

/** Whether a reason passes the server's own check (`reverseTransactionSchema`), so Confirm waits for one that will. */
export function reversalReasonValid(note: string): boolean {
  return reverseTransactionSchema.safeParse({ note }).success;
}

/**
 * The receipts as read again after a press, or undefined when they were not.
 *
 * The dialog re-reads the list by invalidating its key, then reads the cache.
 * When that read fails (`status: 'error'`), waits for a connection
 * (`fetchStatus: 'paused'`) or never runs, TanStack keeps the list it had —
 * the one from before the press — and judged as a re-read it told the manager
 * «the receipts read again do not show it» about a read that never answered
 * (review of PR #113). Only a read that answered after the press counts.
 */
export function receiptsReadAgain<E>(
  state: Pick<QueryState<{ items: E[] }>, 'status' | 'fetchStatus' | 'dataUpdatedAt' | 'data'> | undefined,
  pressedAt: number,
): E[] | undefined {
  if (!state || state.status !== 'success' || state.fetchStatus !== 'idle' || state.dataUpdatedAt < pressedAt) {
    return undefined;
  }
  return state.data?.items;
}

/**
 * What a failed «عكس الوصل» press means, judged with the receipts read again
 * after it (`reread`: `receiptsReadAgain`, undefined when they could not be).
 *
 * A reversal carries no retry key, and needs none: the receipt's own id is the
 * act's key. The server reverses a receipt once — it asks under the bill's lock
 * whether one already opposes it, and a unique index on `reversalOfId` stands
 * behind that — so a press repeated after its answer was lost is refused with
 * `TRANSACTION_ALREADY_REVERSED`, never recorded twice. That refusal says the
 * act exists, so it is answered as done, the way a refusal `keyIsSpent` names
 * is on a keyed form (`lib/request-id.ts`) — never as a failure. Each outcome
 * has its own words, so the dialog never says what did not happen:
 *
 * - `already-reversed`: the server says the receipt was reversed before this
 *   press, or refused this press while the receipts read again show it
 *   reversed (another press got there first). Done.
 * - `went-through`: this press was not confirmed — no answer, a timeout or a
 *   server error (`outcomeInDoubt`) — and the receipts read again show it
 *   reversed: the press went through, its answer did not. Done.
 * - `in-doubt`: not confirmed, and the receipts read again do not show it
 *   reversed. Pressing again is safe: the server answers it with the reversal
 *   if the first press was recorded.
 * - `unread`: not confirmed, and the receipts could not be read again, so
 *   nothing says whether it was recorded. Pressing again is just as safe.
 * - `refused`: this attempt was refused (a wallet that cannot cover the refund,
 *   …); its message is shown beside the action.
 */
export function reversalFailure(
  caught: unknown,
  reread: ReadonlyArray<{ id: string; reversed: boolean }> | undefined,
  receiptId: string,
): 'already-reversed' | 'went-through' | 'in-doubt' | 'unread' | 'refused' {
  if (caught instanceof ApiRequestError && caught.code === 'TRANSACTION_ALREADY_REVERSED') return 'already-reversed';
  const shownReversed = reread?.some((entry) => entry.id === receiptId && entry.reversed) ?? false;
  if (!outcomeInDoubt(caught)) return shownReversed ? 'already-reversed' : 'refused';
  if (shownReversed) return 'went-through';
  return reread ? 'in-doubt' : 'unread';
}

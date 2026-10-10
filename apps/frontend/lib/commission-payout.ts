import type { PayoutAllowance } from '@mechanization/shared-schemas';
import { ApiRequestError } from './api-client';
import { keyIsSpent, outcomeInDoubt, type KeyScope } from './request-id';

/**
 * «صرف عمولة» — what the payout dialog decides, kept out of the component so
 * each rule can be tested on its own (`components/admin/inspector-payout-dialog.tsx`).
 *
 * The dialog moves money once the treasury is live, so it follows the rule
 * every money form here follows (STA-4, `lib/request-id.ts`): one retry key per
 * payout, held outside the dialog, kept across every failure, edit and close,
 * and spent only when the server confirms the act.
 */

/** One payout per inspector: paying another inspector is another act, under another key. */
export function commissionScope(staffId: string): KeyScope {
  return `commission:${staffId}`;
}

/**
 * What a failed press does to the held key.
 *
 * - `spend`: the server says an act already exists under it — `keyIsSpent`'s
 *   refusals, and `INSPECTOR_PAYOUT_REQUEST_REUSED`, which says the key paid
 *   another inspector or wrote another voucher. The next press is a new act.
 * - `doubt`: no answer, a timeout or a 5xx (`outcomeInDoubt`). The payout may
 *   have gone through, so the key is kept, the figures are read again, and the
 *   checks that read them stop refusing (`payoutFieldErrors`).
 * - `keep`: a refusal of this attempt alone; the key is kept, which costs
 *   nothing — the server reads a key it never recorded as new.
 */
export function payoutKeyAfterFailure(caught: unknown): 'spend' | 'doubt' | 'keep' {
  if (keyIsSpent(caught)) return 'spend';
  if (caught instanceof ApiRequestError && caught.code === 'INSPECTOR_PAYOUT_REQUEST_REUSED') return 'spend';
  if (outcomeInDoubt(caught)) return 'doubt';
  return 'keep';
}

/** What is wrong with a press, by field, before any request: a code the dialog words. */
export interface PayoutFieldErrors {
  accountId?: 'accountId';
  /** `overOwed` is worded by `payoutRefusal`, the server's own rule. */
  amount?: 'amount' | 'overOwed' | 'short';
}

/**
 * The checks made before the request, and whether they refuse.
 *
 * Normally an amount above what is owed, or above the wallet's balance, is
 * refused here to save a round trip; the server refuses both again.
 *
 * Except after a press whose answer was lost (`retrying`). The figures are read
 * again then, and if that payout went through they already carry it: what is
 * owed and what the wallet holds have both gone down by it. Refusing on them
 * would block the one retry the server answers from the key, and the way round
 * the refusal — a smaller amount, another wallet — would be a second payout
 * under a new key. So while the key is held in doubt both are warnings, and
 * only the server judges: it answers a replay before it reads the balance.
 */
export function payoutFieldErrors(input: {
  live: boolean;
  hasAccount: boolean;
  typed: number;
  allowance: PayoutAllowance;
  /** The amount is more than the chosen wallet holds. */
  short: boolean;
  retrying: boolean;
}): PayoutFieldErrors {
  const errors: PayoutFieldErrors = {};
  if (input.live && !input.hasAccount) errors.accountId = 'accountId';
  if (input.typed <= 0) {
    errors.amount = 'amount';
    return errors;
  }
  if (input.retrying) return errors;
  if (Math.round(input.typed * 100) > Math.round(input.allowance.owed * 100) || !input.allowance.allowed) {
    errors.amount = 'overOwed';
  } else if (input.short) {
    errors.amount = 'short';
  }
  return errors;
}

/** One of the dialog's two reads, as TanStack Query hands it over. */
export interface PayoutRead<T> {
  data: T | undefined;
  isError: boolean;
}

/**
 * Which state the dialog draws (STA-1), from its two reads.
 *
 * TanStack keeps the last answer when a background re-read fails — a refocus
 * past the stale time, the invalidation after a payout — and sets `isError`
 * beside it. Checking the error first swapped the form for an error panel, and
 * the unmount threw away what was typed and released the dialog's close guard
 * while a payout might still be committing. So the error takes the dialog only
 * while a read has never answered; once both have, the form stays and the
 * failure is a note above it.
 */
export function payoutDialogView<P, O>(
  profile: PayoutRead<P>,
  overview: PayoutRead<O>,
):
  | { state: 'failed' }
  | { state: 'loading' }
  | { state: 'ready'; profile: P; overview: O; refreshFailed: boolean } {
  if (profile.data !== undefined && overview.data !== undefined) {
    return {
      state: 'ready',
      profile: profile.data,
      overview: overview.data,
      refreshFailed: profile.isError || overview.isError,
    };
  }
  if ((profile.isError && profile.data === undefined) || (overview.isError && overview.data === undefined)) {
    return { state: 'failed' };
  }
  return { state: 'loading' };
}

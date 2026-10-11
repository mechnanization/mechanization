import { reverseTransactionSchema } from '@mechanization/shared-schemas';
import { hasRole, PAYMENT_REVERSE_ROLES } from './staff-roles';

/**
 * Whether a receipt on the bill page offers «عكس الوصل»: money taken in, still
 * standing, to the manager.
 *
 * Not on the opposing row itself (`isReversal`) — the server refuses to reverse
 * a reversal (`TRANSACTION_IS_REVERSAL`) — and not on a receipt already
 * reversed (`TRANSACTION_ALREADY_REVERSED`). The role mirrors
 * `@Roles(...PAYMENT_REVERSE_ROLES)` on `POST fees/transactions/:id/reverse`;
 * the server is the enforcement (CODE-4).
 */
export function mayReverseReceipt(
  entry: { isReversal: boolean; reversed: boolean },
  role: string | null | undefined,
): boolean {
  return hasRole(PAYMENT_REVERSE_ROLES, role) && !entry.isReversal && !entry.reversed;
}

/** The longest reason the server takes, read off its own schema — the box's `maxLength`. */
export const REVERSAL_REASON_MAX = reverseTransactionSchema.shape.note.maxLength ?? undefined;

/** Whether a reason passes the server's own check (`reverseTransactionSchema`), so Confirm waits for one that will. */
export function reversalReasonValid(note: string): boolean {
  return reverseTransactionSchema.safeParse({ note }).success;
}

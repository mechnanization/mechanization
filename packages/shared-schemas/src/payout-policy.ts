/**
 * When a field inspector may be paid, and how much.
 *
 * Any amount up to what is still owed, on any day.
 *
 * There used to be two more rules, both removed by decision:
 *
 * - Nothing at all before lifetime earnings reached $100 (removed 2026-09-27,
 *   the municipality's decision). It had stopped four of six officers from
 *   being paid anything, and the corrected unit counts lowered every total,
 *   which pushed more people under it rather than fewer.
 * - At most $50 in any one week, the weeks counted in sevens of days from the
 *   first payout (removed 2026-10-04).
 *
 * The constants are gone rather than set to zero or to a number nobody will
 * reach. A limit that can never fire is a branch nobody can test and a refusal
 * message nobody can ever read, which is the shape AGENTS.md §8.7 is about: a
 * control that cannot fail for the right reason looks like coverage and is
 * worse than none. The balance check remains, because it still refuses things.
 *
 * One function for both sides of the wire. The server refuses a payout this
 * rejects — that is the check that protects the money — and the payout dialog
 * calls the same function to say, before anyone types an amount, what the
 * server will accept and why.
 */

/** Money in whole cents, so 0.1 + 0.2 never decides whether a payout goes through. */
function cents(amount: number): number {
  return Math.round(amount * 100);
}

export interface PayoutPolicyInput {
  /** What is still owed. */
  pendingBalance: number;
}

export interface PayoutAllowance {
  allowed: boolean;
  reason: 'OK' | 'NOTHING_OWED';
  /** What is still owed, and so the largest payout accepted. */
  owed: number;
}

/** What may be paid to one inspector now. */
export function payoutAllowance(input: PayoutPolicyInput): PayoutAllowance {
  const owed = Math.max(0, cents(input.pendingBalance));
  return {
    allowed: owed > 0,
    reason: owed === 0 ? 'NOTHING_OWED' : 'OK',
    owed: owed / 100,
  };
}

/**
 * Why `amount` cannot be paid, in the words the dialog and the server both
 * show — or null when it can.
 */
export function payoutRefusal(allowance: PayoutAllowance, amount: number): string | null {
  if (allowance.reason === 'NOTHING_OWED') {
    return 'لا يوجد رصيد مستحق لهذا المفتش.';
  }
  if (cents(amount) > cents(allowance.owed)) {
    return `المبلغ أكبر من الرصيد المستحق (${allowance.owed.toFixed(2)}$).`;
  }
  return null;
}

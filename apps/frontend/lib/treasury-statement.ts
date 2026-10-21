import { TREASURY_ADMIN_ROLES, type TreasuryEntrySource } from '@mechanization/shared-schemas';
import { hasRole } from './staff-roles';

/**
 * The days an account statement covers: `YYYY-MM-DD` on the municipality's
 * calendar (`municipalToday`), both inclusive. The server reads `to` as the end
 * of that day in Beirut, so a statement for one day is `from === to`.
 */
export interface StatementRange {
  from: string;
  to: string;
}

/** The month so far: the first of `today`'s month up to `today` itself. */
export function monthSoFar(today: string): StatementRange {
  return { from: `${today.slice(0, 8)}01`, to: today };
}

/**
 * The balance after the last movement shown.
 *
 * Not the account's balance now: that is the same figure only when the range
 * runs up to the latest movement. A statement for last Tuesday has to close on
 * Tuesday's balance, and one that was cut short closes on the last row it
 * shows. So this adds what the shown rows moved to the balance before the first
 * of them, which holds whichever order the rows arrive in. Rounded to the cent
 * so that a few hundred additions do not leave dust on a printed register.
 */
export function closingBalance(statement: {
  openingBalance: number;
  entries: ReadonlyArray<{ amount: number }>;
}): number {
  const moved = statement.entries.reduce((sum, entry) => sum + entry.amount, 0);
  return Math.round((statement.openingBalance + moved) * 100) / 100;
}

/**
 * Whether a statement row offers «إلغاء التسليم»: a handover's own movement,
 * still standing, to the manager.
 *
 * A transfer's movement (`TRANSFER`) carries the transfer's id in `sourceId`,
 * which is what `voidTransfer` takes. Not on a movement already cancelled
 * (`reversed`) — the server would refuse it, `TRANSFER_ALREADY_VOID` — and not
 * on the cancelling movement itself (`isReversal`), which is the void, not the
 * handover. The role mirrors `@Roles(...TREASURY_ADMIN_ROLES)` on
 * `POST /treasury/transfers/:id/void`; the server is the enforcement (CODE-4).
 */
export function mayVoidTransfer(
  entry: { source: TreasuryEntrySource; sourceId: string | null; isReversal: boolean; reversed: boolean },
  role: string | undefined,
): boolean {
  return (
    hasRole(TREASURY_ADMIN_ROLES, role) &&
    entry.source === 'TRANSFER' &&
    Boolean(entry.sourceId) &&
    !entry.isReversal &&
    !entry.reversed
  );
}

/**
 * Who a shared unit bill's payer selector starts on (0099, decision D5; the
 * user's decisions of 2026-10-27).
 *
 * A shared bill is owed in full by everyone registered on the unit, and the
 * receipt names the one who paid. The clerk can always choose another; this is
 * only where the choice starts:
 *
 *  1. the citizen whose file the bill was opened from — the person at the
 *     counter is usually the one the clerk looked up;
 *  2. otherwise the unit's «مالك مسؤول», when it names one;
 *  3. otherwise nobody: the clerk chooses (the counter's own settle page, on a
 *     unit with no responsible owner).
 */
export function defaultPayer(
  debtors: ReadonlyArray<{ citizenId: string; responsible?: boolean }>,
  fileCitizenId?: string | null,
): string {
  if (fileCitizenId && debtors.some((debtor) => debtor.citizenId === fileCitizenId)) return fileCitizenId;
  return debtors.find((debtor) => debtor.responsible)?.citizenId ?? '';
}

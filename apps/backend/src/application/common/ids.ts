/**
 * Whether two ids name the same row, whatever their spelling.
 *
 * A UUID has one row in Postgres and many spellings in JavaScript:
 * `ParseUUIDPipe` passes an upper-cased UUID on as typed, the database reads
 * either case as the same row, and a string `===` does not. «3F2A…» was
 * another inspector to the self-payout check and the advisory lock (review of
 * 2026-10-11), and another person to «أنت» on the inspector profile (task S11
 * of the 2026-11-14 security audit, N-7). Every guard that compares a
 * caller's id with a row's uses this, so the class of bug has one fix.
 *
 * Absent is never the same as anything, itself included: a guard comparing
 * two missing ids must not conclude they match.
 */
export function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

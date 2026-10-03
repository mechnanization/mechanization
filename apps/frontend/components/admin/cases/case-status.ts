import type { CaseStatus } from '@mechanization/shared-schemas';

/**
 * The next state a quick tap moves a case to — `OPEN → SCHEDULED → RESOLVED`,
 * and from `RESOLVED` back to `OPEN`.
 *
 * A cycle rather than three buttons, because it is one control in a table row
 * and the order is the order a case actually travels: somebody agrees to a
 * revisit before the revisit happens. Reopening from the end is the correction
 * path — a case closed in error, or a household that moved out again.
 */
export function nextStatus(status: CaseStatus): CaseStatus {
  if (status === 'OPEN') return 'SCHEDULED';
  if (status === 'SCHEDULED') return 'RESOLVED';
  return 'OPEN';
}

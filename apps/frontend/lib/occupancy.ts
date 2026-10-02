import { isUnoccupied } from '@mechanization/shared-schemas';

/**
 * The dot an existing unit wears: filled while somebody lives there, grey while
 * nobody does (شاغرة، قيد الإنجاز). A مسكن موسمي is neither — kept for an owner
 * who is away most of the year — so it gets a ring rather than a dot. Nothing
 * at all for a unit not yet surveyed, or for structure: a dot there would
 * claim an answer nobody gave.
 *
 * One definition for every surface that draws it — the unit grid and the
 * citizen's properties page each had their own copy.
 */
export function occupancyDot(status: string | null | undefined): 'occupied' | 'vacant' | 'seasonal' | null {
  if (!status) return null;
  if (status === 'SEASONAL') return 'seasonal';
  return isUnoccupied(status as never) ? 'vacant' : 'occupied';
}

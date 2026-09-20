import { ValidationError } from '../../application/common/exceptions';

/**
 * Coercions every controller needs on a query string, in one place.
 *
 * A query string is whatever arrived. Nothing downstream should have to defend
 * itself against a value that could only have come from a typo or a stale
 * bookmark, and a 500 is the wrong answer to one.
 */

/**
 * A date from a query string, or nothing — never an `Invalid Date`.
 *
 * `new Date('last tuesday')` is a `Date` object that passes every type check
 * and fails on use: Prisma turns it into a 500, and `AuditService.cacheKey`
 * calls `.toISOString()` on it, which throws `RangeError` before the query is
 * even built. Both are a server error for a malformed URL. Dropping the filter
 * shows the unfiltered list, which is what an unreadable filter means.
 */
export function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * The same coercion, refusing instead of dropping.
 *
 * Two behaviours because the two are read differently. A log or a case list
 * narrowed by a date that would not parse shows the unfiltered list, which is
 * what "no usable filter" means and is visibly everything. A figure — an
 * officer's counts for a period — read with the filter silently dropped is a
 * *different number* presented as the one that was asked for, so that one
 * refuses. Use `parseDate` for lists, this for anything that adds up.
 */
export function requireDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ValidationError('تاريخ غير صالح');
  return parsed;
}

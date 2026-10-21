import { municipalDayStart } from '@mechanization/shared-schemas';
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

const BARE_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A `YYYY-MM-DD` that names a real day: «2026-02-30» parses — as 2 March — so it
 * must come back unchanged. And in a year a record can carry: `Date.UTC` reads
 * 0–99 as 1900–1999, and the day after 9999-12-31 prints as «+010000», so
 * `to=9999-12-31` was a range ending in 1909 that matched nothing.
 */
function realDay(day: string): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  const year = Number(day.slice(0, 4));
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== day ||
    year < 1900 ||
    year > 2100
  ) {
    throw new ValidationError({ code: 'INVALID_QUERY_DATE', message: `Not a day on the calendar: ${day}` });
  }
  return day;
}

/**
 * The start of a range that adds up. A bare day is that day's first instant on
 * the municipality's calendar; anything else is read as an instant, refusing
 * what will not parse (`requireDate`).
 */
export function requireRangeStart(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  return BARE_DAY.test(value) ? municipalDayStart(realDay(value)) : requireDate(value);
}

/**
 * The end of a range that adds up. A bare day is that day's last instant in
 * Beirut, so `to=2026-10-08` includes the 8th — read as an instant it meant
 * midnight UTC at the start of the 8th, and the day the reader asked for was
 * left out of the figure.
 */
export function requireRangeEnd(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  if (!BARE_DAY.test(value)) return requireDate(value);
  const next = new Date(`${realDay(value)}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return new Date(municipalDayStart(next.toISOString().slice(0, 10)).getTime() - 1);
}

/**
 * A whole number from a query string, or nothing. Digits only: `parseInt`
 * read `"12abc"` as 12 and `"-5"` as -5, and a limit is not a place for either.
 */
export function optionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d{1,9}$/.test(value)) {
    throw new ValidationError({ code: 'INVALID_QUERY_VALUE', message: `Not a whole number: ${value}` });
  }
  return Number(value);
}

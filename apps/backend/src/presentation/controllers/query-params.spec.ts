import { ValidationError } from '../../application/common/exceptions';
import { parseDate, requireDate } from './query-params';

/**
 * A query string is whatever arrived.
 *
 * `new Date('last tuesday')` is a `Date` that passes every type check and
 * fails on use — Prisma answers it with a 500, and `AuditService.cacheKey`
 * calls `.toISOString()` on it, which throws `RangeError` before a query is
 * even built. Both are a server error for a mistyped URL.
 */
describe('parseDate — for a list', () => {
  it('reads an ISO instant', () => {
    expect(parseDate('2026-09-19T08:00:00.000Z')?.toISOString()).toBe('2026-09-19T08:00:00.000Z');
  });

  it('drops what will not parse rather than handing on an Invalid Date', () => {
    expect(parseDate('yesterday')).toBeUndefined();
    expect(parseDate('2026-13-45')).toBeUndefined();
    expect(parseDate('')).toBeUndefined();
    expect(parseDate(undefined)).toBeUndefined();
  });
});

describe('requireDate — for a figure', () => {
  it('refuses what will not parse, because a dropped filter changes the number', () => {
    expect(() => requireDate('yesterday')).toThrow(ValidationError);
  });

  it('still lets an absent filter through', () => {
    expect(requireDate(undefined)).toBeUndefined();
  });
});

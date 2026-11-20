import { ValidationError } from '../../application/common/exceptions';
import {
  optionalInt,
  optionalOneOf,
  parseDate,
  queryLimit,
  queryOffset,
  requireDate,
  requireRangeEnd,
  requireRangeStart,
} from './query-params';

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

/*
  A range sent as days is read on the municipality's calendar. Read as an
  instant, `to=2026-10-08` meant midnight UTC at the start of the 8th — the day
  the reader asked for was left out of the figure, and in Beirut the boundary
  sat two or three hours off either way.
*/
describe('requireRangeStart / requireRangeEnd — a range that adds up', () => {
  it('reads a bare day as that whole day in Beirut, summer (UTC+3) and winter (UTC+2)', () => {
    expect(requireRangeStart('2026-10-08')?.toISOString()).toBe('2026-10-07T21:00:00.000Z');
    expect(requireRangeEnd('2026-10-08')?.toISOString()).toBe('2026-10-08T20:59:59.999Z');
    expect(requireRangeStart('2026-01-15')?.toISOString()).toBe('2026-01-14T22:00:00.000Z');
    expect(requireRangeEnd('2026-01-15')?.toISOString()).toBe('2026-01-15T21:59:59.999Z');
  });

  it('keeps the 23-hour and 25-hour days whole, where the clocks change at midnight', () => {
    // 29 March 2026: midnight never happens, the day opens at 01:00.
    expect(requireRangeStart('2026-03-29')?.toISOString()).toBe('2026-03-28T22:00:00.000Z');
    expect(requireRangeEnd('2026-03-29')?.toISOString()).toBe('2026-03-29T20:59:59.999Z');
    // 24 October 2026: 23:00 to midnight happens twice, and both belong to the 24th.
    expect(requireRangeStart('2026-10-24')?.toISOString()).toBe('2026-10-23T21:00:00.000Z');
    expect(requireRangeEnd('2026-10-24')?.toISOString()).toBe('2026-10-24T21:59:59.999Z');
  });

  it('keeps an instant as the instant it names', () => {
    expect(requireRangeEnd('2026-10-08T12:00:00.000Z')?.toISOString()).toBe('2026-10-08T12:00:00.000Z');
  });

  it('refuses a day that is not on the calendar, with its own code', () => {
    expect(() => requireRangeEnd('2026-02-30')).toThrow(ValidationError);
    expect(() => requireRangeStart('2026-02-30')).toThrow(expect.objectContaining({ code: 'INVALID_QUERY_DATE' }));
  });

  it('refuses a year no record carries, rather than reading it as another', () => {
    // `Date.UTC` reads 0–99 as 1900–1999, and the day after 9999-12-31 prints as «+010000».
    for (const day of ['0000-01-01', '0099-12-31', '1899-12-31', '2101-01-01', '9999-12-31']) {
      expect(() => requireRangeStart(day)).toThrow(expect.objectContaining({ code: 'INVALID_QUERY_DATE' }));
      expect(() => requireRangeEnd(day)).toThrow(expect.objectContaining({ code: 'INVALID_QUERY_DATE' }));
    }
    expect(requireRangeStart('1900-01-01')).toBeInstanceOf(Date);
    expect(requireRangeEnd('2100-12-31')?.toISOString()).toBe('2100-12-31T21:59:59.999Z');
  });

  it('lets an absent bound through', () => {
    expect(requireRangeStart(undefined)).toBeUndefined();
    expect(requireRangeEnd('')).toBeUndefined();
  });
});

describe('optionalInt — a limit or a page', () => {
  it('reads digits', () => {
    expect(optionalInt('50')).toBe(50);
    expect(optionalInt(undefined)).toBeUndefined();
  });

  it('refuses what parseInt would have half-read', () => {
    for (const raw of ['12abc', '-5', '1.5', ' 7']) {
      expect(() => optionalInt(raw)).toThrow(expect.objectContaining({ code: 'INVALID_QUERY_VALUE' }));
    }
  });
});

/** Task S11 of the 2026-11-14 security audit: each value that reached the database as a 500. */
describe('queryLimit / queryOffset — a page of rows', () => {
  it('defaults an absent limit and clamps one out of range', () => {
    expect(queryLimit(undefined, 50, 200)).toBe(50);
    expect(queryLimit('999999', 50, 200)).toBe(200);
    expect(queryLimit('0', 50, 200)).toBe(1);
  });

  it('refuses what `Number()` used to wave through', () => {
    for (const value of ['1e20', '-5', 'Infinity', '12abc']) {
      expect(() => queryLimit(value, 50, 200)).toThrow(ValidationError);
      expect(() => queryOffset(value)).toThrow(ValidationError);
    }
  });

  it('reads an offset as zero when absent and keeps it within nine digits', () => {
    expect(queryOffset(undefined)).toBe(0);
    expect(queryOffset('40')).toBe(40);
    expect(() => queryOffset('1000000000')).toThrow(ValidationError);
  });
});

describe('optionalOneOf — a filter the database holds as an enum', () => {
  const METHODS = ['CASH', 'WHISH_MONEY'] as const;

  it('takes a listed value, and nothing for absent or empty', () => {
    expect(optionalOneOf('CASH', METHODS)).toBe('CASH');
    expect(optionalOneOf(undefined, METHODS)).toBeUndefined();
    expect(optionalOneOf('', METHODS)).toBeUndefined();
  });

  it('refuses a value the list does not hold, case included', () => {
    expect(() => optionalOneOf('cash', METHODS)).toThrow(expect.objectContaining({ code: 'INVALID_QUERY_VALUE' }));
  });
});

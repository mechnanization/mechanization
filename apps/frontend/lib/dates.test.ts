import { describe, expect, it } from 'vitest';
import { formatDay, formatDayLong, formatRelative } from './dates';

describe('formatDay', () => {
  it('rearranges a business day without passing it through any zone', () => {
    expect(formatDay('2026-10-09')).toBe('09/10/2026');
    expect(formatDay('2027-01-01')).toBe('01/01/2027');
  });
});

describe('formatDayLong', () => {
  it('names the weekday and the month, with Latin digits, on the day given', () => {
    // The punctuation between the parts is ICU's to choose; the day, month and weekday are not.
    expect(formatDayLong('2026-10-09', 'en')).toMatch(/^Friday,? 9 October 2026$/);
    const arabic = formatDayLong('2026-10-09', 'ar');
    expect(arabic).toContain('9');
    expect(arabic).toContain('2026');
    expect(arabic).not.toMatch(/[٠-٩]/);
  });
});

describe('formatRelative', () => {
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);

  it('measures against the clock it is given, not the browser’s', () => {
    expect(formatRelative(new Date(now - 30_000), 'en', now)).toBe('Just now');
    expect(formatRelative(new Date(now - 5 * 60_000), 'en', now)).toBe('5 minutes ago');
    expect(formatRelative(new Date(now - 3 * 3_600_000), 'en', now)).toBe('3 hours ago');
  });

  it('says «الآن» for under a minute in Arabic', () => {
    expect(formatRelative(new Date(now - 10_000), 'ar', now)).toBe('الآن');
  });
});

import { describe, expect, it } from 'vitest';
import { formatRelative } from './dates';

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

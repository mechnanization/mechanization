import { describe, expect, it } from 'vitest';
import { readView } from './read-view';

describe('readView', () => {
  it('keeps what is on screen when a background re-read fails, and says so beside it', () => {
    // The count sheet after a refocus read answered 502: the typed boxes must stay mounted.
    const sheet = { day: '2026-10-09' };
    expect(readView(sheet, 'تعذّر تحميل جرد اليومية.')).toEqual({
      state: 'ready',
      data: sheet,
      refreshFailed: 'تعذّر تحميل جرد اليومية.',
    });
  });

  it('gives the page to the error only while nothing has loaded', () => {
    expect(readView(undefined, 'تعذّر التحميل.')).toEqual({ state: 'failed', error: 'تعذّر التحميل.' });
    expect(readView(undefined, null)).toEqual({ state: 'loading' });
    expect(readView({ day: '2026-10-09' }, null)).toEqual({
      state: 'ready',
      data: { day: '2026-10-09' },
      refreshFailed: null,
    });
  });
});

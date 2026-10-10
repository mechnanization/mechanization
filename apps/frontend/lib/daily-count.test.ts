import { describe, expect, it } from 'vitest';
import type { DailyCountLineView, DailyCountView } from '@mechanization/shared-schemas';
import { countPayload, hasUnsavedCounts, initialDraft, judgeDraft, varianceKind } from './daily-count';

const SAFE = 'a0000000-0000-4000-8000-000000000001';
const WHISH = 'a0000000-0000-4000-8000-000000000002';

function line(id: string, currency: string, expectedAmount: number, count: Partial<DailyCountView> | null = null): DailyCountLineView {
  return {
    account: { id, name: id === SAFE ? 'صندوق النقد — ليرة' : 'حساب Whish — دولار', type: 'CASH_SAFE', currency, isPrimary: true, active: true },
    expectedAmount,
    count: count
      ? {
          expectedAmount,
          countedAmount: expectedAmount,
          difference: 0,
          varianceReason: null,
          countedByName: 'رنا المحاسبة',
          countedAt: '2026-10-09T14:00:00.000Z',
          stale: false,
          ...count,
        }
      : null,
  };
}

describe('varianceKind', () => {
  it('says which way a difference goes, and calls a cent’s float noise a match', () => {
    expect(varianceKind(0)).toBe('MATCH');
    expect(varianceKind(0.1 + 0.2 - 0.3)).toBe('MATCH');
    expect(varianceKind(5_000)).toBe('SURPLUS');
    expect(varianceKind(-0.5)).toBe('SHORTAGE');
  });
});

describe('initialDraft', () => {
  it('opens on the recorded count, grouped as typed', () => {
    expect(initialDraft(line(SAFE, 'LBP', 1_250_000, { countedAmount: 1_240_000, varianceReason: 'ورقة ناقصة' }))).toEqual({
      raw: '1,240,000',
      reason: 'ورقة ناقصة',
    });
    expect(initialDraft(line(WHISH, 'USD', 20.5, { countedAmount: 20.5 }))).toEqual({ raw: '20.5', reason: '' });
  });

  it('opens empty with no count, and with one the books have moved past', () => {
    expect(initialDraft(line(SAFE, 'LBP', 100))).toEqual({ raw: '', reason: '' });
    expect(initialDraft(line(SAFE, 'LBP', 100, { stale: true, expectedAmount: 90 }))).toEqual({ raw: '', reason: '' });
  });
});

describe('judgeDraft', () => {
  it('works out the difference against the books, as the server will', () => {
    expect(judgeDraft(line(SAFE, 'LBP', 1_250_000), { raw: '1,200,000', reason: '' })).toEqual({
      state: 'READY',
      counted: 1_200_000,
      difference: -50_000,
      kind: 'SHORTAGE',
      needsReason: true,
      changed: true,
    });
  });

  it('reads Arabic-Indic digits, and refuses what is not a figure', () => {
    expect(judgeDraft(line(SAFE, 'LBP', 100), { raw: '١٠٠', reason: '' })).toMatchObject({ state: 'READY', kind: 'MATCH' });
    expect(judgeDraft(line(WHISH, 'USD', 1), { raw: '1.234', reason: '' })).toEqual({ state: 'INVALID', reason: 'decimals' });
    expect(judgeDraft(line(SAFE, 'LBP', 1), { raw: '  ', reason: '' })).toEqual({ state: 'EMPTY' });
  });

  it('calls an unchanged count unchanged, and a new reason a change', () => {
    const counted = line(SAFE, 'LBP', 100, { countedAmount: 90, difference: -10, varianceReason: 'سبب' });
    expect(judgeDraft(counted, { raw: '90', reason: 'سبب' })).toMatchObject({ changed: false });
    expect(judgeDraft(counted, { raw: '90', reason: 'سبب أوضح' })).toMatchObject({ changed: true });
  });
});

describe('countPayload', () => {
  const lines = [line(SAFE, 'LBP', 1_000_000), line(WHISH, 'USD', 20)];

  it('sends the counted wallets with the books’ figure they were counted against', () => {
    expect(
      countPayload('2026-10-09', lines, {
        [SAFE]: { raw: '990,000', reason: '  ورقة ١٠ آلاف ناقصة ' },
        [WHISH]: { raw: '', reason: '' },
      }),
    ).toEqual({
      input: {
        businessDate: '2026-10-09',
        counts: [{ accountId: SAFE, expectedAmount: 1_000_000, countedAmount: 990_000, varianceReason: 'ورقة ١٠ آلاف ناقصة' }],
      },
      problems: {},
    });
  });

  it('holds the whole request back while a difference has no reason or a box is not a figure', () => {
    expect(
      countPayload('2026-10-09', lines, {
        [SAFE]: { raw: '990,000', reason: '' },
        [WHISH]: { raw: '20.555', reason: '' },
      }),
    ).toEqual({ input: null, problems: { [SAFE]: 'reasonRequired', [WHISH]: 'decimals' } });
  });

  it('sends nothing when nothing changed', () => {
    const counted = [line(SAFE, 'LBP', 100, { countedAmount: 100 })];
    expect(countPayload('2026-10-09', counted, {})).toEqual({ input: null, problems: {} });
    expect(countPayload('2026-10-09', counted, { [SAFE]: { raw: '100', reason: '' } })).toEqual({ input: null, problems: {} });
  });
});

describe('hasUnsavedCounts', () => {
  it('holds the close while a typed figure is not saved, and not for an untouched or emptied box', () => {
    const lines = [line(SAFE, 'LBP', 100, { countedAmount: 100 })];
    expect(hasUnsavedCounts(lines, {})).toBe(false);
    expect(hasUnsavedCounts(lines, { [SAFE]: { raw: '100', reason: '' } })).toBe(false);
    expect(hasUnsavedCounts(lines, { [SAFE]: { raw: '', reason: '' } })).toBe(false);
    expect(hasUnsavedCounts(lines, { [SAFE]: { raw: '95', reason: 'x' } })).toBe(true);
    expect(hasUnsavedCounts(lines, { [SAFE]: { raw: 'abc', reason: '' } })).toBe(true);
  });
});

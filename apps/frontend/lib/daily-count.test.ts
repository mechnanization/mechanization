import { describe, expect, it } from 'vitest';
import type { DailyCountLineView, DailyCountSheet, DailyCountView } from '@mechanization/shared-schemas';
import {
  closeLanded,
  closeRequest,
  countPayload,
  dayList,
  draftsAfterExpectedChanged,
  draftsAfterSave,
  hasUnsavedCounts,
  initialDraft,
  judgeDraft,
  movedAccounts,
  varianceKind,
  verdictParams,
} from './daily-count';

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

describe('draftsAfterSave', () => {
  it('keeps a correction typed while the save was in flight, so it still holds the close', () => {
    // Sent: the safe at 12,500,000. Typed during the request: 12,000,000.
    const sent = { [SAFE]: { raw: '12,500,000', reason: '' }, [WHISH]: { raw: '1,250.50', reason: '' } };
    const current = { ...sent, [SAFE]: { raw: '12,000,000', reason: '' } };
    const after = draftsAfterSave(current, sent);
    expect(after).toEqual({ [SAFE]: { raw: '12,000,000', reason: '' } });

    // The safe was saved at 12,500,000: the kept box is a figure the server does not have.
    const saved = [line(SAFE, 'LBP', 12_500_000, { countedAmount: 12_500_000 })];
    expect(hasUnsavedCounts(saved, after)).toBe(true);
  });

  it('clears every box the request carried unchanged, and keeps a box first touched during it', () => {
    const sent = { [SAFE]: { raw: '100', reason: 'x' } };
    expect(draftsAfterSave(sent, sent)).toEqual({});
    expect(draftsAfterSave({ ...sent, [WHISH]: { raw: '5', reason: '' } }, sent)).toEqual({ [WHISH]: { raw: '5', reason: '' } });
    expect(draftsAfterSave({ [SAFE]: { raw: '100', reason: 'y' } }, sent)).toEqual({ [SAFE]: { raw: '100', reason: 'y' } });
  });
});

describe('after COUNT_EXPECTED_CHANGED', () => {
  it('reads the moved wallets off the refusal, and nothing from a shape it does not know', () => {
    expect(movedAccounts({ accounts: [{ accountId: SAFE, expectedAmount: 13_500_000 }] })).toEqual([SAFE]);
    expect(movedAccounts(undefined)).toEqual([]);
    expect(movedAccounts([{ path: 'x', message: 'y' }])).toEqual([]);
    expect(movedAccounts({ accounts: [{ expectedAmount: 1 }] })).toEqual([]);
  });

  it('empties a moved wallet’s figure and reason, so the old reason cannot be filed against the new difference', () => {
    const typed = {
      [SAFE]: { raw: '12,450,000', reason: 'نقص 50,000 ل.ل: ورقة نقدية ممزقة' },
      [WHISH]: { raw: '20', reason: '' },
    };
    const after = draftsAfterExpectedChanged(typed, [SAFE]);
    expect(after).toEqual({ [SAFE]: { raw: '', reason: '' }, [WHISH]: { raw: '20', reason: '' } });

    // The books moved to 13,500,000: the second press sends nothing for the safe until it is counted again.
    const moved = [line(SAFE, 'LBP', 13_500_000), line(WHISH, 'USD', 20)];
    expect(countPayload('2026-10-09', moved, after).input?.counts.map((count) => count.accountId)).toEqual([WHISH]);
  });
});

describe('closeRequest', () => {
  it('sends every count the dialog lists, with when it was counted', () => {
    const sheet = {
      day: { businessDate: '2026-10-09' } as DailyCountSheet['day'],
      lines: [line(SAFE, 'LBP', 100, { countedAt: '2026-10-09T18:01:02.345Z' }), line(WHISH, 'USD', 20)],
    };
    expect(closeRequest(sheet)).toEqual({
      businessDate: '2026-10-09',
      counts: [{ accountId: SAFE, countedAt: '2026-10-09T18:01:02.345Z' }],
    });
  });
});

describe('closeLanded', () => {
  const day = (businessDate: string, status: 'OPEN' | 'CLOSED' | 'REOPENED') => ({
    day: { businessDate, status } as DailyCountSheet['day'],
  });

  it('says a close with a lost answer went through only when that day now reads CLOSED', () => {
    expect(closeLanded(day('2026-10-09', 'CLOSED'), '2026-10-09')).toBe(true);
    expect(closeLanded(day('2026-10-09', 'OPEN'), '2026-10-09')).toBe(false);
    // The next day to close, which a committed close moves the page on to, says nothing about this one.
    expect(closeLanded(day('2026-10-10', 'CLOSED'), '2026-10-09')).toBe(false);
    expect(closeLanded(null, '2026-10-09')).toBe(false);
  });
});

describe('dates in the closing panel', () => {
  it('names the day as the rest of the page does, never in the wire’s ISO form', () => {
    expect(verdictParams({ ok: false, code: 'DAY_NOT_OVER' }, '2026-10-10')).toEqual({ date: '10/10/2026', count: 0, min: 10 });
    expect(
      verdictParams({ ok: false, code: 'UNRESOLVED_ACTIVE_DAYS_EXIST', day: '2026-10-04', days: 2 }, '2026-10-09'),
    ).toMatchObject({ date: '04/10/2026', count: 2 });
  });

  it('lists days with the locale’s own comma', () => {
    expect(dayList(['2026-10-07', '2026-10-08'], 'ar')).toBe('07/10/2026، 08/10/2026');
    expect(dayList(['2026-10-07', '2026-10-08'], 'en')).toBe('07/10/2026, 08/10/2026');
  });
});

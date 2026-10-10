import {
  addDays,
  closedDayFor,
  closedThrough,
  daysFrom,
  isCountedWallet,
  nextDayToClose,
  planClosure,
  planCountDate,
  planCountLine,
  planReopen,
  summariseDay,
  varianceOf,
  type ClosureRecord,
} from './day-closing.plan';

const GO_LIVE = '2026-10-01';
const TODAY = '2026-10-10';
const SAFE = 'a0000000-0000-4000-8000-000000000001';
const WHISH = 'a0000000-0000-4000-8000-000000000002';

const closed = (businessDate: string): ClosureRecord => ({ businessDate, status: 'CLOSED' });
const reopened = (businessDate: string): ClosureRecord => ({ businessDate, status: 'REOPENED' });

/** A closure request that passes every rule, for each test to break one. */
function closing(overrides: Partial<Parameters<typeof planClosure>[0]> = {}): Parameters<typeof planClosure>[0] {
  return {
    businessDate: '2026-10-02',
    today: TODAY,
    goLiveOn: GO_LIVE,
    closures: [closed('2026-10-01')],
    activeDays: ['2026-10-01', '2026-10-02'],
    requiredAccountIds: [SAFE, WHISH],
    counts: [
      { accountId: SAFE, expectedAmount: 1_500_000 },
      { accountId: WHISH, expectedAmount: 20.5 },
    ],
    expectedNow: new Map([
      [SAFE, 1_500_000],
      [WHISH, 20.5],
    ]),
    ...overrides,
  };
}

describe('calendar days', () => {
  it('steps across a month end and a year end', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('lists a range with both ends, and nothing when it is backwards', () => {
    expect(daysFrom('2026-10-29', '2026-11-01')).toEqual(['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    expect(daysFrom('2026-10-02', '2026-10-01')).toEqual([]);
  });
});

describe('the lock', () => {
  it('is the latest CLOSED day; a reopened one does not count', () => {
    expect(closedThrough([])).toBeNull();
    expect(closedThrough([closed('2026-10-01'), closed('2026-10-03'), closed('2026-10-02')])).toBe('2026-10-03');
    expect(closedThrough([closed('2026-10-01'), reopened('2026-10-02')])).toBe('2026-10-01');
  });

  it('refuses an instant on or before the latest closed day, on Beirut’s calendar', () => {
    // 22:30 UTC on 3 October is 01:30 on the 4th in Beirut (UTC+3 until the 25th).
    expect(closedDayFor(new Date('2026-10-03T22:30:00Z'), '2026-10-03')).toBeNull();
    expect(closedDayFor(new Date('2026-10-03T20:59:00Z'), '2026-10-03')).toBe('2026-10-03');
    expect(closedDayFor(new Date('2026-09-15T12:00:00Z'), '2026-10-03')).toBe('2026-09-15');
    expect(closedDayFor(new Date('2026-10-03T12:00:00Z'), null)).toBeNull();
  });

  it('counts every wallet but a collector’s custody', () => {
    expect(isCountedWallet('CASH_SAFE')).toBe(true);
    expect(isCountedWallet('WHISH_ACCOUNT')).toBe(true);
    expect(isCountedWallet('BANK_ACCOUNT')).toBe(true);
    expect(isCountedWallet('PETTY_CASH')).toBe(true);
    expect(isCountedWallet('COLLECTOR_CUSTODY')).toBe(false);
  });
});

describe('planCountDate', () => {
  const base = { today: TODAY, goLiveOn: GO_LIVE, closedThrough: '2026-10-05' };

  it('accepts today and any open day since the last close', () => {
    expect(planCountDate({ ...base, businessDate: TODAY })).toEqual({ ok: true });
    expect(planCountDate({ ...base, businessDate: '2026-10-06' })).toEqual({ ok: true });
  });

  it('refuses a day that has not come yet', () => {
    expect(planCountDate({ ...base, businessDate: '2026-10-11' })).toEqual({ ok: false, code: 'COUNT_DATE_IN_FUTURE' });
  });

  it('refuses a day before the treasury went live: there is no balance to count against', () => {
    expect(planCountDate({ ...base, businessDate: '2026-09-30' })).toEqual({
      ok: false,
      code: 'DAY_BEFORE_GO_LIVE',
      goLiveOn: GO_LIVE,
    });
  });

  it('refuses a closed day and every day before it', () => {
    expect(planCountDate({ ...base, businessDate: '2026-10-05' })).toEqual({ ok: false, code: 'DAY_ALREADY_CLOSED' });
    expect(planCountDate({ ...base, businessDate: '2026-10-02' })).toEqual({ ok: false, code: 'DAY_ALREADY_CLOSED' });
  });

  it('refuses everything while the treasury is not active', () => {
    expect(planCountDate({ ...base, goLiveOn: null, businessDate: TODAY })).toEqual({
      ok: false,
      code: 'TREASURY_NOT_ACTIVE',
    });
  });
});

describe('planCountLine', () => {
  it('works out the difference to the cent, either way', () => {
    expect(varianceOf(100.1, 100.3)).toBe(-0.2);
    expect(varianceOf(1_500_000, 1_450_000)).toBe(50_000);
    expect(varianceOf(0.3, 0.1 + 0.2)).toBe(0);
  });

  it('accepts a count that matches, with no reason', () => {
    expect(planCountLine({ shownExpected: 500, actualExpected: 500, counted: 500 })).toEqual({
      ok: true,
      difference: 0,
      reason: null,
    });
  });

  it('asks why for a shortage and for a surplus alike', () => {
    expect(planCountLine({ shownExpected: 500, actualExpected: 500, counted: 450 })).toEqual({
      ok: false,
      code: 'COUNT_VARIANCE_REASON_REQUIRED',
      difference: -50,
    });
    expect(planCountLine({ shownExpected: 500, actualExpected: 500, counted: 510, reason: '   ' })).toEqual({
      ok: false,
      code: 'COUNT_VARIANCE_REASON_REQUIRED',
      difference: 10,
    });
    expect(planCountLine({ shownExpected: 500, actualExpected: 500, counted: 510, reason: ' ورقة زائدة ' })).toEqual({
      ok: true,
      difference: 10,
      reason: 'ورقة زائدة',
    });
  });

  it('refuses a count taken against a figure the books have since moved past', () => {
    expect(planCountLine({ shownExpected: 500, actualExpected: 650, counted: 500, reason: 'x' })).toEqual({
      ok: false,
      code: 'COUNT_EXPECTED_CHANGED',
      shown: 500,
      actual: 650,
    });
  });

  it('keeps a note given with no difference', () => {
    expect(planCountLine({ shownExpected: 20, actualExpected: 20, counted: 20, reason: 'عُدّ مرتين' })).toMatchObject({
      ok: true,
      reason: 'عُدّ مرتين',
    });
  });
});

describe('planClosure', () => {
  it('closes a counted day that follows the last closed one', () => {
    expect(planClosure(closing())).toEqual({ ok: true, sweeps: [] });
  });

  it('closes the go-live day first, when nothing is closed yet', () => {
    expect(planClosure(closing({ businessDate: GO_LIVE, closures: [] }))).toEqual({ ok: true, sweeps: [] });
  });

  it('refuses today and anything later: only a day that has ended closes', () => {
    expect(planClosure(closing({ businessDate: TODAY }))).toEqual({ ok: false, code: 'DAY_NOT_OVER' });
    expect(planClosure(closing({ businessDate: '2026-10-11' }))).toEqual({ ok: false, code: 'DAY_NOT_OVER' });
  });

  it('refuses a day before go-live, and anything while the treasury is not active', () => {
    expect(planClosure(closing({ businessDate: '2026-09-30' }))).toEqual({
      ok: false,
      code: 'DAY_BEFORE_GO_LIVE',
      day: GO_LIVE,
    });
    expect(planClosure(closing({ goLiveOn: null }))).toEqual({ ok: false, code: 'TREASURY_NOT_ACTIVE' });
  });

  it('refuses a day already closed, and one before the last close', () => {
    expect(planClosure(closing({ businessDate: '2026-10-01' }))).toEqual({ ok: false, code: 'DAY_ALREADY_CLOSED' });
    expect(
      planClosure(closing({ businessDate: '2026-10-02', closures: [closed('2026-10-01'), closed('2026-10-03')] })),
    ).toEqual({ ok: false, code: 'DAY_ALREADY_CLOSED' });
  });

  it('sweeps the quiet days between the last close and this one', () => {
    expect(
      planClosure(closing({ businessDate: '2026-10-05', activeDays: ['2026-10-01', '2026-10-05'] })),
    ).toEqual({ ok: true, sweeps: ['2026-10-02', '2026-10-03', '2026-10-04'] });
  });

  it('refuses while an earlier day with movement is still open, naming the first', () => {
    expect(
      planClosure(closing({ businessDate: '2026-10-05', activeDays: ['2026-10-03', '2026-10-04', '2026-10-05'] })),
    ).toEqual({ ok: false, code: 'UNRESOLVED_ACTIVE_DAYS_EXIST', day: '2026-10-03', days: 2 });
  });

  it('refuses a later day while a reopened one waits to be closed again', () => {
    expect(
      planClosure(
        closing({
          businessDate: '2026-10-03',
          closures: [closed('2026-10-01'), reopened('2026-10-02')],
          activeDays: [],
        }),
      ),
    ).toEqual({ ok: false, code: 'CLOSURE_OUT_OF_CHRONOLOGICAL_ORDER', day: '2026-10-02' });
  });

  it('closes a reopened day again', () => {
    expect(
      planClosure(closing({ businessDate: '2026-10-02', closures: [closed('2026-10-01'), reopened('2026-10-02')] })),
    ).toEqual({ ok: true, sweeps: [] });
  });

  it('refuses until every counted wallet has a count', () => {
    expect(planClosure(closing({ counts: [{ accountId: SAFE, expectedAmount: 1_500_000 }] }))).toEqual({
      ok: false,
      code: 'COUNT_MISSING_FOR_ACTIVE_ACCOUNTS',
      accounts: 1,
    });
  });

  it('refuses a count taken before the books moved, until it is recounted', () => {
    const expectedNow = new Map([
      [SAFE, 1_650_000],
      [WHISH, 20.5],
    ]);
    expect(planClosure(closing({ expectedNow }))).toEqual({ ok: false, code: 'COUNT_EXPECTED_CHANGED', accounts: 1 });
  });

  it('ignores a count of a wallet that no longer needs one', () => {
    expect(
      planClosure(
        closing({
          requiredAccountIds: [SAFE],
          counts: [
            { accountId: SAFE, expectedAmount: 1_500_000 },
            { accountId: WHISH, expectedAmount: 999 },
          ],
        }),
      ),
    ).toEqual({ ok: true, sweeps: [] });
  });
});

describe('nextDayToClose', () => {
  const base = { goLiveOn: GO_LIVE, today: TODAY };

  it('offers a reopened day before anything else', () => {
    expect(nextDayToClose({ ...base, closures: [closed('2026-10-01'), reopened('2026-10-02')], activeDays: [] })).toBe(
      '2026-10-02',
    );
  });

  it('offers the first day with movement after the last close', () => {
    expect(
      nextDayToClose({ ...base, closures: [closed('2026-10-01')], activeDays: ['2026-10-04', '2026-10-06'] }),
    ).toBe('2026-10-04');
  });

  it('offers yesterday when every open day since is quiet: its close sweeps the rest', () => {
    expect(nextDayToClose({ ...base, closures: [closed('2026-10-01')], activeDays: [TODAY] })).toBe('2026-10-09');
  });

  it('offers today when everything that has ended is closed', () => {
    expect(nextDayToClose({ ...base, closures: [closed('2026-10-09')], activeDays: [] })).toBe(TODAY);
  });

  it('offers the go-live day first, and nothing while the treasury is not active', () => {
    expect(nextDayToClose({ ...base, closures: [], activeDays: [GO_LIVE] })).toBe(GO_LIVE);
    expect(nextDayToClose({ ...base, goLiveOn: null, closures: [], activeDays: [] })).toBeNull();
  });
});

describe('planReopen', () => {
  const closures = [closed('2026-10-01'), closed('2026-10-02'), closed('2026-10-03')];
  const reason = 'سند صرف سُجّل في اليوم الخطأ';

  it('reopens the latest closed day', () => {
    expect(planReopen({ businessDate: '2026-10-03', closures, reason })).toEqual({ ok: true });
  });

  it('refuses an older day: it would leave a closed day after an open one', () => {
    expect(planReopen({ businessDate: '2026-10-02', closures, reason })).toEqual({
      ok: false,
      code: 'ONLY_LATEST_CLOSED_DAY_CAN_BE_REOPENED',
      latest: '2026-10-03',
    });
  });

  it('refuses a day that is not closed', () => {
    expect(planReopen({ businessDate: '2026-10-04', closures, reason })).toEqual({ ok: false, code: 'DAY_NOT_CLOSED' });
    expect(
      planReopen({ businessDate: '2026-10-03', closures: [closed('2026-10-02'), reopened('2026-10-03')], reason }),
    ).toEqual({ ok: false, code: 'DAY_NOT_CLOSED' });
  });

  it('refuses without a reason worth keeping', () => {
    expect(planReopen({ businessDate: '2026-10-03', closures, reason: '  خطأ   ' })).toEqual({
      ok: false,
      code: 'REOPEN_REASON_REQUIRED',
    });
  });
});

describe('summariseDay', () => {
  it('keeps money in and money out apart, by wallet and by source', () => {
    const days = summariseDay([
      { accountId: SAFE, amount: 250_000, source: 'CITIZEN_PAYMENT' },
      { accountId: SAFE, amount: 100_000, source: 'CITIZEN_PAYMENT' },
      { accountId: SAFE, amount: -100_000, source: 'CITIZEN_PAYMENT' },
      { accountId: SAFE, amount: -40_000, source: 'EXPENSE_VOUCHER' },
      { accountId: WHISH, amount: 0.1, source: 'INCOME_VOUCHER' },
      { accountId: WHISH, amount: 0.2, source: 'INCOME_VOUCHER' },
    ]);
    expect(days.get(SAFE)).toEqual({
      receipts: 350_000,
      payments: 140_000,
      movements: 4,
      bySource: [
        { source: 'CITIZEN_PAYMENT', receipts: 350_000, payments: 100_000 },
        { source: 'EXPENSE_VOUCHER', receipts: 0, payments: 40_000 },
      ],
    });
    // Summed in cents: 0.1 + 0.2 is 0.3 here, not 0.30000000000000004.
    expect(days.get(WHISH)?.receipts).toBe(0.3);
  });
});

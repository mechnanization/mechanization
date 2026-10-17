import { incomePeriod, municipalDayStart, planIncomeDate } from './income.plan';

const TODAY = '2026-10-06';
const GO_LIVE = '2026-10-01';

describe('planIncomeDate', () => {
  it('accepts today, with no reason asked for', () => {
    expect(planIncomeDate({ today: TODAY, goLiveOn: GO_LIVE })).toEqual({
      ok: true,
      receivedOn: TODAY,
      backdatedDays: 0,
    });
  });

  it('refuses a date after today: money that has not arrived is not income', () => {
    expect(planIncomeDate({ receivedOn: '2026-10-07', today: TODAY, goLiveOn: GO_LIVE })).toEqual({
      ok: false,
      code: 'INCOME_DATE_IN_FUTURE',
    });
  });

  it('refuses a date before go-live: that money is already in the opening balance', () => {
    expect(planIncomeDate({ receivedOn: '2026-09-30', reason: 'تحويل قديم', today: TODAY, goLiveOn: GO_LIVE })).toEqual({
      ok: false,
      code: 'INCOME_DATE_BEFORE_GO_LIVE',
      goLiveOn: GO_LIVE,
    });
  });

  it('asks why a voucher is back-dated, and counts the days', () => {
    expect(planIncomeDate({ receivedOn: '2026-10-03', today: TODAY, goLiveOn: GO_LIVE })).toEqual({
      ok: false,
      code: 'INCOME_BACKDATE_REASON_REQUIRED',
      backdatedDays: 3,
    });
  });

  it('accepts a back-dated voucher that says why', () => {
    expect(
      planIncomeDate({ receivedOn: '2026-10-03', reason: 'وصل التحويل يوم الجمعة', today: TODAY, goLiveOn: GO_LIVE }),
    ).toEqual({ ok: true, receivedOn: '2026-10-03', backdatedDays: 3 });
  });

  /*
    The rule is the expense rule, delegated rather than copied. This pins that
    every one of its refusals comes back renamed — an income refusal must never
    reach the screen saying «نفقة».
  */
  it('never answers with an expense code', () => {
    const verdicts = [
      planIncomeDate({ receivedOn: '2026-12-01', today: TODAY, goLiveOn: GO_LIVE }),
      planIncomeDate({ receivedOn: '2026-01-01', reason: 'x', today: TODAY, goLiveOn: GO_LIVE }),
      planIncomeDate({ receivedOn: '2026-10-02', today: TODAY, goLiveOn: GO_LIVE }),
    ];
    for (const verdict of verdicts) {
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code.startsWith('INCOME_')).toBe(true);
    }
  });
});

describe('municipalDayStart', () => {
  it('starts a winter day two hours before UTC midnight', () => {
    expect(municipalDayStart('2026-01-15').toISOString()).toBe('2026-01-14T22:00:00.000Z');
  });

  it('starts a summer day three hours before UTC midnight', () => {
    expect(municipalDayStart('2026-07-15').toISOString()).toBe('2026-07-14T21:00:00.000Z');
  });

  /*
    The night summer time starts, Beirut's clocks jump from 00:00 to 01:00, so
    the 29th's first instant is the one that reads 01:00 — 22:00 UTC on the
    28th. One second earlier is still Saturday.
  */
  it('starts the day the clocks go forward at its first real instant', () => {
    expect(municipalDayStart('2026-03-29').toISOString()).toBe('2026-03-28T22:00:00.000Z');
  });

  /*
    The night summer time ends, the clocks fall back at midnight, and the hour
    between 21:00 and 22:00 UTC reads 23:xx on the 24th a second time. The 25th
    begins after it.
  */
  it('starts the day the clocks go back after the repeated hour', () => {
    expect(municipalDayStart('2026-10-25').toISOString()).toBe('2026-10-24T22:00:00.000Z');
  });
});

describe('incomePeriod', () => {
  it('covers both days whole, as a half-open range', () => {
    expect(incomePeriod('2026-10-01', '2026-10-31')).toEqual({
      gte: new Date('2026-09-30T21:00:00.000Z'),
      // 1 November is in winter time: the day after the last one begins at 22:00 UTC.
      lt: new Date('2026-10-31T22:00:00.000Z'),
    });
  });

  it('leaves an open side open', () => {
    expect(incomePeriod(undefined, undefined)).toEqual({});
    expect(incomePeriod('2026-10-01')).toEqual({ gte: new Date('2026-09-30T21:00:00.000Z') });
  });
});

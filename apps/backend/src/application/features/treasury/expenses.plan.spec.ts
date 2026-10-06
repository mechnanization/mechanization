import { expenseOccurredAt, planExpenseDate } from './expenses.plan';

const TODAY = '2026-10-06';
const GO_LIVE = '2026-10-01';

describe('planExpenseDate', () => {
  it('accepts today, with no reason asked for', () => {
    expect(planExpenseDate({ today: TODAY, goLiveOn: GO_LIVE })).toEqual({
      ok: true,
      paidOn: TODAY,
      backdatedDays: 0,
    });
  });

  it('defaults to today when the screen sends no date', () => {
    const verdict = planExpenseDate({ today: TODAY, goLiveOn: GO_LIVE });
    expect(verdict).toMatchObject({ ok: true, paidOn: TODAY });
  });

  it('refuses a date after today: money that has not left is not an expense', () => {
    expect(planExpenseDate({ paidOn: '2026-10-07', today: TODAY, goLiveOn: GO_LIVE })).toEqual({
      ok: false,
      code: 'EXPENSE_DATE_IN_FUTURE',
    });
  });

  it('refuses a date before go-live: that money is already out of the opening balance', () => {
    expect(planExpenseDate({ paidOn: '2026-09-30', today: TODAY, goLiveOn: GO_LIVE })).toEqual({
      ok: false,
      code: 'EXPENSE_DATE_BEFORE_GO_LIVE',
      goLiveOn: GO_LIVE,
    });
  });

  it('accepts the go-live day itself', () => {
    expect(planExpenseDate({ paidOn: GO_LIVE, today: TODAY, goLiveOn: GO_LIVE, reason: 'جرد' })).toMatchObject({
      ok: true,
      paidOn: GO_LIVE,
      backdatedDays: 5,
    });
  });

  it('asks why a voucher is back-dated', () => {
    expect(planExpenseDate({ paidOn: '2026-10-03', today: TODAY, goLiveOn: GO_LIVE })).toEqual({
      ok: false,
      code: 'EXPENSE_BACKDATE_REASON_REQUIRED',
      backdatedDays: 3,
    });
  });

  it('treats blank space as no reason at all', () => {
    expect(planExpenseDate({ paidOn: '2026-10-03', reason: '   ', today: TODAY, goLiveOn: GO_LIVE })).toMatchObject({
      ok: false,
      code: 'EXPENSE_BACKDATE_REASON_REQUIRED',
    });
  });

  it('accepts a back-dated voucher that says why, and counts the days', () => {
    expect(
      planExpenseDate({ paidOn: '2026-10-03', reason: 'دُفعت نقداً يوم السبت', today: TODAY, goLiveOn: GO_LIVE }),
    ).toEqual({ ok: true, paidOn: '2026-10-03', backdatedDays: 3 });
  });

  it('checks the future before the go-live date, so a forward date is never called early', () => {
    expect(planExpenseDate({ paidOn: '2026-12-01', today: TODAY, goLiveOn: GO_LIVE })).toMatchObject({
      code: 'EXPENSE_DATE_IN_FUTURE',
    });
  });

  it('asks nothing about go-live when the treasury is not live', () => {
    expect(planExpenseDate({ paidOn: '2020-01-01', reason: 'قديمة', today: TODAY })).toMatchObject({ ok: true });
  });
});

describe('expenseOccurredAt', () => {
  it("keeps the real clock time for today's voucher, so the day reads in order", () => {
    const now = new Date('2026-10-06T07:30:00.000Z');
    expect(expenseOccurredAt(TODAY, TODAY, now)).toEqual(now);
  });

  it('puts a back-dated voucher at midday, so no time zone moves it off its day', () => {
    expect(expenseOccurredAt('2026-10-03', TODAY).toISOString()).toBe('2026-10-03T12:00:00.000Z');
  });
});

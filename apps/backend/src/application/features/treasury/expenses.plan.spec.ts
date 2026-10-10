import { planExpenseDate, urgentCeilingBreached } from './expenses.plan';

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

describe('urgentCeilingBreached (decision D6)', () => {
  const decimal = (value: number) => ({ toNumber: () => value });

  it('refuses above the ceiling of the wallet’s currency, naming it', () => {
    expect(urgentCeilingBreached({ amount: 100_001, currency: 'LBP', ceilings: { LBP: decimal(100_000), USD: null } })).toEqual({
      ceiling: 100_000,
      currency: 'LBP',
    });
  });

  it('lets an amount equal to the ceiling through', () => {
    expect(urgentCeilingBreached({ amount: 100_000, currency: 'LBP', ceilings: { LBP: decimal(100_000), USD: null } })).toBeNull();
  });

  it('has no limit when the ceiling is not set, or the currency has none', () => {
    expect(urgentCeilingBreached({ amount: 9e9, currency: 'LBP', ceilings: { LBP: null, USD: decimal(50) } })).toBeNull();
    expect(urgentCeilingBreached({ amount: 9e9, currency: 'EUR', ceilings: { LBP: decimal(1), USD: decimal(1) } })).toBeNull();
  });
});

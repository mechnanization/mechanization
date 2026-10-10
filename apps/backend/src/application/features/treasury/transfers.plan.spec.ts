import { exchangeRateOf, judgeExchange } from '@mechanization/shared-schemas';
import { exchangeRuleChangeAllowed, planTransferDate, transferKindOf } from './transfers.plan';

/*
  المناقلات والمصارفة, the rules with no database: the day a transfer is booked
  on, which kind it is, the rate two amounts imply, and how an exchange is
  judged against the official rate. The form warns with the same two exchange
  functions the server refuses with, so these pin both.
*/

describe('planTransferDate', () => {
  const base = { goLiveOn: '2026-10-01', today: '2026-10-10' };

  it('books today when no day is given', () => {
    expect(planTransferDate(base)).toEqual({ ok: true, transferredOn: '2026-10-10', backdatedDays: 0 });
  });

  it('refuses a day after today', () => {
    expect(planTransferDate({ ...base, transferredOn: '2026-10-11' })).toEqual({
      ok: false,
      code: 'TRANSFER_DATE_IN_FUTURE',
    });
  });

  it('refuses a day before go-live, naming it', () => {
    expect(planTransferDate({ ...base, transferredOn: '2026-09-30', reason: 'x' })).toEqual({
      ok: false,
      code: 'TRANSFER_DATE_BEFORE_GO_LIVE',
      goLiveOn: '2026-10-01',
    });
  });

  it('asks why a transfer is dated earlier, and accepts it with a reason', () => {
    expect(planTransferDate({ ...base, transferredOn: '2026-10-08' })).toEqual({
      ok: false,
      code: 'TRANSFER_BACKDATE_REASON_REQUIRED',
      backdatedDays: 2,
    });
    expect(planTransferDate({ ...base, transferredOn: '2026-10-08', reason: 'سُحب من Whish يوم السبت' })).toEqual({
      ok: true,
      transferredOn: '2026-10-08',
      backdatedDays: 2,
    });
  });
});

describe('transferKindOf', () => {
  it('reads a handover from its custody source, whatever the currencies', () => {
    expect(transferKindOf({ type: 'COLLECTOR_CUSTODY', currency: 'LBP' }, { currency: 'LBP' })).toBe('HANDOVER');
  });

  it('tells an internal transfer from an exchange by the currencies', () => {
    expect(transferKindOf({ type: 'WHISH_ACCOUNT', currency: 'USD' }, { currency: 'USD' })).toBe('SAME_CURRENCY');
    expect(transferKindOf({ type: 'CASH_SAFE', currency: 'USD' }, { currency: 'LBP' })).toBe('EXCHANGE');
  });
});

describe('exchangeRateOf', () => {
  it('reads pounds per dollar whichever way the money went', () => {
    expect(
      exchangeRateOf({ fromCurrency: 'USD', toCurrency: 'LBP', amount: 100, receivedAmount: 8_950_000, baseCurrency: 'LBP' }),
    ).toEqual({ rate: 89_500, foreignAmount: 100 });
    expect(
      exchangeRateOf({ fromCurrency: 'LBP', toCurrency: 'USD', amount: 9_000_000, receivedAmount: 100, baseCurrency: 'LBP' }),
    ).toEqual({ rate: 90_000, foreignAmount: 100 });
  });

  it('keeps six decimals and no more', () => {
    const legs = exchangeRateOf({ fromCurrency: 'USD', toCurrency: 'LBP', amount: 3, receivedAmount: 268_501, baseCurrency: 'LBP' });
    expect(legs?.rate).toBe(89_500.333333);
  });

  it('has no rate for a pair with no base currency in it, or for one currency', () => {
    expect(
      exchangeRateOf({ fromCurrency: 'USD', toCurrency: 'EUR', amount: 100, receivedAmount: 92, baseCurrency: 'LBP' }),
    ).toBeNull();
    expect(
      exchangeRateOf({ fromCurrency: 'USD', toCurrency: 'USD', amount: 100, receivedAmount: 100, baseCurrency: 'LBP' }),
    ).toBeNull();
  });
});

describe('judgeExchange', () => {
  const rule = { officialRate: 89_500, tolerancePercent: 3, largeThreshold: 1_000 };

  it('passes a fair, ordinary exchange without a flag', () => {
    expect(judgeExchange({ ...rule, rate: 89_000, foreignAmount: 100 })).toEqual({
      deviationPercent: 0.56,
      beyondTolerance: false,
      large: false,
      noOfficialRate: false,
      requiresReview: false,
    });
  });

  it('keeps a rate exactly on the tolerance inside it', () => {
    // 3% of 89,500 is 2,685.
    expect(judgeExchange({ ...rule, rate: 92_185, foreignAmount: 100 }).beyondTolerance).toBe(false);
    expect(judgeExchange({ ...rule, rate: 86_815, foreignAmount: 100 }).beyondTolerance).toBe(false);
  });

  it('flags a rate beyond the tolerance either side, and asks for a reason', () => {
    const high = judgeExchange({ ...rule, rate: 92_200, foreignAmount: 100 });
    expect(high.beyondTolerance).toBe(true);
    expect(high.requiresReview).toBe(true);
    expect(judgeExchange({ ...rule, rate: 80_000, foreignAmount: 100 }).beyondTolerance).toBe(true);
  });

  it('flags a large exchange whatever its rate, but not one exactly on the threshold', () => {
    expect(judgeExchange({ ...rule, rate: 89_500, foreignAmount: 1_000.01 })).toMatchObject({
      large: true,
      beyondTolerance: false,
      requiresReview: true,
    });
    expect(judgeExchange({ ...rule, rate: 89_500, foreignAmount: 1_000 }).requiresReview).toBe(false);
  });

  it('flags an exchange with no official rate to compare, without asking a reason', () => {
    expect(judgeExchange({ ...rule, officialRate: null, rate: 89_500, foreignAmount: 10 })).toEqual({
      deviationPercent: null,
      beyondTolerance: false,
      large: false,
      noOfficialRate: true,
      requiresReview: true,
    });
  });

  it('reads a zero tolerance as «any difference needs a reason»', () => {
    expect(judgeExchange({ ...rule, tolerancePercent: 0, rate: 89_501, foreignAmount: 10 }).beyondTolerance).toBe(true);
    expect(judgeExchange({ ...rule, tolerancePercent: 0, rate: 89_500, foreignAmount: 10 }).beyondTolerance).toBe(false);
  });
});

describe('exchangeRuleChangeAllowed', () => {
  const current = { tolerancePercent: 3, largeThreshold: 1000 };

  it('lets the manager move the rule', () => {
    expect(exchangeRuleChangeAllowed({ role: 'SUPER_ADMIN', current, requested: { tolerancePercent: 10 } })).toBe(true);
  });

  it('refuses the accountant moving either half of it', () => {
    expect(exchangeRuleChangeAllowed({ role: 'ACCOUNTANT', current, requested: { tolerancePercent: 10 } })).toBe(false);
    expect(exchangeRuleChangeAllowed({ role: 'ACCOUNTANT', current, requested: { largeThreshold: 5000 } })).toBe(false);
  });

  it('lets the accountant save the section with the rule sent back unchanged, or not sent at all', () => {
    expect(
      exchangeRuleChangeAllowed({ role: 'ACCOUNTANT', current, requested: { tolerancePercent: 3, largeThreshold: 1000 } }),
    ).toBe(true);
    expect(exchangeRuleChangeAllowed({ role: 'ACCOUNTANT', current, requested: {} })).toBe(true);
  });
});

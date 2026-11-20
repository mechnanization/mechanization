import { counterCredit } from './payment-ledger.service';

/**
 * What a counter payment credits and hands back — the one rule the ledger
 * records and `settleInPerson` judges large change on (findings F18, F19).
 */
describe('counterCredit', () => {
  it('credits a sum within the balance as it is, with no change', () => {
    expect(counterCredit({ amount: 200_000, tendered: null, outstanding: 500_000, currency: 'LBP' })).toEqual({
      credit: 200_000,
      changeGiven: 0,
    });
  });

  it('credits the balance and hands back the rest of a foreign note, in whole ليرة', () => {
    expect(
      counterCredit({ amount: 1_790_000, tendered: { local: 0, foreign: 20 }, outstanding: 500_000, currency: 'LBP' }),
    ).toEqual({ credit: 500_000, changeGiven: 1_290_000 });
  });

  it('takes half a pound over the balance as the balance, with no change', () => {
    expect(counterCredit({ amount: 500_000.4, tendered: null, outstanding: 500_000, currency: 'LBP' })).toEqual({
      credit: 500_000.4,
      changeGiven: 0,
    });
  });

  it('refuses ليرة beyond the balance: change comes from foreign notes only', () => {
    expect(() =>
      counterCredit({ amount: 600_000, tendered: { local: 600_000, foreign: 0 }, outstanding: 500_000, currency: 'LBP' }),
    ).toThrow(expect.objectContaining({ code: 'PAYMENT_TENDER_EXCEEDS_BALANCE' }));
  });

  it('refuses a sum above the balance with no notes to split', () => {
    expect(() => counterCredit({ amount: 600_000, tendered: null, outstanding: 500_000, currency: 'LBP' })).toThrow(
      expect.objectContaining({ code: 'PAYMENT_EXCEEDS_BALANCE' }),
    );
  });

  it('refuses anything on a bill that owes nothing, which is what a retry of a settled bill meets', () => {
    expect(() =>
      counterCredit({ amount: 1_790_000, tendered: { local: 0, foreign: 20 }, outstanding: 0, currency: 'LBP' }),
    ).not.toThrow();
    expect(() => counterCredit({ amount: 1, tendered: null, outstanding: 0, currency: 'LBP' })).toThrow(
      expect.objectContaining({ code: 'PAYMENT_EXCEEDS_BALANCE' }),
    );
  });
});

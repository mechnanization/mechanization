import { describe, expect, it } from 'vitest';
import type { TreasuryRate } from '@mechanization/shared-schemas';
import { convertAmount, totalInCurrency, usableRate } from './treasury-convert';

const RATE: TreasuryRate = {
  baseCurrency: 'LBP',
  secondaryCurrency: 'USD',
  exchangeRate: 89_500,
  exchangeRateUpdatedAt: '2026-10-01T08:00:00.000Z',
};
const NO_RATE: TreasuryRate = { ...RATE, exchangeRate: null, exchangeRateUpdatedAt: null };

const BALANCES = [
  { currency: 'LBP', amount: 179_000_000 },
  { currency: 'USD', amount: 1_000.5 },
];

describe('usableRate', () => {
  it('is null without a rate, with a zero or negative rate, or with no secondary currency', () => {
    expect(usableRate(NO_RATE)).toBeNull();
    expect(usableRate({ ...RATE, exchangeRate: 0 })).toBeNull();
    expect(usableRate({ ...RATE, exchangeRate: -1 })).toBeNull();
    expect(usableRate({ ...RATE, secondaryCurrency: null })).toBeNull();
  });

  it('names the pair when the rate is set', () => {
    expect(usableRate(RATE)).toEqual({ base: 'LBP', secondary: 'USD', exchangeRate: 89_500 });
  });
});

describe('convertAmount', () => {
  it('multiplies secondary into base and divides base into secondary', () => {
    expect(convertAmount(2, 'USD', 'LBP', RATE)).toBe(179_000);
    expect(convertAmount(179_000, 'LBP', 'USD', RATE)).toBe(2);
  });

  it('leaves an amount in its own currency alone, even with no rate', () => {
    expect(convertAmount(5, 'USD', 'USD', NO_RATE)).toBe(5);
  });

  it('refuses a currency the rate does not cover', () => {
    expect(convertAmount(5, 'EUR', 'LBP', RATE)).toBeNull();
  });
});

describe('totalInCurrency', () => {
  it('adds everything up in pounds, rounded to the whole pound', () => {
    expect(totalInCurrency(BALANCES, 'LBP', RATE)).toEqual({
      total: 179_000_000 + 89_544_750,
      currency: 'LBP',
      skipped: [],
    });
  });

  it('adds everything up in dollars, rounded to the cent', () => {
    // 179,000,000 / 89,500 = 2,000 exactly.
    expect(totalInCurrency(BALANCES, 'USD', RATE)).toEqual({ total: 3_000.5, currency: 'USD', skipped: [] });
  });

  it('returns null rather than a partial sum when a rate is needed and none is set', () => {
    expect(totalInCurrency(BALANCES, 'USD', NO_RATE)).toBeNull();
  });

  it('still totals a single currency with no rate', () => {
    expect(totalInCurrency([{ currency: 'LBP', amount: 10 }], 'LBP', NO_RATE)?.total).toBe(10);
  });

  it('reports a currency it could not convert instead of dropping it silently', () => {
    const result = totalInCurrency([...BALANCES, { currency: 'EUR', amount: 7 }], 'LBP', RATE);
    expect(result?.skipped).toEqual(['EUR']);
    expect(result?.total).toBe(179_000_000 + 89_544_750);
  });

  it('does not mutate its input', () => {
    const copy = BALANCES.map((entry) => ({ ...entry }));
    totalInCurrency(BALANCES, 'LBP', RATE);
    expect(BALANCES).toEqual(copy);
  });
});

import { describe, expect, it } from 'vitest';
import {
  MINUS_SIGN,
  formatForeign,
  formatLbp,
  formatLbpCompact,
  formatMoney,
  formatTypedAmount,
  lbpCompactParts,
  moneyParts,
  parseAmount,
} from './currency';

describe('formatLbp', () => {
  it('groups to the last pound, with the unit in the page’s language', () => {
    expect(formatLbp(1_250_000)).toBe('1,250,000 ل.ل');
    expect(formatLbp(1_250_000, 'en')).toBe('1,250,000 LBP');
    expect(formatLbp(1_249_999.6)).toBe('1,250,000 ل.ل');
  });
});

describe('formatLbpCompact', () => {
  it('is exact below a million and scaled above it', () => {
    expect(formatLbpCompact(950_000)).toBe('950,000 ل.ل');
    expect(formatLbpCompact(12_500_000)).toBe('12.5 مليون ل.ل');
    expect(formatLbpCompact(12_500_000, 'en')).toBe('12.5M LBP');
    expect(formatLbpCompact(1_250_000_000)).toBe('1.25 مليار ل.ل');
  });
});

describe('formatForeign and formatMoney', () => {
  it('writes cents only when there are cents, with the symbol after the figure', () => {
    expect(formatForeign(75)).toBe('75 $');
    expect(formatForeign(75.5)).toBe('75.5 $');
    expect(formatForeign(1_234_567.891, 'EUR')).toBe('1,234,567.89 €');
  });

  it('sends ليرة to formatLbp and anything else to formatForeign', () => {
    expect(formatMoney(1_000, 'LBP', 'en')).toBe('1,000 LBP');
    expect(formatMoney(1_000, 'USD', 'en')).toBe('1,000 $');
  });
});

describe('moneyParts', () => {
  it('keeps the figure and the unit apart, with the figures formatLbp and formatForeign write', () => {
    expect(moneyParts(1_500_000, 'LBP')).toEqual({ figure: '1,500,000', unit: 'ل.ل' });
    expect(moneyParts(1_500_000, 'LBP', 'en')).toEqual({ figure: '1,500,000', unit: 'LBP' });
    expect(moneyParts(1_250.5, 'USD')).toEqual({ figure: '1,250.5', unit: '$' });
    expect(moneyParts(10, 'EUR')).toEqual({ figure: '10', unit: '€' });
    expect(moneyParts(10, 'GBP')).toEqual({ figure: '10', unit: 'GBP' });
  });

  it('puts one minus sign, U+2212, on the figure of a negative amount', () => {
    expect(MINUS_SIGN).toBe('−');
    expect(moneyParts(-50_000, 'LBP')).toEqual({ figure: '−50,000', unit: 'ل.ل' });
    expect(moneyParts(-75.5, 'USD')).toEqual({ figure: '−75.5', unit: '$' });
    // Never the hyphen toLocaleString writes.
    expect(moneyParts(-50_000, 'LBP').figure).not.toContain('-');
  });

  it('adds «+» to a positive figure only when asked, for a ledger’s movement', () => {
    expect(moneyParts(2_000_000, 'LBP', 'ar', true).figure).toBe('+2,000,000');
    expect(moneyParts(2_000_000, 'LBP', 'ar', false).figure).toBe('2,000,000');
    expect(moneyParts(-2_000_000, 'LBP', 'ar', true).figure).toBe('−2,000,000');
  });

  it('gives a figure that rounds to zero no sign', () => {
    expect(moneyParts(0, 'LBP', 'ar', true).figure).toBe('0');
    expect(moneyParts(-0.4, 'LBP').figure).toBe('0');
    expect(moneyParts(-0.001, 'USD').figure).toBe('0');
  });
});

describe('lbpCompactParts', () => {
  it('splits the compact form where the joined string has its space', () => {
    expect(lbpCompactParts(12_500_000)).toEqual({ figure: '12.5', unit: 'مليون ل.ل' });
    expect(lbpCompactParts(12_500_000, 'en')).toEqual({ figure: '12.5M', unit: 'LBP' });
    expect(lbpCompactParts(1_250_000_000)).toEqual({ figure: '1.25', unit: 'مليار ل.ل' });
    expect(lbpCompactParts(1_250_000_000, 'en')).toEqual({ figure: '1.25B', unit: 'LBP' });
  });

  it('is the exact figure below a million', () => {
    expect(lbpCompactParts(950_000)).toEqual({ figure: '950,000', unit: 'ل.ل' });
  });

  it('keeps the minus on the figure', () => {
    expect(lbpCompactParts(-12_500_000)).toEqual({ figure: '−12.5', unit: 'مليون ل.ل' });
  });

  it('joins back into formatLbpCompact for a positive amount', () => {
    for (const amount of [950_000, 12_500_000, 999_000_000, 1_250_000_000]) {
      for (const locale of ['ar', 'en']) {
        const { figure, unit } = lbpCompactParts(amount, locale);
        expect(`${figure} ${unit}`).toBe(formatLbpCompact(amount, locale));
      }
    }
  });
});

describe('parseAmount and formatTypedAmount', () => {
  it('reads what a clerk types, Arabic digits and separators included', () => {
    expect(parseAmount('1,250,000')).toBe(1_250_000);
    expect(parseAmount('١٢٣٤')).toBe(1234);
    expect(parseAmount('75٫5')).toBe(75.5);
    expect(parseAmount('')).toBe(0);
    expect(parseAmount('-5')).toBe(0);
  });

  it('groups as the clerk types, and keeps two decimals at most for dollars', () => {
    expect(formatTypedAmount('1250000', 0)).toBe('1,250,000');
    expect(formatTypedAmount('1250000.75', 0)).toBe('1,250,000');
    expect(formatTypedAmount('75.555', 2)).toBe('75.55');
    expect(formatTypedAmount('007', 0)).toBe('7');
  });
});

import { describe, expect, it } from 'vitest';
import { currencyUnit, formatMoney, parseAmount } from './currency';

describe('currencyUnit', () => {
  it('names the pound in the page’s language', () => {
    expect(currencyUnit('LBP', 'ar')).toBe('ل.ل');
    expect(currencyUnit('LBP', 'en')).toBe('LBP');
  });

  it('writes the dollar as its sign, and anything else as its code', () => {
    expect(currencyUnit('USD', 'ar')).toBe('$');
    expect(currencyUnit('EUR', 'en')).toBe('EUR');
  });
});

describe('formatMoney', () => {
  it('writes pounds whole, grouped, with Latin digits', () => {
    expect(formatMoney(1_250_000, 'LBP', 'ar')).toBe('1,250,000 ل.ل');
  });

  it('writes dollars with cents only when there are cents', () => {
    expect(formatMoney(20, 'USD')).toBe('20 $');
    expect(formatMoney(20.5, 'USD')).toBe('20.5 $');
  });
});

describe('parseAmount', () => {
  it('reads separators and Arabic-Indic digits, and anything unreadable as 0', () => {
    expect(parseAmount('1,250,000')).toBe(1_250_000);
    expect(parseAmount('١٢٥٠')).toBe(1250);
    expect(parseAmount('abc')).toBe(0);
  });
});

import type { TreasuryRate } from '@mechanization/shared-schemas';

/**
 * Showing the treasury's balances in one currency.
 *
 * The wallets each hold one currency and stay that way: this only adds up a
 * second view, at the municipality's own rate (`TreasuryRate`), and never
 * replaces a wallet's real figure. `exchangeRate` is units of the base
 * currency per one unit of the secondary one, so dollars to pounds multiplies
 * and pounds to dollars divides.
 */

export interface CurrencyAmount {
  currency: string;
  amount: number;
}

/** The two currencies the rate can convert between, or null when no usable rate is set. */
export function usableRate(
  rate: TreasuryRate,
): { base: string; secondary: string; exchangeRate: number } | null {
  const { baseCurrency, secondaryCurrency, exchangeRate } = rate;
  if (!secondaryCurrency || secondaryCurrency === baseCurrency) return null;
  if (exchangeRate === null || !Number.isFinite(exchangeRate) || exchangeRate <= 0) return null;
  return { base: baseCurrency, secondary: secondaryCurrency, exchangeRate };
}

/** Whole pounds for the base currency, cents for any other. */
function roundTo(value: number, currency: string, base: string): number {
  const factor = currency === base ? 1 : 100;
  return Math.round(value * factor) / factor;
}

/**
 * One amount in the target currency, or null when the rate cannot take it
 * there (no rate set, or a currency the rate does not cover).
 */
export function convertAmount(
  amount: number,
  from: string,
  target: string,
  rate: TreasuryRate,
): number | null {
  if (from === target) return amount;
  const pair = usableRate(rate);
  if (!pair) return null;
  if (from === pair.secondary && target === pair.base) return amount * pair.exchangeRate;
  if (from === pair.base && target === pair.secondary) return amount / pair.exchangeRate;
  return null;
}

export interface ConvertedTotal {
  /** The sum in `currency`, rounded to the currency's own unit. */
  total: number;
  currency: string;
  /** Currencies that could not be converted and are therefore NOT in `total`. */
  skipped: string[];
}

/**
 * Every balance added up in `target`.
 *
 * Returns null, not a partial sum, when something needs converting and no rate
 * is set: a total that quietly leaves a wallet out is worse than no total. A
 * currency the rate does not cover is listed in `skipped` so the screen can
 * say the figure is incomplete.
 */
export function totalInCurrency(
  balances: readonly CurrencyAmount[],
  target: string,
  rate: TreasuryRate,
): ConvertedTotal | null {
  const needsRate = balances.some((entry) => entry.currency !== target);
  if (needsRate && !usableRate(rate)) return null;

  let total = 0;
  const skipped = new Set<string>();
  for (const entry of balances) {
    const converted = convertAmount(entry.amount, entry.currency, target, rate);
    if (converted === null) skipped.add(entry.currency);
    else total += converted;
  }
  return { total: roundTo(total, target, rate.baseCurrency), currency: target, skipped: [...skipped] };
}

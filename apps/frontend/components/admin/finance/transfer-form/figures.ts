/** How the transfer form writes and rounds a figure. */

/** A percentage in Latin digits, two places at most (TYP-4): a message argument, not a figure in a column. */
export const percent = (value: number): string => value.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** ليرة has no fractions to move; a dollar keeps its cents. */
export const decimalsOf = (currency: string | undefined): 0 | 2 => (currency === 'LBP' ? 0 : 2);

/** A typed figure rounded the way its currency is kept. */
export const roundTo = (value: number, currency: string): number => {
  const factor = 10 ** decimalsOf(currency);
  return Math.round(value * factor) / factor;
};

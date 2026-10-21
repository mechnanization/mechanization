/**
 * المصارفة — how an exchange between two wallets is judged (docs/finance.md §6.3).
 *
 * One module, read by the transfer form as the figures are typed and by
 * `TransfersService` when the exchange is booked, so the warning on screen and
 * the refusal from the server are the same arithmetic. A rule written twice is
 * a rule that will one day disagree with itself.
 *
 * == The rate is derived, never typed as a third figure =================
 *
 * What physically happened is that one amount left a wallet and another
 * arrived in a different one. The rate is what those two imply, so it is
 * computed from them and stored beside them; a form that took the rate as well
 * could be sent three figures that do not agree. The convention is the payment
 * ledger's and `system_settings.exchangeRate`'s: units of the base currency per
 * one unit of the other — «89,500 ليرة للدولار» whichever way the money went.
 *
 * == What is checked ======================================================
 *
 *  - the rate against the municipality's official one: beyond the tolerance it
 *    needs a written reason, and is reviewed afterwards;
 *  - the size: above the threshold on the non-base side (the dollars, in
 *    practice), it is reviewed whatever its rate;
 *  - no official rate to compare with: reviewed, since nothing says it is fair.
 *
 * None of these blocks the exchange except the missing reason. The money moves
 * and the flag waits for an auditor, so counter work is never frozen (§6.3).
 */

/**
 * The rule when the manager has set none: migration 0084's column defaults,
 * named here for the one reader that can meet a municipality with no settings
 * row yet. Change them together with the migration's, never alone.
 */
export const DEFAULT_EXCHANGE_TOLERANCE_PERCENT = 3;
export const DEFAULT_LARGE_EXCHANGE_THRESHOLD = 1000;

/** Six decimals, the column's own precision and `system_settings.exchangeRate`'s. */
const RATE_DECIMALS = 6;

function roundRate(value: number): number {
  const factor = 10 ** RATE_DECIMALS;
  return Math.round(value * factor) / factor;
}

export interface ExchangeLegs {
  fromCurrency: string;
  toCurrency: string;
  /** What left the source, in its currency. */
  amount: number;
  /** What reached the destination, in its currency. */
  receivedAmount: number;
  /** The municipality's base currency (`system_settings.baseCurrency`). */
  baseCurrency: string;
}

/**
 * Base currency per one unit of the other side, and the amount on that other
 * side; null when neither side is the base currency, a pair this convention
 * cannot express.
 */
export function exchangeRateOf(legs: ExchangeLegs): { rate: number; foreignAmount: number } | null {
  if (legs.amount <= 0 || legs.receivedAmount <= 0) return null;
  if (legs.fromCurrency === legs.toCurrency) return null;
  if (legs.toCurrency === legs.baseCurrency) {
    return { rate: roundRate(legs.receivedAmount / legs.amount), foreignAmount: legs.amount };
  }
  if (legs.fromCurrency === legs.baseCurrency) {
    return { rate: roundRate(legs.amount / legs.receivedAmount), foreignAmount: legs.receivedAmount };
  }
  return null;
}

export interface ExchangeJudgement {
  /** How far the rate strays from the official one, in percent; null with no official rate. */
  deviationPercent: number | null;
  /** Beyond the tolerance: a written reason is required, and the exchange is reviewed. */
  beyondTolerance: boolean;
  /** Above the threshold on the non-base side. */
  large: boolean;
  /** No official rate was set to compare with. */
  noOfficialRate: boolean;
  /** Flagged for the auditor when booked. */
  requiresReview: boolean;
}

/**
 * Judges one exchange. `tolerancePercent` and `largeThreshold` are the
 * manager's settings; `officialRate` is `system_settings.exchangeRate`.
 */
export function judgeExchange(input: {
  rate: number;
  foreignAmount: number;
  officialRate: number | null;
  tolerancePercent: number;
  largeThreshold: number;
}): ExchangeJudgement {
  const noOfficialRate = input.officialRate === null || input.officialRate <= 0;
  const deviationPercent = noOfficialRate
    ? null
    : (Math.abs(input.rate - input.officialRate!) / input.officialRate!) * 100;
  /*
    Compared without dividing — |rate − official| × 100 against tolerance ×
    official — so a rate exactly on the tolerance (3% of 89,500 is 2,685) is
    inside it, and the only slack is a float's noise, a billionth of the rate.
    Rounding the percentage instead would let a zero tolerance pass a rate a
    pound away: that is 0.001%, which rounds to nothing.
  */
  const beyondTolerance =
    !noOfficialRate &&
    Math.abs(input.rate - input.officialRate!) * 100 - input.tolerancePercent * input.officialRate! >
      input.officialRate! * 1e-9;
  const large = Math.round(input.foreignAmount * 100) > Math.round(input.largeThreshold * 100);

  return {
    deviationPercent: deviationPercent === null ? null : Math.round(deviationPercent * 100) / 100,
    beyondTolerance,
    large,
    noOfficialRate,
    requiresReview: beyondTolerance || large || noOfficialRate,
  };
}

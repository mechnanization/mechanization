/**
 * The rules a cash counter works under, in one place for the server that
 * enforces them and the page that explains them.
 *
 * Each rule answers a question a municipal audit asks of a cash payment:
 * at what rate were the dollars taken, and who decided it; on what day was
 * the money received, and why was it entered later.
 */

/** The municipality's own clock. The server runs in UTC; its «today» is not. */
export const MUNICIPAL_TIME_ZONE = 'Asia/Beirut';

/**
 * Today's date on the municipality's calendar, as `YYYY-MM-DD`.
 *
 * Evaluated per call, never at module load: a value frozen when the process
 * started would refuse today's payments once it has run past midnight.
 */
export function municipalToday(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MUNICIPAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * How far back any clerk who takes payments may date one. A payment written
 * up the next morning, or at the end of a week's collection round, fits; a
 * payment from last quarter is a correction, and goes to a finance role.
 */
export const BACKDATE_WINDOW_DAYS = 30;

/**
 * Who may record a payment at a rate other than the municipality's own, or
 * date one further back than `BACKDATE_WINDOW_DAYS`. A collector takes the
 * official rate; a deviation is a finance decision.
 */
export const FINANCE_OVERRIDE_ROLES = ['SUPER_ADMIN', 'ACCOUNTANT'] as const;

export function canOverrideCashRules(role: string | null | undefined): boolean {
  return (FINANCE_OVERRIDE_ROLES as readonly string[]).includes(role ?? '');
}

/** A reason short enough to type at a counter, long enough to mean something. */
export const ADJUSTMENT_REASON_MIN = 5;

/** Rates are kept to four decimal places; the credit is computed from the stored rate. */
export function roundRate(rate: number): number {
  return Math.round(rate * 10_000) / 10_000;
}

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

/**
 * The instant a municipal day (`YYYY-MM-DD`) begins on the municipality's clock.
 *
 * Beirut is UTC+2 in winter and UTC+3 in summer, so the offset is read for the
 * day itself rather than assumed: start from UTC midnight of that date, ask what
 * the municipal clock reads then, and step back by the difference — twice,
 * which also settles a day whose offset changes during it. A range sent as
 * days (`to=2026-10-08`) is read through this, so the 8th is the 8th in Beirut.
 */
export function municipalDayStart(day: string): Date {
  const target = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  let instant = target;
  for (let pass = 0; pass < 2; pass++) {
    instant = target - (municipalWallClock(instant) - instant);
  }
  return new Date(instant);
}

/** What the municipal clock reads at `instant`, written as if that wall time were UTC. */
function municipalWallClock(instant: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MUNICIPAL_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
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

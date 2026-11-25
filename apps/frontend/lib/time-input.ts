/**
 * The rules of the kit's time field (`components/ui/time-picker.tsx`, decision U-8).
 *
 * A time travels as `"HH:MM"` on the 24-hour clock, exactly as the native
 * `<input type="time">` it replaces gave it, so `scheduleInstant`
 * (`lib/news-article-form.ts`) and every other reader is unchanged. What the
 * field adds is what the native one could not promise: the same look in every
 * browser and on every operating system (it drew a 12-hour clock with «ص»/«م»
 * on some, and the digits of the system's language on others), Latin digits as
 * everywhere else in the portal (TYP-4), and a keyboard that steps. Pure, so
 * `time-input.test.ts` can pin it without a DOM.
 */

const MINUTES_A_DAY = 24 * 60;

/** Arabic-Indic (٠–٩) and Eastern Arabic-Indic (۰–۹) digits, which an Arabic keyboard types, as Latin ones. */
export function latinDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

const COMPLETE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `"HH:MM"` exactly, or null: nothing is guessed from a partial or out-of-range text. */
export function completeTime(text: string): string | null {
  return COMPLETE.test(text) ? text : null;
}

/**
 * What the box shows while a time is being typed: Latin digits and one colon, five
 * characters at most. Typing digits alone, the colon goes in after the hour, and the
 * hour is one digit when it cannot be two: «930» is 09:30 (a first digit of 3 to 9, or
 * a 2 followed by 4 to 9, is a one-digit hour), «1930» is 19:30. The box only shapes what
 * is typed; whether it is a time is judged when it is complete or the field is left.
 */
export function typedTime(raw: string): string {
  const kept = latinDigits(raw).replace(/[^\d:]/g, '');
  const colon = kept.indexOf(':');
  if (colon === -1) {
    const hourLength = kept[0]! >= '3' || (kept[0] === '2' && kept[1]! > '3') ? 1 : 2;
    if (kept.length <= hourLength) return kept;
    return `${kept.slice(0, hourLength).padStart(2, '0')}:${kept.slice(hourLength, hourLength + 2)}`;
  }
  // A colon typed or already there: keep the first, and what fits either side of it.
  const hours = kept.slice(0, colon).replace(/:/g, '').slice(0, 2);
  const minutes = kept.slice(colon + 1).replace(/:/g, '').slice(0, 2);
  return `${hours}:${minutes}`;
}

/**
 * The time a text means once the field is left: `H`, `HH`, `HMM`, `HHMM`, `H:MM`
 * and `HH:MM` are all understood, «9» as 09:00 and «930» as 09:30. Null when it is
 * not a time (an hour past 23, a minute past 59, a lone minute digit).
 */
export function normalizeTime(text: string): string | null {
  const clean = latinDigits(text).trim();
  if (clean === '') return null;
  let hours: string;
  let minutes: string;
  const colon = clean.indexOf(':');
  if (colon !== -1) {
    hours = clean.slice(0, colon);
    minutes = clean.slice(colon + 1);
    // «9:5» could be 09:05 or 09:50: not guessed.
    if (minutes.length !== 2) return null;
  } else if (/^\d{1,2}$/.test(clean)) {
    hours = clean;
    minutes = '00';
  } else if (/^\d{3,4}$/.test(clean)) {
    hours = clean.slice(0, clean.length - 2);
    minutes = clean.slice(-2);
  } else {
    return null;
  }
  if (!/^\d{1,2}$/.test(hours) || !/^\d{2}$/.test(minutes)) return null;
  return completeTime(`${hours.padStart(2, '0')}:${minutes}`);
}

/** Minutes since midnight of a complete time. */
function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  return hours * 60 + minutes;
}

function timeOf(totalMinutes: number): string {
  const wrapped = ((totalMinutes % MINUTES_A_DAY) + MINUTES_A_DAY) % MINUTES_A_DAY;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/**
 * The next time on the grid of `step` minutes, up or down, wrapping past midnight.
 *
 * From a time on the grid it moves one step; from one off it (14:32 by 5) it goes to
 * the grid line in that direction, 14:35 up and 14:30 down, so repeated presses land on
 * round times. A whole hour (`step` 60) is what Shift gives. With nothing in the field
 * the first press gives `start`, so the field opens on a sensible time and not on 00:00.
 */
export function stepTime(current: string | null, direction: 1 | -1, step: number, start: string): string {
  if (current === null) return start;
  const total = minutesOf(current);
  const onGrid = total % step === 0;
  const next = direction === 1 ? (Math.floor(total / step) + 1) * step : (onGrid ? total - step : Math.floor(total / step) * step);
  return timeOf(next);
}

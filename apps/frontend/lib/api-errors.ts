import { createTranslator } from 'next-intl';
import { isSpecificErrorCode, type ErrorParams } from '@mechanization/shared-schemas';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { formatDay } from './dates';

/**
 * The words for an API refusal, in the language of the page.
 *
 * The API refuses with a code from `ERROR_CODES` and the values the message
 * needs (`params`); the text lives here, in `messages/{ar,en}.json` under
 * `errors`. The server's own `message` is English, meant for logs, and is
 * shown only when there is nothing better: an error from a throw site that has
 * no code yet (whose message is still the Arabic prose the server wrote), a
 * code this build does not know (an API deployed ahead of the portal), or
 * params that do not fit the message.
 *
 * This is a plain module, not a hook, because `ApiRequestError` builds its
 * message where no React context exists. That is why every screen that shows
 * `error.message` gets the translated text without changing.
 */

export type Locale = 'ar' | 'en';

/**
 * `ar-u-nu-latn`: Arabic plural rules with Latin digits, which is how every
 * figure on the portal is written (`formatLbp` groups with `en-US`). Plain
 * `ar` would print a payment's amount in Arabic-Indic digits in an error and in
 * Latin digits everywhere else on the same screen. Every plain-module
 * translator uses it (`fee-assessment.ts` too).
 */
export const FORMAT_LOCALE: Record<Locale, string> = { ar: 'ar-u-nu-latn', en: 'en' };

/** Returned by the translator when a message cannot be produced; never a real message. */
const NO_MESSAGE = '\u0000';

const translators = {
  ar: makeTranslator('ar', ar.errors),
  en: makeTranslator('en', en.errors),
};

function makeTranslator(locale: Locale, errors: Record<string, string>) {
  return createTranslator({
    locale: FORMAT_LOCALE[locale],
    messages: { errors },
    namespace: 'errors',
    // A missing message or a param that does not fit is not worth a console
    // error on a citizen's phone: the caller falls back to the server's text.
    onError: () => undefined,
    getMessageFallback: () => NO_MESSAGE,
  });
}

/** The page's language: the `lang` the tenant layout puts on `<html>`, Arabic by default. */
export function currentLocale(): Locale {
  if (typeof document !== 'undefined') {
    const lang = document.documentElement.lang;
    if (lang === 'en' || lang === 'ar') return lang;
  }
  return 'ar';
}

/** What `localizeApiError` reads from an error response. */
export interface ApiErrorText {
  code?: string;
  message?: string;
  params?: ErrorParams;
}

/** A calendar day as the server sends one: `2026-10-09`. */
const WIRE_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The params as the page writes its values. A day the server names — the
 * closed day in `CLOSED_DAY_MUTATION_BLOCKED`, `DAY_ALREADY_CLOSED`,
 * `DAY_NOT_OVER`, a go-live day, the short day of
 * `TREASURY_INSUFFICIENT_FUNDS_ON_DAY` — travels as `YYYY-MM-DD`, and is shown
 * as `09/10/2026` through `formatDay` (PRIM-12), like every day on the page
 * around it. Passed through untouched, it read «يومية 2026-10-09 مقفلة» under a
 * sheet that said «يمكن إقفال يومية 09/10/2026» (review of 2026-10-11).
 */
function displayParams(params: ErrorParams | undefined): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    values[key] = typeof value === 'string' && WIRE_DAY.test(value) ? formatDay(value) : value;
  }
  return values;
}

/** The text to show for an API error: the translated code when there is one, else the server's message. */
export function localizeApiError(payload: ApiErrorText, locale: Locale = currentLocale()): string {
  const { code } = payload;
  if (isSpecificErrorCode(code)) {
    const translate = translators[locale] as unknown as {
      has(key: string): boolean;
      (key: string, values?: Record<string, string | number>): string;
    };
    if (translate.has(code)) {
      const text = translate(code, displayParams(payload.params));
      if (text && text !== NO_MESSAGE && !text.includes(NO_MESSAGE)) return text;
    }
  }
  return payload.message ?? '';
}

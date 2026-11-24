export const locales = ['en', 'ar'] as const;
export type Locale = (typeof locales)[number];
/**
 * The one default: Arabic, what a visitor with no cookie and no `Accept-Language` is sent to (DRY-15).
 * `middleware.ts` redirects with it and `i18n/request.ts` falls back to it, so an unrecognised locale
 * segment reads as Arabic rather than as English under a different default.
 */
export const defaultLocale: Locale = 'ar';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && locales.includes(value as Locale);
}

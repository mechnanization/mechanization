/**
 * Lebanese pound formatting.
 *
 * LBP has no minor unit in practice and a very large nominal scale: a routine
 * household fee runs to seven figures, and a municipality-wide outstanding
 * total to nine or ten. Written out in full that is `1,250,000,000 ل.ل` — 17
 * characters — which is why the compact form below exists and why nothing that
 * renders money is given a fixed width.
 *
 * Digits stay Latin (`en-US` grouping) to match the rest of the portal: a
 * reference number, a phone number and an amount are all read character by
 * character against a printed slip, and mixing Arabic-Indic digits into that
 * would make two of the three unverifiable at a glance.
 */

const MILLION = 1_000_000;
const BILLION = 1_000_000_000;

/** Grouped to the last pound — what a receipt has to say. */
export function formatLbp(amount: number, locale: string = 'ar'): string {
  const formatted = Math.round(amount).toLocaleString('en-US');
  return locale === 'en' ? `${formatted} LBP` : `${formatted} ل.ل`;
}

/**
 * How many decimals a scaled figure keeps.
 *
 * Below ten the second decimal is real information — 5.5 million and 5.55 million
 * are 50,000 LBP apart, which is a fee. Above ten it is noise: at 123.45 million
 * the last digit is 10,000 LBP against a number where the reader only wants
 * the magnitude, and the extra glyphs cost more than they say.
 */
function scaled(value: number): string {
  const digits = Math.abs(value) < 10 ? 2 : 1;
  // `toFixed` then `Number` strips the trailing zeros `toFixed` insists on,
  // so 5.00 prints as 5 rather than as a falsely precise 5.00.
  return String(Number(value.toFixed(digits)));
}

/** True when `amount` is large enough that `formatLbp` would be unwieldy. */
export function isCompactable(amount: number): boolean {
  return Math.abs(amount) >= MILLION;
}

/**
 * Shorthand for anything in the millions or above; exact below that.
 */
export function formatLbpCompact(amount: number, locale: string = 'ar'): string {
  const magnitude = Math.abs(amount);
  if (magnitude < MILLION) return formatLbp(amount, locale);

  const millions = scaled(amount / MILLION);
  if (magnitude < BILLION && Math.abs(Number(millions)) < 1000) {
    return locale === 'en' ? `${millions}M LBP` : `${millions} مليون ل.ل`;
  }

  return locale === 'en' ? `${scaled(amount / BILLION)}B LBP` : `${scaled(amount / BILLION)} مليار ل.ل`;
}

/**
 * Dollars and euros, the one way the portal writes them: two decimals when
 * there are cents, the symbol after the figure, Latin digits. There were three
 * spellings of this before (`$x.toFixed(2)`, `x USD`, a locale guess); this is
 * the one the cash page, the staff roster and the receipt now share.
 */
export function formatForeign(amount: number, currency: string = 'USD'): string {
  const formatted = amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency;
  return `${formatted} ${symbol}`;
}

/** Money in whichever currency a bill is in — ليرة through `formatLbp`, the rest through `formatForeign`. */
export function formatMoney(amount: number, currency: string, locale: string = 'ar'): string {
  return currency === 'LBP' ? formatLbp(amount, locale) : formatForeign(amount, currency);
}

/**
 * The unit an amount field shows in its own segment beside the digits
 * (`CurrencyInput`, PRIM-25): «ل.ل» for the pound, «$» for the dollar, the
 * code for anything else.
 *
 * It was a page-local `unitOf` in three finance components; the fourth would
 * have been a copy (PRIM-22), so it lives here once.
 */
export function currencyUnit(currency: string, locale: string = 'ar'): string {
  if (currency === 'LBP') return locale === 'en' ? 'LBP' : 'ل.ل';
  return currency === 'USD' ? '$' : currency;
}

const ARABIC_INDIC = /[٠-٩۰-۹]/g;

/** «١٢٣» and «۱۲۳» → «123»: a clerk's keyboard may type either. */
export function toLatinDigits(raw: string): string {
  return raw.replace(ARABIC_INDIC, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/** A typed amount as a number: separators ignored, Arabic digits accepted, anything else 0. */
export function parseAmount(raw: string): number {
  const value = Number(toLatinDigits(raw).replace(/[,،٬\s]/g, '').replace('٫', '.'));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * What a clerk types, as it should read: «100000» → «100,000», as they type.
 * Digits only for ليرة, which has no fractions to pay in; up to two decimals
 * for dollars. Anything else typed is dropped rather than shown and refused.
 */
export function formatTypedAmount(raw: string, decimals: 0 | 2 | 4): string {
  const cleaned = toLatinDigits(raw).replace('٫', '.').replace(/[^\d.]/g, '');
  const [whole = '', ...rest] = cleaned.split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (decimals === 0 || rest.length === 0) return grouped;
  return `${grouped || '0'}.${rest.join('').slice(0, decimals)}`;
}

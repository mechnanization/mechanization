/**
 * The query half of the search fold.
 *
 * `users."searchText"` and `citizen_payments."searchText"` are generated
 * columns holding every looked-up value folded to one alphabet (migration
 * 0018). This is the same fold applied to what the clerk typed, so both sides
 * of a comparison are in that alphabet — which is the whole mechanism. If the
 * two ever disagree, search silently stops matching things that plainly should
 * match, so the rules below and the `search_normalize` function in that
 * migration have to be changed together.
 *
 * Everything here is intentionally about *matching*, not about validation. A
 * search box is not a form field: a term that cannot possibly be a real phone
 * number or reference should return nothing, not an error.
 */

/**
 * Character folds, mirroring `translate()` in migration 0018.
 *
 * Each pair is a distinction that changes nothing about who or what a string
 * refers to. The hamza-carrying alefs are written interchangeably by hand;
 * ة and ه are the same letter to anyone typing at speed; ى/ي is a keyboard
 * difference. The digits are the important ones in practice — an Arabic
 * keyboard produces ٠١٢ by default, and every number in this database is
 * stored in Latin digits.
 */
const FOLD: ReadonlyArray<readonly [RegExp, string]> = [
  [/[أإآٱ]/g, 'ا'], // أ إ آ ٱ → ا
  [/ى/g, 'ي'], //                     ى → ي
  [/ة/g, 'ه'], //                     ة → ه
  [/ؤ/g, 'و'], //                     ؤ → و
  [/ئ/g, 'ي'], //                     ئ → ي
  [/ـ/g, ''], //                           tatweel, removed
  [/[ً-ْٰ]/g, ''], //            tashkeel, removed
];

/** Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits → Latin. */
function foldDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/**
 * The fold itself: lowercase, letters and digits normalised, every separator
 * collapsed to a single space.
 *
 * `\p{L}\p{N}` rather than an explicit Arabic range, to match the database's
 * Unicode-aware `[[:alnum:]]`. A dash, a plus, a comma and a newline all become
 * the same thing here and in the stored column, which is what lets
 * `BZR-2608-NZ58VK` and `bzr 2608 nz58vk` reduce to the same three tokens.
 */
export function normalizeSearchText(raw: string): string {
  let value = foldDigits(raw.toLowerCase());
  for (const [pattern, replacement] of FOLD) value = value.replace(pattern, replacement);
  return value.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * The dialling prefixes a person might type in front of the digits the column
 * holds: Lebanon's, then the `00` a foreign number is dialled with.
 *
 * The `00` is taken off only in front of 8–15 digits — E.164's own bounds, the
 * same `internationalPhone` accepts — because that is the one reading in which
 * it is a prefix. Left on, `0033 6 12 34 56 78` lost only its first zero and
 * searched for `033612345678`, which the stored `+33612345678` does not
 * contain, so a foreign owner on file came back as «لا نتيجة».
 */
const DIAL_PREFIX = /^(?:00961|961|00(?=\d{8,15}$)|0)/;

/**
 * A reference number with its dashes gone: `BZR2608NZ58VK`.
 *
 * Matched rather than parsed, because this only decides *how to search* — a
 * near-miss should return no rows, which the substring search does anyway.
 */
const COMPACT_REFERENCE = /^[a-z]{3}\d{4}[a-z0-9]{6}$/;

/** More than this and the query is a paste, not a search; each token costs a scan. */
const MAX_TOKENS = 6;

/**
 * What the clerk typed, as the list of substrings a row must contain — all of
 * them.
 *
 * AND rather than OR, and this is the fix for the bug that made the fees and
 * payments screens unsearchable by name: a person is «أحمد نصرالله», and the
 * old query asked for a *single column* containing that whole string. No
 * arrangement of ORs over `firstName`/`lastName` can express "both of these
 * words, anywhere in the name", which is why every two-word query returned
 * nothing. Against one folded column holding the whole name, it is just two
 * substring tests.
 *
 * Two shapes short-circuit to a single token instead of being split:
 *
 *  - **A run of digits** is a phone number, an identity document or a civil
 *    record number, and splitting `70 123 456` into three tokens would match
 *    any row containing `70` and `123` and `456` anywhere — which is most of
 *    them. The dialling prefix comes off because the column holds E.164
 *    (`+96170123456`) while the clerk reads `03/70 123 456` off a form.
 *
 *  - **A reference number**, which is three groups that are meaningless apart.
 */
export function searchTokens(raw: string | undefined | null): string[] {
  const normalized = normalizeSearchText(raw ?? '');
  if (!normalized) return [];

  const compact = normalized.replace(/ /g, '');

  if (/^\d+$/.test(compact) && compact.length >= 4) {
    return [compact.replace(DIAL_PREFIX, '') || compact];
  }
  if (COMPACT_REFERENCE.test(compact)) return [compact];

  return normalized.split(' ').filter(Boolean).slice(0, MAX_TOKENS);
}

/**
 * A token as a `LIKE` pattern.
 *
 * `%` and `_` in a term the clerk typed are literals, not wildcards — a search
 * for `%` must look for a per-cent sign, not match every row. The backslash is
 * escaped too, because it is `LIKE`'s own default escape character and would
 * otherwise let a term consume the character after it.
 *
 * Only used by the raw-SQL callers; the Prisma query builder's `contains`
 * escapes its argument itself, and double-escaping there would break the
 * literal case in the opposite direction.
 */
export function likePattern(token: string): string {
  return `%${token.replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
}

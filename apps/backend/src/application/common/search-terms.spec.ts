import { likePattern, normalizeSearchText, searchTokens } from './search-terms';

/**
 * These cases were checked against Postgres itself before being written down:
 * every expectation in `normalizeSearchText` is the literal output of the
 * `search_normalize` function in migration 0018 for the same input. That
 * agreement is the whole mechanism — a stored column folded one way and a
 * query folded another matches nothing, and does so silently — so if one side
 * is changed the other has to be changed with it, and this is where the drift
 * shows up.
 */
describe('normalizeSearchText', () => {
  it.each([
    // The hamza-carrying alefs. Written interchangeably by hand, so a clerk
    // typing احمد must find أحمد.
    ['أحمد خالد نصرالله', 'احمد خالد نصرالله'],
    ['احمد خالد نصرالله', 'احمد خالد نصرالله'],
    ['إبراهيم', 'ابراهيم'],
    ['آمنة', 'امنه'],
    // Tashkeel and tatweel: decoration, never identity.
    ['أَحْمَد', 'احمد'],
    ['محمّد الطويــل', 'محمد الطويل'],
    // ة/ه and ى/ي — a keyboard difference, not a spelling one.
    ['فاطمة', 'فاطمه'],
    ['مصطفى', 'مصطفي'],
    // Arabic-Indic and Extended Arabic-Indic digits. An Arabic keyboard
    // produces these by default; every number in the database is Latin.
    ['٠٧٠١٢٣٤٥٦', '070123456'],
    ['۰۹۸', '098'],
    ['رسم النفايات ٢٠٢٦', 'رسم النفايات 2026'],
    // Separators all collapse, which is what makes a dashed reference number
    // and a dictated one the same tokens.
    ['BZR-2608-NZ58VK', 'bzr 2608 nz58vk'],
    ['+96170123456', '96170123456'],
    ['  spaced   out  ', 'spaced out'],
    ["Ali O'Brien", 'ali o brien'],
    ['', ''],
  ])('folds %s to %s', (input, expected) => {
    expect(normalizeSearchText(input)).toBe(expected);
  });
});

describe('searchTokens', () => {
  /**
   * The bug this exists to fix: «أحمد نصرالله» is how a person is referred to,
   * and the old query compared it as one string against a name that includes
   * the middle name — so first-plus-family found nobody. Two tokens, ANDed
   * against one folded column, is the whole fix.
   */
  it('splits a name into tokens that are ANDed', () => {
    expect(searchTokens('أحمد نصرالله')).toEqual(['احمد', 'نصرالله']);
  });

  it('matches a name typed without hamza against one stored with it', () => {
    expect(searchTokens('احمد')).toEqual(searchTokens('أحمد'));
  });

  /**
   * A reference number is three groups that mean nothing apart, so it stays one
   * token however it arrives — dictated down a phone line, pasted off a وصل, or
   * typed with the dashes the input mask inserts.
   */
  it.each([['BZR-2608-NZ58VK'], ['bzr2608nz58vk'], ['BZR 2608 NZ58VK']])(
    'keeps the reference %s as one token',
    (input) => {
      expect(searchTokens(input)).toEqual(['bzr2608nz58vk']);
    },
  );

  /**
   * Phones are stored E.164 (`+96170123456`) and read off a form as `03/70 123
   * 456`. Splitting on the spaces would ask for rows containing `70` and `123`
   * and `456` anywhere, which is most of them.
   */
  it.each([['070123456'], ['+961 70 123 456'], ['70123456'], ['00961 70 123 456']])(
    'reduces the phone %s to its national digits',
    (input) => {
      expect(searchTokens(input)).toEqual(['70123456']);
    },
  );

  /**
   * A foreign number is stored `+33612345678`, folded to `33612345678`. Typed
   * with the `00` it is dialled with, only the first zero used to come off, and
   * `033612345678` is not a substring of what is stored.
   */
  it.each([['+33 6 12 34 56 78'], ['0033 6 12 34 56 78'], ['٠٠٣٣٦١٢٣٤٥٦٧٨']])(
    'reduces the foreign phone %s to the digits after its country prefix',
    (input) => {
      expect(searchTokens(input)).toEqual(['33612345678']);
    },
  );

  /** Too short to follow an international `00`, so only the one zero goes, as before. */
  it('leaves a short number that merely starts with 00 alone', () => {
    expect(searchTokens('0012')).toEqual(['012']);
  });

  it('returns nothing for an empty or punctuation-only term', () => {
    expect(searchTokens('')).toEqual([]);
    expect(searchTokens('   ')).toEqual([]);
    expect(searchTokens('---')).toEqual([]);
    expect(searchTokens(undefined)).toEqual([]);
  });

  /** Each token costs a scan; past a handful the input is a paste, not a search. */
  it('caps the number of tokens', () => {
    expect(searchTokens('a b c d e f g h i j')).toHaveLength(6);
  });
});

describe('likePattern', () => {
  /**
   * A search for `%` looks for a per-cent sign. Without this it matched every
   * row in the municipality.
   */
  it('escapes LIKE metacharacters so a typed term is a literal', () => {
    expect(likePattern('50%')).toBe('%50\\%%');
    expect(likePattern('a_b')).toBe('%a\\_b%');
    expect(likePattern('a\\b')).toBe('%a\\\\b%');
  });
});

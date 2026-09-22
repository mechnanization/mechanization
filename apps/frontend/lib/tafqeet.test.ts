import { describe, expect, it } from 'vitest';
import { tafqeet } from './tafqeet';

/**
 * تفقيط — the written-out amount on a municipal receipt.
 *
 * This is the module in `lib/` with the least forgiving failure mode. The
 * figure in words is the *legally operative* one on a Lebanese receipt: where
 * it disagrees with the digits, the words are what the document says. A bug
 * here does not produce a broken screen, it produces a stack of signed وصولات
 * that say the wrong amount, and nobody notices until one is disputed.
 *
 * So these tests are about grammar as much as arithmetic. Arabic number
 * agreement is genuinely intricate — the counted noun changes form at two, at
 * three-to-ten, and again above ten, and the gender of the numeral flips
 * against the gender of what it counts — and each of those boundaries is a
 * place this converter can be wrong while looking right.
 */
describe('tafqeet', () => {
  /** Every receipt ends this way; asserting it separately would be noise. */
  const SUFFIX = 'ليرة لبنانية فقط لا غير';

  describe('zero and the smallest amounts', () => {
    it('writes zero out rather than leaving the line blank', () => {
      // A zero-value receipt is real — a fee waived, or fully offset by a
      // credit — and the line still has to say something.
      expect(tafqeet(0)).toBe(`صفر ${SUFFIX}`);
    });

    it('uses the singular feminine for one pound', () => {
      // ليرة is feminine, so «واحد» would be wrong; and the adjective follows
      // the noun it agrees with, giving «ليرة واحدة لبنانية».
      expect(tafqeet(1)).toBe('ليرة واحدة لبنانية فقط لا غير');
    });

    it('uses the dual for two pounds rather than "two pound"', () => {
      // Arabic has a dual number: ليرتان, not «اثنتان ليرة».
      expect(tafqeet(2)).toBe('ليرتان لبنانيتان فقط لا غير');
    });

    it('uses the plural of paucity for three to ten', () => {
      // 3–10 take the broken plural ليرات with a *feminine* numeral.
      expect(tafqeet(3)).toBe('ثلاث ليرات لبنانية فقط لا غير');
      expect(tafqeet(10)).toBe('عشر ليرات لبنانية فقط لا غير');
    });

    it('returns to the singular counted noun above ten', () => {
      // 11+ reverts to «ليرة لبنانية» — the suffix form — so this is the
      // boundary where the three preceding rules all stop applying.
      expect(tafqeet(11)).toBe(`أحد عشر ${SUFFIX}`);
    });
  });

  describe('tens, teens and hundreds', () => {
    it('writes the teens as single words, not as ten-plus-n', () => {
      expect(tafqeet(12)).toBe(`اثنا عشر ${SUFFIX}`);
      expect(tafqeet(19)).toBe(`تسعة عشر ${SUFFIX}`);
    });

    it('puts the unit before the ten, joined by و', () => {
      // «واحد وعشرون», literally "one and twenty" — the opposite order to
      // English, and the thing a naive implementation gets backwards.
      expect(tafqeet(21)).toBe(`واحد وعشرون ${SUFFIX}`);
      expect(tafqeet(99)).toBe(`تسعة وتسعون ${SUFFIX}`);
    });

    it('drops the unit entirely at a round ten', () => {
      expect(tafqeet(20)).toBe(`عشرون ${SUFFIX}`);
      expect(tafqeet(90)).toBe(`تسعون ${SUFFIX}`);
    });

    it('writes hundreds as their own words, including the dual', () => {
      expect(tafqeet(100)).toBe(`مائة ${SUFFIX}`);
      // مائتان is a dual form, not «اثنان مائة».
      expect(tafqeet(200)).toBe(`مائتان ${SUFFIX}`);
      expect(tafqeet(900)).toBe(`تسعمائة ${SUFFIX}`);
    });

    it('joins a hundred to its remainder with و', () => {
      expect(tafqeet(101)).toBe(`مائة وواحد ${SUFFIX}`);
      expect(tafqeet(999)).toBe(`تسعمائة وتسعة وتسعون ${SUFFIX}`);
    });

    it('does not apply the 3–10 noun rule once a hundred is present', () => {
      // 103 is not «مائة وثلاث ليرات» — the paucity plural applies only when
      // the whole amount is 3–10, which is the subtlety worth pinning down.
      expect(tafqeet(103)).toBe(`مائة وثلاثة ${SUFFIX}`);
    });
  });

  describe('thousands', () => {
    it('uses the bare singular for one thousand', () => {
      // «ألف», never «واحد ألف».
      expect(tafqeet(1_000)).toBe(`ألف ${SUFFIX}`);
    });

    it('uses the dual for two thousand', () => {
      expect(tafqeet(2_000)).toBe(`ألفان ${SUFFIX}`);
    });

    it('uses the plural of paucity for three to ten thousand', () => {
      expect(tafqeet(3_000)).toBe(`ثلاثة آلاف ${SUFFIX}`);
      expect(tafqeet(10_000)).toBe(`عشرة آلاف ${SUFFIX}`);
    });

    it('uses the accusative singular above ten thousand', () => {
      // «ألفاً» — the تمييز, which is what distinguishes 11,000 from 10,000
      // grammatically and is a common thing to get wrong.
      expect(tafqeet(11_000)).toBe(`أحد عشر ألفاً ${SUFFIX}`);
      expect(tafqeet(50_000)).toBe(`خمسون ألفاً ${SUFFIX}`);
    });

    it('joins thousands to the remainder', () => {
      expect(tafqeet(1_500)).toBe(`ألف وخمسمائة ${SUFFIX}`);
      expect(tafqeet(250_000)).toBe(`مائتان وخمسون ألفاً ${SUFFIX}`);
    });
  });

  describe('millions and billions', () => {
    it('handles the singular, dual and paucity forms of million', () => {
      expect(tafqeet(1_000_000)).toBe(`مليون ${SUFFIX}`);
      expect(tafqeet(2_000_000)).toBe(`مليونان ${SUFFIX}`);
      expect(tafqeet(3_000_000)).toBe(`ثلاثة ملايين ${SUFFIX}`);
    });

    it('handles the singular, dual and paucity forms of billion', () => {
      expect(tafqeet(1_000_000_000)).toBe(`مليار ${SUFFIX}`);
      expect(tafqeet(2_000_000_000)).toBe(`ملياران ${SUFFIX}`);
      expect(tafqeet(3_000_000_000)).toBe(`ثلاثة مليارات ${SUFFIX}`);
    });

    it('writes the documented example exactly', () => {
      // Straight from the module's own doc comment — so the documentation and
      // the behaviour cannot drift apart silently.
      expect(tafqeet(2_500_000)).toBe(`مليونان وخمسمائة ألف ${SUFFIX}`);
    });

    it('chains every scale in one amount, in descending order', () => {
      /*
        A realistic municipality-wide outstanding total, and the case that
        exercises all three تمييز bands at once:

        - `234` million ends on ثلاثون (30), in the 11–99 band → «مليوناً»
        - `567` thousand ends on ستون (60), same band        → «ألفاً»
        - `890` is the bare remainder, which takes no scale word at all
      */
      expect(tafqeet(1_234_567_890)).toBe(
        'مليار ومائتان وأربعة وثلاثون مليوناً وخمسمائة وسبعة وستون ألفاً وثمانمائة وتسعون ' +
          SUFFIX,
      );
    });

    it('keeps the genitive singular when a scale ends on a round hundred', () => {
      /*
        The case the implementation used to get wrong, kept as its own test.

        «خمسمائة» ends on a hundred rather than on a 3–10 or an 11–99, so the
        counted noun is the genitive singular «ألف». The old code reached for
        the accusative «ألفاً» for every count above ten, which made
        500,000 read «خمسمائة ألفاً» — and disagreed with this module's own
        documented example, which is the same number.
      */
      expect(tafqeet(500_000)).toBe(`خمسمائة ألف ${SUFFIX}`);
      expect(tafqeet(200_000_000)).toBe(`مائتان مليون ${SUFFIX}`);
    });

    it('keeps the plural of paucity when a scale ends on 3–10', () => {
      // 105 ends on خمسة (5), so it stays «آلاف» rather than taking the
      // accusative that its size alone would suggest.
      expect(tafqeet(105_000)).toBe(`مائة وخمسة آلاف ${SUFFIX}`);
    });

    it('skips an empty scale instead of writing a zero for it', () => {
      // 1,000,001 has no millions-to-thousands part; a naive chunker writes
      // «ألف وصفر» or an extra و here.
      expect(tafqeet(1_000_001)).toBe(`مليون وواحد ${SUFFIX}`);
      expect(tafqeet(1_000_000_000_0 / 10)).toBe(`مليار ${SUFFIX}`);
    });
  });

  describe('inputs that are not clean positive integers', () => {
    it('truncates a fractional amount rather than rounding it up', () => {
      // LBP has no minor unit in practice (see `lib/currency.ts`), so a
      // fraction is a bug upstream. Truncating is the conservative choice: a
      // receipt must never claim more money than was handed over.
      expect(tafqeet(1.9)).toBe('ليرة واحدة لبنانية فقط لا غير');
      expect(tafqeet(2_500_000.75)).toBe(`مليونان وخمسمائة ألف ${SUFFIX}`);
    });

    it('takes the magnitude of a negative amount', () => {
      // `Math.abs` in the implementation. Worth pinning: a refund reaching
      // this function should read as a positive figure rather than as the
      // word «سالب», which no receipt template has a place for.
      expect(tafqeet(-1_000)).toBe(`ألف ${SUFFIX}`);
    });

    it('treats a negative fraction as zero', () => {
      expect(tafqeet(-0.5)).toBe(`صفر ${SUFFIX}`);
    });
  });

  describe('the currency argument', () => {
    it('substitutes a different currency in the suffix', () => {
      expect(tafqeet(1_000, 'دولار أمريكي')).toBe('ألف دولار أمريكي فقط لا غير');
    });

    it('still uses the Lebanese-pound wording for the 1, 2 and 3–10 cases', () => {
      /*
        A real limitation, asserted rather than hidden.

        The small-amount branches hard-code ليرة / ليرتان / ليرات and ignore the
        `currency` argument entirely, so `tafqeet(2, 'دولار')` says "two Lebanese
        pounds". Every caller in this app passes LBP, so it has never mattered —
        but a test that quietly skipped these cases would let the next person
        add a second currency and produce wrong receipts with no failure to
        warn them. Locking the current behaviour in means that change breaks a
        test, which is where it should break.
      */
      expect(tafqeet(2, 'دولار أمريكي')).toBe('ليرتان لبنانيتان فقط لا غير');
      expect(tafqeet(5, 'دولار أمريكي')).toBe('خمس ليرات لبنانية فقط لا غير');
    });
  });

  describe('properties that must hold for every amount', () => {
    /** The fee amounts and totals this system actually renders. */
    const REALISTIC_AMOUNTS = [
      0, 1, 2, 7, 15, 40, 99, 100, 350, 999, 1_000, 7_500, 25_000, 150_000, 999_999, 1_000_000,
      2_500_000, 12_750_000, 500_000_000, 1_000_000_000, 8_400_000_000,
    ];

    it('never emits a doubled separator, a stray digit or a double space', () => {
      for (const amount of REALISTIC_AMOUNTS) {
        const words = tafqeet(amount);

        // A Latin digit in the words means a chunk fell through unconverted —
        // the clearest single signal that the output is malformed.
        expect(words, `digits leaked for ${amount}`).not.toMatch(/\d/);
        expect(words, `double space for ${amount}`).not.toMatch(/ {2}/);
        expect(words, `doubled "و و" for ${amount}`).not.toMatch(/ و و/);
        expect(words, `trailing separator for ${amount}`).not.toMatch(/و\s*فقط/);
      }
    });

    it('always ends with the legally required closing phrase', () => {
      // «فقط لا غير» — "only, and no more" — is what stops an amount being
      // extended by hand after signing. Its absence is a forgery risk, not a
      // formatting nit.
      for (const amount of REALISTIC_AMOUNTS) {
        expect(tafqeet(amount).endsWith('فقط لا غير'), `missing for ${amount}`).toBe(true);
      }
    });

    it('names the currency exactly once', () => {
      for (const amount of REALISTIC_AMOUNTS) {
        const occurrences = tafqeet(amount).split('لبنانية').length - 1;
        // 2 (ليرتان لبنانيتان) uses a dual form that does not contain the
        // string, so it is excluded rather than special-cased into the count.
        if (amount === 2) continue;
        expect(occurrences, `currency named ${occurrences}× for ${amount}`).toBe(1);
      }
    });
  });
});

import { describe, expect, it } from 'vitest';
import { tafqeet, tafqeetAmount } from './tafqeet';

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

    it('returns to the singular counted noun above ten, with a feminine numeral', () => {
      // 11+ reverts to «ليرة لبنانية» — the suffix form. The numeral still
      // agrees with ليرة, which is feminine: «إحدى عشرة», never «أحد عشر».
      expect(tafqeet(11)).toBe(`إحدى عشرة ${SUFFIX}`);
    });
  });

  describe('tens, teens and hundreds', () => {
    it('writes the teens as single words, not as ten-plus-n', () => {
      // Feminine, as ليرة is: «ثلاث عشرة ليرة», not «ثلاثة عشر ليرة».
      expect(tafqeet(12)).toBe(`اثنتا عشرة ${SUFFIX}`);
      expect(tafqeet(13)).toBe(`ثلاث عشرة ${SUFFIX}`);
      expect(tafqeet(19)).toBe(`تسع عشرة ${SUFFIX}`);
    });

    it('puts the unit before the ten, joined by و', () => {
      // «واحد وعشرون», literally "one and twenty" — the opposite order to
      // English, and the thing a naive implementation gets backwards.
      // The unit agrees with ليرة: «إحدى وعشرون»، «خمس وعشرون».
      expect(tafqeet(21)).toBe(`إحدى وعشرون ${SUFFIX}`);
      expect(tafqeet(25)).toBe(`خمس وعشرون ${SUFFIX}`);
      expect(tafqeet(99)).toBe(`تسع وتسعون ${SUFFIX}`);
    });

    it('drops the unit entirely at a round ten', () => {
      expect(tafqeet(20)).toBe(`عشرون ${SUFFIX}`);
      expect(tafqeet(90)).toBe(`تسعون ${SUFFIX}`);
    });

    it('writes hundreds as their own words, including the dual', () => {
      expect(tafqeet(100)).toBe(`مائة ${SUFFIX}`);
      // A dual, not «اثنان مائة» — in construct with the noun that follows it: «مائتا ليرة».
      expect(tafqeet(200)).toBe(`مائتا ${SUFFIX}`);
      expect(tafqeet(900)).toBe(`تسعمائة ${SUFFIX}`);
    });

    it('joins a hundred to its remainder with و', () => {
      expect(tafqeet(101)).toBe(`مائة وواحدة ${SUFFIX}`);
      expect(tafqeet(999)).toBe(`تسعمائة وتسع وتسعون ${SUFFIX}`);
    });

    it('keeps the plural of paucity when the amount ends in 3–10, after a hundred too', () => {
      /*
        The counted noun agrees with the last numeral spoken, as `countNoun`
        has it for دولار: 103 ends on ثلاث, so «مائة وثلاث ليرات». This test
        once pinned «مائة وثلاثة ليرة» — a masculine numeral on a feminine noun,
        and the singular after three — printed as the operative figure on
        «أمر الصرف» and on a citizen's وصل.
      */
      expect(tafqeet(103)).toBe('مائة وثلاث ليرات لبنانية فقط لا غير');
      expect(tafqeet(110)).toBe('مائة وعشر ليرات لبنانية فقط لا غير');
      expect(tafqeet(1_005)).toBe('ألف وخمس ليرات لبنانية فقط لا غير');
    });
  });

  describe('thousands', () => {
    it('uses the bare singular for one thousand', () => {
      // «ألف», never «واحد ألف».
      expect(tafqeet(1_000)).toBe(`ألف ${SUFFIX}`);
    });

    it('uses the dual for two thousand, in construct when the noun follows it', () => {
      // «ألفا ليرة», not «ألفان ليرة»: a dual followed by its noun drops its ن.
      expect(tafqeet(2_000)).toBe(`ألفا ${SUFFIX}`);
      // With more after it, it keeps it.
      expect(tafqeet(2_500)).toBe(`ألفان وخمسمائة ${SUFFIX}`);
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
      expect(tafqeet(2_000_000)).toBe(`مليونا ${SUFFIX}`);
      expect(tafqeet(3_000_000)).toBe(`ثلاثة ملايين ${SUFFIX}`);
    });

    it('handles the singular, dual and paucity forms of billion', () => {
      expect(tafqeet(1_000_000_000)).toBe(`مليار ${SUFFIX}`);
      expect(tafqeet(2_000_000_000)).toBe(`مليارا ${SUFFIX}`);
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
      expect(tafqeet(200_000_000)).toBe(`مائتا مليون ${SUFFIX}`);
    });

    it('keeps the plural of paucity when a scale ends on 3–10', () => {
      // 105 ends on خمسة (5), so it stays «آلاف» rather than taking the
      // accusative that its size alone would suggest.
      expect(tafqeet(105_000)).toBe(`مائة وخمسة آلاف ${SUFFIX}`);
    });

    it('skips an empty scale instead of writing a zero for it', () => {
      // 1,000,001 has no millions-to-thousands part; a naive chunker writes
      // «ألف وصفر» or an extra و here.
      expect(tafqeet(1_000_001)).toBe(`مليون وواحدة ${SUFFIX}`);
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

/**
 * The same line on «أمر الصرف» and «سند القبض», in the voucher's own currency.
 *
 * دولار is masculine where ليرة is feminine, so every boundary the pound tests
 * pin moves the other way here: the numeral 3–10 is feminine in form
 * («ثلاثة دولارات»), and the noun after 11–99 is accusative («دولاراً
 * أميركياً»). Cents follow the same rule and come after the dollars.
 */
describe('tafqeetAmount', () => {
  it('writes a ليرة amount exactly as tafqeet does, so a voucher and a وصل never disagree', () => {
    for (const amount of [0, 1, 2, 7, 11, 500_000, 2_500_000, 234_000_000]) {
      expect(tafqeetAmount(amount, 'LBP')).toBe(tafqeet(amount));
    }
  });

  it('names one and two dollars by the noun alone', () => {
    expect(tafqeetAmount(1, 'USD')).toBe('دولار أميركي واحد فقط لا غير');
    expect(tafqeetAmount(2, 'USD')).toBe('دولاران أميركيان فقط لا غير');
  });

  it('uses the feminine numeral and the plural for three to ten', () => {
    expect(tafqeetAmount(3, 'USD')).toBe('ثلاثة دولارات أميركية فقط لا غير');
    expect(tafqeetAmount(10, 'USD')).toBe('عشرة دولارات أميركية فقط لا غير');
  });

  it('takes the accusative after eleven to ninety-nine', () => {
    expect(tafqeetAmount(11, 'USD')).toBe('أحد عشر دولاراً أميركياً فقط لا غير');
    expect(tafqeetAmount(25, 'USD')).toBe('خمسة وعشرون دولاراً أميركياً فقط لا غير');
    expect(tafqeetAmount(150, 'USD')).toBe('مائة وخمسون دولاراً أميركياً فقط لا غير');
  });

  it('agrees with the last numeral spoken, not with the size of the whole', () => {
    expect(tafqeetAmount(100, 'USD')).toBe('مائة دولار أميركي فقط لا غير');
    expect(tafqeetAmount(103, 'USD')).toBe('مائة وثلاثة دولارات أميركية فقط لا غير');
    expect(tafqeetAmount(1_000, 'USD')).toBe('ألف دولار أميركي فقط لا غير');
    expect(tafqeetAmount(2_500, 'USD')).toBe('ألفان وخمسمائة دولار أميركي فقط لا غير');
  });

  it('keeps the cents, after the dollars', () => {
    expect(tafqeetAmount(1_500.75, 'USD')).toBe(
      'ألف وخمسمائة دولار أميركي وخمسة وسبعون سنتاً فقط لا غير',
    );
    expect(tafqeetAmount(12.05, 'USD')).toBe('اثنا عشر دولاراً أميركياً وخمسة سنتات فقط لا غير');
    expect(tafqeetAmount(1.01, 'USD')).toBe('دولار أميركي واحد وسنت واحد فقط لا غير');
  });

  it('writes cents alone when there is no whole dollar', () => {
    expect(tafqeetAmount(0.5, 'USD')).toBe('خمسون سنتاً فقط لا غير');
    expect(tafqeetAmount(0.02, 'USD')).toBe('سنتان فقط لا غير');
  });

  it('rounds to the cent rather than reading a float’s tail', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary; a voucher for 30 cents says 30.
    expect(tafqeetAmount(0.1 + 0.2, 'USD')).toBe('ثلاثون سنتاً فقط لا غير');
  });

  it('writes zero out rather than leaving the line blank', () => {
    expect(tafqeetAmount(0, 'USD')).toBe('صفر دولار أميركي فقط لا غير');
  });

  it('has no words for a currency it does not know, rather than the pound’s', () => {
    expect(tafqeetAmount(100, 'EUR')).toBeNull();
  });

  it('counts ليرة as the feminine noun it is, on a voucher as on a وصل', () => {
    // What a voucher printed before: «ثلاثة عشر ليرة»، «خمسة وعشرون ليرة»، «مائة وثلاثة ليرة».
    expect(tafqeetAmount(13, 'LBP')).toBe('ثلاث عشرة ليرة لبنانية فقط لا غير');
    expect(tafqeetAmount(25, 'LBP')).toBe('خمس وعشرون ليرة لبنانية فقط لا غير');
    expect(tafqeetAmount(103, 'LBP')).toBe('مائة وثلاث ليرات لبنانية فقط لا غير');
  });

  it('puts a dual that ends the amount in construct with the currency', () => {
    // «ألفا دولار», not «ألفان دولار»; the same for million and billion, and for مائتان.
    expect(tafqeetAmount(2_000, 'USD')).toBe('ألفا دولار أميركي فقط لا غير');
    expect(tafqeetAmount(2_000_000, 'USD')).toBe('مليونا دولار أميركي فقط لا غير');
    expect(tafqeetAmount(200, 'USD')).toBe('مائتا دولار أميركي فقط لا غير');
    expect(tafqeetAmount(2_000_000, 'LBP')).toBe('مليونا ليرة لبنانية فقط لا غير');
    expect(tafqeetAmount(1_200, 'LBP')).toBe('ألف ومائتا ليرة لبنانية فقط لا غير');
    // Not when more follows it, or for a count of 2 that is not last.
    expect(tafqeetAmount(2_000_500, 'USD')).toBe('مليونان وخمسمائة دولار أميركي فقط لا غير');
    expect(tafqeetAmount(2_002_000, 'USD')).toBe('مليونان وألفا دولار أميركي فقط لا غير');
  });

  it('writes no words for a ليرة amount with a fraction, rather than words for less than the figure', () => {
    // The API takes two decimals in any currency; `tafqeet` drops the fraction.
    expect(tafqeetAmount(1_500.5, 'LBP')).toBeNull();
    expect(tafqeetAmount(1_500, 'LBP')).toBe('ألف وخمسمائة ليرة لبنانية فقط لا غير');
  });
});

/**
 * Arabic number-to-words converter (Tafqeet / تفقيط الأرقام باللغة العربية).
 *
 * Formats financial figures into grammatically sound Arabic words for
 * municipal receipts and counter slips (e.g. 2,500,000 -> "مليونان وخمسمائة ألف ليرة لبنانية فقط لا غير").
 */

const ONES_MASCULINE = [
  '',
  'واحد',
  'اثنان',
  'ثلاثة',
  'أربعة',
  'خمسة',
  'ستة',
  'سبعة',
  'ثمانية',
  'تسعة',
  'عشرة',
  'أحد عشر',
  'اثنا عشر',
  'ثلاثة عشر',
  'أربعة عشر',
  'خمسة عشر',
  'ستة عشر',
  'سبعة عشر',
  'ثمانية عشر',
  'تسعة عشر',
];

const ONES_FEMININE = [
  '',
  'واحدة',
  'اثنتان',
  'ثلاث',
  'أربع',
  'خمس',
  'ست',
  'سبع',
  'ثمان',
  'تسع',
  'عشر',
  'إحدى عشرة',
  'اثنتا عشرة',
  'ثلاث عشرة',
  'أربع عشرة',
  'خمس عشرة',
  'ست عشرة',
  'سبع عشرة',
  'ثماني عشرة',
  'تسع عشرة',
];

const TENS = [
  '',
  'عشرة',
  'عشرون',
  'ثلاثون',
  'أربعون',
  'خمسون',
  'ستون',
  'سبعون',
  'ثمانون',
  'تسعون',
];

const HUNDREDS = [
  '',
  'مائة',
  'مائتان',
  'ثلاثمائة',
  'أربعمائة',
  'خمسمائة',
  'ستمائة',
  'سبعمائة',
  'ثمانمائة',
  'تسعمائة',
];

/**
 * Converts a 1-999 chunk into Arabic words.
 *
 * `feminine` when the counted noun is feminine (ليرة): «ثلاث عشرة»، «خمس
 * وعشرون»، «إحدى وعشرون». `construct` when that noun follows these words
 * directly, which a round «مائتان» answers by losing its ن: «مائتا ليرة»،
 * «مائتا ألف».
 */
function convertThreeDigits(num: number, feminine = false, construct = false): string {
  if (num === 0) return '';

  const parts: string[] = [];
  const hundred = Math.floor(num / 100);
  const remainder = num % 100;

  if (hundred > 0) {
    parts.push(hundred === 2 && remainder === 0 && construct ? 'مائتا' : HUNDREDS[hundred]!);
  }

  if (remainder > 0) {
    if (remainder < 20) {
      parts.push(feminine ? ONES_FEMININE[remainder]! : ONES_MASCULINE[remainder]!);
    } else {
      const unit = remainder % 10;
      const ten = Math.floor(remainder / 10);

      if (unit > 0) {
        // One, joined to a ten before a feminine noun, is إحدى: «إحدى وعشرون ليرة».
        const unitWord = feminine ? (unit === 1 ? 'إحدى' : ONES_FEMININE[unit]!) : ONES_MASCULINE[unit]!;
        parts.push(`${unitWord} و${TENS[ten]!}`);
      } else {
        parts.push(TENS[ten]!);
      }
    }
  }

  return parts.join(' و');
}

/**
 * The four forms a counted scale word takes: ألف / ألفان / آلاف / ألفاً.
 *
 * Arabic picks between them by the *numeral*, not by the quantity, which is why
 * this cannot be a simple singular/plural switch.
 */
interface ScaleForms {
  /** 1, and any count ending in a round hundred — the genitive تمييز. */
  singular: string;
  /** Exactly 2 — the dual. */
  dual: string;
  /**
   * Exactly 2, as the last numeral before the currency noun — the dual in
   * construct, which loses its ن: «ألفا ليرة»، «مليونا دولار». Where more
   * follows («مليونان وخمسمائة ألف») it keeps it.
   */
  construct: string;
  /** 3–10, and counts ending in 3–10 — the plural of paucity. */
  plural: string;
  /** Counts ending in 11–99 — the accusative تمييز. */
  accusative: string;
}

const THOUSAND: ScaleForms = {
  singular: 'ألف',
  dual: 'ألفان',
  construct: 'ألفا',
  plural: 'آلاف',
  accusative: 'ألفاً',
};

const MILLION: ScaleForms = {
  singular: 'مليون',
  dual: 'مليونان',
  construct: 'مليونا',
  plural: 'ملايين',
  accusative: 'مليوناً',
};

const BILLION: ScaleForms = {
  singular: 'مليار',
  dual: 'ملياران',
  construct: 'مليارا',
  plural: 'مليارات',
  accusative: 'ملياراً',
};

/**
 * Writes one scale chunk — `234` + million — with the right تمييز.
 *
 * The rule Arabic actually applies is that the counted noun agrees with the
 * **last numeral spoken**, not with the size of the whole number. So in
 * «مائتان وأربعة وثلاثون» the operative numeral is ثلاثون (30), which is in the
 * 11–99 band and takes the accusative singular «مليوناً» — *not* the plural
 * «ملايين», which belongs only to 3–10. And «خمسمائة» ends on a round hundred,
 * which takes the genitive singular «ألف».
 *
 * This replaces three hand-written if-ladders that each had the 1 / 2 / 3–10
 * cases right and everything above ten wrong in two different ways:
 *
 * - thousands always took «ألفاً», so 500,000 read «خمسمائة ألفاً» where it
 *   should read «خمسمائة ألف» — contradicting this module's own documented
 *   example of 2,500,000, which is the same case.
 * - millions above ten took the *plural* «ملايين», so 234,000,000 read
 *   «مائتان وأربعة وثلاثون ملايين» instead of «… مليوناً».
 *
 * On a screen that is a typo. On a وصل it is the legally operative figure: where
 * the words and the digits disagree on a Lebanese receipt, the words are what
 * the document says.
 */
function writeScale(count: number, forms: ScaleForms, lastBeforeNoun: boolean): string {
  if (count === 1) return forms.singular;
  if (count === 2) return lastBeforeNoun ? forms.construct : forms.dual;
  if (count <= 10) return `${ONES_MASCULINE[count]!} ${forms.plural}`;

  // The scale word follows its count directly: «مائتا ألف».
  const words = convertThreeDigits(count, false, true);
  // The last two digits are what carries the agreement: 0 means the number
  // ended on a hundred, 3–10 keeps the paucity plural, everything else in
  // 11–99 takes the accusative.
  const last = count % 100;

  if (last === 0) return `${words} ${forms.singular}`;
  if (last >= 3 && last <= 10) return `${words} ${forms.plural}`;
  return `${words} ${forms.accusative}`;
}

/**
 * The words for a whole number of 1 or more, with no counted noun after them —
 * «مائتان وأربعة وثلاثون ألفاً وخمسمائة». What follows depends on the currency,
 * and each caller picks its own noun by the last numeral spoken.
 *
 * Every caller writes that noun straight after these words, so the last
 * numeral is in construct with it (`ScaleForms.construct`, «مائتا»). The last
 * three digits agree with the noun's gender (`feminine` for ليرة); the scale
 * words are مذكر whatever is counted after them.
 */
function integerWords(integerPart: number, feminine = false): string {
  const billions = Math.floor(integerPart / 1_000_000_000);
  const millions = Math.floor((integerPart % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((integerPart % 1_000_000) / 1_000);
  const remainder = integerPart % 1_000;

  const scales: Array<[number, ScaleForms]> = [
    [billions, BILLION],
    [millions, MILLION],
    [thousands, THOUSAND],
  ];
  // The scale the noun follows directly: the last one written, when nothing below it is.
  const lastScale = remainder > 0 ? -1 : scales.map(([count]) => count > 0).lastIndexOf(true);

  const chunks: string[] = [];

  // Each scale is مذكر, and each picks its form the same way — see `writeScale`.
  scales.forEach(([count, forms], index) => {
    if (count > 0) chunks.push(writeScale(count, forms, index === lastScale));
  });
  if (remainder > 0) chunks.push(convertThreeDigits(remainder, feminine, true));

  return chunks.join(' و');
}

/** The Lebanese pound, feminine: what `tafqeet` counts unless told otherwise. */
const LIRA = 'ليرة لبنانية';

/**
 * Converts any non-negative integer into Arabic words with the currency unit and "فقط لا غير".
 *
 * @param amount - Non-negative integer (in LBP)
 * @param currency - Optional currency suffix, defaults to 'ليرة لبنانية'
 */
export function tafqeet(amount: number, currency = LIRA): string {
  const integerPart = Math.floor(Math.abs(amount));

  if (integerPart === 0) {
    return `صفر ${currency} فقط لا غير`;
  }

  // One to ten name the pound itself, with its own agreement.
  if (integerPart === 1) return `ليرة واحدة لبنانية فقط لا غير`;
  if (integerPart === 2) return `ليرتان لبنانيتان فقط لا غير`;
  if (integerPart <= 10) return `${ONES_FEMININE[integerPart]} ليرات لبنانية فقط لا غير`;

  /*
    ليرة is feminine, so above ten its numerals are too — «ثلاث عشرة ليرة»،
    «خمس وعشرون ليرة» — and an amount ending in 3–10 takes the plural of
    paucity, as one of 3–10 does: «مائة وثلاث ليرات». The rule `countNoun`
    applies to دولار, with the genders the other way round.
  */
  if (currency === LIRA) {
    const last = integerPart % 100;
    const noun = last >= 3 && last <= 10 ? 'ليرات لبنانية' : LIRA;
    return `${integerWords(integerPart, true)} ${noun} فقط لا غير`;
  }

  return `${integerWords(integerPart)} ${currency} فقط لا غير`;
}

/**
 * A whole number of a masculine counted noun, agreeing with the last numeral
 * spoken — the rule `writeScale` applies to ألف and مليون, applied to the
 * currency itself:
 *
 * - 1 and 2 name the noun alone, singular and dual: «دولار أميركي واحد»،
 *   «دولاران أميركيان».
 * - 3–10, and any count ending in 3–10, take the plural of paucity with the
 *   numeral in its feminine form, as a masculine noun requires: «ثلاثة دولارات
 *   أميركية»، «مائة وثلاثة دولارات أميركية».
 * - 11–99 at the end take the accusative singular: «خمسون دولاراً أميركياً».
 * - A count ending on a round hundred, or on 01 or 02 after one, takes the
 *   genitive singular: «مائة دولار أميركي»، «ألف دولار أميركي».
 */
interface NounForms {
  one: string;
  two: string;
  plural: string;
  accusative: string;
  genitive: string;
}

const DOLLAR: NounForms = {
  one: 'دولار أميركي واحد',
  two: 'دولاران أميركيان',
  plural: 'دولارات أميركية',
  accusative: 'دولاراً أميركياً',
  genitive: 'دولار أميركي',
};

const CENT: NounForms = {
  one: 'سنت واحد',
  two: 'سنتان',
  plural: 'سنتات',
  accusative: 'سنتاً',
  genitive: 'سنت',
};

function countNoun(count: number, forms: NounForms): string {
  if (count === 1) return forms.one;
  if (count === 2) return forms.two;
  if (count <= 10) return `${ONES_MASCULINE[count]!} ${forms.plural}`;

  const last = count % 100;
  if (last >= 3 && last <= 10) return `${integerWords(count)} ${forms.plural}`;
  if (last >= 11) return `${integerWords(count)} ${forms.accusative}`;
  return `${integerWords(count)} ${forms.genitive}`;
}

/**
 * The amount on a voucher, written out in its own currency — the line under
 * the figure on «أمر الصرف» and «سند القبض».
 *
 * ليرة is whole pounds and reads exactly as `tafqeet` writes it, so a voucher
 * and a citizen's وصل never spell the same sum two ways. A dollar amount keeps
 * its cents, named after the dollars: «مائة وخمسون دولاراً أميركياً وخمسة
 * وعشرون سنتاً فقط لا غير». Null for a currency this module has no words
 * for: printing a pound's words under a figure in another currency would be
 * the one wrong answer on a document where the words are the operative figure.
 *
 * Null too for a ليرة amount with a fraction. The screens take whole pounds,
 * but the API takes two decimals in any currency, and `tafqeet` drops a
 * fraction: LBP 1,500.5 would print words for 1,500 under a figure of 1,500.5.
 * No words is the honest answer there; words that disagree with the figure are
 * not.
 */
export function tafqeetAmount(amount: number, currency: string): string | null {
  if (currency === 'LBP') return Math.round(Math.abs(amount) * 100) % 100 === 0 ? tafqeet(amount) : null;
  if (currency !== 'USD') return null;

  const totalCents = Math.round(Math.abs(amount) * 100);
  const dollars = Math.floor(totalCents / 100);
  const cents = totalCents % 100;

  if (dollars === 0 && cents === 0) return `صفر ${DOLLAR.genitive} فقط لا غير`;

  const parts: string[] = [];
  if (dollars > 0) parts.push(countNoun(dollars, DOLLAR));
  if (cents > 0) parts.push(countNoun(cents, CENT));
  return `${parts.join(' و')} فقط لا غير`;
}

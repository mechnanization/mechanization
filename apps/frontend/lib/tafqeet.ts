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

/** Converts a 1-999 chunk into Arabic words. */
function convertThreeDigits(num: number, feminine = false): string {
  if (num === 0) return '';

  const parts: string[] = [];
  const hundred = Math.floor(num / 100);
  const remainder = num % 100;

  if (hundred > 0) {
    parts.push(HUNDREDS[hundred]!);
  }

  if (remainder > 0) {
    if (remainder < 20) {
      parts.push(feminine ? ONES_FEMININE[remainder]! : ONES_MASCULINE[remainder]!);
    } else {
      const unit = remainder % 10;
      const ten = Math.floor(remainder / 10);

      if (unit > 0) {
        const unitWord = feminine ? ONES_FEMININE[unit]! : ONES_MASCULINE[unit]!;
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
  /** 3–10, and counts ending in 3–10 — the plural of paucity. */
  plural: string;
  /** Counts ending in 11–99 — the accusative تمييز. */
  accusative: string;
}

const THOUSAND: ScaleForms = {
  singular: 'ألف',
  dual: 'ألفان',
  plural: 'آلاف',
  accusative: 'ألفاً',
};

const MILLION: ScaleForms = {
  singular: 'مليون',
  dual: 'مليونان',
  plural: 'ملايين',
  accusative: 'مليوناً',
};

const BILLION: ScaleForms = {
  singular: 'مليار',
  dual: 'ملياران',
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
function writeScale(count: number, forms: ScaleForms): string {
  if (count === 1) return forms.singular;
  if (count === 2) return forms.dual;
  if (count <= 10) return `${ONES_MASCULINE[count]!} ${forms.plural}`;

  const words = convertThreeDigits(count, false);
  // The last two digits are what carries the agreement: 0 means the number
  // ended on a hundred, 3–10 keeps the paucity plural, everything else in
  // 11–99 takes the accusative.
  const last = count % 100;

  if (last === 0) return `${words} ${forms.singular}`;
  if (last >= 3 && last <= 10) return `${words} ${forms.plural}`;
  return `${words} ${forms.accusative}`;
}

/**
 * Converts any non-negative integer into Arabic words with the currency unit and "فقط لا غير".
 *
 * @param amount - Non-negative integer (in LBP)
 * @param currency - Optional currency suffix, defaults to 'ليرة لبنانية'
 */
export function tafqeet(amount: number, currency = 'ليرة لبنانية'): string {
  const integerPart = Math.floor(Math.abs(amount));

  if (integerPart === 0) {
    return `صفر ${currency} فقط لا غير`;
  }

  const billions = Math.floor(integerPart / 1_000_000_000);
  const millions = Math.floor((integerPart % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((integerPart % 1_000_000) / 1_000);
  const remainder = integerPart % 1_000;

  const chunks: string[] = [];

  // Each scale is مذكر, and each picks its form the same way — see `writeScale`.
  if (billions > 0) chunks.push(writeScale(billions, BILLION));
  if (millions > 0) chunks.push(writeScale(millions, MILLION));
  if (thousands > 0) chunks.push(writeScale(thousands, THOUSAND));

  // Remainder (0-999)
  if (remainder > 0) {
    if (chunks.length === 0 && remainder === 1) {
      return `ليرة واحدة لبنانية فقط لا غير`;
    } else if (chunks.length === 0 && remainder === 2) {
      return `ليرتان لبنانيتان فقط لا غير`;
    } else if (chunks.length === 0 && remainder >= 3 && remainder <= 10) {
      return `${ONES_FEMININE[remainder]} ليرات لبنانية فقط لا غير`;
    } else {
      chunks.push(convertThreeDigits(remainder, false));
    }
  }

  const words = chunks.join(' و');
  return `${words} ${currency} فقط لا غير`;
}

import { z } from 'zod';
import { typeError } from './type-error';

/** Converts Eastern Arabic / Arabic-Indic digits to ASCII standard digits. */
export function normalizeDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776));
}

/**
 * `normalizeDigits` in SQL: `translate(x, EASTERN_DIGITS, LATIN_DIGITS)` maps
 * each Arabic-Indic and Persian digit to the Latin digit at the same position.
 * Bind both as parameters; change them together with the function above.
 */
export const EASTERN_DIGITS = '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
export const LATIN_DIGITS = '01234567890123456789';

/** Lebanese mobile numbers: +961 3/70/71/76/78/79/81 XXXXXX, stored E.164. */
export const lebanesePhone = z
  .string(typeError({ required: 'رقم الهاتف مطلوب' }))
  .trim()
  .transform((v) => normalizeDigits(v).replace(/[\s-]/g, ''))
  .pipe(
    z
      .string()
      .regex(/^(\+961|00961|0)?(3|7[0-9]|8[1])\d{6}$/, 'رقم الهاتف غير صالح'),
  )
  .transform((v) => {
    const digits = v.replace(/^(\+961|00961|0)/, '');
    return `+961${digits}`;
  });

/**
 * A mobile number from anywhere, with Lebanon as the unstated default.
 *
 * ## Why this is not just a looser `lebanesePhone`
 *
 * The register holds people the municipality has to be able to reach, and not
 * all of them are on a Lebanese network: an owner in Abidjan or Sydney whose
 * flat is let here, a landlord a شاغل بتسامح can name but whose only number is
 * a foreign one, a returning family still carrying the number they lived on.
 * `lebanesePhone` refused all of them, and a required field that refuses the
 * true answer does not collect a better one — it collects an invented one, or
 * an «غير مؤكَّد» flag on every such record until the flag stops meaning
 * anything.
 *
 * ## Lebanon stays the default, and that is the whole ergonomic point
 *
 * A bare `71123456` is Lebanese, exactly as it has always been. Nobody typing
 * an ordinary local number types a country code, and asking them to would slow
 * down every registration in the municipality to accommodate the rare one.
 * International is opt-in, marked by the `+` or `00` the person writing it
 * already knows to use.
 *
 * ## What it stores
 *
 * E.164 with a leading `+`, the same as before, so `@@index([kind, phone])`,
 * the `searchText` generated column and every existing row keep working
 * untouched. A Lebanese number normalises to `+961…` exactly as it used to —
 * this widens what is accepted, it does not change what is stored for anything
 * that was already accepted.
 *
 * ## The limits are E.164's own
 *
 * 8 to 15 digits after the `+`. The upper bound is the standard's; the lower
 * rejects a half-typed number without pretending to know how short a valid
 * subscriber number is in a country this codebase has never heard of. There is
 * deliberately no per-country validation table: one would be wrong within a
 * year, and wrong in the direction of refusing a real person's real number.
 */
export const internationalPhone = z
  // Both messages Arabic: a wrong type reached the screen as Zod's English default.
  .string(typeError({ required: 'رقم الهاتف مطلوب', invalid: 'رقم الهاتف غير صالح' }))
  .trim()
  .transform((v) => normalizeDigits(v).replace(/[\s\-().]/g, ''))
  .superRefine((v, ctx) => {
    const invalid = () =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'رقم الهاتف غير صالح' });

    // Explicitly international: the writer said so with a + or 00.
    if (v.startsWith('+') || v.startsWith('00')) {
      const digits = v.replace(/^(\+|00)/, '');
      if (!/^\d{8,15}$/.test(digits)) invalid();
      return;
    }

    /*
      No country code, so it is local — and local means Lebanese, which is the
      one country this register can validate properly. Same rule as
      `lebanesePhone`, kept deliberately strict: a mistyped Lebanese number is
      the commonest error on this form by a wide margin, and loosening the
      local branch to "any 8-15 digits" would stop catching it.
    */
    if (!/^0?(3|7[0-9]|8[1])\d{6}$/.test(v)) invalid();
  })
  .transform((v) => {
    if (v.startsWith('+') || v.startsWith('00')) return `+${v.replace(/^(\+|00)/, '')}`;
    return `+961${v.replace(/^0/, '')}`;
  });

/**
 * A phone number that may simply not be there — an empty box read as absent.
 *
 * `internationalPhone.optional().or(z.literal(''))` is the obvious spelling
 * and the wrong one: when the number is malformed every branch of that union
 * fails, and Zod reports the *union's* failure as «Invalid input» — English,
 * on a form that is Arabic-first, for the commonest typo there is. A
 * preprocessor instead means there is only ever one branch, so a bad number
 * keeps `internationalPhone`'s own «رقم الهاتف غير صالح».
 *
 * An empty string becomes `undefined` rather than surviving as `''`: a blank
 * box is an unanswered question, and `''` is a value — one that satisfies
 * `IS NOT NULL` and matches every other blank record if it reaches a column.
 * Required-ness is then the caller's to add, which is what lets «لا يملك رقم
 * هاتف» waive it (`contactDetailsSchema`).
 */
export const optionalInternationalPhone = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  internationalPhone.optional(),
);

export const arabicOrLatinName = z
  .string(typeError({ required: 'الاسم مطلوب' }))
  .trim()
  .min(2, 'الاسم قصير جداً')
  .max(60, 'الاسم طويل جداً')
  .regex(/^[\u0600-\u06FFa-zA-Z\s'-]+$/u, 'الاسم يحتوي على رموز غير مسموحة');

export const documentNumber = z
  .string(typeError({ required: 'رقم الوثيقة مطلوب' }))
  .trim()
  .min(3, 'رقم الوثيقة قصير جداً')
  .max(40, 'رقم الوثيقة طويل جداً');

/**
 * رقم السجل — Lebanese civil register numbers are frequently 1–3 digits, so the
 * generic `documentNumber` minimum would wrongly reject valid records.
 */
export const civilRecordNumber = z
  .string(typeError({ required: 'رقم السجل مطلوب' }))
  .trim()
  .min(1, 'رقم السجل مطلوب')
  .max(20, 'رقم السجل طويل جداً')
  .regex(/^[0-9\u0660-\u0669]+$/u, 'رقم السجل يجب أن يحتوي أرقاماً فقط');

/** Municipality slug used for tenant resolution in the URL path. */
export const tenantSlug = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(50)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Invalid municipality slug');

/**
 * Any 8-4-4-4-12 hex id. `guid`, not zod 4's `uuid`, which also checks the
 * version and variant digits: zod 3's `uuid` never did, and every id this
 * accepted before the zod 4 upgrade must still be accepted after it.
 */
export const uuid = z.string().guid();

/**
 * A real calendar day as `YYYY-MM-DD`: «2026-02-30» or «2026-10-00» is refused,
 * not rolled into the next month. The pattern alone let both through — `Date`
 * reads «2026-09-31» as 1 October — so a back-dated document was stored on a day
 * nobody typed, or reached the server as an Invalid Date and answered with a 500.
 */
export function isCalendarDay(day: string): boolean {
  const parsed = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === day;
}

/**
 * A day on the municipality's own calendar, `YYYY-MM-DD` — what every treasury
 * form and register sends for a date: a voucher's or a transfer's day, a count's,
 * a register's `from` and `to`. One schema for all of them, so none checks only
 * the pattern (the transfer's did, until the review of 2026-10-11).
 */
export const businessDay = z
  .string(typeError({ required: 'اختر التاريخ' }))
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ غير صالح')
  .refine(isCalendarDay, 'تاريخ غير صالح');

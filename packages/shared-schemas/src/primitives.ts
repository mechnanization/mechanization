import { z } from 'zod';

/** Converts Eastern Arabic / Arabic-Indic digits to ASCII standard digits. */
export function normalizeDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776));
}

/** Lebanese mobile numbers: +961 3/70/71/76/78/79/81 XXXXXX, stored E.164. */
export const lebanesePhone = z
  .string({ required_error: 'رقم الهاتف مطلوب' })
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
  .string({ required_error: 'رقم الهاتف مطلوب' })
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

export const arabicOrLatinName = z
  .string({ required_error: 'الاسم مطلوب' })
  .trim()
  .min(2, 'الاسم قصير جداً')
  .max(60, 'الاسم طويل جداً')
  .regex(/^[\u0600-\u06FFa-zA-Z\s'-]+$/u, 'الاسم يحتوي على رموز غير مسموحة');

export const documentNumber = z
  .string({ required_error: 'رقم الوثيقة مطلوب' })
  .trim()
  .min(3, 'رقم الوثيقة قصير جداً')
  .max(40, 'رقم الوثيقة طويل جداً');

/**
 * رقم السجل — Lebanese civil register numbers are frequently 1–3 digits, so the
 * generic `documentNumber` minimum would wrongly reject valid records.
 */
export const civilRecordNumber = z
  .string({ required_error: 'رقم السجل مطلوب' })
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

export const uuid = z.string().uuid();

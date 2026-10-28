import { z } from 'zod';
import { typeError } from './type-error';

/**
 * At most two decimals, judged on the number's own decimal form.
 *
 * Not `value * 100` against its rounding: that is float arithmetic, and from
 * 2^27 (about 134 million) on it refused valid two-decimal figures, while it
 * let `1e-9` through, which a DECIMAL(14,2) column then rounds to 0.00 and its
 * CHECK refuses with a server error. `String(value)` is the shortest form that
 * reads back as the same number, so a figure typed with two decimals prints
 * with at most two, and float noise or a third decimal prints with more (or in
 * exponent form, which the pattern refuses as well).
 */
export function hasAtMostTwoDecimals(value: number): boolean {
  return /^-?\d+(\.\d{1,2})?$/.test(String(value));
}

/**
 * An amount paid out: greater than zero, at most two decimals, and no more than
 * `max`, the most the column it is stored in holds.
 *
 * The bound is the column's, never a policy: past it the database refuses the
 * figure as a numeric overflow, which reaches the client as a server error. And
 * a third decimal is refused rather than rounded by the column, because the
 * request's figure is the one written into the audit row: «صرف عمولة» once
 * booked 12.345 in its Tier 1 rows and paid 12.35 (review of 2026-10-11).
 */
export function positiveMoneyAmount(max: number) {
  return z
    .number(typeError({ required: 'اكتب المبلغ', invalid: 'المبلغ رقم' }))
    .finite('المبلغ رقم')
    .positive('المبلغ أكبر من صفر')
    .max(max, 'المبلغ كبير جداً')
    .refine(hasAtMostTwoDecimals, 'خانتان عشريتان على الأكثر');
}

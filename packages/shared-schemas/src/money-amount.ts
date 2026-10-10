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

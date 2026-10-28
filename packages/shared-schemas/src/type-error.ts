/**
 * zod 3's `required_error` and `invalid_type_error`, which zod 4 folds into a
 * single `error` option: the first message for a value that is missing, the
 * second for a value of the wrong type, and zod's own for every other issue —
 * an enum value off the list, a string too short — exactly as zod 3 did.
 *
 *   z.string(typeError({ required: 'الاسم مطلوب' }))
 *   z.number(typeError({ required: 'اكتب المبلغ', invalid: 'المبلغ رقم' }))
 *
 * Kept out of `primitives.ts` so `enums.ts` and every schema can import it
 * without a cycle.
 */
export function typeError(messages: { required?: string; invalid?: string }): {
  error: (issue: { code?: string; input?: unknown }) => string | undefined;
} {
  return {
    error: (issue) =>
      issue.code === 'invalid_type'
        ? issue.input === undefined
          ? messages.required
          : messages.invalid
        : undefined,
  };
}

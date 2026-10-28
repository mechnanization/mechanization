import { z } from 'zod';

/**
 * `.partial()` as zod 3 read it: a key the input leaves out stays out.
 *
 * zod 4 applies a field's `.default()` even when the field is optional, so a
 * plain `.partial()` fills in every default for a key the input never sent —
 * `hasNoPhone: false`, `whatsappSameAsPhone: true`, `sharedRights: []` — and
 * whatever reads the result as "what the caller changed" overwrites the stored
 * value with it. This unwraps each default before making the field optional.
 * `zod4-optional-defaults.spec.ts` (backend) fails if any exported schema holds
 * an `optional` around a `default` again.
 */
export function partialKeepingAbsent<T extends z.ZodObject>(schema: T): ReturnType<T['partial']> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
    shape[key] = z.optional(field instanceof z.ZodDefault ? field.unwrap() : field);
  }
  return schema.extend(shape) as unknown as ReturnType<T['partial']>;
}

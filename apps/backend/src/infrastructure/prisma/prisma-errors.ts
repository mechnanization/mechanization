/**
 * The one place a Prisma error code is matched. Above this file nothing spells
 * `P2002` or `P2034`; callers ask a question in words instead.
 *
 * Every predicate here matches structurally on `code` and `meta`, never with
 * `instanceof`: the registry and tenant clients generate separate error
 * classes, and an `instanceof` against one is silently false for an error the
 * other threw (see `isTransientConnectionError`, which made the same choice).
 */

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as { code?: unknown }).code;
}

/** Prisma's unique violation (`P2002`), on any column or index. */
export function isUniqueViolation(error: unknown): boolean {
  return errorCode(error) === 'P2002';
}

/**
 * Whether `error` is Prisma's unique violation (`P2002`) on `field`.
 *
 * `meta.target` is the field list on a model write and the constraint name on
 * some others, so both shapes are read: an array must hold `field`, a string
 * must contain it.
 *
 * Used where two presses carrying one retry key race past their first read:
 * the loser's insert hits the unique index, and the caller answers it from the
 * winner's row instead of as a server error.
 */
export function isUniqueViolationOn(error: unknown, field: string): boolean {
  if (!isUniqueViolation(error)) return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  return typeof target === 'string' && target.includes(field);
}

/**
 * Prisma's foreign-key violation (`P2003`): the constraint it names
 * (`meta.field_name`, e.g. `property_entries_buildingId_fkey (index)`), or
 * `null` when `error` is anything else. A violation that names nothing answers
 * `''`, so a caller can still tell it from no violation at all.
 */
export function foreignKeyViolated(error: unknown): string | null {
  if (errorCode(error) !== 'P2003') return null;
  const field = (error as { meta?: { field_name?: unknown } }).meta?.field_name;
  return typeof field === 'string' ? field : '';
}

/**
 * Prisma's `P2034`: the transaction failed on a write conflict or a deadlock,
 * and rolled back whole. Somebody else is writing the same rows right now; the
 * caller says so in words a person can act on, or tries again.
 */
export function isSerializationFailure(error: unknown): boolean {
  return errorCode(error) === 'P2034';
}

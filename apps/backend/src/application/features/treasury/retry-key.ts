/**
 * Whether `error` is Prisma's unique violation (`P2002`) on `field`.
 *
 * Matched structurally on `code` and `meta.target`, never with `instanceof`:
 * the registry and tenant clients generate separate error classes (see
 * `ExpensesService.writeCategory`). `meta.target` is the field list on a model
 * write and the constraint name on some others, so both shapes are read.
 *
 * Used where two presses carrying one retry key race past their first read:
 * the loser's insert hits the unique index, and the caller answers it from the
 * winner's row instead of as a server error.
 */
export function isUniqueViolationOn(error: unknown, field: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, meta } = error as { code?: unknown; meta?: { target?: unknown } };
  if (code !== 'P2002') return false;
  const target = meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  return typeof target === 'string' && target.includes(field);
}

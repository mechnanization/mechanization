/**
 * One CSV cell, quoted, and safe to open in a spreadsheet.
 *
 * A value starting with `=`, `+`, `-` or `@` is run as a formula by Excel the
 * moment a clerk opens the file, and a leading tab or carriage return lets one
 * through as well. Every export carries text somebody typed into this system
 * (a citizen's name, a building name, an officer's note), so such a value is
 * prefixed with `'`, which tells the spreadsheet to read the rest as text.
 *
 * Always quoted, with `"` doubled: the two halves are not separable, since a
 * leading `'` only means "treat the rest as text" inside a quoted field. The
 * server's citizen export and every CSV the portal builds use this one
 * function; its spec is `apps/backend/src/application/common/csv-cell.spec.ts`
 * (this package has no test runner).
 */
export function csvCell(value: unknown): string {
  const text = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

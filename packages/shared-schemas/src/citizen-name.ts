/**
 * How a citizen record is named on a screen, a bill or a receipt.
 *
 * The three name parts, joined — except for an estate (migration 0076), which
 * is the deceased owner's own file kept under his name and shown as «ورثة
 * المرحوم …»: the heirs are who owes, and a bill addressed to a dead man is one
 * nobody can pay (the user's decision, 2026-10-07). Derived rather than stored,
 * so the name stays his name for search, for duplicate checks and for the day
 * the estate is partitioned.
 *
 * An institution's name is stored across the parts (first word, rest) and
 * joins back to itself.
 */
export interface NamedRecord {
  firstName: string | null;
  middleName?: string | null;
  lastName: string | null;
  residence?: string | null;
}

export function citizenDisplayName(
  person: NamedRecord,
  options: { locale?: string; middleName?: boolean } = {},
): string {
  const parts = [person.firstName, options.middleName === false ? null : person.middleName, person.lastName];
  const name = parts.filter((part): part is string => Boolean(part && part.trim())).join(' ');
  // No name yet (a form still being filled) is no name, not «ورثة المرحوم» alone.
  if (person.residence === 'ESTATE' && name) {
    return options.locale === 'en' ? `Heirs of the late ${name}` : `ورثة المرحوم ${name}`;
  }
  return name;
}

/**
 * An institution's name as the form takes it — one line — split into the parts
 * the register stores, so every place that joins first and last reads it whole.
 */
export function splitInstitutionName(name: string): { firstName: string; middleName: null; lastName: string } {
  const words = name.trim().split(/\s+/);
  return { firstName: words[0] ?? '', middleName: null, lastName: words.slice(1).join(' ') };
}

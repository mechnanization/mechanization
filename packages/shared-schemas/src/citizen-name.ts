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

/**
 * The name as the row holds it — never with «ورثة المرحوم». For writing a
 * citizen's name into another row (a tenancy card's owner name): the prefix
 * is how an estate is shown, and stored text keeps no record of the kind it
 * was copied under, so a file corrected back to a person would leave it wrong.
 */
export function citizenStoredName(person: NamedRecord): string {
  return [person.firstName, person.middleName, person.lastName]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' ');
}

/**
 * «ورثة المرحوم …» as somebody typed it, read as the name it carries — so a
 * tenant who writes the owner the way the register shows an estate still
 * matches the deceased's own name. `ESTATE_PREFIX_PATTERN` is the same rule in
 * POSIX form for the SQL twin of the match.
 */
export const ESTATE_PREFIX_PATTERN = '^[[:space:]]*ورثة[[:space:]]+((ال)?مرحوم(ة)?|المغفور[[:space:]]+لها?)?[[:space:]]*';
const ESTATE_PREFIX = /^\s*ورثة\s+(?:(?:ال)?مرحومة?|المغفور\s+لها?)?\s*/u;

export function withoutEstatePrefix(name: string): string {
  return name.replace(ESTATE_PREFIX, '');
}

/**
 * The owner's name as a tenancy card stores it (`property_entries.landlordName`).
 *
 * What a form sends can be a name it was *shown*: the owner lookup and the unit
 * matrix answer with `citizenDisplayName`, and «نعم، هو المالك» and the
 * sole-owner prefill copy that into the card. So «ورثة المرحوم» comes off here,
 * at the write, for every client — a queued offline save included. Given the
 * owner the card is linked to, a name that is that owner's shown form (with or
 * without the middle name) is stored as `citizenStoredName(owner)`. Anything
 * else is what the tenant said, kept.
 */
export function storedLandlordName(
  submitted: string | null | undefined,
  owner?: NamedRecord | null,
): string | null {
  const typed = submitted?.trim().replace(/\s+/g, ' ');
  if (!typed) return null;
  // A name that is nothing but the prefix has no name in it to keep.
  const name = withoutEstatePrefix(typed).trim() || typed;
  if (owner) {
    // Compared without the prefix, so a name already stripped once (the entity does) still matches.
    const shown = [citizenDisplayName(owner), citizenDisplayName(owner, { middleName: false })].map((form) =>
      withoutEstatePrefix(form).trim(),
    );
    const stored = citizenStoredName(owner);
    if (stored && shown.includes(name)) return stored;
  }
  return name;
}

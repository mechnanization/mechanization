import { internationalPhone } from '@mechanization/shared-schemas';

/**
 * The contact section's correction rules, kept pure so they are tested — the
 * form (`citizen-form.tsx`) and the duplicate question (`citizen-editor.tsx`)
 * call them. The values are the form's own: `CitizenFormValues['contact']`.
 */

type Contact = Record<string, unknown>;

const typed = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** A typed number as the schema stores it (E.164), or as typed when it is not a number yet. */
function stored(value: string): string {
  const parsed = internationalPhone.safeParse(value);
  return parsed.success ? parsed.data : value;
}

/** Whether two typed numbers are the same number — `03 123 456` and `+9613123456` are. */
export function samePhone(a: string, b: string): boolean {
  return stored(a.trim()) === stored(b.trim());
}

/**
 * «لا يملك رقم هاتف» carries the number already on the file into «رقم
 * للتواصل» instead of throwing it away.
 *
 * This is the whole point of the flag on an *existing* record. The file being
 * corrected holds a relative's number in `phone` — that is why it is being
 * corrected — and that number is the one thing in the record worth keeping: it
 * is how the municipality reaches this person. Clearing the box without moving
 * it would lose it, and losing it is what makes an officer type it back into
 * `phone` next visit.
 *
 * Only ever on the tick, only from a number that is there, and never over a
 * «رقم للتواصل» that already holds something — an officer who has already
 * named the relative has said more than this rule knows. Unticking does not
 * move it back: by then nobody can tell whose number it is any more, and
 * guessing would put a relative's number back in the identity field.
 */
export function carryHeldPhone<T extends Contact>(before: Contact, next: T): T {
  const held = typed(before.phone);
  const named = typed(next.contactPhone);
  const justFlagged = next.hasNoPhone === true && before.hasNoPhone !== true;
  return justFlagged && held && !named ? { ...next, contactPhone: held } : next;
}

/**
 * Whether the file already names a relative's number that is not the typed
 * phone. Then «رقم أحد أقاربه» is no answer to a phone found on another file:
 * there is one «رقم للتواصل», and saying the typed number is a relative's would
 * have to drop the one the officer recorded.
 */
export function namesAnotherRelative(contact: Contact): boolean {
  const named = typed(contact.contactPhone);
  if (!named) return false;
  const phone = typed(contact.phone);
  return !phone || !samePhone(named, phone);
}

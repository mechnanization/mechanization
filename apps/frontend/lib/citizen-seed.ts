import { normalizeDigits, type CitizenResidence } from '@mechanization/shared-schemas';
import type { CitizenFormValues } from '@/components/admin/citizen-form';
import { namesForKind } from './residence-move';

/**
 * Switching نوع الملف, as a value rather than a state update.
 *
 * Nothing typed is thrown away — a clerk who picks the wrong kind and back
 * again gets their answers back, cards included.
 *
 * It used to turn every card into «مالك» on the way to a non-resident record,
 * when that record held owners only. It now also holds a person who rents or
 * runs a shop, an office, a clinic, a warehouse or a plot here while living
 * elsewhere, so a tenant's card is left exactly as it was: whether a card fits
 * a non-resident is the schema's question (`nonResidentCardIssues`), and it is
 * answered on the field that has to change rather than by silently rewriting
 * what the officer entered.
 *
 * Pure so the two ways a record becomes non-resident agree: the chooser at the
 * top of the form, and a unit link that arrives already carrying
 * `?residence=NON_RESIDENT_OWNER` on `citizens/new`.
 */
export function withResidence(
  values: CitizenFormValues,
  residence: CitizenResidence,
): CitizenFormValues {
  const from = values.residence ?? 'RESIDENT';
  if (from === residence) return values;
  // An institution's name is one line, a person's three boxes (`namesForKind`).
  const names = namesForKind(values.personal, from, residence, values.namesBefore);
  return { ...values, residence, personal: names.personal, namesBefore: names.before };
}

/**
 * The phone number a search term holds, or null when it does not hold one.
 *
 * The unit panel's box searches by name, phone and رقم القيد alike, and in the
 * field the phone is usually what gets typed first — it is the one thing a
 * household reads out without hesitating. So a term is a phone when it is
 * nothing but digits, with an optional leading `+`, once the separators people
 * dictate numbers with are taken out: `03 123 456`, `70-123456`, `(+33) 6 12
 * 34 56 78`, `٠٠٣٣٦١٢٣٤٥٦٧٨`.
 *
 * ## Where a digit run is not a phone
 *
 * Fewer than seven digits and no `+`. Seven is the shortest number this
 * register accepts at all (`3 123456`, Lebanon's 03 without its zero); below it
 * the term is a رقم السجل, which runs to one to three digits, or a number the
 * officer stopped typing halfway. Either one in الهاتف is a wrong answer
 * sitting in a required field, so it seeds nothing. A `+` settles it at any
 * length: nobody writes one in front of anything but a phone.
 *
 * ## What it returns
 *
 * The digits in Latin with the separators gone, and the `+` or `00` kept as
 * typed. It is deliberately *not* validated against `internationalPhone`: a
 * foreign number typed without its `+` is still that person's number, and the
 * phone field's own error and hint («ابدأ بـ + ثم رمز الدولة») are where that
 * gets fixed — not a blank field and a retype.
 */
export function phoneFromSearchTerm(term: string): string | null {
  const compact = normalizeDigits(term.trim()).replace(/[\s\-()./]/g, '');
  if (!/^\+?\d+$/.test(compact)) return null;
  return compact.startsWith('+') || compact.length >= 7 ? compact : null;
}

/**
 * Seeds the form from whatever the officer had typed into the search that sent
 * them here: the phone field when it is a number, the name block otherwise.
 *
 * The unit panel's «ملف جديد» links carry their search term across, so a
 * search that found nobody is not retyped into the form immediately after. It
 * also gives the duplicate check something to check on the first render —
 * against the phone, which is the stronger of the two things it matches on,
 * whenever the officer searched by one.
 *
 * ## What it refuses to seed
 *
 * Into the name, a term holding a digit. «03 123456» split across الاسم الأول
 * and الشهرة is worse than an empty form — it is a name nobody will read
 * closely before saving, and `arabicOrLatinName` would reject it at the point
 * where the officer has stopped looking at it. A term that is neither a name
 * nor a phone — a رقم السجل, a reference number — seeds nothing at all.
 *
 * ## How a name splits
 *
 * A single word is a first name. Two are الاسم الأول and الشهرة, because that
 * is how a person is addressed and therefore how they are searched for. Three
 * or more fill اسم الأب with everything in between, which is the one reading
 * that never loses a word the officer typed. None of it is authoritative — it
 * is a first draft of three fields the officer is looking straight at.
 */
export function withSeededSearch(
  values: CitizenFormValues,
  term: string,
  /** The kind the form is opening as — the caller applies it after (`withResidence`). */
  kind: CitizenResidence = values.residence ?? 'RESIDENT',
): CitizenFormValues {
  const phone = phoneFromSearchTerm(term);
  if (phone) return { ...values, contact: { ...values.contact, phone } };

  const trimmed = term.trim();
  // An institution's name is one line, digits and all («مدرسة رسمية 2»): kept whole (0076).
  if (trimmed && kind === 'INSTITUTION') {
    return { ...values, personal: { ...values.personal, firstName: trimmed } };
  }
  // Arabic-Indic and Extended digits alongside the Latin ones: an Arabic
  // keyboard produces «٠٣» by default, and a phone typed that way is no more a
  // name than «03» is.
  if (!trimmed || /[\d٠-٩۰-۹]/u.test(trimmed)) return values;

  const parts = trimmed.split(/\s+/);
  const [firstName, ...rest] = parts;
  const lastName = rest.length > 0 ? rest[rest.length - 1] : undefined;
  const middleName = rest.length > 1 ? rest.slice(0, -1).join(' ') : undefined;

  return {
    ...values,
    personal: {
      ...values.personal,
      firstName,
      ...(middleName ? { middleName } : {}),
      ...(lastName ? { lastName } : {}),
    },
  };
}

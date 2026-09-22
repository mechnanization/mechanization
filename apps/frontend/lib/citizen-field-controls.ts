import {
  BUILDING_UNIT_FIELDS,
  GENDER,
  LAND_TYPE,
  MARITAL_STATUS,
  PROPERTY_FIELD_MAP,
  RESIDENT_STATUS,
  UNIT_STATUS,
  getLabels,
} from '@mechanization/shared-schemas';
import { BUILDING_UNIT_TYPES } from '@/components/citizen/unit-fields';

/**
 * What kind of input one citizen field wants, keyed by its leaf name.
 *
 * ## Why this exists at all
 *
 * «استكمال البيانات الناقصة» renders a handful of fields pulled out of three
 * different sections of a four-step form and shown together, in the order the
 * gaps happen to be in. It cannot reuse `PersonalStep` or `PropertyCard` to do
 * that — those render whole sections, with their branches, their headings and
 * their layout — so something has to say that «الجنس» is a choice of two and
 * «المساحة» is a number.
 *
 * ## Why it is safe to be a second list
 *
 * Because it is a second list of *one* fact — which control a field takes —
 * and not a second copy of the form's rules. Everything that could actually go
 * wrong stays where it was:
 *
 *  - **which fields exist and are askable** is `askableFields` in
 *    `citizen-form.tsx`, still the only statement of the branches;
 *  - **what a value may be** is the shared Zod schemas, which validate this
 *    dialog's save exactly as they validate the form's — the dialog submits
 *    through `toSubmission` and `updateCitizen` like any other edit;
 *  - **what a field is called** is `labels.citizenField`, read here rather than
 *    restated.
 *
 * So the worst a mistake here can do is show a text box where a dropdown
 * belongs. It cannot admit a value the form would have refused.
 *
 * The one thing it *could* do quietly is fall behind — a field added to a
 * property branch, with no entry here, rendering as a text box for an enum, or
 * silently missing. `ControlledField` below is what refuses to let that happen:
 * the card and unit halves of it are *derived* from `PROPERTY_FIELD_MAP` and
 * `BUILDING_UNIT_FIELDS`, the same two constants the form branches on, so a new
 * branch field is a compile error in this file until it is given a control.
 * (This app has no test runner, so the check has to be the type system; it is
 * the technique `CardFieldIsShaped` already uses one layer down.)
 *
 * ## The `select` options are functions
 *
 * Not constants, because two of them depend on the locale for their labels and
 * one (`unitType`) is a list this app derives rather than an enum — see
 * `BUILDING_UNIT_TYPES`, which deliberately excludes «منزل مستقل» and every
 * structural type. Reading it here rather than reaching for `UNIT_TYPE` is what
 * keeps «طابق أعمدة» off this dialog too.
 */
export type FieldControl =
  | { kind: 'text' }
  /** Latin/Arabic digits, `dir="ltr"`, phone keypad on a handset. */
  | { kind: 'phone' }
  /** A quantity — area, shares, household size. Still submitted as a string. */
  | { kind: 'number' }
  /** A free-text list; the form renders chips, this renders one line. */
  | { kind: 'tags' }
  | { kind: 'select'; options: (locale: string) => Array<{ value: string; label: string }> };

const from = (
  values: readonly string[],
  map: (locale: string) => Record<string, string>,
): FieldControl => ({
  kind: 'select',
  options: (locale) => {
    const labels = map(locale);
    return values.map((value) => ({ value, label: labels[value] ?? value }));
  },
});

/** Every field a property card renders, straight from the form's own map. */
type CardField = (typeof PROPERTY_FIELD_MAP)[keyof typeof PROPERTY_FIELD_MAP][number];

/**
 * Every leaf name that can reach this dialog, and nothing else.
 *
 * The card and unit halves are derived, so they cannot fall behind the form.
 * Two of the card's fields are subtracted by name and both are deliberate:
 *
 *  - `units` is a whole array, not a value. A flag on it says «we never got
 *    into the building», which is answered by going through it on the card's
 *    own editor — the dialog lists it and offers no box.
 *  - `buildingName` is not flaggable at all (`askableFields` excludes it: it is
 *    optional on both structure branches, so it can never be the reason a
 *    record is incomplete).
 *
 * The personal and contact halves are written out, because they are written out
 * in `askableFields` too — there is no constant to derive them from, and
 * inventing one would put the form's branch rules in two places to save
 * repeating eleven names.
 *
 * Nothing from `NON_FLAGGABLE_FIELDS` appears: `occupancyType`, `propertyType`
 * and `isLebanese` are the discriminators every branch reads, no flag can
 * excuse them, and a control for one here would be this dialog offering to
 * change what the record fundamentally is.
 */
type ControlledField =
  | Exclude<CardField, 'units' | 'buildingName'>
  | (typeof BUILDING_UNIT_FIELDS)[number]
  // Gated on occupancy rather than property type, so absent from the map above.
  | 'landlordName'
  | 'landlordPhone'
  | 'firstName'
  | 'middleName'
  | 'lastName'
  | 'motherName'
  | 'gender'
  | 'residentStatus'
  | 'civilRecordNumber'
  | 'nationality'
  | 'identityDocNumber'
  | 'residencyNumber'
  | 'residencePlace'
  | 'phone'
  | 'whatsapp'
  | 'maritalStatus'
  | 'totalRegisteredMembers'
  | 'actualHouseholdMembers';

export const CITIZEN_FIELD_CONTROLS = {
  // ── personal ──
  firstName: { kind: 'text' },
  middleName: { kind: 'text' },
  lastName: { kind: 'text' },
  motherName: { kind: 'text' },
  gender: from(GENDER, (locale) => getLabels(locale).gender),
  residentStatus: from(RESIDENT_STATUS, (locale) => getLabels(locale).residentStatus),
  civilRecordNumber: { kind: 'text' },
  nationality: { kind: 'text' },
  identityDocNumber: { kind: 'text' },
  residencyNumber: { kind: 'text' },
  residencePlace: { kind: 'text' },

  // ── contact ──
  phone: { kind: 'phone' },
  whatsapp: { kind: 'phone' },
  maritalStatus: from(MARITAL_STATUS, (locale) => getLabels(locale).maritalStatus),
  totalRegisteredMembers: { kind: 'number' },
  actualHouseholdMembers: { kind: 'number' },

  // ── a property card ──
  neighborhood: { kind: 'text' },
  propertyNumber: { kind: 'text' },
  side: { kind: 'text' },
  unitArea: { kind: 'number' },
  shares: { kind: 'number' },
  sharedRights: { kind: 'tags' },
  landType: from(LAND_TYPE, (locale) => getLabels(locale).landType),
  tentLocation: { kind: 'text' },
  landlordName: { kind: 'text' },
  landlordPhone: { kind: 'phone' },

  // ── one unit inside a مبنى card ──
  /* `BUILDING_UNIT_TYPES`, never `UNIT_TYPE`: the narrower list is what a
     building can contain, and it is what keeps «منزل مستقل» and «طابق أعمدة»
     out of a dialog whose every field belongs to somebody's file. */
  unitType: from(BUILDING_UNIT_TYPES, (locale) => getLabels(locale).unitType),
  floor: { kind: 'text' },
  unitStatus: from(UNIT_STATUS, (locale) => getLabels(locale).unitStatus),
  /*
    `satisfies`, not an annotation, and that is the whole guarantee: it checks
    both directions. A `ControlledField` with no entry fails to compile, and so
    does an entry for a name that is not one — which is what would otherwise
    happen when a field is renamed and only one of the two places is updated.
  */
} satisfies Record<ControlledField, FieldControl>;

/**
 * The control for a dot-path's leaf, or `text` for anything unrecognised.
 *
 * The fallback is not a hole in the type checking above — it is for paths that
 * are not fields at all. `personal.possibleDuplicate` is a verdict about the
 * whole record and `properties.0.units` is an array; both reach this function
 * on their way to being rendered without a box, and neither should have to be
 * special-cased by every caller to avoid a crash.
 */
export function controlFor(path: string): FieldControl {
  const leaf = path.split('.').at(-1) ?? '';
  return (CITIZEN_FIELD_CONTROLS as Record<string, FieldControl | undefined>)[leaf] ?? {
    kind: 'text',
  };
}

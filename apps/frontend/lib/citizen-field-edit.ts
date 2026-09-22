import type { CitizenFormData, CitizenWriteInput } from './api-client';

/**
 * One corrected field on a citizen already on file, shaped for `PATCH /citizens/:id`.
 *
 * ## Why this exists
 *
 * «ملاحظات الجودة» can now correct the three fields a duplicate is decided on
 * without leaving the comparison — and the endpoint that takes a correction is
 * the same one the full edit form posts to. That endpoint replaces the
 * citizen's details *and reconciles the properties of their latest
 * registration*: a card missing from the payload is deleted, along with its
 * documents. So a one-field edit still has to send the whole record back,
 * exactly as it came.
 *
 * `GET /citizens/:id/form` returns it in the shape `PATCH` expects — that is
 * the endpoint's stated contract — but "the same shape" is not "safe to echo".
 * Four things in `CitizenForm`'s own `toSubmission` are corrections rather than
 * formatting, and each one is a save that fails, or a value that changes behind
 * the officer's back, if it is skipped here:
 *
 *  - **A null `unitArea` must be dropped, not sent.** `areaField` is
 *    `z.coerce.number().positive()`, and `Number(null)` is `0` — so echoing the
 *    null the census stores for an unmeasured flat fails the save on «المساحة
 *    يجب أن تكون أكبر من صفر», naming a field nobody touched.
 *  - **A Lebanese citizen's legacy identity document is left behind.** The form
 *    stopped collecting one in 2026-09; a stored number that no longer fits
 *    `documentNumber` would fail a save with no box to correct it in. An edit
 *    never writes what it is not sent, so leaving it out preserves it.
 *  - **`landlordLink` is what the form *shows*, never what it sends** — and on a
 *    linked tenancy whose own `landlordName` is empty, the linked owner's name
 *    is what satisfies the schema's "a tenant names an owner" rule.
 *  - **«غير مؤكَّد» flags and «ملاحظات» must travel.** Without the flags, a
 *    record filed with gaps is validated as though it had none and the save is
 *    refused; without the note, a save that replaces it silently deletes what
 *    the last visit wrote.
 *
 * Pure, and in `lib/` rather than beside the screen, so it is testable without a
 * DOM — see `citizen-field-edit.test.ts`, which is the actual guarantee that a
 * phone correction leaves a household's property cards exactly as they were.
 */

/** The fields «ملاحظات الجودة» may correct in place. */
export const CITIZEN_EDITABLE_FIELDS = [
  'firstName',
  'middleName',
  'lastName',
  'motherName',
  'phone',
] as const;

export type CitizenEditableField = (typeof CITIZEN_EDITABLE_FIELDS)[number];

/** Which section of the submission each field belongs to. */
const SECTION: Record<CitizenEditableField, 'personal' | 'contact'> = {
  firstName: 'personal',
  middleName: 'personal',
  lastName: 'personal',
  motherName: 'personal',
  phone: 'contact',
};

/**
 * What a «غير مقيم في البلدة» file is asked, and only that.
 *
 * Mirrors `submittedPersonal`/`submittedContact` in `citizen-form.tsx`: an owner
 * living elsewhere is not asked for a household, a mother's name or a marital
 * status, and sending those back would put fields the form never showed through
 * validation.
 */
const NON_RESIDENT_PERSONAL = ['firstName', 'middleName', 'lastName', 'residencePlace'] as const;
const NON_RESIDENT_CONTACT = [
  'phone',
  'whatsapp',
  'whatsappSameAsPhone',
  'localContactName',
  'localContactPhone',
] as const;

/** A field the form does not ask on this kind of file cannot be corrected on it. */
export function isEditableOn(form: CitizenFormData, field: CitizenEditableField): boolean {
  if (form.residence !== 'NON_RESIDENT_OWNER') return true;
  return field !== 'motherName';
}

const pick = (source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));

/** A number the wire will accept, or nothing at all. See the null-area note above. */
const numeric = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * One stored property card, back on the wire unchanged.
 *
 * Every identity it arrived with travels — `id`, `buildingId`, the units and
 * their `unitId`s — because each one is a row the server keeps by identity, and
 * a card that loses its `buildingId` loses the census link a colleague made
 * from the matrix.
 */
function toPayloadCard(card: Record<string, unknown>): Record<string, unknown> {
  const {
    id,
    buildingId,
    unitArea,
    shares,
    units,
    landlordLink,
    landlordAgreedName,
    pendingBuilding: _pending,
    ...rest
  } = card;

  const link = landlordLink as { name?: string } | null | undefined;
  const isNonOwner = rest.occupancyType === 'TENANT' || rest.occupancyType === 'FREE_OCCUPANT';
  const landlordName =
    isNonOwner && !text(rest.landlordName).trim()
      ? (link?.name ?? (landlordAgreedName as string | undefined) ?? rest.landlordName)
      : rest.landlordName;

  const area = numeric(unitArea);
  const shareCount = numeric(shares);

  return {
    ...(id ? { id } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...rest,
    ...(landlordName !== undefined ? { landlordName } : {}),
    ...(area !== undefined ? { unitArea: area } : {}),
    // أسهم describe a share of the land itself — never sent on a tenant's card.
    ...(shareCount !== undefined && rest.occupancyType === 'OWNER' ? { shares: shareCount } : {}),
    ...(Array.isArray(units) ? { units: units.map(toPayloadUnit) } : {}),
  };
}

function toPayloadUnit(unit: unknown): Record<string, unknown> {
  const row = (unit ?? {}) as Record<string, unknown>;
  const { id, unitId, unitArea, ...rest } = row;
  const area = numeric(unitArea);
  return {
    ...(id ? { id } : {}),
    ...(unitId ? { unitId } : {}),
    ...rest,
    ...(area !== undefined ? { unitArea: area } : {}),
  };
}

/**
 * The record as loaded, with the named fields corrected — nothing else moved.
 *
 * `expectedVersion` rides along whenever the form endpoint supplied one, so a
 * correction made from the comparison is refused if somebody changed the file
 * while it was open, exactly as it is from the edit form.
 */
export function citizenFieldPatch(
  form: CitizenFormData,
  edits: Partial<Record<CitizenEditableField, string>>,
): CitizenWriteInput {
  const nonResident = form.residence === 'NON_RESIDENT_OWNER';

  const personal: Record<string, unknown> = { ...form.personal };
  const contact: Record<string, unknown> = { ...form.contact };

  for (const [field, value] of Object.entries(edits) as Array<[CitizenEditableField, string]>) {
    if (value === undefined) continue;
    if (SECTION[field] === 'personal') personal[field] = value;
    else contact[field] = value;
  }

  /*
    `isLebanese` is nullable on a record filed before the column existed, and
    the form reads any non-`false` value as لبناني. Resolved here so what the
    screen compared and what the save sends are the same answer — left null, the
    save fails on a question this screen never asked.
  */
  const lebanese = personal.isLebanese !== false;

  const submittedPersonal = nonResident
    ? pick(personal, NON_RESIDENT_PERSONAL)
    : lebanese
      ? (() => {
          const {
            identityDocType: _type,
            identityDocNumber: _number,
            residencyNumber: _residency,
            ...rest
          } = personal;
          return { ...rest, isLebanese: true };
        })()
      : personal;

  const submittedContact = nonResident ? pick(contact, NON_RESIDENT_CONTACT) : contact;

  return {
    residence: form.residence ?? 'RESIDENT',
    personal: submittedPersonal,
    contact: submittedContact,
    properties: form.properties.map(toPayloadCard),
    flags: form.flags ?? [],
    ...(form.notes?.trim() ? { notes: form.notes.trim() } : {}),
    ...(form.version ? { expectedVersion: form.version } : {}),
  };
}

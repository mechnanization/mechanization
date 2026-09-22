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
 * Drops the nulls the register stores and the schemas will not take.
 *
 * `GET /citizens/:id/form` hands back the columns as Prisma holds them, and a
 * nullable column with no answer is `null`. Not one field on a property card
 * is `.nullable()` — every optional one is `.optional()`, which accepts
 * `undefined` and refuses `null` — so echoing the record back verbatim sends
 * a value the save rejects on a field nobody touched.
 *
 * `unitStatus` is the one that would have been hit first and hardest: a unit
 * nobody has marked is the common case (`property.schema.ts` says so — it is
 * billed by default), so a reviewer correcting a phone number on «ملاحظات
 * الجودة» would get «حالة الوحدة غير صالحة» back about a field the compare
 * screen does not even draw a box for. `neighborhood`, `side`, `buildingName`,
 * `landlordName`, `landlordPhone` and `tentLocation` are the same shape.
 *
 * Dropping rather than coercing is what preserves the record, by both of the
 * two routes the server takes. Most columns it sets with `?? null`, so absent
 * is written as null — the value that was already there. For `neighborhood`
 * and `propertyNumber` on a card, and `unitType`, `floor` and `unitArea` on a
 * unit, it passes the key straight through, so absent is Prisma's `undefined`
 * and the stored column is left alone — again the value that was already
 * there. Both answers preserve, because the null being dropped was read from
 * this same record moments earlier and `expectedVersion` refuses the save if
 * it moved. Coercing one to `''` or `0` would instead be this function
 * inventing an answer, which is the failure it exists to prevent.
 *
 * That equivalence is the precondition, not a property of the filter: build a
 * card from anything other than a fresh `GET /citizens/:id/form` of this
 * citizen and "leave alone" stops meaning "write back what was there".
 *
 * One level deep, everywhere it is applied — the card, the unit, and the
 * `personal`/`contact` sections. Nested `units` are handled by `toPayloadUnit`,
 * and nothing else on a card is an object whose nulls matter.
 */
const withoutNulls = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));

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
    ...withoutNulls(rest),
    ...(landlordName !== undefined && landlordName !== null ? { landlordName } : {}),
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
    ...withoutNulls(rest),
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

  /*
    The same null filter, on the other two sections.

    `getEditable` guards the string columns it returns — `motherName ?? ''`,
    `bloodType ?? ''` — and leaves nine others raw, every one of them nullable
    in `schema.prisma`: `gender`, `maritalStatus`, `whatsapp`,
    `identityDocType`, `residentStatus`, `nationality`, `phone` and the two
    household counts. Echo one of those back as `null` and the save is refused
    on a field «ملاحظات الجودة» does not draw a box for.

    `totalRegisteredMembers` is the one that would have been hit in practice,
    because it needs no «غير مؤكَّد» flag to be absent: it is `.optional()` and
    nullable, so a household whose قيد عائلي nobody recorded holds NULL and
    opens fine in the full form — `contactDetailsSchema`'s own transform fills
    it from `actualHouseholdMembers` when the key is absent, which is exactly
    what `toFormValues` does for the edit form. Dropping the null therefore
    hands the server the same answer the edit form would, rather than a value
    this function invented.

    Applied here rather than at the top so it runs over what is actually sent:
    `submittedPersonal` has already dropped a Lebanese file's legacy document
    fields and pinned `isLebanese`, and a non-resident file has already been
    narrowed to the questions its form asks.
  */
  return {
    residence: form.residence ?? 'RESIDENT',
    personal: withoutNulls(submittedPersonal),
    contact: withoutNulls(submittedContact),
    properties: form.properties.map(toPayloadCard),
    flags: form.flags ?? [],
    ...(form.notes?.trim() ? { notes: form.notes.trim() } : {}),
    ...(form.version ? { expectedVersion: form.version } : {}),
  };
}

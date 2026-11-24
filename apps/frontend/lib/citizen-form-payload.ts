import { isOwnerRecord } from '@mechanization/shared-schemas';
import type { CitizenFormValues, PropertyDraft, UnitDraft } from './citizen-form-values';
import { withoutUnusedWhatsapp } from './citizen-contact';
import { landlordNameToSend } from './citizen-field-edit';
import { flagsToArray } from './field-flags';

/*
  The citizen form's values as they go on the wire (GOD-22).

  Moved out of `components/admin/citizen-form.tsx` as it was. What the server
  will receive, and what the offline queue stores, is decided here and nowhere
  else; nothing here is a component.
*/

/** Drops UI-only fields and coerces the numeric strings the inputs produce. */
export function toPayloadProperty(property: PropertyDraft): Record<string, unknown> {
  /*
    `pendingBuilding` is destructured off and never sent.

    It describes work still to be done — a structure to create before this
    registration is submitted — not a field of the card. By the time the
    payload reaches the server the building exists and `buildingId` names it;
    the intent that produced it is none of the server's business. Dropped here
    rather than left to `branchFieldsOnly`, which would discard it silently and
    give the next reader no reason to think it was deliberate.
  */
  const {
    unitArea,
    shares,
    units,
    id,
    buildingId,
    pendingBuilding: _pending,
    landlordLink,
    landlordAgreedName,
    ...rest
  } = property;

  /*
    The owner's name, as the tenant gave it.

    `landlordLink` and `landlordAgreedName` are what the locked field *shows*
    and never travel: the server keeps a linked card's own name as it was, and
    resolves the owner's registered name on every read. The registered name is
    sent only where the tenant's own is empty — a card whose name was flagged
    unknown before the owner was identified — because the schema requires one
    of a مستأجر and the field cannot be typed into while locked. Never in its
    shown form: see `landlordNameToSend`.
  */
  const landlordName = landlordNameToSend({ ...rest, landlordLink, landlordAgreedName }) as
    | string
    | undefined;

  return {
    // Present only when this card is editing a stored row; the create endpoint
    // never sees it, and the update endpoint reads it as "this one, changed".
    ...(id ? { id } : {}),
    // The census link, when the picker set one. Omitted rather than sent as
    // null, because the schema treats an absent key as "no link" and a `null`
    // as a value it has no rule for.
    ...(buildingId ? { buildingId } : {}),
    ...rest,
    ...(landlordName !== undefined ? { landlordName } : {}),
    ...(unitArea !== undefined && unitArea !== '' ? { unitArea: Number(unitArea) } : {}),
    // أسهم are a share of ownership — never sent on a tenant's or free occupant's card.
    ...(shares !== undefined && shares !== '' && property.occupancyType === 'OWNER'
      ? { shares: Number(shares) }
      : {}),
    ...(units ? { units: units.map(toPayloadUnit) } : {}),
  };
}

/** Coerces one building unit's numeric strings for the wire. */
function toPayloadUnit(unit: UnitDraft): Record<string, unknown> {
  const { unitArea, unitId, id, ...rest } = unit;
  return {
    // The stored row this line was loaded from: the server keeps it by identity
    // and refuses it if its flat ended while the form was open.
    ...(id ? { id } : {}),
    ...(unitId ? { unitId } : {}),
    ...rest,
    ...(unitArea !== undefined && unitArea !== '' ? { unitArea: Number(unitArea) } : {}),
  };
}

/** The submission exactly as the server will receive it. */
export function toSubmission(values: CitizenFormValues) {
  return {
    residence: values.residence ?? 'RESIDENT',
    personal: submittedPersonal(values),
    contact: submittedContact(values),
    properties: values.properties.map(toPayloadProperty),
    flags: flagsToArray(values.flags),
    // Absent unless quick-save was used. `undefined` rather than `''`: the
    // schema's four-character floor would reject an empty string, and an
    // ordinary save must not have to think about this field at all.
    ...(values.blanketFlagReason ? { blanketFlagReason: values.blanketFlagReason } : {}),
    /*
      Sent as `undefined` when blank, never `''`.

      The server treats an absent note and an empty one identically — both
      store null — but sending `''` would make «هل هناك ملاحظة؟» a question
      about string length rather than presence, on both sides of the wire.
    */
    ...(values.notes?.trim() ? { notes: values.notes.trim() } : {}),
    // Only on an edit, and only what the officer answered — see `removals`.
    ...(values.removals?.length ? { removals: values.removals } : {}),
    /*
      This form asks «حالة الوحدة» of an owner and will not send without it
      (or its «غير مؤكَّد»). A payload without this came from a form that did
      not ask, and the server flags its gaps rather than refusing them.
    */
    unitStatusAsked: true,
    ...(values.residenceMove ? { movedOn: values.residenceMove.movedOn } : {}),
  };
}

/**
 * The personal section as it goes on the wire — only what this kind of file asks.
 *
 * Two things are left behind, and neither is erased on the server by being
 * left behind (an edit never writes what it is not sent):
 *
 *  - a Lebanese citizen's identity document. The edit form still *loads* the
 *    real number stored on an older record; sending it back would put a field
 *    nobody can see through validation, and a legacy value that no longer fits
 *    the rules would fail a save with no box to correct it in;
 *  - a household file's fields, on a non-resident record.
 */
function submittedPersonal(values: CitizenFormValues): Record<string, unknown> {
  const personal = values.personal;
  if (values.residence === 'NON_RESIDENT_OWNER') {
    const { firstName, middleName, lastName, residencePlace } = personal;
    return { firstName, middleName, lastName, residencePlace };
  }
  if (values.residence === 'ESTATE') {
    const { firstName, middleName, lastName } = personal;
    return { firstName, middleName, lastName };
  }
  if (values.residence === 'INSTITUTION') return { firstName: personal.firstName };
  if (personal.isLebanese !== false) {
    const { identityDocType: _type, identityDocNumber: _number, residencyNumber: _residency, ...rest } =
      personal;
    return rest;
  }
  return personal;
}

/**
 * The contact section as it goes on the wire — and, like the personal one, only
 * what this kind of file asks. A WhatsApp number nobody is using is left out
 * (`withoutUnusedWhatsapp`), so a value typed into a box that has since been
 * hidden cannot fail validation on a field nobody can see.
 */
function submittedContact(values: CitizenFormValues): Record<string, unknown> {
  // A non-resident, an estate or an institution: a phone, and somebody to reach.
  if (!isOwnerRecord(values.residence)) return withoutUnusedWhatsapp(values.contact);
  const { phone, whatsapp, whatsappSameAsPhone, localContactName, localContactPhone } = values.contact;
  return withoutUnusedWhatsapp({ phone, whatsapp, whatsappSameAsPhone, localContactName, localContactPhone });
}

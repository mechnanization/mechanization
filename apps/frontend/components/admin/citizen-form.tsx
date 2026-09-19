'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CloudOff,
  FileQuestion,
  IdCard,
  Loader2,
  Plus,
  Save,
  StickyNote,
  TriangleAlert,
  UsersRound,
  Zap,
} from 'lucide-react';
import {
  adminCreateCitizenSubmissionSchema,
  allowedPropertyTypesFor,
  getLabels,
  normalizeDigits,
  PROPERTY_FIELD_MAP,
  type CitizenResidence,
} from '@mechanization/shared-schemas';
import type { PublicTenantConfig } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  ContactStep,
  OwnerContactStep,
  OwnerPersonalStep,
  PersonalStep,
} from '@/components/citizen/steps';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  PossibleDuplicatesBar,
  PossibleDuplicatesPanel,
  usePossibleDuplicates,
} from './possible-duplicates';
import {
  PropertyCard,
  type PropertyDraft,
  type UnitDraft,
} from '@/components/citizen/property-card';
import { Field, FieldFlagProvider, flagsToArray } from '@/components/ui/field';
import { UnverifiedFieldsDialog } from './unverified-fields-dialog';
import { QuickSaveDialog } from './quick-save-dialog';
import type { LockedCensusTarget } from './building-unit-picker';
import { ParcelRosterDialog } from './parcel-roster-dialog';
import { scrollElementToTop } from '@/lib/scroll-to-top';
import { cn, scopeErrors } from '@/lib/utils';
import { useSectionNav } from '@/lib/use-section-nav';

export interface CitizenFormValues {
  /**
   * نوع الملف — a household living in the town, or «غير مقيم في البلدة». Decides
   * which questions the first two sections ask. Absent reads as a household,
   * which is what every draft and queued record from before it meant.
   */
  residence?: CitizenResidence;
  personal: Record<string, unknown>;
  contact: Record<string, unknown>;
  properties: PropertyDraft[];
  /**
   * Fields the officer recorded as «غير مؤكَّد», keyed by dot-path.
   *
   * A Map rather than the array the wire uses, because every operation this
   * form performs on them is by path: is this field flagged, flag it, drop it
   * when its card is deleted. `flagsToArray` converts at the edge.
   */
  flags: Map<string, string>;
  /**
   * The server's «بانتظار التحقق» notes on this record, keyed by dot-path.
   *
   * Not part of what the form edits and never sent back — the server derives
   * these from its own cadastre on every write. They are carried in the form's
   * values only so the fields they name can say so while the officer is
   * looking at them.
   */
  unverified: Map<string, string>;
  /**
   * «سبب عام لنقص البيانات» — one reason for the whole visit (D12).
   *
   * Not a flag and not a replacement for them: the server copies it onto every
   * remaining gap as an overridable default, so a reviewer still gets a list of
   * named fields rather than one sentence attached to nothing. Undefined on an
   * ordinary save, which is the overwhelming majority of them.
   */
  blanketFlagReason?: string;
  /**
   * «ملاحظات» — free text the officer adds, asked for by no field.
   *
   * Deliberately *not* `blanketFlagReason`, which is the only free-text box
   * this form used to have and which officers were therefore using for this.
   * That one is a reason data is missing: it propagates onto every gap in the
   * record and its presence is part of what lands a registration at
   * «يتطلب مراجعة». Writing «الأسرة تنتقل نهاية الشهر» into it flags a clean
   * record for review. A note flags nothing.
   */
  notes?: string;
}

/**
 * The three sections, in one list.
 *
 * Declared once and read by both the jump-link bar and the section headings
 * so the two cannot fall out of step — a nav entry pointing at an `id` no
 * heading renders is a link that silently does nothing, and it is exactly the
 * kind of drift that survives review because nothing about it looks wrong.
 *
 * The `id` is also the error-key prefix (`personal.firstName`,
 * `properties.0.neighborhood`), which is what lets the bar mark a section as
 * holding a problem without a second mapping.
 */
const SECTIONS = [
  { id: 'personal', step: '١', icon: IdCard, title: 'البيانات الشخصية' },
  { id: 'contact', step: '٢', icon: UsersRound, title: 'التواصل والأسرة' },
  { id: 'properties', step: '٣', icon: Building2, title: 'العقارات' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

/** Stable identity for the nav hook's observer dependency. */
const SECTION_IDS = SECTIONS.map((section) => section.id) as readonly SectionId[];

/**
 * A brand new record — one blank property card, Lebanese by default.
 *
 * A factory rather than a shared constant. The old constant handed every form
 * that opened it the *same* `Map` and the same property array; nothing mutates
 * them today, because every update in this file copies before it writes, but
 * one `flags.set(...)` written in the ordinary imperative style would have
 * leaked one officer's «غير مؤكَّد» flags into the next blank form on that
 * device — and it would have looked completely reasonable in review.
 */
export function emptyCitizen(): CitizenFormValues {
  return {
    residence: 'RESIDENT',
    personal: { isLebanese: true },
    contact: { whatsappSameAsPhone: true },
    // Empty, not one blank card — a citizen who owns nothing and only rents
    // has no property to file, and that is the common case this form should
    // not stand in the way of. Staff add a card only for someone who owns.
    properties: [],
    flags: new Map(),
    unverified: new Map(),
  };
}

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
  return { ...values, residence };
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
): CitizenFormValues {
  const phone = phoneFromSearchTerm(term);
  if (phone) return { ...values, contact: { ...values.contact, phone } };

  const trimmed = term.trim();
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

/**
 * One field this form is currently asking about, in the order it is asked.
 *
 * The section and the leaf are carried alongside the path because both of this
 * list's consumers need them and neither should be re-deriving them by string
 * surgery: the leaf is the label key, and the section is what the manager
 * dialog groups by.
 */
export interface AskableField {
  path: string;
  /** The leaf name — `civilRecordNumber`, `landlordPhone`. Also the label key. */
  field: string;
  section: 'personal' | 'contact' | 'properties';
  /** Which card, for a property field. */
  propertyIndex?: number;
}

/**
 * Every dot-path this form is currently *asking about*.
 *
 * The form is branchy — رقم السجل exists only for a Lebanese citizen, a
 * landlord block only for a tenant, وحدات المبنى only for a building — and an
 * officer who flags a field and then changes the branch above it leaves a flag
 * pointing at an input nobody can see. Stored, that flag would hold the record
 * at «يتطلب مراجعة» over a question the form has stopped asking, and nothing on
 * screen would explain why.
 *
 * So flags are pruned to this set. It is derived from the same
 * `PROPERTY_FIELD_MAP` the cards render from, which is what keeps "what is on
 * screen" and "what may be flagged" the same list.
 *
 * This is also the *only* statement of that list. The «خانات غير مؤكَّدة»
 * dialog used to carry its own copy of these branches, which meant two places
 * had to agree on what a non-Lebanese citizen is asked or what a خيمة card
 * shows — and the failure mode was quiet in the worst way: the dialog offering
 * a field the form would prune the moment it was confirmed, so the officer
 * ticked six boxes and came back to five. One list, read by both.
 */
export function askableFields(values: CitizenFormValues): AskableField[] {
  /*
    A non-resident record asks five things and nothing a household file asks —
    so a flag left on a household field by an officer who then switched the
    record to «غير مقيم في البلدة» is pruned rather than holding it at
    «يتطلب مراجعة» over a question the form no longer puts.
  */
  if (values.residence === 'NON_RESIDENT_OWNER') {
    const owner: AskableField[] = [
      { path: 'personal.firstName', field: 'firstName', section: 'personal' },
      { path: 'personal.middleName', field: 'middleName', section: 'personal' },
      { path: 'personal.lastName', field: 'lastName', section: 'personal' },
      { path: 'personal.residencePlace', field: 'residencePlace', section: 'personal' },
      { path: 'contact.phone', field: 'phone', section: 'contact' },
    ];
    if (values.contact.whatsappSameAsPhone === false) {
      owner.push({ path: 'contact.whatsapp', field: 'whatsapp', section: 'contact' });
    }
    return [...owner, ...propertyAskableFields(values)];
  }

  const fields: AskableField[] = [
    { path: 'personal.firstName', field: 'firstName', section: 'personal' },
    { path: 'personal.middleName', field: 'middleName', section: 'personal' },
    { path: 'personal.lastName', field: 'lastName', section: 'personal' },
    { path: 'personal.motherName', field: 'motherName', section: 'personal' },
    { path: 'personal.gender', field: 'gender', section: 'personal' },
    /*
      No «فئة الدم» here, deliberately. It is optional on the form now
      (`personalDetailsObject.bloodType`), and a flag is an excuse for an
      answer the register needs — offering one for a field that may simply be
      left blank sent records to «يتطلب مراجعة» over a question a reviewer
      cannot answer either.
    */
    { path: 'personal.residentStatus', field: 'residentStatus', section: 'personal' },
  ];

  // No identity document is asked of a Lebanese citizen — see `PersonalStep`.
  if (values.personal.isLebanese !== false) {
    fields.push(
      { path: 'personal.civilRecordNumber', field: 'civilRecordNumber', section: 'personal' },
    );
  } else {
    fields.push(
      { path: 'personal.nationality', field: 'nationality', section: 'personal' },
      { path: 'personal.identityDocNumber', field: 'identityDocNumber', section: 'personal' },
      { path: 'personal.residencyNumber', field: 'residencyNumber', section: 'personal' },
    );
  }

  fields.push(
    { path: 'contact.phone', field: 'phone', section: 'contact' },
    { path: 'contact.maritalStatus', field: 'maritalStatus', section: 'contact' },
    { path: 'contact.totalRegisteredMembers', field: 'totalRegisteredMembers', section: 'contact' },
    { path: 'contact.actualHouseholdMembers', field: 'actualHouseholdMembers', section: 'contact' },
  );

  if (values.contact.whatsappSameAsPhone === false) {
    fields.push({ path: 'contact.whatsapp', field: 'whatsapp', section: 'contact' });
  }

  fields.push(...propertyAskableFields(values));

  return fields;
}

/**
 * The fields each property card is asking about — the same for a household file
 * and a non-resident record, because a card's questions depend on the card.
 */
function propertyAskableFields(values: CitizenFormValues): AskableField[] {
  const fields: AskableField[] = [];

  values.properties.forEach((property, propertyIndex) => {
    const branch = PROPERTY_FIELD_MAP[property.propertyType as keyof typeof PROPERTY_FIELD_MAP];

    /*
      أسهم are a share of *ownership*: asked of an owner of أرض, never of a tenant
      or a شاغل بتسامح farming it — and so never flaggable on their card either.
    */
    for (const field of branch ?? []) {
      if (field === 'shares' && property.occupancyType !== 'OWNER') continue;
      /*
        «اسم المبنى» is no longer required of either structure branch, so it can
        no longer be the reason a record is incomplete — and a flag that cannot
        excuse anything is the failure this list's docblock names: it puts a
        «غير مؤكَّد» box under a field that was never going to fail, until the
        flags stop meaning "this record is missing something".

        Excluded here and *not* from `PROPERTY_FIELD_MAP`, which is a different
        question with a different answer. That map says which fields a card
        carries, and `branchFieldsOnly` reads it to decide what survives the
        trip to the server — dropping the name from it would stop storing the
        names officers do supply.

        See `buildingNameField`, and the note below about حالة الوحدة, which is
        absent from this list for exactly the same reason.
      */
      if (field === 'buildingName') continue;

      fields.push({
        path: `properties.${propertyIndex}.${field}`,
        field,
        section: 'properties',
        propertyIndex,
      });
    }

    /*
      The landlord block, asked of both non-owner occupancies and flaggable
      unevenly between them.

      A tenant's landlord phone is required, so it can be the reason a record
      is incomplete and therefore something an officer needs to be able to
      excuse. A free occupant's is optional — there is nothing to excuse, and
      offering the flag anyway would put a «غير مؤكَّد» box under a field that
      was never going to fail, which is how a flag list stops meaning
      "this record is missing something".

      حالة الوحدة is absent here for the same reason and more strongly: it is
      optional on every card that shows it, so it can never hold a record up.
    */
    /*
      Neither is asked of a card whose owner is a confirmed or agreed link: the
      register established both, the fields are locked, and a «غير مؤكَّد» on
      them would say the opposite of what the card shows. The server drops such
      a flag anyway; not offering it keeps quick-save from raising one.
    */
    const linked = Boolean(property.landlordLink || property.landlordCitizenId);
    const nonOwnerFields = linked
      ? []
      : property.occupancyType === 'TENANT'
        ? (['landlordName', 'landlordPhone'] as const)
        : property.occupancyType === 'FREE_OCCUPANT'
          ? (['landlordName'] as const)
          : [];

    for (const field of nonOwnerFields) {
      fields.push({
        path: `properties.${propertyIndex}.${field}`,
        field,
        section: 'properties',
        propertyIndex,
      });
    }
  });

  return fields;
}

/** The same list as a set, for the "is this still being asked?" question. */
function askablePaths(values: CitizenFormValues): Set<string> {
  return new Set(askableFields(values).map((entry) => entry.path));
}

/**
 * Renumbers a path-keyed map of property annotations after the card at
 * `removed` is deleted — the officer's flags, and the server's notes alike.
 *
 * Drops that card's own flags and shifts every higher index down by one, which
 * is the same correction `removeProperty` applies to the collapsed set — for
 * the same reason, and with worse consequences if it is skipped: a stale
 * collapsed index folds the wrong card, a stale flag index misattributes a
 * missing field to the wrong property.
 */
function reindexFlags(flags: ReadonlyMap<string, string>, removed: number): Map<string, string> {
  const next = new Map<string, string>();

  for (const [path, reason] of flags) {
    const match = /^properties\.(\d+)\.(.+)$/.exec(path);
    if (!match) {
      next.set(path, reason);
      continue;
    }

    const index = Number(match[1]);
    if (index === removed) continue;
    next.set(`properties.${index > removed ? index - 1 : index}.${match[2]}`, reason);
  }

  return next;
}

/**
 * The same renumbering one level down, after row `rowIndex` of card `cardIndex`
 * leaves the form — ended from the file while the form is open. That row's own
 * flags go with it and the rows after it move up, as the server does.
 */
function reindexRowFlags(
  flags: ReadonlyMap<string, string>,
  cardIndex: number,
  rowIndex: number,
): Map<string, string> {
  const next = new Map<string, string>();

  for (const [path, reason] of flags) {
    const match = /^properties\.(\d+)\.units\.(\d+)\.(.+)$/.exec(path);
    if (!match || Number(match[1]) !== cardIndex) {
      next.set(path, reason);
      continue;
    }

    const row = Number(match[2]);
    if (row === rowIndex) continue;
    next.set(`properties.${cardIndex}.units.${row > rowIndex ? row - 1 : row}.${match[3]}`, reason);
  }

  return next;
}

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
    of a مستأجر and the field cannot be typed into while locked.
  */
  const isNonOwner = property.occupancyType === 'TENANT' || property.occupancyType === 'FREE_OCCUPANT';
  const landlordName =
    isNonOwner && !rest.landlordName?.trim()
      ? (landlordLink?.name ?? landlordAgreedName ?? rest.landlordName)
      : rest.landlordName;

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
  if (personal.isLebanese !== false) {
    const { identityDocType: _type, identityDocNumber: _number, residencyNumber: _residency, ...rest } =
      personal;
    return rest;
  }
  return personal;
}

function submittedContact(values: CitizenFormValues): Record<string, unknown> {
  if (values.residence !== 'NON_RESIDENT_OWNER') return values.contact;
  const { phone, whatsapp, whatsappSameAsPhone, localContactName, localContactPhone } = values.contact;
  return { phone, whatsapp, whatsappSameAsPhone, localContactName, localContactPhone };
}

/**
 * Validates the whole record at once, against the same schema the server
 * validates against.
 *
 * Not "the same rules" — the same object. `adminCreateCitizenSubmissionSchema`
 * is what the controller's validation pipe runs, so what this form accepts and
 * what the server accepts cannot drift, and neither can the subtler half: which
 * complaints a «غير مؤكَّد» flag is allowed to excuse. That matters most in the
 * case this feature exists for, where the officer is offline and the server is
 * hours away from seeing the record — a browser that were more permissive would
 * queue registrations that fail on arrival, in a settlement nobody is going
 * back to.
 *
 * The wizard checked one step per «التالي» because that was the only moment it
 * could. A single page has no such moment, so everything is checked on save —
 * and the caller gets one flat error map covering all three sections, which is
 * what lets a mistake in البيانات الشخصية surface while the clerk is looking
 * at العقارات.
 */
/**
 * The value at a dot-path, so the quick-save estimate can tell an empty field
 * from a filled one.
 *
 * Mirrors `valueAt` in `admin-citizen.schema.ts`, which is what the server
 * actually uses to decide. Written here rather than shared because the two walk
 * different shapes — this one the form's draft, that one the parsed submission
 * — which is also why the number is shown to the officer as an estimate.
 */
function valueAtPath(values: CitizenFormValues, path: string): unknown {
  const [head, ...rest] = path.split('.');
  if (head === 'personal' || head === 'contact') return values[head][rest[0]];

  // properties.<index>.<field>, and properties.<index>.units.<n>.<field>
  const card = values.properties[Number(rest[0])] as Record<string, unknown> | undefined;
  if (!card) return undefined;
  if (rest[1] !== 'units') return card[rest[1]];

  const unit = (card.units as Array<Record<string, unknown>> | undefined)?.[Number(rest[2])];
  return unit?.[rest[3]];
}

/** Empty, in the sense the server's `isAbsent` means it. */
function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function validate(values: CitizenFormValues): Record<string, string> {
  const result = adminCreateCitizenSubmissionSchema.safeParse(toSubmission(values));
  if (result.success) return {};

  const flagPaths = [...values.flags.keys()];
  const out: Record<string, string> = {};

  for (const issue of result.error.issues) {
    /*
      A complaint about a flag is shown on the field it excuses.

      Zod reports it at `flags.3.reason`, which names nothing on screen — the
      officer sees a reason box under رقم العقار, not a numbered list of flags.
      Resolving the index back to the path is what puts "يرجى ذكر سبب…"
      underneath the box it is about.
    */
    if (issue.path[0] === 'flags') {
      const key = flagPaths[Number(issue.path[1])];
      if (key && !(key in out)) out[key] = issue.message;
      continue;
    }

    const key = issue.path.join('.');
    if (!(key in out)) out[key] = issue.message;
  }

  return out;
}

/**
 * Create or correct one citizen record — the citizen wizard's six steps as a
 * single page.
 *
 * The step-by-step shape existed for a citizen filling this in on a phone,
 * alone, once: it broke an intimidating form into answerable pieces and
 * refused to let them past a piece they had got wrong. A clerk at a counter is
 * the opposite case — they do this all day, they are working from papers laid
 * out in front of them, and the person is waiting. Sections they can jump
 * between and a single «حفظ» beat six «التالي» presses and a review screen.
 *
 * The section *contents* are the wizard's own components, not copies:
 * `PersonalStep`, `ContactStep` and `PropertyCard` render here exactly as they
 * render for a citizen, so the conditional fields (رقم السجل only for a
 * Lebanese citizen, a landlord block only for a tenant, a units editor only
 * for a building) cannot drift between the two entry points.
 *
 * The two steps that are *not* here are deliberate: المستندات, because a clerk
 * has paper rather than files to attach, and الإقرار, because a declaration
 * ticked on someone else's behalf is not a declaration.
 */
export function CitizenForm({
  tenant,
  token,
  citizenId,
  config,
  mode,
  initial,
  submitting,
  error,
  offline = false,
  onSubmit,
  onCancel,
  onValuesChange,
  locale = 'ar',
  lockedCensusTarget,
}: {
  tenant: string;
  /**
   * The staff session's token, for the parcel roster lookup.
   *
   * Optional because this form is also the citizen-facing wizard's admin twin
   * and the roster is staff-only — without it the neighbours line stays the
   * plain count it always was.
   */
  token?: string | null;
  /**
   * The citizen being edited, when there is one.
   *
   * Passed through to the census picker's unit chips and used for one
   * question only: is the occupancy already recorded in this flat *theirs*, or
   * somebody else's. Undefined on a create, and on the citizen-facing wizard,
   * which is the safe direction — a record that does not exist yet cannot be
   * the one already in the unit.
   */
  citizenId?: string;
  config: PublicTenantConfig;
  mode: 'create' | 'edit';
  initial: CitizenFormValues;
  submitting: boolean;
  /** Server-side failure, shown above the actions. */
  error: string | null;
  /**
   * The browser has no connection, so «حفظ» will queue rather than send.
   *
   * Said on the button rather than discovered after pressing it: an officer
   * who does not know a record was stored locally has no reason to keep the
   * portal open until it syncs, and closing it is how a queue is forgotten.
   */
  offline?: boolean;
  onSubmit: (values: CitizenFormValues) => void;
  onCancel: () => void;
  /**
   * Every change to what is on screen, so the parent can persist a draft.
   *
   * Reported rather than lifted: `values` stays this component's state. The
   * form is edited on nearly every keystroke and hoisting it would re-render
   * the editor — which owns the token, the tenant config and the offline queue
   * — on each one. The parent is expected to debounce; see `CitizenEditor`.
   *
   * Fires once on mount with whatever the form opened with, which is what lets
   * a restored draft be written straight back and keep its timestamp fresh.
   */
  onValuesChange?: (values: CitizenFormValues) => void;
  locale?: string;
  /**
   * Launched from a building's unit matrix — the structure, and possibly the
   * flat, is already decided.
   *
   * Applied to the first property card only. It arrives as a URL parameter, so
   * this form does not have to know anything about the matrix that sent it.
   */
  lockedCensusTarget?: LockedCensusTarget | null;
}) {
  const [values, setValues] = useState<CitizenFormValues>(initial);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [unverifiedDialogOpen, setUnverifiedDialogOpen] = useState(false);
  const [quickSaveOpen, setQuickSaveOpen] = useState(false);
  /** Which رقم العقار's roster is open, if any. */
  const [rosterParcel, setRosterParcel] = useState<string | null>(null);
  /** Which property cards are folded shut. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  /**
   * The jump bar's highlight and scroll handler.
   *
   * Re-observed when a property card is added or removed: the sections keep
   * their ids, but the page height under them changes enough that a stale
   * observer would highlight against the old layout.
   */
  const { active, jumpTo } = useSectionNav(SECTION_IDS, [values.properties.length]);

  // Re-seeds when the record finishes loading. Keyed on the object identity,
  // so a parent that fetches once does not clobber what has been typed since.
  useEffect(() => {
    setValues(initial);
    /*
      Every card opens expanded, on a correction exactly as on a new filing.

      An existing record used to open with its cards folded, on the reasoning
      that a clerk fixing a phone number should not scroll past four properties
      to reach «حفظ». It made the two forms different screens: the same section,
      with the same heading, showing its contents on one and a row of shut
      drawers on the other — and a field an officer cannot see is a field they
      do not check. Folding is still one tap away per card, and the jump bar
      reaches «حفظ» without passing them.
    */
    setCollapsed(new Set());
  }, [initial]);

  /*
    Tell the parent what the form now holds, so it can keep a draft.

    Depends on `values` alone. Including `onValuesChange` would re-fire this on
    every render of a parent that passes an inline arrow — which is every
    parent — and the handler writes to localStorage, so that is a synchronous
    disk write per render rather than per edit. The callback is invoked through
    a ref so the one that runs is always the latest, without being a dependency.
  */
  const notifyChange = useRef(onValuesChange);
  notifyChange.current = onValuesChange;
  useEffect(() => {
    notifyChange.current?.(values);
  }, [values]);

  const update = useCallback((patch: Partial<CitizenFormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
  }, []);

  /**
   * Raise or amend a «غير مؤكَّد» flag — and empty the field it covers.
   *
   * Clearing the value is the substantive half. A flag says the value was
   * never established; leaving a half-typed number underneath it would make
   * the record contradict itself, and — because the server strips flagged
   * fields before it validates anything — would be discarded on arrival
   * anyway. Doing it here means what the officer sees is what gets stored.
   *
   * Amending an existing flag (typing in its reason box) does not re-clear,
   * because there is nothing left to clear; the same code path handles both
   * since clearing an already-empty field is a no-op.
   */
  const setFlag = useCallback((path: string, reason: string) => {
    setValues((current) => {
      const flags = new Map(current.flags);
      flags.set(path, reason);

      const [section, ...rest] = path.split('.');

      if (section === 'personal' || section === 'contact') {
        const field = rest[0];
        const next = { ...current[section] };
        delete next[field];
        return { ...current, [section]: next, flags };
      }

      // properties.<index>.<field>
      const index = Number(rest[0]);
      const field = rest[1];
      return {
        ...current,
        properties: current.properties.map((property, i) => {
          if (i !== index) return property;
          const next = { ...property } as Record<string, unknown>;
          delete next[field];
          return next as PropertyDraft;
        }),
        flags,
      };
    });
  }, []);

  /** Withdraws a flag. The field comes back empty, which is where it was. */
  const clearFlag = useCallback((path: string) => {
    setValues((current) => {
      const flags = new Map(current.flags);
      flags.delete(path);
      return { ...current, flags };
    });
  }, []);

  const flagging = useMemo(
    () => ({
      flags: values.flags,
      unverified: values.unverified,
      set: setFlag,
      clear: clearFlag,
      locale,
    }),
    [values.flags, values.unverified, setFlag, clearFlag, locale],
  );

  /**
   * One card, updated from whatever it currently is.
   *
   * Takes an updater rather than a finished `PropertyDraft`, and that is a
   * correctness fix rather than a style preference.
   *
   * `PropertyCard` used to build the replacement by spreading the `draft` prop
   * it had been rendered with — `onChange({ ...draft, ...patch })` — so every
   * write carried a full copy of the card *as it was at that render*. Two
   * writes landing before React re-rendered therefore both spread the same
   * stale copy, and the second silently reverted the first.
   *
   * That is not a rare interleaving; it is the census picker's ordinary
   * behaviour. Linking a building sets `buildingId`, which makes the picker
   * fetch the structure, which fires the effect that copies «اسم المبنى» down
   * — and that second write, built from the pre-link draft, put `buildingId`
   * back to undefined. The officer saw the building selected on screen, saved,
   * and got «بلا ربط بسجل المباني» for a card they had just linked. Ticking two
   * flats quickly lost the first one the same way.
   *
   * An updater cannot express that bug: `p` is whatever the card holds at the
   * moment the update runs, so writes compose instead of racing.
   */
  const setProperty = useCallback(
    (index: number, update: (current: PropertyDraft) => PropertyDraft) => {
      setValues((current) => ({
        ...current,
        properties: current.properties.map((p, i) => (i === index ? update(p) : p)),
      }));
    },
    [],
  );

  /**
   * A new card.
   *
   * `sameParcelAs` carries the parcel's own identity across — رقم العقار and
   * الحي — for the case this form could not express at all until now: one deed
   * carrying a building, the house behind it and a shop on the street. Those
   * are three structures that are typed, inspected and taxed differently, so
   * they are three cards; what they are *not* is three different pieces of
   * land, and making the clerk retype the number that says so invites the
   * transposed digit that puts the shop on someone else's parcel.
   *
   * The owner is not copied because the owner was never on the card. It is the
   * citizen this whole form is about, typed once at the top — which is why
   * adding a fifth structure costs one tap and no re-entry.
   */
  const addProperty = useCallback((sameParcelAs?: number) => {
    setValues((current) => {
      const source = sameParcelAs === undefined ? undefined : current.properties[sameParcelAs];

      const properties = [
        ...current.properties,
        {
          // A clerk entering several properties for one household fills the same
          // shape repeatedly, so a new card inherits the last one's occupancy.
          occupancyType: (source ?? current.properties.at(-1))?.occupancyType,
          ...(source
            ? { propertyNumber: source.propertyNumber, neighborhood: source.neighborhood }
            : {}),
        },
      ];
      setCollapsed(new Set(properties.slice(0, -1).map((_, i) => i)));
      return { ...current, properties };
    });
  }, []);

  /**
   * Property cards grouped by shared رقم العقار.
   *
   * A parcel with a building, the house behind it and a shop on the street is
   * one عقار holding three cards — array position doesn't say that, matching
   * رقم العقار values do. Grouping here is what lets the form show them as one
   * parcel with several ملكيات instead of three unrelated-looking top-level
   * cards that merely happen to repeat the same number in their subtitle.
   *
   * A group of one (the ordinary case: no other card shares its number) still
   * renders as a single plain card — the grouping header only earns its place
   * once there is something to group.
   */
  const propertyGroups = useMemo(() => {
    const groups: { propertyNumber: string | null; indices: number[] }[] = [];
    const groupByNumber = new Map<string, number>();
    values.properties.forEach((property, index) => {
      const propertyNumber = property.propertyNumber?.trim() || null;
      const groupIndex = propertyNumber ? groupByNumber.get(propertyNumber) : undefined;
      if (groupIndex !== undefined) {
        groups[groupIndex].indices.push(index);
        return;
      }
      if (propertyNumber) groupByNumber.set(propertyNumber, groups.length);
      groups.push({ propertyNumber, indices: [index] });
    });
    return groups;
  }, [values.properties]);

  /**
   * Renders `propertyGroups` as cards — a lone card per single-property parcel,
   * or a headed cluster of «الملكية N» cards plus one shared add-button for a
   * parcel carrying several. Called once per layout (mobile stepper, desktop
   * sequential view) rather than duplicated, so the grouping logic is stated
   * once.
   */
  const renderPropertyGroups = () =>
    propertyGroups.map((group) => {
      if (group.indices.length === 1) {
        const index = group.indices[0];
        const property = values.properties[index];
        return (
          <PropertyCard
            key={property.id ?? index}
            tenant={tenant}
            index={index}
            draft={property}
            citizenId={citizenId}
            allowedTypes={allowedTypes}
            collapsed={collapsed.has(index)}
            onToggleCollapse={() => toggleCollapsed(index)}
            onChange={(update) => setProperty(index, update)}
            onAddOnSameParcel={() => addProperty(index)}
            onViewParcel={token ? setRosterParcel : undefined}
            onRemove={() => removeProperty(index)}
            // Ended on the server, kept there as history — no longer this form's.
            // A partial end leaves the card here without the rows that ended.
            onEnded={(result, cardEnded) =>
              cardEnded ? removeProperty(index) : removeEndedRows(index, result.endedRowIds ?? [])
            }
            // Zero properties is a valid registration, so the last remaining
            // card is removable too — not just every card after the first.
            canRemove
            errors={scopeErrors(shown, `properties.${index}`)}
            locale={locale}
            token={token}
            censusPicker
            nonResident={isNonResident}
            // Only the first card inherits a matrix launch: the officer opened
            // one flat, and pinning every card they go on to add to it would
            // link properties they never said were in that building.
            lockedCensusTarget={index === 0 ? (lockedCensusTarget ?? null) : null}
          />
        );
      }

      return (
        <div
          key={group.propertyNumber}
          className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3"
        >
          <div className="flex items-center gap-2 px-1 text-primary">
            <Building2 className="size-4 shrink-0" aria-hidden />
            <span className="text-sm font-semibold">
              {locale === 'en'
                ? `Parcel ${group.propertyNumber} — ${group.indices.length} properties`
                : `العقار رقم ${group.propertyNumber} — ${group.indices.length} ملكيات`}
            </span>
          </div>

          {group.indices.map((index, unitPosition) => {
            const property = values.properties[index];
            return (
              <PropertyCard
                key={property.id ?? index}
                tenant={tenant}
                index={index}
                draft={property}
                citizenId={citizenId}
                allowedTypes={allowedTypes}
                collapsed={collapsed.has(index)}
                onToggleCollapse={() => toggleCollapsed(index)}
                onChange={(update) => setProperty(index, update)}
                onViewParcel={token ? setRosterParcel : undefined}
                onRemove={() => removeProperty(index)}
                onEnded={(result, cardEnded) =>
                  cardEnded ? removeProperty(index) : removeEndedRows(index, result.endedRowIds ?? [])
                }
                canRemove
                errors={scopeErrors(shown, `properties.${index}`)}
                locale={locale}
                token={token}
                censusPicker
                nonResident={isNonResident}
                lockedCensusTarget={index === 0 ? (lockedCensusTarget ?? null) : null}
                title={locale === 'en' ? `Unit ${unitPosition + 1}` : `الملكية ${unitPosition + 1}`}
              />
            );
          })}

          <button
            type="button"
            onClick={() => addProperty(group.indices[0])}
            className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-primary/50 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/5"
          >
            <Plus className="size-3.5 shrink-0" aria-hidden />
            {locale === 'en'
              ? 'Add another property on this parcel'
              : 'إضافة ملكية أخرى على هذا العقار'}
          </button>
        </div>
      );
    });

  const removeProperty = useCallback((index: number) => {
    setValues((current) => ({
      ...current,
      properties: current.properties.filter((_, i) => i !== index),
      /*
        Flags are addressed by card index, so deleting a card renumbers them.

        Left alone, a flag on `properties.2.propertyNumber` would silently
        become a flag on whatever card slid into position 2 — excusing a field
        nobody said anything about, and holding that card's real gap against
        the officer. The removed card's own flags go with it.

        The server's «بانتظار التحقق» notes are addressed the same way and are
        renumbered with them: a note reading "this parcel number is not in the
        cadastre" parked on the wrong card sends someone to re-check a number
        that was never in question.
      */
      flags: reindexFlags(current.flags, index),
      unverified: reindexFlags(current.unverified, index),
    }));
    // Indices above the removed card shift down by one; rebuilding the set
    // rather than deleting from it keeps the wrong card from folding shut.
    setCollapsed((current) => {
      const next = new Set<number>();
      for (const i of current) {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      }
      return next;
    });
  }, []);

  /**
   * Rows of card `index` that «إنهاء الإيجار» just ended while the card goes on.
   *
   * Taken out of the form by id rather than left for the officer to notice: a
   * save carrying them would name rows that have ended, which the server refuses
   * so an ended flat is never written back as held. Flags on those rows go with
   * them; later rows' flags move up.
   */
  const removeEndedRows = useCallback((index: number, rowIds: readonly string[]) => {
    if (rowIds.length === 0) return;
    setValues((current) => {
      const card = current.properties[index];
      const units = card?.units ?? [];
      const positions = units
        .map((unit, position) => (unit.id && rowIds.includes(unit.id) ? position : -1))
        .filter((position) => position >= 0)
        .sort((a, b) => b - a);
      if (!card || positions.length === 0) return current;

      let flags: Map<string, string> = new Map(current.flags);
      let unverified: Map<string, string> = new Map(current.unverified);
      for (const position of positions) {
        flags = reindexRowFlags(flags, index, position);
        unverified = reindexRowFlags(unverified, index, position);
      }
      return {
        ...current,
        properties: current.properties.map((property, i) =>
          i === index
            ? { ...property, units: units.filter((unit) => !(unit.id && rowIds.includes(unit.id))) }
            : property,
        ),
        flags,
        unverified,
      };
    });
  }, []);

  const toggleCollapsed = useCallback((index: number) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  /**
   * Which نوع العقار is offered: the municipality's enabled types, minus خيمة
   * for anyone who is not a لاجئ. Re-checked on the server, where صفة الإقامة
   * and the property list are both in hand.
   */
  const allowedTypes = useMemo(() => {
    const enabled = new Set(config.enabledPropertyTypes);
    return allowedPropertyTypesFor(values.personal.residentStatus as string | undefined).filter(
      (type) => enabled.has(type),
    );
  }, [config.enabledPropertyTypes, values.personal.residentStatus]);

  /**
   * A property left holding a type the current صفة الإقامة no longer permits
   * has it cleared, rather than failing validation on save against a control
   * the form has stopped offering.
   */
  useEffect(() => {
    const permitted = new Set(allowedTypes);
    if (values.properties.every((p) => !p.propertyType || permitted.has(p.propertyType))) return;

    setValues((current) => ({
      ...current,
      properties: current.properties.map((p) =>
        p.propertyType && !permitted.has(p.propertyType)
          ? { ...p, propertyType: undefined, tentLocation: undefined }
          : p,
      ),
    }));
  }, [allowedTypes, values.properties]);

  /**
   * A flag whose field the form has stopped asking about is withdrawn.
   *
   * Switching a card from خيمة to أرض, or a citizen from أجنبي to لبناني,
   * retires whole groups of inputs. A flag left behind on one of them would
   * hold the record at «يتطلب مراجعة» over a question nothing on screen is
   * asking — the officer would see a complete form and an unexplained status.
   */
  useEffect(() => {
    const askable = askablePaths(values);
    if ([...values.flags.keys()].every((path) => askable.has(path))) return;

    setValues((current) => {
      const kept = new Map<string, string>();
      for (const [path, reason] of current.flags) {
        if (askable.has(path)) kept.set(path, reason);
      }
      return { ...current, flags: kept };
    });
  }, [values]);

  const shown = useMemo(() => (showErrors ? fieldErrors : {}), [showErrors, fieldErrors]);
  const messages = [...new Set(Object.values(shown))];

  const sectionInvalid = useCallback(
    (prefix: string) => Object.keys(shown).some((key) => key.startsWith(`${prefix}.`)),
    [shown],
  );

  /**
   * The «غير مؤكَّد» fields, named, above the save button.
   *
   * A flag is a per-field control, so a form with six of them scattered across
   * three sections gives no sense of how much of the record is actually
   * missing. This is the whole list in one place, read at the moment it
   * matters: the officer is about to file the person, and this is what the
   * record will say about itself when someone opens it next month.
   */
  const flagSummary = useMemo(() => {
    const labels = getLabels(locale);
    return [...values.flags].map(([path, reason]) => {
      const segments = path.split('.');
      const field = labels.citizenField[segments.at(-1) ?? ''] ?? segments.at(-1) ?? path;
      const card = segments[0] === 'properties' ? Number(segments[1]) + 1 : null;
      return {
        path,
        reason,
        label:
          card === null
            ? field
            : locale === 'en'
              ? `${field} — property ${card}`
              : `${field} — العقار ${card}`,
      };
    });
  }, [values.flags, locale]);

  /** «غير مقيم في البلدة» — the stored value still reads OWNER; see `CITIZEN_RESIDENCE`. */
  const isNonResident = values.residence === 'NON_RESIDENT_OWNER';

  /** Switching نوع الملف. See `withResidence`. */
  const setResidence = useCallback((residence: CitizenResidence) => {
    setValues((current) => withResidence(current, residence));
  }, []);

  /**
   * «قد يكون مسجَّلاً مسبقاً» — looked up once, shown in one of two places.
   *
   * On a correction as well as a new filing, with the open file itself dropped
   * from its own matches (`excludeId`). It used to be creates-only, on the
   * reasoning that every match on an edit is a match with the record being
   * looked at. That is true of the record itself and of nobody else: an officer
   * correcting a surname, or adding the phone the household actually answers
   * on, is doing the very thing that turns two files into recognisable
   * duplicates, and this is the one screen where that is visible while it
   * happens.
   */
  const duplicateCheck = usePossibleDuplicates({
    tenant,
    token,
    firstName: values.personal.firstName,
    lastName: values.personal.lastName,
    phone: values.contact.phone,
    whatsapp: values.contact.whatsappSameAsPhone === false ? values.contact.whatsapp : undefined,
    excludeId: citizenId,
  });

  /**
   * On a desktop: in place, under the phone number, handed to whichever
   * contact step is rendered.
   *
   * It lives there rather than at the foot of the personal step, where it used
   * to sit. It matches on the name *and* the phone, and the phone is by far
   * the stronger of the two — so the old placement put an orange warning about
   * a number one section above the field that asks for it, reading as a
   * complaint about the name the officer had just typed.
   */
  const duplicatesPanel = (
    <PossibleDuplicatesPanel check={duplicateCheck} locale={locale} className="hidden lg:block" />
  );

  /**
   * On a phone or a tablet: pinned in the sticky header instead, so it is on
   * screen on every step and at every scroll position. See
   * `PossibleDuplicatesBar` for why below `lg` the in-place panel is not
   * enough.
   */
  const duplicatesBar = (
    <PossibleDuplicatesBar check={duplicateCheck} locale={locale} className="basis-full lg:hidden" />
  );

  const sections = useMemo(
    () => [
      {
        id: 'personal',
        step: locale === 'en' ? '1' : '١',
        icon: IdCard,
        title: isNonResident
          ? locale === 'en'
            ? 'Basic details'
            : 'البيانات الأساسية'
          : locale === 'en'
            ? 'Personal Info'
            : 'البيانات الشخصية',
        description: isNonResident
          ? locale === 'en'
            ? 'Name, and where the person lives'
            : 'الاسم ومكان الإقامة'
          : locale === 'en'
            ? 'Full name, nationality and residency status'
            : 'الاسم الكامل والجنسية وصفة الإقامة',
      },
      {
        id: 'contact',
        step: locale === 'en' ? '2' : '٢',
        icon: UsersRound,
        title: isNonResident
          ? locale === 'en'
            ? 'Contact'
            : 'التواصل'
          : locale === 'en'
            ? 'Contact & Family'
            : 'التواصل والأسرة',
        description: isNonResident
          ? locale === 'en'
            ? 'How to reach them, and who can be contacted locally'
            : 'وسيلة التواصل، ومن يمكن الرجوع إليه محلياً'
          : locale === 'en'
            ? 'Phone number used by citizen for login and tracking submissions'
            : 'رقم الهاتف الذي يستخدمه المواطن للدخول ومتابعة طلبه',
      },
      {
        id: 'properties',
        step: locale === 'en' ? '3' : '٣',
        icon: Building2,
        title: locale === 'en' ? 'Properties' : 'العقارات',
        description:
          locale === 'en'
            ? 'Property parcel number verified against municipality records'
            : 'رقم العقار يُطابَق مع السجل العقاري للبلدية أثناء الكتابة',
      },
    ],
    [locale, isNonResident],
  );

  const [mobileStep, setMobileStep] = useState<SectionId>('personal');

  /** The form's outermost element — what a mobile step change scrolls back
   *  to. `window.scrollTo` was used here and did nothing: inside the admin
   *  shell the scroller is an inner `<main>`, not the document. */
  const formRootRef = useRef<HTMLDivElement | null>(null);

  const stepIndex = useMemo(
    () => sections.findIndex((s) => s.id === mobileStep),
    [sections, mobileStep],
  );

  const goToNextStep = useCallback(() => {
    const nextIdx = stepIndex + 1;
    if (nextIdx < sections.length) {
      setMobileStep(sections[nextIdx].id as SectionId);
      scrollElementToTop(formRootRef.current);
    }
  }, [stepIndex, sections]);

  const goToPrevStep = useCallback(() => {
    const prevIdx = stepIndex - 1;
    if (prevIdx >= 0) {
      setMobileStep(sections[prevIdx].id as SectionId);
      scrollElementToTop(formRootRef.current);
    }
  }, [stepIndex, sections]);

  function handleSubmit(withBlanketReason?: string) {
    const candidate = withBlanketReason
      ? { ...values, blanketFlagReason: withBlanketReason }
      : values;

    const errors = validate(candidate);
    setFieldErrors(errors);
    setShowErrors(true);

    if (Object.keys(errors).length > 0) {
      /*
        A quick save that still fails has failed for a reason the blanket
        reason is not allowed to cover — a missing surname, a discriminator, or
        a value that was entered and is wrong. The dialog closes so the officer
        can see which field the complaint landed on, because leaving it open
        over a form they cannot read is the one outcome that helps nobody.
      */
      if (withBlanketReason) setQuickSaveOpen(false);

      const firstInvalidSection = sections.find((s) => sectionInvalid(s.id));
      if (firstInvalidSection) {
        setMobileStep(firstInvalidSection.id as SectionId);
      }
      setTimeout(() => {
        document
          .querySelector('[data-section-invalid="true"]')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
      return;
    }

    setQuickSaveOpen(false);
    onSubmit(candidate);
  }

  /**
   * Roughly how many fields the blanket reason would be asked to cover.
   *
   * `askableFields` is the same list the «غير مؤكَّد» dialog offers, so this
   * counts the gaps a reviewer would actually see — an estimate stated as one,
   * because the authoritative answer is the server's `autoFlags` and this runs
   * on every keystroke.
   */
  const gapCount = useMemo(
    () =>
      askableFields(values).filter(
        (field) => !values.flags.has(field.path) && isBlank(valueAtPath(values, field.path)),
      ).length,
    [values],
  );

  return (
    <FieldFlagProvider value={flagging}>
    <div ref={formRootRef} className="space-y-4 pb-20 sm:space-y-5 sm:pb-0">
      {/* ── Desktop Section Nav (hidden on mobile) ── */}
      <nav
        aria-label={locale === 'en' ? 'Form sections' : 'أقسام النموذج'}
        className="sticky top-0 z-20 hidden sm:flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 bg-background/95 p-1.5 shadow-2xs backdrop-blur supports-[backdrop-filter]:bg-background/80"
      >
        <ul className="flex flex-wrap items-center gap-1.5">
          {sections.map((section) => {
            const Icon = section.icon;
            const invalid = sectionInvalid(section.id);
            const isActive = active === section.id;
            return (
              <li key={section.id}>
                <button
                  type="button"
                  onClick={() => jumpTo(section.id as SectionId)}
                  aria-current={isActive ? 'true' : undefined}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors select-none',
                    isActive
                      ? 'bg-primary text-primary-foreground shadow-2xs'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    invalid &&
                      !isActive &&
                      'border border-destructive/30 bg-destructive/10 text-destructive',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'rounded px-1 text-[10px] font-semibold',
                      isActive ? 'bg-primary-foreground/20' : 'bg-muted-foreground/10',
                    )}
                  >
                    {section.step}
                  </span>
                  <Icon className="size-3.5 shrink-0" aria-hidden />
                  <span className="whitespace-nowrap">
                    {section.id === 'properties'
                      ? `${section.title} (${values.properties.length})`
                      : section.title}
                  </span>
                  {invalid ? (
                    <TriangleAlert
                      className={cn(
                        'size-3 shrink-0',
                        isActive ? 'text-primary-foreground' : 'text-destructive',
                      )}
                      aria-hidden
                    />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setUnverifiedDialogOpen(true)}
          className={cn(
            'h-8 gap-1.5 px-2 sm:px-3 text-xs font-medium transition-colors shrink-0',
            values.flags.size > 0
              ? 'border-warning/50 bg-warning/10 text-warning hover:bg-warning/20'
              : 'text-muted-foreground hover:text-foreground',
          )}
          title={locale === 'en' ? 'Unverified Fields' : 'خانات غير مؤكَّدة'}
        >
          <FileQuestion className="size-3.5 shrink-0" aria-hidden />
          <span className="hidden sm:inline">
            {locale === 'en' ? 'Unverified Fields' : 'خانات غير مؤكَّدة'}
          </span>
          {values.flags.size > 0 ? (
            <span className="rounded-full bg-warning/20 px-1.5 py-0.5 text-[10px] font-bold text-warning">
              {values.flags.size}
            </span>
          ) : null}
        </Button>

        {duplicatesBar}
      </nav>

      {/* ── Mobile Step Header (visible on mobile only) ── */}
      <div className="sm:hidden space-y-2 sticky top-0 z-20 rounded-xl border border-border/80 bg-background/95 p-2 shadow-xs backdrop-blur">
        <div className="flex items-center justify-between text-xs font-semibold px-1">
          <span className="text-muted-foreground">
            {locale === 'en' ? `Step ${stepIndex + 1} of 3` : `الخطوة ${sections[stepIndex].step} من ٣`}
          </span>
          <span className="text-primary font-bold">{sections[stepIndex].title}</span>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {sections.map((section, idx) => {
            const isCurrent = mobileStep === section.id;
            const isCompleted = stepIndex > idx;
            const invalid = sectionInvalid(section.id);

            return (
              <button
                key={section.id}
                type="button"
                onClick={() => setMobileStep(section.id as SectionId)}
                className={cn(
                  'flex items-center justify-center gap-1 rounded-lg py-1.5 text-xs font-medium transition-all select-none',
                  isCurrent
                    ? 'bg-primary text-primary-foreground shadow-2xs font-semibold'
                    : isCompleted
                      ? 'bg-muted/70 text-foreground'
                      : 'bg-muted/30 text-muted-foreground',
                  invalid && !isCurrent && 'border border-destructive/40 text-destructive',
                )}
              >
                <span>{section.step}.</span>
                <span className="truncate">{section.title}</span>
                {invalid ? (
                  <TriangleAlert className="size-3 shrink-0 text-destructive" />
                ) : null}
              </button>
            );
          })}
        </div>

        {duplicatesBar}
      </div>

      {/* ── Mobile View: Active Step Only ── */}
      <div className="block space-y-4 sm:hidden">
        {mobileStep === 'personal' && (
          <FormSection
            /*
              `-step`, so this copy and the desktop one below do not both
              answer to `personal`.

              Both layouts are in the DOM at once — `sm:hidden` and
              `hidden sm:block` are CSS, not removal — and this block comes
              first, so `document.getElementById('personal')` was returning
              *this* element on a desktop screen, where it has no layout box.
              That is why the jump bar's first pill never highlighted and never
              scrolled: the observer was watching, and `jumpTo` was scrolling
              to, an element that is `display:none` on the only layout that has
              a jump bar. The canonical ids now belong to the desktop column,
              which is the column that uses them.
            */
            id="personal-step"
            step={locale === 'en' ? '1' : '١'}
            icon={IdCard}
            title={sections[0].title}
            description={sections[0].description}
            invalid={sectionInvalid('personal')}
          >
            <ResidenceChooser value={values.residence ?? 'RESIDENT'} onChange={setResidence} locale={locale} />
            {isNonResident ? (
              <OwnerPersonalStep value={values.personal} errors={shown} onChange={(personal) => update({ personal })} locale={locale} />
            ) : (
              <PersonalStep value={values.personal} errors={shown} onChange={(personal) => update({ personal })} locale={locale} />
            )}
          </FormSection>
        )}

        {mobileStep === 'contact' && (
          <FormSection
            // `-step` — see the personal section above.
            id="contact-step"
            step={locale === 'en' ? '2' : '٢'}
            icon={UsersRound}
            title={sections[1].title}
            description={sections[1].description}
            invalid={sectionInvalid('contact')}
          >
            {isNonResident ? (
              <OwnerContactStep value={values.contact} errors={shown} onChange={(contact) => update({ contact })} locale={locale} afterPhone={duplicatesPanel} />
            ) : (
              <ContactStep value={values.contact} errors={shown} onChange={(contact) => update({ contact })} locale={locale} afterPhone={duplicatesPanel} />
            )}
          </FormSection>
        )}

        {mobileStep === 'properties' && (
          <FormSection
            // `-step` — see the personal section above.
            id="properties-step"
            step={locale === 'en' ? '3' : '٣'}
            icon={Building2}
            title={
              locale === 'en'
                ? `Properties (${values.properties.length})`
                : `العقارات (${values.properties.length})`
            }
            description={
              locale === 'en'
                ? 'Property parcel number verified against municipality records'
                : 'رقم العقار يُطابَق مع السجل العقاري للبلدية أثناء الكتابة'
            }
            invalid={sectionInvalid('properties')}
          >
            <div className="space-y-4">
              {values.properties.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground">
                  {locale === 'en'
                    ? 'No property to add? Leave this empty for a citizen who owns nothing and only rents.'
                    : 'لا يملك المواطن أي عقار؟ يمكن ترك هذا القسم فارغاً إذا كان يستأجر فقط.'}
                </p>
              ) : null}

              {renderPropertyGroups()}

              {mode === 'edit' && values.properties.some((property) => property.id) ? (
                <p className="rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs">
                  {locale === 'en'
                    ? 'Deleting a registered property will also delete associated attachments (title deed or lease).'
                    : 'حذف عقار مسجّل يحذف معه المستندات المرفقة به (سند الملكية أو عقد الإيجار).'}
                </p>
              ) : null}

              <Button
                variant="outline"
                size="sm"
                onClick={() => addProperty()}
                className="w-full border-dashed border-primary/60 text-primary hover:bg-primary/5 h-9 text-xs sm:text-sm font-medium"
              >
                <Plus className="size-4" aria-hidden />
                {locale === 'en'
                  ? values.properties.length === 0
                    ? 'Add Property'
                    : 'Add Another Property'
                  : values.properties.length === 0
                    ? 'إضافة عقار'
                    : 'إضافة عقار آخر'}
              </Button>
            </div>
          </FormSection>
        )}

        {/*
          Outside the step switch on purpose — this is what puts «ملاحظات»
          under all three steps rather than only after the last one. One
          instance, so the three steps share a single box and a note typed in
          العقارات is still there when the officer steps back to البيانات
          الشخصية to fix a surname.
        */}
        <StepNotesField
          value={values.notes ?? ''}
          error={shown['notes']}
          onChange={(notes) => update({ notes })}
          locale={locale}
        />
      </div>

      {/* ── Desktop View: All Sections Sequentially ── */}
      <div className="hidden sm:block space-y-5">
        <FormSection
          id="personal"
          step={locale === 'en' ? '1' : '١'}
          icon={IdCard}
          title={sections[0].title}
          description={sections[0].description}
          invalid={sectionInvalid('personal')}
        >
          <ResidenceChooser value={values.residence ?? 'RESIDENT'} onChange={setResidence} locale={locale} />
          {isNonResident ? (
            <OwnerPersonalStep value={values.personal} errors={shown} onChange={(personal) => update({ personal })} locale={locale} />
          ) : (
            <PersonalStep value={values.personal} errors={shown} onChange={(personal) => update({ personal })} locale={locale} />
          )}
        </FormSection>

        <FormSection
          id="contact"
          step={locale === 'en' ? '2' : '٢'}
          icon={UsersRound}
          title={sections[1].title}
          description={sections[1].description}
          invalid={sectionInvalid('contact')}
        >
          {isNonResident ? (
            <OwnerContactStep value={values.contact} errors={shown} onChange={(contact) => update({ contact })} locale={locale} afterPhone={duplicatesPanel} />
          ) : (
            <ContactStep value={values.contact} errors={shown} onChange={(contact) => update({ contact })} locale={locale} afterPhone={duplicatesPanel} />
          )}
        </FormSection>

        <FormSection
          id="properties"
          step={locale === 'en' ? '3' : '٣'}
          icon={Building2}
          title={
            locale === 'en'
              ? `Properties (${values.properties.length})`
              : `العقارات (${values.properties.length})`
          }
          description={
            locale === 'en'
              ? 'Property parcel number verified against municipality records'
              : 'رقم العقار يُطابَق مع السجل العقاري للبلدية أثناء الكتابة'
          }
          invalid={sectionInvalid('properties')}
        >
          <div className="space-y-4">
            {values.properties.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground">
                {locale === 'en'
                  ? 'No property to add? Leave this empty for a citizen who owns nothing and only rents.'
                  : 'لا يملك المواطن أي عقار؟ يمكن ترك هذا القسم فارغاً إذا كان يستأجر فقط.'}
              </p>
            ) : null}

            {renderPropertyGroups()}

            {mode === 'edit' && values.properties.some((property) => property.id) ? (
              <p className="rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs">
                {locale === 'en'
                  ? 'Deleting a registered property will also delete associated attachments (title deed or lease).'
                  : 'حذف عقار مسجّل يحذف معه المستندات المرفقة به (سند الملكية أو عقد الإيجار).'}
              </p>
            ) : null}

            <Button
              variant="outline"
              size="sm"
              onClick={() => addProperty()}
              className="w-full border-dashed border-primary/60 text-primary hover:bg-primary/5 h-9 text-xs sm:text-sm font-medium"
            >
              <Plus className="size-4" aria-hidden />
              {locale === 'en'
                ? values.properties.length === 0
                  ? 'Add Property'
                  : 'Add Another Property'
                : values.properties.length === 0
                  ? 'إضافة عقار'
                  : 'إضافة عقار آخر'}
            </Button>
          </div>
        </FormSection>

        {/*
          «ملاحظات» — the back of the paper form.

          Deliberately *not* a fourth entry in `SECTIONS`. That array drives the
          wizard's step nav, its «الخطوة ٣ من ٣» counter and the next/back
          buttons, and a field nobody is required to fill in must not become a
          step somebody has to pass through. It sits after the last step, says
          «اختياري» where the others carry a number, and gates nothing.

          Not `blanketFlagReason`, which is the box officers were using for this
          because it was the only free text on the form. That one is a *reason
          data is missing*: it is copied onto every gap in the record and its
          presence is part of what lands a registration at «يتطلب مراجعة», so
          writing «الأسرة تنتقل نهاية الشهر» into it flags a clean record for
          review and attaches that sentence to fields it does not describe.
        */}
        <FormSection
          id="notes"
          step={locale === 'en' ? 'Optional' : 'اختياري'}
          icon={StickyNote}
          title={locale === 'en' ? 'Notes' : 'ملاحظات'}
          description={
            locale === 'en'
              ? 'Anything about this visit that no field above asks for.'
              : 'أي ملاحظة عن هذه الزيارة لا يسأل عنها أي حقل أعلاه.'
          }
          invalid={Boolean(shown['notes'])}
        >
          <Field
            label={locale === 'en' ? 'Notes' : 'ملاحظات'}
            /*
              `notes-input`, not `notes`. The `FormSection` card above already
              carries `id="notes"` as the page's scroll anchor, so the textarea
              was a second element with the same id and `htmlFor="notes"`
              resolved to the card — meaning tapping the label focused nothing.
            */
            htmlFor="notes-input"
            error={shown['notes']}
            hint={
              locale === 'en'
                ? 'Optional. Does not flag the record or change its status.'
                : 'اختياري. لا يضع علامة على السجل ولا يغيّر حالته.'
            }
          >
            <Textarea
              id="notes-input"
              rows={3}
              maxLength={2000}
              placeholder={
                locale === 'en'
                  ? 'e.g. the family is moving at the end of the month; the stairs are broken, use the back entrance.'
                  : 'مثال: الأسرة تنتقل نهاية الشهر · الدرج مكسور، الزيارة القادمة من الخلف.'
              }
              value={values.notes ?? ''}
              onChange={(event) => update({ notes: event.target.value })}
            />
          </Field>
        </FormSection>
      </div>

      {/* ── Mobile Sticky Bottom Action Bar ── */}
      {/* Padded past the home indicator: without it the save row is the strip
          of screen iOS reserves for its own gesture, and every tap there is a
          swipe up instead. */}
      <div className="fixed bottom-0 left-0 right-0 z-40 block sm:hidden border-t border-border/80 bg-background/95 p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] shadow-2xl backdrop-blur supports-[backdrop-filter]:bg-background/90">
        <div className="flex items-center justify-between gap-2">
          {stepIndex > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={goToPrevStep}
              className="h-10 px-3 text-xs font-semibold gap-1 shrink-0"
            >
              <ArrowRight className="size-4 rtl:rotate-180" />
              <span>{locale === 'en' ? 'Back' : 'السابق'}</span>
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCancel}
              className="h-10 px-3 text-xs text-muted-foreground shrink-0"
            >
              {locale === 'en' ? 'Cancel' : 'إلغاء'}
            </Button>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setUnverifiedDialogOpen(true)}
            className={cn(
              'h-10 px-2.5 text-xs font-medium gap-1 flex-1 max-w-[150px] truncate',
              values.flags.size > 0 && 'border-warning/50 bg-warning/10 text-warning',
            )}
          >
            <FileQuestion className="size-3.5 shrink-0" />
            <span className="truncate">{locale === 'en' ? 'Unverified' : 'غير مؤكَّد'}</span>
            {values.flags.size > 0 ? (
              <span className="rounded-full bg-warning/20 px-1.5 py-0.2 text-[10px] font-bold text-warning">
                {values.flags.size}
              </span>
            ) : null}
          </Button>

          {/*
            Quick save sits next to «غير مؤكَّد» because they are the same
            decision at two scales: one field the officer could not establish,
            or a visit that produced almost nothing.

            Offered on a correction as well, so the two forms carry the same
            controls in the same places — a bar that loses a button between the
            screen you register on and the screen you fix a record on is the
            difference this section exists to remove. It is worth knowing what
            it now allows that it did not: a blanket reason on an *edit* excuses
            gaps in a record that has already been reviewed once, which is a
            broader claim than the same button makes on a first filing. The
            dialog still names the count and still writes the reason onto every
            gap it covers, so what was claimed and by whom stays on the file.
          */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setQuickSaveOpen(true)}
            disabled={submitting}
            className="h-10 shrink-0 gap-1 px-2.5 text-xs font-medium"
          >
            <Zap className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{locale === 'en' ? 'Quick save' : 'حفظ سريع'}</span>
          </Button>

          {stepIndex < sections.length - 1 ? (
            <Button
              type="button"
              size="sm"
              onClick={goToNextStep}
              className="h-10 px-4 text-xs font-semibold gap-1 bg-primary text-primary-foreground shadow-sm shrink-0"
            >
              <span>{locale === 'en' ? 'Next' : 'التالي'}</span>
              <ArrowLeft className="size-4 rtl:rotate-180" />
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => handleSubmit()}
              disabled={submitting}
              className="h-10 px-4 text-xs font-semibold gap-1.5 bg-primary text-primary-foreground shadow-sm shrink-0"
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : offline ? (
                <CloudOff className="size-4" />
              ) : (
                <Save className="size-4" />
              )}
              <span>
                {offline
                  ? locale === 'en'
                    ? 'Save'
                    : 'حفظ'
                  : locale === 'en'
                    ? 'Save & Create'
                    : 'حفظ وإنشاء'}
              </span>
            </Button>
          )}
        </div>
      </div>

      {/* ── Desktop Fixed Bottom Actions Bar ── */}
      <div className="sticky bottom-0 z-30 hidden sm:block -mx-4 -mb-6 mt-8 border-t border-border/80 bg-background/95 px-4 py-3 shadow-md backdrop-blur supports-[backdrop-filter]:bg-background/85 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        {error ? (
          <p
            role="alert"
            className="mb-2.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}

        {messages.length > 0 ? (
          <div
            role="alert"
            className="mb-2.5 space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
          >
            <p className="flex items-center gap-1.5 font-semibold">
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
              {locale === 'en'
                ? 'Please correct the following fields before saving:'
                : 'يرجى إكمال وتصحيح الحقول التالية قبل الحفظ:'}
            </p>
            <ul className="list-inside list-disc ps-1 grid gap-0.5 sm:grid-cols-2">
              {messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {flagSummary.length > 0 ? (
          <div className="mb-2.5 space-y-1.5 rounded-lg border border-warning/40 bg-warning/5 p-2.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 font-semibold text-warning">
                <FileQuestion className="size-3.5 shrink-0" aria-hidden />
                {locale === 'en'
                  ? `Saving with ${flagSummary.length} unverified field(s) — marked "Requires Review".`
                  : `سيُحفظ السجل مع ${flagSummary.length} خانة غير مؤكَّدة بحالة «يتطلب مراجعة».`}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setUnverifiedDialogOpen(true)}
                className="h-6 px-2 text-[11px] text-warning hover:bg-warning/15 hover:text-warning"
              >
                {locale === 'en' ? 'Manage' : 'تعديل الخانات'}
              </Button>
            </div>
            <ul className="grid gap-0.5 ps-1 sm:grid-cols-2">
              {flagSummary.map((flag) => (
                <li key={flag.path} className="truncate text-muted-foreground">
                  <span className="font-medium text-foreground">{flag.label}</span>
                  {flag.reason ? ` — ${flag.reason}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className={cn(
                'inline-block size-2 rounded-full',
                offline ? 'bg-warning' : 'bg-primary/60',
              )}
            />
            <span>
              {offline
                ? locale === 'en'
                  ? 'Offline — this record will be stored on this device and synced automatically'
                  : 'بدون اتصال — سيُحفظ السجل على هذا الجهاز ويُرسل تلقائياً عند عودة الشبكة'
                : mode === 'edit'
                  ? (locale === 'en' ? 'Editing citizen record' : 'تعديل بيانات المواطن')
                  : (locale === 'en' ? 'New citizen registration' : 'تسجيل مواطن جديد')}
            </span>
          </div>

          <div className="flex items-center gap-2.5 ms-auto">
            {/* Both modes, for the reason the mobile bar above gives. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setQuickSaveOpen(true)}
              disabled={submitting}
              className="h-8 gap-1.5 rounded-lg px-4 text-xs font-medium"
            >
              <Zap className="size-3.5" aria-hidden />
              {locale === 'en' ? 'Quick save' : 'حفظ سريع'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={submitting}
              className="h-8 px-4 text-xs font-medium rounded-lg hover:bg-muted"
            >
              {locale === 'en' ? 'Cancel' : 'إلغاء'}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => handleSubmit()}
              disabled={submitting}
              className="h-8 px-4 text-xs font-medium rounded-lg shadow-2xs gap-1.5"
            >
              {submitting ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : offline ? (
                <CloudOff className="size-3.5" aria-hidden />
              ) : (
                <Save className="size-3.5" aria-hidden />
              )}
              {offline
                ? (locale === 'en' ? 'Save on This Device' : 'حفظ على الجهاز')
                : mode === 'edit'
                  ? (locale === 'en' ? 'Save Changes' : 'حفظ التعديلات')
                  : (locale === 'en' ? 'Save & Create' : 'حفظ وإنشاء')}
            </Button>
          </div>
        </div>
      </div>
    </div>

    <QuickSaveDialog
      open={quickSaveOpen}
      onOpenChange={setQuickSaveOpen}
      gapCount={gapCount}
      submitting={submitting}
      error={error}
      onConfirm={(reason) => handleSubmit(reason)}
      locale={locale}
    />

    {token && rosterParcel ? (
      <ParcelRosterDialog
        open
        onOpenChange={(next) => setRosterParcel(next ? rosterParcel : null)}
        tenant={tenant}
        token={token}
        propertyNumber={rosterParcel}
        locale={locale}
      />
    ) : null}

    <UnverifiedFieldsDialog
      open={unverifiedDialogOpen}
      onOpenChange={setUnverifiedDialogOpen}
      values={values}
      onSaveFlags={(newFlags) => {
        // Also prune fields from values if they are newly flagged
        setValues((current) => {
          let updated = { ...current, flags: newFlags };
          // If a field is newly flagged, clear its value in current state
          for (const path of newFlags.keys()) {
            const [section, ...rest] = path.split('.');
            if (section === 'personal' || section === 'contact') {
              const field = rest[0];
              const nextSec = { ...updated[section] };
              delete nextSec[field];
              updated = { ...updated, [section]: nextSec };
            } else if (section === 'properties') {
              const idx = Number(rest[0]);
              const field = rest[1];
              updated = {
                ...updated,
                properties: updated.properties.map((p, i) => {
                  if (i !== idx) return p;
                  const nextP = { ...p } as Record<string, unknown>;
                  delete nextP[field];
                  return nextP as PropertyDraft;
                }),
              };
            }
          }
          return updated;
        });
      }}
      locale={locale}
    />
    </FieldFlagProvider>
  );
}

/**
 * «من يُسجَّل؟» — a household that lives in the town, or an owner who does not.
 *
 * Asked as a question about **where the person lives most of the year**, never
 * about محل القيد: plenty of people registered in the town live in Beirut, and
 * an expatriate whose family is on the civil register here still lives abroad.
 * Somebody who lives in someone else's property is always a household — the
 * non-resident record holds what they own, and what they rent or occupy that
 * nobody lives in (`nonResidentCardIssues`).
 */
function ResidenceChooser({
  value,
  onChange,
  locale,
}: {
  value: CitizenResidence;
  onChange: (next: CitizenResidence) => void;
  locale: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  return (
    <div className="mb-4 space-y-2 rounded-lg border border-border/70 bg-muted/10 p-3">
      <Field
        label={en ? 'Does this person live in the town most of the year?' : 'هل يقيم هذا الشخص في البلدة معظم السنة؟'}
        htmlFor="residence"
        required
      >
        <SegmentedControl
          value={value}
          onChange={(next) => onChange(next as CitizenResidence)}
          options={[
            { value: 'RESIDENT', label: labels.citizenResidence.RESIDENT },
            { value: 'NON_RESIDENT_OWNER', label: labels.citizenResidence.NON_RESIDENT_OWNER },
          ]}
        />
      </Field>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {value === 'NON_RESIDENT_OWNER'
          ? en
            ? 'Lives elsewhere, and owns something here or rents a shop, office, clinic, warehouse or land here. Name, contact and place of residence only — no ID, household or blood type. Someone who rents a home here and lives in it is a household file.'
            : 'يقيم خارج البلدة، ويملك فيها عقاراً أو يستأجر فيها محلاً أو مكتباً أو عيادة أو مستودعاً أو أرضاً. الاسم ووسيلة التواصل ومكان الإقامة فقط — دون وثيقة أو بيانات أسرة أو فئة دم. من يستأجر مسكناً في البلدة ويسكنه يُسجَّل بملف أسرة.'
          : en
            ? 'A household file. Choose «Lives outside the town» for an owner who only visits, or someone who only works or farms here.'
            : 'ملف أسرة كامل. اختر «غير مقيم في البلدة» لمالك لا يأتي إلا زائراً، أو لمن يعمل أو يزرع في البلدة ويسكن خارجها.'}
      </p>
    </div>
  );
}

/**
 * «ملاحظات» on a phone — under every step, not parked after the last one.
 *
 * The desktop layout can afford to put this at the bottom of a long page: the
 * whole record is on one scroll, so "after العقارات" is somewhere an officer
 * passes anyway. A phone shows one step at a time, and the notes card lived
 * inside the `hidden sm:block` column — so on the device this form is actually
 * used on, in a stairwell, there was **no way to write a note at all**.
 *
 * What makes that expensive is *when* the note occurs to someone. It is never
 * at the end: it is «الدرج مكسور» while they are standing on the stairs, and
 * «الأسرة تنتقل نهاية الشهر» while the person is saying it, halfway through
 * البيانات الشخصية. A box reachable only from the last step asks them to hold
 * the sentence in their head across two «التالي» presses, and what actually
 * happened instead is that officers typed it into «سبب عام لنقص البيانات» —
 * the one free-text box that *was* reachable — which flags a clean record for
 * review and attaches the sentence to fields it does not describe.
 *
 * So it is rendered once, outside the step switch, and every step has it.
 *
 * ## Why it is not collapsed behind a tap
 *
 * A fold would buy back about 100px on a screen that already scrolls, and it
 * would cost the one property that makes this worth doing: that the box is
 * *there*, needing nothing, at the moment the sentence occurs. It is also the
 * last thing in the step, so the height it takes displaces nothing — an
 * officer reaches it after the step's own fields, on the way to «التالي».
 *
 * It stays visually quiet while empty — dashed, on the page's own tone — so
 * that being present on all three steps does not make it loud on all three.
 */
function StepNotesField({
  value,
  error,
  onChange,
  locale,
}: {
  value: string;
  error?: string;
  onChange: (notes: string) => void;
  locale: string;
}) {
  const en = locale === 'en';
  const written = value.trim().length > 0;

  return (
    <div
      /*
        Not `id="notes"`. The desktop card owns that, it comes *second* in the
        document, and `getElementById` returns the first match — so sharing the
        id would point the page's `notes` anchor at this element on desktop,
        where it is `display:none` and `scrollIntoView` is a silent no-op.
      */
      id="notes-mobile"
      className={cn(
        'scroll-mt-28 rounded-xl border p-3 transition-colors',
        error
          ? 'border-destructive/50 bg-destructive/5'
          : written
            ? 'border-border/80 bg-card shadow-2xs'
            : 'border-dashed border-border/70 bg-muted/10',
      )}
    >
      <Field
        label={en ? 'Notes' : 'ملاحظات'}
        htmlFor="notes-mobile-input"
        error={error}
        hint={
          en
            ? 'Anything this visit showed that no field above asks for. Does not flag the record.'
            : 'أي ما أظهرته هذه الزيارة ولا يسأل عنه أي حقل. لا يضع علامة على السجل.'
        }
      >
        <Textarea
          id="notes-mobile-input"
          rows={2}
          maxLength={2000}
          placeholder={
            en
              ? 'e.g. the stairs are broken — use the back entrance next time.'
              : 'مثال: الدرج مكسور، الزيارة القادمة من الخلف.'
          }
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
    </div>
  );
}

/**
 * One titled section of the form.
 */
function FormSection({
  id,
  step,
  icon: Icon,
  title,
  description,
  invalid,
  children,
}: {
  id: string;
  step: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  invalid: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card
      id={id}
      data-section-invalid={invalid || undefined}
      className={cn(
        'scroll-mt-24 rounded-xl border border-border/80 bg-card shadow-2xs overflow-hidden',
        invalid && 'border-destructive/50 ring-1 ring-destructive/20',
      )}
    >
      <CardHeader className="flex-row items-center gap-3 space-y-0 border-b border-border/60 bg-muted/10 px-4 py-3 sm:px-5">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20"
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
            <span
              aria-hidden
              className="rounded bg-muted px-1.5 py-0.5 text-xs font-semibold text-muted-foreground font-mono"
            >
              {step}
            </span>
            {title}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
      </CardHeader>
      <CardContent className="p-4 sm:p-5">{children}</CardContent>
    </Card>
  );
}

import { PROPERTY_FIELD_MAP } from '@mechanization/shared-schemas';
import type { CitizenFormValues } from './citizen-form-values';

/*
  Which fields the citizen form is asking about, and the bookkeeping that keeps
  a path-keyed map of flags in step with the cards it points at (GOD-22).

  Moved out of `components/admin/citizen-form.tsx` as it was: pure functions of
  the form's values, which the «خانات غير مؤكَّد» dialog and the review page read
  as well, and which had no test of their own.
*/

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
  /** Which flat of that card, for a per-flat field — «حالة الوحدة» on a مبنى. */
  unitIndex?: number;
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
    An estate asks the deceased's name and an institution its own; nothing
    else on either is required, so nothing else can be excused (0076).
  */
  if (values.residence === 'ESTATE' || values.residence === 'INSTITUTION') {
    const named: AskableField[] =
      values.residence === 'ESTATE'
        ? [
            { path: 'personal.firstName', field: 'firstName', section: 'personal' },
            { path: 'personal.middleName', field: 'middleName', section: 'personal' },
            { path: 'personal.lastName', field: 'lastName', section: 'personal' },
          ]
        : [{ path: 'personal.firstName', field: 'firstName', section: 'personal' }];
    return [...named, ...propertyAskableFields(values)];
  }
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
    { path: 'contact.maritalStatus', field: 'maritalStatus', section: 'contact' },
    { path: 'contact.totalRegisteredMembers', field: 'totalRegisteredMembers', section: 'contact' },
    { path: 'contact.actualHouseholdMembers', field: 'actualHouseholdMembers', section: 'contact' },
  );

  /*
    «لا يملك رقم هاتف» answers the phone question, so neither number is
    offered a «غير مؤكَّد» flag any more.

    A flag is an excuse for an answer the register still needs — the same
    reason «فئة الدم» is absent above. Leaving the phone flaggable here would
    put a finished record in «يتطلب مراجعة» over a field whose answer is
    «there is no number», and ask a reviewer to find one that does not exist.
  */
  if (values.contact.hasNoPhone !== true) {
    fields.push({ path: 'contact.phone', field: 'phone', section: 'contact' });

    if (values.contact.whatsappSameAsPhone === false) {
      fields.push({ path: 'contact.whatsapp', field: 'whatsapp', section: 'contact' });
    }
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

      حالة الوحدة is the exception since 2026-09-30: required of an owner on a
      منزل and on each flat of a مبنى, so it can be the reason a record is
      incomplete and has to be excusable — below. (It stays unasked on أرض,
      where it is still optional.)
    */
    if (property.occupancyType === 'OWNER' && property.propertyType === 'HOUSE') {
      fields.push({
        path: `properties.${propertyIndex}.unitStatus`,
        field: 'unitStatus',
        section: 'properties',
        propertyIndex,
      });
    }
    if (property.occupancyType === 'OWNER' && property.propertyType === 'BUILDING') {
      (property.units ?? []).forEach((_unit, unitIndex) => {
        fields.push({
          path: `properties.${propertyIndex}.units.${unitIndex}.unitStatus`,
          field: 'unitStatus',
          section: 'properties',
          propertyIndex,
          unitIndex,
        });
      });
    }
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
export function askablePaths(values: CitizenFormValues): Set<string> {
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
export function reindexFlags(flags: ReadonlyMap<string, string>, removed: number): Map<string, string> {
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
export function reindexRowFlags(
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

/**
 * The value at a dot-path, so the quick-save estimate can tell an empty field
 * from a filled one.
 *
 * Mirrors `valueAt` in `admin-citizen.schema.ts`, which is what the server
 * actually uses to decide. Written here rather than shared because the two walk
 * different shapes — this one the form's draft, that one the parsed submission
 * — which is also why the number is shown to the officer as an estimate.
 */
export function valueAtPath(values: CitizenFormValues, path: string): unknown {
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
export function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

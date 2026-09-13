import { z } from 'zod';
import {
  contactDetailsSchema,
  nonResidentOwnerContactSchema,
  nonResidentOwnerPersonalSchema,
  partialContactDetailsSchema,
  partialNonResidentOwnerContactSchema,
  partialNonResidentOwnerPersonalSchema,
  partialPersonalDetailsSchema,
  personalDetailsSchema,
} from './citizen.schema';
import {
  partialPropertyEntrySchema,
  propertyEntriesSchema,
  propertyEntrySchema,
  PROPERTY_FIELD_MAP,
} from './property.schema';
import {
  fieldFlagsSchema,
  flaggedPaths,
  isFlaggablePath,
  isUnestablished,
  issuePath,
  withoutFlagged,
  type FieldFlag,
} from './field-flag.schema';
import { uuid } from './primitives';
import {
  citizenResidenceSchema,
  isDwellingUnitType,
  NON_OWNER_OCCUPANCY,
  type CitizenResidence,
} from './enums';

/**
 * Staff-entered registrations — the same submission a citizen used to file
 * themselves, minus the two parts that only make sense when the citizen is the
 * one typing.
 *
 * `documentSlots` is gone because a clerk entering a claim from paper has no
 * browser `File` objects to attach, and `declarationAccepted` is gone because a
 * checkbox a clerk ticks on someone else's behalf is not an الإقرار — the
 * legal act belongs to the person whose data it is, and recording a staff tick
 * as though it were theirs would be worse than not recording one at all.
 *
 * Everything else is deliberately the *same schema object* the public wizard
 * validated against, not a parallel copy: the taxonomy rules (a tenant needs
 * units, a plot needs a land type, a tenant occupancy needs a landlord) are the
 * municipality's rules about property, not about who is holding the keyboard.
 */

/**
 * خيمة is only available to a لاجئ.
 *
 * Spans `personal` and `properties`, so — exactly as in
 * `submitRegistrationSchema` — it can only be checked at the top level where
 * both are in hand. Shared between create and update rather than written twice.
 */
function assertTentOnlyForRefugees(
  data: { personal: { residentStatus: string }; properties: Array<{ propertyType: string }> },
  ctx: z.RefinementCtx,
): void {
  if (data.personal.residentStatus === 'REFUGEE') return;

  data.properties.forEach((property, index) => {
    if (property.propertyType === 'TENT') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['properties', index, 'propertyType'],
        message: 'الخيمة متاحة لصفة الإقامة «لاجئ» فقط',
      });
    }
  });
}

/** A staff member filing a new citizen and their first registration. */
export const adminCreateCitizenSchema = z
  .object({
    personal: personalDetailsSchema,
    contact: contactDetailsSchema,
    properties: propertyEntriesSchema,
  })
  .superRefine(assertTentOnlyForRefugees);

export type AdminCreateCitizen = z.infer<typeof adminCreateCitizenSchema>;

/**
 * A property card that may already exist.
 *
 * `id` present means "this is the row you already have, changed"; absent means
 * "this is new". An id the citizen's registration does not own is rejected
 * server-side rather than silently adopted — see `CitizensService.update`.
 */
export const identifiedPropertyEntrySchema = z.intersection(
  propertyEntrySchema,
  z.object({ id: uuid.optional() }),
);

export type IdentifiedPropertyEntry = z.infer<typeof identifiedPropertyEntrySchema>;

/**
 * A staff member correcting a citizen already on file.
 *
 * The whole record is sent, not a patch: the admin form is a single page
 * showing every field at once, so "what is on screen" and "what should be
 * stored" are the same thing — and a diff computed in the browser is one more
 * place for the two to disagree.
 */
export const adminUpdateCitizenSchema = z
  .object({
    personal: personalDetailsSchema,
    contact: contactDetailsSchema,
    properties: z
      .array(identifiedPropertyEntrySchema)
      .max(25, 'عدد العقارات كبير جداً — يرجى مراجعة البلدية'),
  })
  .superRefine(assertTentOnlyForRefugees);

export type AdminUpdateCitizen = z.infer<typeof adminUpdateCitizenSchema>;

// ───────────────  Submissions carrying «غير مؤكَّد» flags  ───────────────

/**
 * The wire shape of a staff submission that may leave fields unestablished.
 *
 * The two schemas above are unchanged and are still the only statement of what
 * a *complete* record looks like. What is new is who may decide that an
 * incomplete one is nonetheless worth storing: a field officer, one field at a
 * time, with a written reason attached to each.
 *
 * The mechanism is subtractive rather than a second, gentler rulebook. A
 * submission is validated by the strict schemas, in full; it is accepted when
 * **every complaint they raise lands on a field the officer flagged**. Nothing
 * is relaxed, no rule is restated in a weaker form, and a rule added to
 * `personalDetailsSchema` tomorrow applies to flagged submissions the same day.
 * All a flag can do is excuse one named field — never a neighbouring one,
 * never a whole section, and never one of `NON_FLAGGABLE_FIELDS`.
 *
 * The sections arrive as opaque records because they cannot be parsed by the
 * strict schemas before the flags are known: which field is excused is what
 * decides whether the parse should have failed at all.
 */
const rawSection = z.record(z.unknown());

/**
 * A card's fields, minus everything its نوع العقار does not have.
 *
 * The strict branch schemas already do this — `z.object` drops keys it does
 * not declare — so an out-of-branch leftover (a `side` still sitting on a card
 * switched from منزل to أرض) passes validation and is discarded. The partial
 * shape has no branches and would therefore *validate* that leftover, and a
 * long-irrelevant value could fail a card the strict pass had already cleared.
 * Filtering to the branch's own fields first is what keeps the two agreeing.
 */
function branchFieldsOnly(card: Record<string, unknown>): Record<string, unknown> {
  const branch = PROPERTY_FIELD_MAP[card.propertyType as keyof typeof PROPERTY_FIELD_MAP] ?? [];

  const keep = new Set<string>([
    'occupancyType',
    'propertyType',
    // أسهم are a share of ownership; a tenant's or free occupant's plot has none.
    ...branch.filter((field) => field !== 'shares' || card.occupancyType === 'OWNER'),
    /*
      Two fields gated on the *occupancy* axis, which `PROPERTY_FIELD_MAP` —
      keyed by property type — has no way to describe. Both are listed here for
      the same reason and neither is a special case of the other: the landlord
      block exists only for someone occupying another person's property, and
      حالة الوحدة exists only for the owner, who is the only person who can
      say a unit is empty. Omitting either from this set would not reject it;
      it would silently drop it on the way to `partialPropertyEntrySchema`,
      which is the quieter and worse failure.
    */
    ...((NON_OWNER_OCCUPANCY as readonly string[]).includes(card.occupancyType as string)
      ? ['landlordName', 'landlordPhone']
      : []),
    ...(card.occupancyType === 'OWNER' ? ['unitStatus'] : []),
    /*
      The census link, on the two types that can stand on a structure.

      Not in `PROPERTY_FIELD_MAP` on purpose: that map says which fields a card
      *renders and requires*, and `buildingId` is neither — it is a reference
      the picker sets and the officer never types. Listing it there would put a
      phantom field into the form's own branch logic and into `askableFields`.
      Kept here for the same reason `landlordName` is: omitting it would not
      reject it, it would silently drop it, which is the quieter failure.
    */
    ...(card.propertyType === 'BUILDING' || card.propertyType === 'HOUSE'
      ? ['buildingId']
      : []),
  ]);

  return Object.fromEntries(Object.entries(card).filter(([key]) => keep.has(key)));
}

interface SubmissionInput {
  residence: CitizenResidence;
  personal: Record<string, unknown>;
  contact: Record<string, unknown>;
  properties: Array<Record<string, unknown>>;
  flags: FieldFlag[];
  blanketFlagReason?: string;
  notes?: string;
  clientSubmissionId?: string;
}

/**
 * The most flags one record may end up carrying once the blanket reason has
 * filled in the gaps.
 *
 * Three times the hand-flagged ceiling, and it has to be: the point of a
 * blanket reason is the record an officer could barely start, and «الأسرة
 * غائبة والجيران لا يعرفون» legitimately accounts for thirty fields across
 * three property cards. The ceiling still exists for the same reason the
 * smaller one does — past it the record has stopped being a registration with
 * gaps and become a blank form with an excuse attached, which is a conversation
 * to have with the officer rather than a row to store.
 */
const MAX_FLAGS_WITH_BLANKET_REASON = 120;

/** The value at a dot-path, so an auto-flag can tell absent from merely wrong. */
function valueAt(input: SubmissionInput, path: string): unknown {
  const [head, ...rest] = path.split('.');
  let cursor: unknown =
    head === 'personal' ? input.personal : head === 'contact' ? input.contact : input.properties;

  for (const segment of rest) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Nothing was entered here — as against something wrong having been. */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim());
}

/**
 * The strict and the shaping schema for each section, by نوع الملف.
 *
 * One switch, read by every pass below, so a household file and a non-resident record
 * can never be validated by one rulebook and shaped by the other — that mismatch
 * would store fields a strict pass never looked at.
 */
function sectionSchemas(residence: CitizenResidence) {
  return residence === 'NON_RESIDENT_OWNER'
    ? {
        personal: nonResidentOwnerPersonalSchema,
        contact: nonResidentOwnerContactSchema,
        partialPersonal: partialNonResidentOwnerPersonalSchema,
        partialContact: partialNonResidentOwnerContactSchema,
      }
    : {
        personal: personalDetailsSchema,
        contact: contactDetailsSchema,
        partialPersonal: partialPersonalDetailsSchema,
        partialContact: partialContactDetailsSchema,
      };
}

/** Every path the strict schemas complain about, given what is already excused. */
function strictIssuePaths(input: SubmissionInput, excused: ReadonlySet<string>): string[] {
  const paths: string[] = [];
  const schemas = sectionSchemas(input.residence);

  const collect = (prefix: string, result: z.SafeParseReturnType<unknown, unknown>) => {
    if (result.success) return;
    for (const issue of result.error.issues) paths.push(issuePath(prefix, issue.path));
  };

  collect(
    'personal',
    schemas.personal.safeParse(withoutFlagged(input.personal, 'personal', excused)),
  );
  collect(
    'contact',
    schemas.contact.safeParse(withoutFlagged(input.contact, 'contact', excused)),
  );
  input.properties.forEach((card, index) => {
    const prefix = `properties.${index}`;
    collect(prefix, propertyEntrySchema.safeParse(withoutFlagged(card, prefix, excused)));
  });

  return paths;
}

/**
 * «سبب عام لنقص البيانات» — the officer's one reason, spread across the fields
 * it actually accounts for.
 *
 * D12, and the emphasis is the whole of it: the blanket reason **fills in**
 * per-field flags as a default, it does not replace them. One sentence attached
 * to a record with thirty holes in it leaves the reviewer nothing actionable —
 * they cannot tell which thirty. Thirty flags each carrying that sentence say
 * exactly which fields are missing *and* why, and each stays individually
 * overridable by an officer who has a better reason for one of them.
 *
 * Two limits on what it may cover, and both are load-bearing:
 *
 *  - **Only flaggable paths.** `isFlaggablePath` already refuses the name and
 *    the three discriminators, so a blanket reason cannot register a person
 *    with no surname, or a property card whose type nobody chose. A record that
 *    could not answer those is not a record with gaps; it is not a record.
 *
 *  - **Only fields that are actually empty.** A value that *was* entered and is
 *    invalid — a malformed phone number, an area of "abc" — is a typo to
 *    correct, not missing data to excuse. Auto-flagging it would blank what the
 *    officer typed and hide the mistake behind a reason that does not describe
 *    it. Those still fail, and the officer fixes them.
 */
function autoFlags(input: SubmissionInput, explicit: ReadonlySet<string>): FieldFlag[] {
  const reason = input.blanketFlagReason?.trim();
  if (!reason) return [];

  const flags: FieldFlag[] = [];
  const seen = new Set<string>();

  for (const path of strictIssuePaths(input, explicit)) {
    if (explicit.has(path) || seen.has(path)) continue;
    if (!isFlaggablePath(path)) continue;
    if (!isAbsent(valueAt(input, path))) continue;

    seen.add(path);
    flags.push({ path, reason, kind: 'UNESTABLISHED' });
  }

  return flags;
}

/**
 * Every flag this submission carries — the officer's own, plus whatever the
 * blanket reason filled in.
 *
 * Recomputed rather than passed along, and computed identically by
 * `unexcusedIssues` and `shapeSubmission`, because Zod's `superRefine` has no
 * way to hand a value to the `transform` that follows it. Both passes see the
 * same input and the function is pure, so they cannot disagree.
 */
function allFlags(input: SubmissionInput): FieldFlag[] {
  const explicit = flaggedPaths(input.flags);
  return [...input.flags, ...autoFlags(input, explicit)];
}

/**
 * What a non-resident's card may say — «غير مقيم في البلدة».
 *
 * A person who lives outside the town may **own** anything here, and may
 * **rent or occupy only what nobody lives in**: a محل، مكتب، عيادة، مستودع, or a
 * plot of أرض. Both halves follow from one fact — they do not live here:
 *
 *  - a مستأجر or شاغل بتسامح of a شقة or منزل *lives in it*, so they are a
 *    household in the town and belong on a household file (and in the
 *    population it counts). If they rent it and do not live in it, the unit is
 *    being used as an office or a store, and its type is what is wrong — which
 *    also changes the rental-value rate (Law 60/1988, Art. 12);
 *  - an owner of a dwelling cannot answer «مشغولة من المالك» for the same
 *    reason. The true answers for a home its owner visits are «مسكن موسمي»,
 *    «شاغرة», or who else is in it.
 *
 * A خيمة is refused elsewhere (it is for a لاجئ, and this record asks no صفة
 * الإقامة). Returned as issues rather than reported directly so each lands on
 * the field that has to change: نوع الإشغال (not flaggable), a unit's نوع الوحدة,
 * or حالة الوحدة.
 *
 * A unit whose type is unknown — its row flagged, or the whole unit list
 * flagged — cannot be shown to be something nobody lives in, so a non-owner
 * card needs at least one unit and every unit's type. That is not a dead end:
 * the officer at a shop can see it is a shop.
 */
function nonResidentCardIssues(
  card: Record<string, unknown>,
  flagged: ReadonlySet<string>,
  prefix: string,
): Array<{ path: Array<string | number>; message: string }> {
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  const owner = card.occupancyType === 'OWNER';
  const units = Array.isArray(card.units) ? (card.units as Array<Record<string, unknown>>) : [];

  if (owner) {
    if (card.propertyType === 'HOUSE' && card.unitStatus === 'OWNER_OCCUPIED') {
      issues.push({ path: ['unitStatus'], message: OWNER_NOT_LIVING_THERE });
    }
    if (card.propertyType === 'BUILDING') {
      units.forEach((unit, unitIndex) => {
        if (isDwellingUnitType(unit.unitType as string) && unit.unitStatus === 'OWNER_OCCUPIED') {
          issues.push({ path: ['units', unitIndex, 'unitStatus'], message: OWNER_NOT_LIVING_THERE });
        }
      });
    }
    return issues;
  }

  if (card.occupancyType === undefined) return issues;

  switch (card.propertyType) {
    case 'LAND':
      return issues;
    case 'BUILDING': {
      if (units.length === 0 || flagged.has(`${prefix}.units`)) {
        issues.push({ path: ['occupancyType'], message: NON_RESIDENT_NEEDS_UNIT_TYPE });
        return issues;
      }
      units.forEach((unit, unitIndex) => {
        if (unit.unitType === undefined || unit.unitType === null || unit.unitType === '') {
          issues.push({ path: ['units', unitIndex, 'unitType'], message: NON_RESIDENT_NEEDS_UNIT_TYPE });
        } else if (isDwellingUnitType(unit.unitType as string)) {
          issues.push({ path: ['units', unitIndex, 'unitType'], message: NON_RESIDENT_DWELLING });
        }
      });
      return issues;
    }
    default:
      // A منزل is a dwelling, and a خيمة is somewhere somebody lives.
      issues.push({ path: ['occupancyType'], message: NON_RESIDENT_DWELLING });
      return issues;
  }
}

const NON_RESIDENT_DWELLING =
  'غير المقيم يستأجر أو يشغل ما لا يُسكن فقط (محل، مكتب، عيادة، مستودع، أرض). من يستأجر مسكناً ويسكنه يُسجَّل بملف أسرة، ومن يستعمله لغير السكن تُصحَّح نوع وحدته';
const NON_RESIDENT_NEEDS_UNIT_TYPE =
  'حدِّد نوع الوحدة — غير المقيم يُسجَّل مستأجراً أو شاغلاً لوحدة غير سكنية فقط';
const OWNER_NOT_LIVING_THERE =
  'غير المقيم لا يسكن هذه الوحدة — اختر «مسكن موسمي» إن كان يحضر في مواسم، أو «شاغرة»، أو حالة من يشغلها';

/** Every issue the strict schemas raise that no flag accounts for. */
function unexcusedIssues(input: SubmissionInput, ctx: z.RefinementCtx): void {
  const flags = allFlags(input);
  const paths = flaggedPaths(flags);

  if (flags.length > MAX_FLAGS_WITH_BLANKET_REASON) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['blanketFlagReason'],
      message: 'عدد الحقول غير المؤكَّدة كبير جداً — يرجى استكمال البيانات',
    });
    return;
  }

  const report = (prefix: string, result: z.SafeParseReturnType<unknown, unknown>) => {
    if (result.success) return;
    for (const issue of result.error.issues) {
      if (paths.has(issuePath(prefix, issue.path))) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...prefix.split('.'), ...issue.path],
        message: issue.message,
      });
    }
  };

  const schemas = sectionSchemas(input.residence);

  report(
    'personal',
    schemas.personal.safeParse(withoutFlagged(input.personal, 'personal', paths)),
  );
  report('contact', schemas.contact.safeParse(withoutFlagged(input.contact, 'contact', paths)));

  input.properties.forEach((card, index) => {
    const prefix = `properties.${index}`;
    report(prefix, propertyEntrySchema.safeParse(withoutFlagged(card, prefix, paths)));
  });

  if (input.residence === 'NON_RESIDENT_OWNER') {
    input.properties.forEach((card, index) => {
      for (const issue of nonResidentCardIssues(card, paths, `properties.${index}`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['properties', index, ...issue.path],
          message: issue.message,
        });
      }
    });
  }

  /*
    خيمة is only for a لاجئ — but only answerable while صفة الإقامة is known.

    Flagged, it is not: the officer has said they could not establish it, and
    refusing a tent on the strength of a status nobody has recorded would turn
    a flag on one field into a rejection of another. The rule re-applies the
    moment someone fills the status in, because it lives in the strict schema
    every later save runs through.
  */
  if (paths.has('personal.residentStatus')) return;

  input.properties.forEach((card, index) => {
    if (card.propertyType === 'TENT' && input.personal.residentStatus !== 'REFUGEE') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['properties', index, 'propertyType'],
        message: 'الخيمة متاحة لصفة الإقامة «لاجئ» فقط',
      });
    }
  });
}

/**
 * Coerces and normalises what survived, dropping every flagged value.
 *
 * Only reachable once `unexcusedIssues` found nothing, which is what makes the
 * `parse` calls here safe: every field still present has already been validated
 * by the strict schema against the identical field rule, so the partial schemas
 * cannot fail on it. Their job is the coercion the strict pass would have done
 * — a phone to E.164, an area to a number — for a record it could not return
 * because it had (correctly) refused it.
 */
function shapeSubmission(input: SubmissionInput) {
  /*
    The blanket reason's flags blank their fields too.

    They are flags in every sense — same kind, same reason string, same
    per-field granularity — so the field each one names is emptied exactly as an
    officer's own flag empties it. Using only `input.flags` here would store the
    half-typed value the officer left behind on a field the record has just
    declared unestablished.
  */
  const flags = allFlags(input);
  const paths = flaggedPaths(flags);
  const schemas = sectionSchemas(input.residence);

  return {
    residence: input.residence,
    /*
      Cast to the household shape because every consumer reads the sections by
      field name and treats each one as possibly absent — which, for an owner
      record, every household field is. Typing the union out would push a
      `'residencePlace' in personal` check into every reader for no safety the
      optional fields do not already give.
    */
    personal: schemas.partialPersonal.parse(
      withoutFlagged(input.personal, 'personal', paths),
    ) as z.infer<typeof partialPersonalDetailsSchema> & { residencePlace?: string },
    contact: schemas.partialContact.parse(
      withoutFlagged(input.contact, 'contact', paths),
    ) as z.infer<typeof partialContactDetailsSchema> & {
      localContactName?: string;
      localContactPhone?: string;
    },
    properties: input.properties.map((card, index) => {
      const id = typeof card.id === 'string' ? card.id : undefined;
      return {
        ...(id ? { id } : {}),
        ...partialPropertyEntrySchema.parse(
          branchFieldsOnly(withoutFlagged(card, `properties.${index}`, paths)),
        ),
      };
    }),
    /**
     * Kept on the record alongside the per-field flags it produced.
     *
     * Redundant with them by design: every flag already carries the sentence,
     * and this is the statement that they came from one. It is what lets a
     * reviewer tell «the officer wrote one reason for the whole visit» from
     * «the officer wrote the same sentence thirty times», which are different
     * conversations to have with them.
     */
    blanketFlagReason: input.blanketFlagReason?.trim() || undefined,
    /*
      Carried through untouched, and emptied to `undefined` rather than kept as
      `''`: a note somebody opened and closed without typing is not a note, and
      storing the empty string would make «هل هناك ملاحظة؟» answerable only by
      checking its length.
    */
    notes: input.notes?.trim() || undefined,
    /*
      Only the officer's own flags survive the wire.

      `UNVERIFIED` says "this value exists and the municipality's records do not
      confirm it", which is a claim only something holding those records can
      make. Accepting one from a browser would let a client mark its own record
      reviewed-and-fine, or — the likelier accident — replay a stale cadastre
      verdict from a phone that queued the record days before the parcel was
      imported. The server re-derives them on every write instead.
    */
    flags: allFlags(input).filter(isUnestablished),
    clientSubmissionId: input.clientSubmissionId,
  };
}

/**
 * `clientSubmissionId` — the browser's own name for this submission.
 *
 * A record filed offline is given an id before it is ever sent, and that id
 * travels with every retry. It is what makes syncing safe to repeat: a queued
 * record whose response was lost to the same bad connection that queued it is
 * re-sent, recognised, and answered with the registration it already created
 * rather than registering the person a second time.
 */
const submissionEnvelope = {
  /**
   * نوع الملف — a household living in the town, or an owner who lives
   * elsewhere. Defaulted so every submission already queued on a phone, and
   * every client that predates the field, keeps meaning what it meant.
   */
  residence: citizenResidenceSchema.default('RESIDENT'),
  personal: rawSection,
  contact: rawSection,
  flags: fieldFlagsSchema,
  /**
   * «سبب عام لنقص البيانات» — one reason for the whole visit.
   *
   * The same four-character floor the per-field reason has, and for the same
   * reason: «لا» records that somebody pressed the button, not why the data is
   * missing, and this one sentence is about to be copied onto every gap in the
   * record. See `autoFlags` for exactly which gaps it may cover — the name and
   * the three discriminators are not among them, and neither is a field whose
   * value is present but wrong.
   */
  blanketFlagReason: z
    .string()
    .trim()
    .min(4, 'يرجى ذكر سبب عدم اكتمال البيانات')
    .max(300, 'السبب طويل جداً')
    .optional(),
  /**
   * «ملاحظات» — whatever the officer needs to say that no field asks for.
   *
   * Free text and genuinely optional, which is the whole design: the form is a
   * long list of required answers, and the things that actually matter at a
   * doorstep are frequently not among them. «الأسرة تنتقل نهاية الشهر»،
   * «الدرج مكسور، الزيارة القادمة من الخلف»، «الأخ يدفع عن الوالدة» — each of
   * these used to be written on the back of a paper form and lost, or forced
   * into `blanketFlagReason`, which is a different thing entirely and carries
   * a consequence: that one propagates onto every gap in the record and lands
   * it at «يتطلب مراجعة». A note is a note. It flags nothing, excuses nothing,
   * and changes no status.
   *
   * Capped at 2000 rather than the 300 a flag reason gets. A reason has to fit
   * beside thirty field names; this is the only place on the record where
   * somebody can write a paragraph, and truncating it into uselessness is how
   * a notes field stops being used at all.
   */
  notes: z
    .string()
    .trim()
    .max(2000, 'الملاحظات طويلة جداً')
    .optional(),
  clientSubmissionId: uuid.optional(),
};

export const adminCreateCitizenSubmissionSchema = z
  .object({
    ...submissionEnvelope,
    properties: z
      .array(rawSection)
      .max(25, 'عدد العقارات كبير جداً — يرجى مراجعة البلدية'),
  })
  .superRefine(unexcusedIssues)
  .transform(shapeSubmission);

export type AdminCitizenSubmission = z.infer<typeof adminCreateCitizenSubmissionSchema>;

export const adminUpdateCitizenSubmissionSchema = z
  .object({
    ...submissionEnvelope,
    /**
     * `passthrough` rather than the bare record the create path uses: the id
     * is the one key on an editing card that has to be *checked* here, since
     * everything else is checked later against the strict schema. The rest of
     * the card still travels untouched, to be read by the same flag-aware pass.
     */
    properties: z
      .array(z.object({ id: uuid.optional() }).passthrough())
      .max(25, 'عدد العقارات كبير جداً — يرجى مراجعة البلدية'),
  })
  .superRefine(unexcusedIssues)
  .transform(shapeSubmission);

export type AdminCitizenUpdateSubmission = z.infer<typeof adminUpdateCitizenSubmissionSchema>;

/**
 * Where a filed record stands.
 *
 * `REQUIRES_REVIEW` is not a rejection and not a draft — the citizen is
 * registered, billable and searchable from the moment it is stored. It says
 * only that named parts of the record were never established, and that the
 * reasons why are attached for whoever completes it.
 */
export const CITIZEN_RECORD_STATUS = ['PENDING', 'REQUIRES_REVIEW'] as const;
export type CitizenRecordStatus = (typeof CITIZEN_RECORD_STATUS)[number];

/**
 * A record is «يتطلب مراجعة» exactly when something on it is still open —
 * a field the officer could not establish, or a value the municipality's own
 * records do not confirm. Both are work for a person; neither is a rejection.
 */
export function statusForFlags(flags: readonly FieldFlag[]): CitizenRecordStatus {
  return flags.length > 0 ? 'REQUIRES_REVIEW' : 'PENDING';
}

/**
 * What is said about a رقم العقار the cadastre has never heard of.
 *
 * Stored verbatim on the record, so the person who opens it next month reads
 * the same sentence whether the number was typed at a counter or queued on a
 * phone three days earlier.
 */
export const CADASTRE_UNVERIFIED_REASON =
  'رقم العقار غير مدرج في السجل العقاري للبلدية — يلزم مطابقته مع سند الملكية.';

/**
 * The `UNVERIFIED` flags a submission earns from the cadastre check.
 *
 * This replaced a hard rejection, and the reasoning is worth keeping next to
 * the code. A number absent from the cadastre is *usually* a typo — which is
 * why the check exists — but it is also, routinely, a parcel the survey office
 * has not imported yet, or one recorded under a different form of the same
 * number. Refusing the submission treats the first case as the only case, and
 * it does so at the worst possible moment: offline, the officer is told the
 * record will sync, walks out of the settlement, and the record fails on
 * arrival hours later with nobody there to retype it.
 *
 * So the number is kept exactly as the officer read it, the record is held at
 * «يتطلب مراجعة» with the reason attached, and the typo is caught by the same
 * person who would have had to catch it anyway — with the household's actual
 * data in front of them instead of a blank.
 *
 * A card whose number the officer already flagged `UNESTABLISHED` is skipped:
 * that field has no value to be unconfirmed about, and two flags on one path
 * is a contradiction the storage cannot express.
 */
export function cadastreFlags(
  properties: ReadonlyArray<{ propertyNumber?: string | null }>,
  missing: ReadonlySet<string>,
  officerFlags: readonly FieldFlag[] = [],
): FieldFlag[] {
  const alreadyFlagged = flaggedPaths(officerFlags);

  return properties.flatMap((property, index) => {
    const number = property.propertyNumber?.trim();
    if (!number || !missing.has(number)) return [];

    const path = `properties.${index}.propertyNumber`;
    if (alreadyFlagged.has(path)) return [];

    return [{ path, reason: CADASTRE_UNVERIFIED_REASON, kind: 'UNVERIFIED' as const }];
  });
}

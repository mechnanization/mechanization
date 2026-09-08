import { z } from 'zod';
import {
  contactDetailsSchema,
  partialContactDetailsSchema,
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
  isUnestablished,
  issuePath,
  withoutFlagged,
  type FieldFlag,
} from './field-flag.schema';
import { uuid } from './primitives';
import { NON_OWNER_OCCUPANCY } from './enums';

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
    ...branch,
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
  ]);

  return Object.fromEntries(Object.entries(card).filter(([key]) => keep.has(key)));
}

interface SubmissionInput {
  personal: Record<string, unknown>;
  contact: Record<string, unknown>;
  properties: Array<Record<string, unknown>>;
  flags: FieldFlag[];
  clientSubmissionId?: string;
}

/** Every issue the strict schemas raise that no flag accounts for. */
function unexcusedIssues(input: SubmissionInput, ctx: z.RefinementCtx): void {
  const paths = flaggedPaths(input.flags);

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

  report(
    'personal',
    personalDetailsSchema.safeParse(withoutFlagged(input.personal, 'personal', paths)),
  );
  report('contact', contactDetailsSchema.safeParse(withoutFlagged(input.contact, 'contact', paths)));

  input.properties.forEach((card, index) => {
    const prefix = `properties.${index}`;
    report(prefix, propertyEntrySchema.safeParse(withoutFlagged(card, prefix, paths)));
  });

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
  const paths = flaggedPaths(input.flags);

  return {
    personal: partialPersonalDetailsSchema.parse(withoutFlagged(input.personal, 'personal', paths)),
    contact: partialContactDetailsSchema.parse(withoutFlagged(input.contact, 'contact', paths)),
    properties: input.properties.map((card, index) => {
      const id = typeof card.id === 'string' ? card.id : undefined;
      return {
        ...(id ? { id } : {}),
        ...partialPropertyEntrySchema.parse(
          branchFieldsOnly(withoutFlagged(card, `properties.${index}`, paths)),
        ),
      };
    }),
    /*
      Only the officer's own flags survive the wire.

      `UNVERIFIED` says "this value exists and the municipality's records do not
      confirm it", which is a claim only something holding those records can
      make. Accepting one from a browser would let a client mark its own record
      reviewed-and-fine, or — the likelier accident — replay a stale cadastre
      verdict from a phone that queued the record days before the parcel was
      imported. The server re-derives them on every write instead.
    */
    flags: input.flags.filter(isUnestablished),
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
  personal: rawSection,
  contact: rawSection,
  flags: fieldFlagsSchema,
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

import { z } from 'zod';

/**
 * «غير مؤكَّد / بانتظار المعلومة» — a field the officer could not fill, with
 * their stated reason for it.
 *
 * A field officer standing in a tent settlement does not always leave with a
 * complete record: the deed is with a relative in another town, the parcel
 * number is on a paper nobody has today, the household has no phone. Before
 * this existed the form's only answers were "invent something" or "do not
 * register the person" — and the register was quietly getting the first one.
 *
 * So a flag is not a way around validation, it is a *recorded* exception: the
 * field is emptied rather than guessed at, the officer says in their own words
 * why, and the whole record lands as `REQUIRES_REVIEW` so it appears on a work
 * queue instead of dissolving into the register looking finished.
 *
 * There are two of those exceptions, and conflating them was a real bug.
 * `UNESTABLISHED` is the one above: nothing was learned, so the field is
 * blanked and the strict schema's complaint about it is excused. `UNVERIFIED`
 * is the opposite shape — a value *was* recorded and could not be confirmed
 * against the municipality's own records. A رقم العقار read off a title deed
 * that the imported cadastre has never heard of is the case that forced the
 * distinction: erasing it (the only thing the old single-semantic model could
 * do) throws away the best information anybody has about that household, and
 * refusing the record outright strands a registration on a phone in a
 * settlement nobody is going back to. So the number is kept, the record is
 * held at «يتطلب مراجعة» with the reason attached, and a human decides.
 *
 * Only an officer raises `UNESTABLISHED` — it is a statement about what they
 * did that afternoon. Only the server raises `UNVERIFIED`, because only the
 * server holds the cadastre to check against; a client-sent one is discarded
 * (`shapeSubmission`) and re-derived on every write, which is what lets a
 * record clear itself the day the missing parcel is finally imported.
 */

/** What kind of exception a flag records. See the note above. */
export const FIELD_FLAG_KINDS = ['UNESTABLISHED', 'UNVERIFIED'] as const;
export type FieldFlagKind = (typeof FIELD_FLAG_KINDS)[number];

/**
 * The fields a flag may never cover.
 *
 * Two different reasons, both structural rather than a judgement about how
 * important the field is:
 *
 *  - `firstName` / `lastName` are `NOT NULL` on `users`, and a record with no
 *    name cannot be searched for again — a "pending info" citizen nobody can
 *    find is worse than an unregistered one.
 *  - `isLebanese`, `occupancyType` and `propertyType` are the discriminators
 *    the rest of the form branches on. Unset, there is no answer to "which
 *    fields does this record even have", so there is nothing left to flag
 *    against. All three are answerable by looking at the person or the
 *    building, which is why they are the safe ones to insist on.
 */
export const NON_FLAGGABLE_FIELDS = [
  'firstName',
  'lastName',
  'isLebanese',
  'occupancyType',
  'propertyType',
] as const;

/** `properties.3.landlordPhone` → `landlordPhone`. */
function leafOf(path: string): string {
  const segments = path.split('.');
  return segments[segments.length - 1] ?? '';
}

/**
 * Paths this form is allowed to raise a flag on.
 *
 * Shape-checked rather than matched against an enumeration of every field:
 * the sections are `personal`, `contact` and an indexed `properties`, and a
 * path outside them cannot resolve to an input whatever it says. A misspelled
 * but well-formed path is harmless — it silences no real validation issue,
 * because issues are matched by exact path.
 *
 * The third alternative is the per-unit one, and it was missing. A مبنى is a
 * card with an array of units under it, so the only flag an officer could
 * raise about a building was on the whole `properties.0.units` array — "we
 * could not go through the building at all". That is a real afternoon and the
 * control still exists for it, but it was also the *only* thing expressible:
 * a stairwell where nine flats were surveyed and the tenth did not answer had
 * to be filed either as a complete building with an invented tenth unit, or as
 * a building nobody entered. `properties.0.units.9.unitArea` is the path that
 * was refused, and both walkers below — `withoutFlagged` here and
 * `unexcusedIssues` in `admin-citizen.schema.ts` — now speak it.
 *
 * The index widths are bounded (`\d{1,2}`) for the same reason they always
 * were: 25 cards and 60 units are the schema's own ceilings, so a
 * three-digit index is not a path this form can produce.
 */
const FLAG_PATH =
  /^(personal|contact)\.[a-zA-Z][a-zA-Z0-9]*$|^properties\.\d{1,2}\.[a-zA-Z][a-zA-Z0-9]*$|^properties\.\d{1,2}\.units\.\d{1,2}\.[a-zA-Z][a-zA-Z0-9]*$/;

export function isFlaggablePath(path: string): boolean {
  if (!FLAG_PATH.test(path)) return false;
  return !(NON_FLAGGABLE_FIELDS as readonly string[]).includes(leafOf(path));
}

/**
 * One flagged field.
 *
 * The reason is required and has a floor of four characters for the same
 * reason the flag exists at all: «لا» or «x» records that someone clicked the
 * button, not why the data is missing, and the whole point is that the person
 * who completes this record later can tell whether to phone the citizen, wait
 * for a document, or visit.
 */
export const fieldFlagSchema = z.object({
  path: z
    .string({ required_error: 'الحقل المعلَّم مطلوب' })
    .trim()
    .max(80)
    .refine(isFlaggablePath, 'لا يمكن تعليم هذا الحقل كـ«غير مؤكَّد»'),
  reason: z
    .string({ required_error: 'يرجى ذكر سبب عدم اكتمال هذه المعلومة' })
    .trim()
    .min(4, 'يرجى ذكر سبب عدم اكتمال هذه المعلومة')
    .max(300, 'السبب طويل جداً'),
  /**
   * Defaulted rather than required, for two populations that both predate it:
   * every flag stored before this existed, and every registration sitting in a
   * field phone's offline queue right now. Both mean the old single semantic,
   * which is `UNESTABLISHED` — so they read back correctly without a backfill
   * and without a queued record failing on arrival for a key it never carried.
   */
  kind: z.enum(FIELD_FLAG_KINDS).default('UNESTABLISHED'),
});

export type FieldFlag = z.infer<typeof fieldFlagSchema>;

/**
 * The same flag as it arrives — `kind` still optional.
 *
 * What the browser puts in IndexedDB and what an older row holds in
 * `flaggedFields` are both this shape, not the parsed one above.
 */
export type FieldFlagInput = z.input<typeof fieldFlagSchema>;

/** A flag records a value that was never established, and so was blanked. */
export function isUnestablished(flag: { kind?: FieldFlagKind }): boolean {
  return flag.kind !== 'UNVERIFIED';
}

/**
 * The flags on one submission.
 *
 * The ceiling is not a data-quality rule — it is the point past which the
 * record has stopped being a registration with gaps and become a blank form
 * with excuses attached, which is a conversation to have with the officer
 * rather than a row to store.
 */
export const fieldFlagsSchema = z
  .array(fieldFlagSchema)
  .max(40, 'عدد الحقول غير المؤكَّدة كبير جداً — يرجى استكمال البيانات')
  .default([])
  .superRefine((flags, ctx) => {
    const seen = new Set<string>();
    flags.forEach((flag, index) => {
      if (seen.has(flag.path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'path'],
          message: 'هذا الحقل معلَّم أكثر من مرة',
        });
      }
      seen.add(flag.path);
    });
  });

/**
 * The paths a flag actually excuses — `UNESTABLISHED` only.
 *
 * An `UNVERIFIED` flag must never reach here. It sits on a field that *has* a
 * value, and every caller of this set either blanks the field or waives the
 * strict schema's complaint about it; doing either to a recorded value would
 * silently discard the very thing the second semantic exists to preserve.
 */
export function flaggedPaths(flags: readonly FieldFlag[]): Set<string> {
  return new Set(flags.filter(isUnestablished).map((flag) => flag.path));
}

/** Fields carrying a recorded-but-unconfirmed value, keyed by path. */
export function unverifiedPaths(flags: readonly FieldFlag[]): Set<string> {
  return new Set(flags.filter((flag) => !isUnestablished(flag)).map((flag) => flag.path));
}

/**
 * Blanks every flagged field before anything is validated or stored.
 *
 * A flag means "we did not establish this", so whatever is sitting in the
 * input for that field — a half-typed number, a value left over from before
 * the officer flagged it — is exactly the thing not to keep. Emptying it here
 * rather than trusting the client to do it also collapses the validation
 * problem: with the value gone, every issue a flag is meant to excuse arrives
 * on that field's own path, so flags can be matched to issues exactly rather
 * than by prefix.
 */
export function withoutFlagged<T extends Record<string, unknown>>(
  section: T,
  prefix: string,
  paths: ReadonlySet<string>,
): T {
  const out: Record<string, unknown> = { ...section };
  for (const key of Object.keys(out)) {
    if (paths.has(`${prefix}.${key}`)) delete out[key];
  }

  /*
    One level down, into a building's units.

    Recursive rather than a second bespoke loop, because a unit is the same
    kind of thing this function already handles — a flat record of fields under
    an indexed prefix — and the indices have to line up exactly with the ones
    `issuePath` produces from a Zod issue's path, which is what lets a flag be
    matched to the complaint it excuses instead of to a neighbouring field.

    `units` deleted just above short-circuits this, and correctly: a flag on
    the whole array says the officer never got into the building, so there are
    no units left to walk and no per-unit reasons to look for.

    Only `units` is descended into and the recursion stops there. It is the one
    nested array in a card, and a generic deep walk would happily strip a field
    out of `sharedRights` — a plain array of strings whose indices mean nothing
    a flag path could name.
  */
  if (Array.isArray(out.units)) {
    out.units = out.units.map((unit, index) =>
      unit !== null && typeof unit === 'object' && !Array.isArray(unit)
        ? withoutFlagged(unit as Record<string, unknown>, `${prefix}.units.${index}`, paths)
        : unit,
    );
  }

  return out as T;
}

/** The dot-path an issue landed on, in the same vocabulary the flags use. */
export function issuePath(prefix: string, path: ReadonlyArray<string | number>): string {
  return [prefix, ...path].join('.');
}

import { z } from 'zod';
import {
  landTypeSchema,
  occupancyTypeSchema,
  PROPERTY_TYPE,
  propertyTypeSchema,
  unitStatusSchema,
  unitTypeSchema,
  isStructuralUnitType,
  type PropertyType,
} from './enums';
import { arabicOrLatinName, internationalPhone, uuid } from './primitives';

/**
 * Steps 3–4 — a single repeatable "property card".
 *
 * Two independent conditional axes are modelled as discriminated unions so that
 * impossible combinations are unrepresentable rather than merely discouraged:
 *
 *   occupancy   OWNER          -> no landlord block; may state حالة الوحدة
 *               TENANT         -> landlord name + phone required
 *               FREE_OCCUPANT  -> landlord name required, phone optional
 *
 *   propertyType BUILDING -> one-or-more units (buildingName optional)
 *                HOUSE    -> side + area + sharedRights, no floor/unitType
 *                            (buildingName optional)
 *                LAND     -> landType + area only
 *                TENT     -> location description only
 *
 * «اسم المبنى» is offered on the two structure branches and demanded on
 * neither — see `buildingNameField` for why a required name produced worse
 * data than an empty column.
 */

/**
 * «نعم، هو المالك» — the registered citizen the officer agreed this card names.
 *
 * An answer, not a lookup. `LandlordMatchHint` finds at most one citizen on a
 * given `landlordPhone` and *asks*; this carries what the officer said, so the
 * link is made with the save instead of waiting for somebody to reach the same
 * card from «روابط المالكين» weeks later, with neither household in front of
 * them.
 *
 * ## Why the client may state this at all
 *
 * It asserts nothing the server takes on trust. `LandlordLinkService.confirm`
 * re-derives the match from the committed card — it refuses any citizen whose
 * `phone` and `whatsapp` both differ from the card's `landlordPhone`, refuses
 * a card naming its own filer, and refuses an OWNER card outright. A forged id
 * is a validation error, not a link. What the client contributes is the one
 * thing a query cannot: a person's answer.
 *
 * ## Why it rides with the submission
 *
 * Because the officer is frequently offline. The save is queued, delivered
 * hours later, and a confirmation the browser was going to make afterwards
 * simply never happens — in exactly the settlement where a return trip is most
 * expensive. Travelling inside the payload, the intent survives the queue and
 * is applied by whoever delivers it.
 *
 * Optional everywhere, and absent is the common case: most landlords are not
 * registered, and an officer who is not sure leaves the question to the queue.
 */
export const landlordCitizenIdField = uuid.optional();

/**
 * `errorMap` on both discriminated unions below because Zod's own message for
 * a missing or unrecognised discriminator — "Invalid discriminator value.
 * Expected 'OWNER' | 'TENANT'" — is English and names the wire value, not the
 * Arabic label a citizen chose from a ChoiceCard. One Arabic message covers
 * every way this branch can fail to resolve; it can only fail this way when
 * the choice has not been made yet.
 */
const occupancyBranch = z.discriminatedUnion(
  'occupancyType',
  [
    z.object({ occupancyType: z.literal('OWNER') }),
    z.object({
      occupancyType: z.literal('TENANT'),
      landlordName: arabicOrLatinName,
      landlordPhone: internationalPhone,
      landlordCitizenId: landlordCitizenIdField,
    }),
    /**
     * شاغل بتسامح — occupying without paying بدل.
     *
     * The owner's *name* is required for the same reason it is of a tenant:
     * the municipality has to know whose property this is, and someone living
     * in it knows. The *phone* is not, and that asymmetry is the whole reason
     * this is a separate branch rather than a relabelled TENANT. A tenant has
     * a landlord they pay every month and can reach; this arrangement is
     * typically a relative who is abroad, elderly, or dead — and a required
     * phone field there does not produce a phone number, it produces an
     * invented one, or an «غير مؤكَّد» flag on every such record until the flag
     * stops meaning anything.
     */
    z.object({
      occupancyType: z.literal('FREE_OCCUPANT'),
      landlordName: arabicOrLatinName,
      landlordPhone: internationalPhone.optional(),
      landlordCitizenId: landlordCitizenIdField,
    }),
  ],
  { errorMap: () => ({ message: 'نوع الإشغال مطلوب' }) },
);

export const sharedRightsField = z
  .array(z.string().trim().min(1, 'القيمة غير صالحة'))
  .max(20)
  .default([]);

/**
 * `z.coerce.number()` turns a missing/blank input into `NaN` before Zod's own
 * type check ever sees it, so the failure surfaces as `invalid_type` — with
 * `required_error` alone silently never firing (the value is never literally
 * `undefined` by the time Zod inspects it). Both messages are set to the same
 * Arabic text so whichever code path actually triggers, the citizen sees the
 * same thing rather than either message falling back to Zod's English default.
 */
export const areaField = z.coerce
  .number({ required_error: 'المساحة مطلوبة', invalid_type_error: 'المساحة يجب أن تكون رقماً' })
  .positive('المساحة يجب أن تكون أكبر من صفر')
  .max(1_000_000);

/**
 * أسهم — a fractional land ownership, out of the Lebanese cadastre's
 * standard 2400-share parcel. LAND only: a building or a house is filed
 * whole (see `buildingUnitSchema`/`unitStatusField`'s occupancy split for how
 * multiple parties on one structure are handled instead), so shares only
 * ever describe a share of the *land itself*.
 */
export const sharesField = z.coerce
  .number({ required_error: 'عدد الأسهم مطلوب', invalid_type_error: 'عدد الأسهم يجب أن يكون رقماً' })
  .int('يجب أن يكون رقماً صحيحاً')
  .min(1, 'يجب أن يكون سهماً واحداً على الأقل')
  .max(2400, 'الحد الأقصى 2400 سهم');

/**
 * حالة الوحدة — optional everywhere, on purpose.
 *
 * Never required, and the omission is the design rather than a gap in it. A
 * مبنى of twenty flats would otherwise demand twenty four-way choices from an
 * officer who came to record who lives there, and a required choice someone
 * cannot answer is not answered honestly — it is answered with whatever is
 * under the thumb. This field decides money (see `FeeNotice.bearer`),
 * and a guessed exemption is worse than no exemption.
 *
 * The consequence is deliberate and runs one way: a unit nobody marked is
 * *billed*. Over-collecting from a flat that was empty produces a resident at
 * the counter with a complaint someone can act on; under-collecting from one
 * that was not produces nothing at all, which is the failure `isUnsurveyed`
 * already refuses to allow. See `isUnoccupied`, which reads null as occupied.
 */
export const unitStatusField = unitStatusSchema.optional();

export const propertyNumberField = z
  .string({ required_error: 'رقم العقار مطلوب' })
  .trim()
  .min(1, 'رقم العقار مطلوب')
  .max(40);

/**
 * الحي — common to every property type, unlike رقم العقار it is not checked
 * against anything (the cadastre has no neighbourhood layer), so this is a
 * plain free-text field rather than a lookup.
 *
 * **Optional, and no longer asked for.** A neighbourhood typed by hand on every
 * card is the same fact a parcel's zone already carries — `Zone.parcelNumbers`
 * says which sector a عقار belongs to (D13), derived once and centrally rather
 * than re-entered per household with a different spelling each time. The field
 * is kept on the wire and in the column so the values already collected survive
 * a round-trip untouched, and so the forms can start rendering it again the day
 * it is wired to the zone instead of to a keyboard.
 *
 * `.optional()` is applied at each branch rather than here: the constant is
 * also what shapes an existing value, and a schema that accepted `undefined`
 * everywhere would stop reporting a genuinely malformed one.
 */
export const neighborhoodField = z
  .string({ required_error: 'الحي مطلوب' })
  .trim()
  .min(1, 'الحي مطلوب')
  .max(80, 'اسم الحي طويل جداً');

/**
 * «اسم المبنى» — what residents call the block, or nothing.
 *
 * **Optional on every branch that carries it**, and applied with `.optional()`
 * at each one for the same reason `neighborhoodField` is: the constant also
 * shapes an existing value, so a schema that accepted `undefined` everywhere
 * would stop reporting a genuinely malformed one.
 *
 * It used to be required of a مبنى and of a منزل, and that demand produced
 * nothing a register could use. Most blocks here have no name at all — an
 * officer standing in front of an unnamed one, with a required field between
 * them and the household they came to record, types «بناية» or the street or
 * the owner's surname, and the column fills with values that name no building.
 * Worse, it fills them *differently* every time, which is the whole reason
 * `Building.name` on the census outranks this field wherever a card is linked:
 * two tenants of one block produced «بناية النور» and «بنايه الن‍ور» and
 * nothing could recognise them as the same structure.
 *
 * Nothing downstream depended on its presence. A card is identified by its
 * رقم العقار and, once linked, by the building's own derived code (D9) — both
 * of which are still required. The name is a convenience for a human reading a
 * notice, and an empty one costs a notice one line.
 *
 * The census side has always agreed: `Building.name` is optional in
 * `building.schema.ts` and nullable in the column. `PropertyEntry`'s taxonomy
 * rules were the half that disagreed, and no longer refuse a card for the lack
 * of a name.
 */
export const buildingNameField = z
  .string()
  .trim()
  .min(1, 'اسم المبنى قصير جداً')
  .max(120, 'اسم المبنى طويل جداً');

/**
 * One unit inside a building — شقة, عيادة or محل.
 *
 * A citizen who owns the whole building registers one عقار containing many of
 * these, rather than one عقار per apartment: the parcel has a single رقم العقار
 * and the cadastre check treats it as taken once, so the units have to hang off
 * the parcel instead of duplicating it.
 */
export const buildingUnitSchema = z.object({
  /**
   * The stored row this line was loaded from, on an edit. Absent on a new line.
   *
   * Lets a save keep each row's identity instead of re-creating the list, and
   * refuse a line whose flat ended («إنهاء الإيجار») while the form was open —
   * otherwise re-saving that form would bring the ended flat back as held.
   */
  id: uuid.optional(),
  /**
   * The canonical `Unit` this card line describes, when the officer picked one.
   *
   * The link the census turns on (§3.7, P2-T8): where it is set the `Unit` is
   * authoritative field by field, and the flat the citizen filed and the flat
   * the municipality surveyed are known to be the same flat rather than two
   * rows that happen to agree. Null everywhere it was not offered — a card
   * filed before the building was censused, or one whose parcel nobody has
   * surveyed — and that is permanent rather than transitional.
   */
  unitId: uuid.optional(),
  /**
   * Narrowed against `unitTypeSchema`, which is the whole enum.
   *
   * A طابق أعمدة or a طابق فارغ is a level of the structure, not a space
   * anyone holds, so it belongs on the matrix and cannot appear on a card: a
   * citizen's card is by construction a claim that somebody occupies or owns
   * the thing it names.
   *
   * Refused here rather than only hidden from the form, for the reason
   * `assertNonResidentOccupancy` gives about its own rule — a rule enforced on
   * one side only makes the other side the way round it. The form's list is
   * `BUILDING_UNIT_TYPES`, which never carried this value; the doors that do
   * not read that list are the CSV import, the offline queue replaying a
   * submission built by an older client, and anything posting to the API
   * directly. This is what those meet.
   */
  unitType: unitTypeSchema.refine(
    (type) => !isStructuralUnitType(type),
    'هذا طابق من البناء وليس وحدة تُسجَّل على ملف — يُرسم في مصفوفة المبنى فقط',
  ),
  floor: z.string({ required_error: 'الطابق مطلوب' }).trim().min(1, 'الطابق مطلوب').max(20),
  side: z.string().trim().max(60).optional(),
  unitArea: areaField,
  sharedRights: sharedRightsField,
  /**
   * Asked of an owner only, and stripped from anyone else's card by
   * `PropertyEntry.normalise` — a مستأجر filing the flat they live in is its
   * occupant, so there is no question to put to them.
   */
  unitStatus: unitStatusField,
});

export type BuildingUnit = z.infer<typeof buildingUnitSchema>;

/** A building with more units than this is a data-entry accident, not a landlord. */
export const buildingUnitsSchema = z
  .array(buildingUnitSchema, { required_error: 'يجب إضافة وحدة واحدة على الأقل' })
  .min(1, 'يجب إضافة وحدة واحدة على الأقل')
  .max(60, 'عدد الوحدات كبير جداً — يرجى مراجعة البلدية');

/**
 * The same unit with nothing required — the coercion shape, not a second
 * rulebook.
 *
 * Stands to `buildingUnitSchema` exactly as `partialPropertyEntrySchema` stands
 * to `propertyEntrySchema`, and exists for the same reason one level further
 * down: a card carrying a per-unit «غير مؤكَّد» flag has had that field blanked
 * before anything is parsed, so the strict unit schema would refuse to *shape*
 * a record its own strict pass had already (correctly) accepted. Without it a
 * flag on `properties.0.units.9.unitArea` passes validation and then throws in
 * `shapeSubmission`, which is the worst of the three possible outcomes.
 *
 * The element rules are the identical field constants either way; what is
 * dropped is only the requiredness the flag has accounted for.
 */
export const partialBuildingUnitSchema = buildingUnitSchema.partial();

/**
 * No `min(1)` here, and that is not a loosening.
 *
 * "At least one unit" is a rule about whether a مبنى card is acceptable, which
 * the strict pass has already settled — either the card had units, or the
 * officer flagged the whole array and said why. Re-asserting it on the
 * coercion pass could only ever fail a record that was already accepted.
 */
export const partialBuildingUnitsSchema = z
  .array(partialBuildingUnitSchema)
  .max(60, 'عدد الوحدات كبير جداً — يرجى مراجعة البلدية');

const propertyBranch = z.discriminatedUnion(
  'propertyType',
  [
    z.object({
      propertyType: z.literal('BUILDING'),
      neighborhood: neighborhoodField.optional(),
      propertyNumber: propertyNumberField,
      /**
       * The censused structure this card is about, when one was picked.
       *
       * On BUILDING and HOUSE only. أرض has nothing standing on it and never
       * gets one, and a خيمة stays a bare card by Q2 — offering the field there
       * would invite a link the census deliberately does not model.
       */
      buildingId: uuid.optional(),
      buildingName: buildingNameField.optional(),
      units: buildingUnitsSchema,
    }),
    z.object({
      propertyType: z.literal('HOUSE'),
      neighborhood: neighborhoodField.optional(),
      propertyNumber: propertyNumberField,
      buildingId: uuid.optional(),
      buildingName: buildingNameField.optional(),
      side: z.string().trim().max(60).optional(),
      unitArea: areaField,
      sharedRights: sharedRightsField,
      unitStatus: unitStatusField,
    }),
    z.object({
      propertyType: z.literal('LAND'),
      neighborhood: neighborhoodField.optional(),
      propertyNumber: propertyNumberField,
      landType: landTypeSchema,
      unitArea: areaField,
      /*
        Optional here, required of an owner below.

        أسهم are a fraction of *ownership* out of the cadastre's 2400. A farmer
        renting an orchard, or a relative working a plot without بدل, holds none,
        and demanding the number of them produced exactly what a required field
        with no true answer produces: an invented one. The requirement is
        occupancy-dependent, which this branch — keyed on نوع العقار alone —
        cannot express; see `ownerLandShares`.
      */
      shares: sharesField.optional(),
      /*
        حالة الأرض, asked of its owner — for the same reason a منزل's is.

        A plot is one billable unit and its card had nowhere to say that
        somebody else works it. So under an occupant-borne notice reaching أرض,
        the owner of a rented plot was billed (an unanswered unit is billed) and
        the farmer renting it was billed again on their own card. «مؤجرة» or
        «مشغولة بتسامح» here is what exempts the owner, exactly as it does for a
        منزل. Stripped from a non-owner's card by `PropertyEntry.normalise`.
      */
      unitStatus: unitStatusField,
    }),
    z.object({
      propertyType: z.literal('TENT'),
      neighborhood: neighborhoodField.optional(),
      propertyNumber: propertyNumberField,
      tentLocation: z
        .string({ required_error: 'موقع الخيمة مطلوب' })
        .trim()
        .min(3, 'موقع الخيمة مطلوب')
        .max(200),
    }),
  ],
  { errorMap: () => ({ message: 'نوع العقار مطلوب' }) },
);

/**
 * أسهم on a plot of land, asked of its owner and of nobody else.
 *
 * Checked across both branches because it depends on both: an owner of أرض
 * states their share of it, a tenant or a شاغل بتسامح of the same أرض holds no
 * share at all. A share count left on a non-owner's card is stripped on the way
 * in (`PropertyEntry.normalise`), not refused — it is what a card edited from
 * مالك to مستأجر looks like.
 */
function ownerLandShares(
  card: { occupancyType: string; propertyType: string; shares?: number },
  ctx: z.RefinementCtx,
): void {
  if (card.propertyType === 'LAND' && card.occupancyType === 'OWNER' && card.shares === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['shares'], message: 'عدد الأسهم مطلوب' });
  }
}

export const propertyEntrySchema = z
  .intersection(occupancyBranch, propertyBranch)
  .superRefine(ownerLandShares);
export type PropertyEntry = z.infer<typeof propertyEntrySchema>;

/**
 * Zero properties is a valid registration — a citizen who owns nothing and
 * only rents has none to file. The soft ceiling just catches accidental
 * repeat taps.
 */
export const propertyEntriesSchema = z
  .array(propertyEntrySchema)
  .max(25, 'عدد العقارات كبير جداً — يرجى مراجعة البلدية');

/**
 * Which fields a given property type renders. The UI reads this instead of
 * re-implementing the branch logic, so the form and the validator cannot drift.
 */
export const PROPERTY_FIELD_MAP = {
  BUILDING: ['neighborhood', 'propertyNumber', 'buildingName', 'units'],
  HOUSE: ['neighborhood', 'propertyNumber', 'buildingName', 'side', 'unitArea', 'sharedRights'],
  LAND: ['neighborhood', 'propertyNumber', 'landType', 'unitArea', 'shares'],
  TENT: ['neighborhood', 'propertyNumber', 'tentLocation'],
} as const satisfies Record<string, readonly string[]>;

/**
 * Every field a card can carry, none of them required, with no branch rules.
 *
 * The strict `propertyEntrySchema` above stays the only authority on whether a
 * card is acceptable. This one exists because a card carrying flags cannot be
 * *shaped* by a schema that refuses it: once the strict pass has ruled that
 * every complaint lands on a flagged field, something still has to coerce the
 * area to a number and default the shared rights, and that is this.
 *
 * The field schemas are the identical constants the branches use, so a rule
 * about what a value may look like is written once. What is restated is the
 * list of names — and `CardFieldIsShaped` below is what stops that list from
 * drifting: add a field to a branch without adding it here and the package
 * fails to compile rather than silently dropping it on flagged records.
 */
export const partialPropertyEntrySchema = z
  .object({
    occupancyType: occupancyTypeSchema,
    landlordName: arabicOrLatinName,
    landlordPhone: internationalPhone,
    landlordCitizenId: landlordCitizenIdField,
    propertyType: propertyTypeSchema,
    neighborhood: neighborhoodField.optional(),
    propertyNumber: propertyNumberField,
    buildingId: uuid,
    buildingName: buildingNameField,
    side: z.string().trim().max(60),
    landType: landTypeSchema,
    tentLocation: z.string().trim().min(3).max(200),
    unitArea: areaField,
    shares: sharesField,
    sharedRights: sharedRightsField,
    unitStatus: unitStatusSchema,
    units: partialBuildingUnitsSchema,
  })
  .partial()
  /**
   * The two discriminators stay required: they are `NON_FLAGGABLE_FIELDS`, so
   * no flag can excuse them and no shape derived from flags may make them
   * optional. It is also what lets a card be handed to the domain entity —
   * whose `occupancyType` and `propertyType` are not nullable — unguarded.
   */
  .required({ occupancyType: true, propertyType: true });

export type PartialPropertyEntry = z.infer<typeof partialPropertyEntrySchema>;

/** Every field name any branch of the strict card schema can require. */
type CardField =
  | (typeof PROPERTY_FIELD_MAP)[keyof typeof PROPERTY_FIELD_MAP][number]
  | 'occupancyType'
  | 'propertyType'
  | 'landlordName'
  | 'landlordPhone'
  | 'landlordCitizenId'
  // Gated on occupancy as well as property type, so — like the landlord pair
  // above it — it is not something `PROPERTY_FIELD_MAP` can express.
  | 'unitStatus';

/**
 * `true` when the partial shape covers every branch field, and `never` — so a
 * compile error right here — when it has fallen behind one.
 */
export type CardFieldIsShaped = CardField extends keyof PartialPropertyEntry ? true : never;
const cardFieldsAreShaped: CardFieldIsShaped = true;
void cardFieldsAreShaped;

/** The per-unit fields a building's unit editor renders. */
export const BUILDING_UNIT_FIELDS = [
  'unitType',
  'floor',
  'side',
  'unitArea',
  'sharedRights',
  'unitStatus',
] as const;

/**
 * صفة الإقامة only *suggests* a property type — a refugee may still own an
 * apartment, so this is a changeable default and never a gate.
 */
export const SUGGESTED_PROPERTY_TYPE: Record<string, 'TENT' | undefined> = {
  REFUGEE: 'TENT',
  DISPLACED: undefined,
  VILLAGE_RESIDENT: undefined,
};

/**
 * خيمة is offered only to a لاجئ.
 *
 * This is the one direction the rule runs. A refugee still gets every other
 * type — the long-standing point that صفة الإقامة describes the person and not
 * their property is unchanged, and someone who fled with a deed in their pocket
 * can still register the apartment they own. What is excluded is the reverse: a
 * village resident or a displaced person filing a tent, which in practice has
 * only ever been a mis-tap on a four-card chooser.
 */
export function allowedPropertyTypesFor(
  residentStatus: string | undefined,
): readonly PropertyType[] {
  return residentStatus === 'REFUGEE'
    ? PROPERTY_TYPE
    : PROPERTY_TYPE.filter((type) => type !== 'TENT');
}

import { z } from 'zod';
import {
  buildingLifecycleSchema,
  damageLevelSchema,
  damageSourceSchema,
  occupancyRoleSchema,
  structureTypeSchema,
  surveyStatusSchema,
  unitStatusSchema,
  unitTypeSchema,
} from './enums';
import { areaField, propertyNumberField } from './property.schema';
import { uuid } from './primitives';

/**
 * The building census, as it crosses the wire.
 *
 * The same shapes validate the request server-side and drive the editor's
 * inline errors client-side — the convention `zone.schema.ts` set — so a
 * building the form accepts is a building the API accepts, and the two cannot
 * drift into disagreeing about what is valid.
 *
 * The rule these all share, and the reason none of them accepts a `code`: the
 * UUID is the identity and the code is derived (D9). A client that could send
 * a code could send one that contradicts the parcel it names.
 */

/** رقم العقار the structure stands on — the same field the citizen form uses. */
const parcelNumber = propertyNumberField;

/**
 * What residents call it — «بناية النور». Optional everywhere.
 *
 * A building is findable by its code without one, and demanding a name from an
 * officer standing in front of an unnamed block produces «بناية» typed twenty
 * times, which is worse than the empty column it replaced.
 */
const buildingName = z.string().trim().min(1, 'اسم المبنى قصير جداً').max(120, 'اسم المبنى طويل جداً');

/**
 * What is actually painted on the building or the door.
 *
 * Free text and deliberately unvalidated against our own format: the whole
 * point of the field is that it records what somebody else wrote. A rule that
 * forced it to look like our code would defeat it.
 */
const postedNumber = z.string().trim().min(1).max(40, 'الرقم المكتوب طويل جداً');

const notes = z.string().trim().max(1000, 'الملاحظات طويلة جداً');

/**
 * A pin, or nothing. Never half of one.
 *
 * Latitude and longitude are checked together rather than as two independent
 * optional numbers, because one without the other is not a partial location —
 * it is a point on the null meridian or the equator, silently plotted in the
 * Gulf of Guinea. See `coordinatePair` below.
 */
const latitude = z.coerce
  .number({ invalid_type_error: 'الإحداثي غير صالح' })
  .min(-90, 'خط العرض غير صالح')
  .max(90, 'خط العرض غير صالح');

const longitude = z.coerce
  .number({ invalid_type_error: 'الإحداثي غير صالح' })
  .min(-180, 'خط الطول غير صالح')
  .max(180, 'خط الطول غير صالح');

/** Rejects a half-supplied pin on whatever object carries the pair. */
function coordinatePair<T extends { latitude?: number | null; longitude?: number | null }>(
  value: T,
  ctx: z.RefinementCtx,
): void {
  const hasLat = value.latitude !== undefined && value.latitude !== null;
  const hasLng = value.longitude !== undefined && value.longitude !== null;
  if (hasLat === hasLng) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [hasLat ? 'longitude' : 'latitude'],
    message: 'الموقع يحتاج خط الطول وخط العرض معاً',
  });
}

/**
 * How many floors a structure may claim.
 *
 * The ceiling is not architectural modesty — it is the range `parseFloorLabel`
 * accepts, so a building cannot be created with more floors than a unit on it
 * could ever be filed against.
 */
const floorsCount = z.coerce
  .number({ invalid_type_error: 'عدد الطوابق يجب أن يكون رقماً' })
  .int('عدد الطوابق يجب أن يكون رقماً صحيحاً')
  .min(1, 'المبنى له طابق واحد على الأقل')
  .max(100, 'عدد الطوابق كبير جداً');

/**
 * A signed floor: basement negative, ground 0. Matches `Unit.floor` and the
 * range `parseFloorLabel` clamps to, so the two cannot disagree about what a
 * storable floor is.
 */
const floorField = z.coerce
  .number({ invalid_type_error: 'الطابق يجب أن يكون رقماً' })
  .int('الطابق يجب أن يكون رقماً صحيحاً')
  .min(-10, 'الطابق خارج النطاق المقبول')
  .max(100, 'الطابق خارج النطاق المقبول');

/**
 * A single unit, created or corrected by hand from the matrix.
 *
 * `floor` and `sequence` are the durable pair and `unitCode` is derived from
 * them, so the code is never accepted from a client — see D9 and
 * `formatUnitCode`.
 */
export const upsertUnitSchema = z.object({
  floor: floorField,
  /**
   * Optional on create: the service allocates the next free position on the
   * floor, which is what stops two officers filling the same matrix from
   * colliding on the unique `(buildingId, floor, sequence)`.
   */
  sequence: z.coerce
    .number({ invalid_type_error: 'الترتيب يجب أن يكون رقماً' })
    .int('الترتيب يجب أن يكون رقماً صحيحاً')
    .min(1, 'الترتيب يبدأ من 1')
    .max(99, 'الترتيب كبير جداً')
    .optional(),
  unitType: unitTypeSchema,
  postedNumber: postedNumber.optional(),
  side: z.string().trim().max(60).optional(),
  unitArea: areaField.optional(),
  unitStatus: unitStatusSchema.optional(),
  surveyStatus: surveyStatusSchema.optional(),
  notes: notes.optional(),
  /**
   * «نعم، هذه وحدة مختلفة» — the unit-level twin of
   * `createBuildingSchema.acknowledgedDuplicates`, and it was missing.
   *
   * `addUnit` allocates the next free position on the floor, so a second محل on
   * a ground floor that already has one is *always* created and the unique
   * `(buildingId, floor, sequence)` can never fire — it is satisfied by
   * construction. The only shape the constraint catches is an explicitly
   * supplied `sequence`, which this control never sends.
   *
   * That is the same hole D18 closed one level up: two officers, or one officer
   * on two visits, record the same physical unit twice and nothing in the
   * database is in a position to notice. The remedy there is also the remedy
   * here — show them what is already on that floor and make them say this is
   * not one of them.
   *
   * Not a validation rule, a confirmation. The answer is always allowed to be
   * yes; four flats a floor is ordinary. What is not allowed is never being
   * asked, because the second محل is not ordinary and looks identical from the
   * form.
   */
  acknowledgedDuplicates: z.boolean().optional(),
});

export type UpsertUnitInput = z.infer<typeof upsertUnitSchema>;

/**
 * How many units one `create` may carry inline.
 *
 * Smaller than `MAX_GENERATED_UNITS` on purpose: a blueprint says "twelve
 * floors of four" in four numbers, while this is a list somebody typed or a
 * card enumerated, and a registration form has no honest reason to describe
 * more flats than one household could hold. A genuine tower is created from the
 * editor and filled from the blueprint generator.
 */
const MAX_INLINE_UNITS = 40;

export const createBuildingSchema = z
  .object({
    parcelNumber,
    name: buildingName.optional(),
    postedNumber: postedNumber.optional(),
    structureType: structureTypeSchema,
    /**
     * Where the structure is in its own life. Defaults to «قائم ومستعمل»
     * because that is what an officer is standing in front of nineteen times
     * out of twenty, and a required question whose answer is nearly always the
     * same is a question that gets answered wrong.
     */
    lifecycleStatus: buildingLifecycleSchema.default('IN_USE'),
    /*
      No `neighborhood`, deliberately.

      It used to be accepted here and there is no column for it: `Building` has
      never had one, and `BuildingsService.create` never read it — so a client
      that sent الحي got a 201 and a building with no الحي, which is the silent
      drop this whole change set exists to remove. الحي lives on the property
      card, where it is asked of the citizen and stored.

      If the census ever needs its own, it needs a column and a migration first.
    */
    latitude: latitude.optional(),
    longitude: longitude.optional(),
    floorsCount: floorsCount.default(1),
    notes: notes.optional(),
    /**
     * «نعم، هذه منشأة مختلفة» — the officer has seen what already stands on
     * this parcel and is asserting this is not one of them.
     *
     * The parcel is the only thing that makes two buildings *look* like one
     * record, and the suffix allocation in §4.4 solves the opposite problem: it
     * guarantees two officers surveying one block from opposite ends get
     * *different* codes, quietly, with nothing to notice. This flag is the
     * moment of noticing, and the server refuses a second structure on an
     * occupied parcel without it.
     *
     * Not a validation rule — a confirmation. The answer is always allowed to
     * be yes; what is not allowed is never being asked.
     */
    acknowledgedDuplicates: z.boolean().optional(),
    /**
     * The suffix the phone showed while offline, if it showed one.
     *
     * Never trusted — the server re-allocates under a lock and returns the
     * authoritative code (§4.4). It is carried so the response can tell the
     * client whether the code it has been quoting changed, which is the one
     * thing an officer needs to know before they quote it again.
     */
    provisionalSuffix: z.string().trim().max(4).optional(),
    /**
     * The browser's own name for this creation, exactly as a registration
     * carries one. It is what makes an offline retry safe to repeat: a building
     * created on a phone with no signal is re-sent, recognised, and answered
     * with the row it already made rather than a second building on the parcel.
     */
    clientSubmissionId: uuid.optional(),
    /**
     * The matrix, created in the same request as the shell.
     *
     * For the registration form, which creates a structure the officer is
     * standing in front of and must attach a household to it in the same save.
     * A shell on its own would be worse than nothing there: `CensusSyncService`
     * claims a unit only when the card line carries a `unitId`, so a building
     * with no units links the card and records no occupancy — and
     * `heldThroughOccupancy` then bills that household for nothing at all.
     *
     * One request rather than a `POST` per unit, for two reasons:
     *
     * - **Replay safety comes free.** `clientSubmissionId` is the building's
     *   primary key, so a re-delivered creation is recognised and the whole
     *   request — units included — is answered with what it already made. A
     *   separate units call carries no idempotency key and would allocate a
     *   fresh `sequence` on every retry.
     * - **Offline has no other path.** The queue has one store for buildings
     *   and none for units, so a fatter payload is the only shape that survives
     *   an airplane-mode create.
     *
     * `sequence` stays optional and server-allocated, exactly as it is on the
     * matrix's own form — that is what keeps two officers filling one building
     * off the same `(buildingId, floor, sequence)`.
     */
    units: z
      .array(
        /*
          `acknowledgedDuplicates` is omitted rather than ignored. It answers
          "is this a second unit on a floor that already has one like it", and
          this building did not exist a statement ago — there is nothing on any
          of its floors to be a duplicate of, which is the same reason `create`
          takes no advisory lock for these sequences.
        */
        upsertUnitSchema.omit({ acknowledgedDuplicates: true }).extend({
          /**
           * The browser's own id for this unit, for the same reason the
           * building has one: a phone with no signal has to be able to put a
           * `unitId` on the card *before* the row exists, and the id it minted
           * is the id the row will have.
           */
          id: uuid.optional(),
        }),
      )
      .max(
        MAX_INLINE_UNITS,
        `لا يمكن إنشاء أكثر من ${MAX_INLINE_UNITS} وحدة في طلب واحد`,
      )
      .optional(),
  })
  .superRefine(coordinatePair);

export type CreateBuildingInput = z.infer<typeof createBuildingSchema>;

/**
 * Everything optional, but at least one field present — a PATCH carrying
 * nothing is a caller bug, and returning the unchanged building would hide it.
 * The same rule `updateCaseSchema` applies.
 *
 * `parcelNumber` is absent on purpose. Moving a building to another parcel is
 * not an edit, it is a different building: the suffix was allocated against the
 * old parcel and the code is derived from it, so a "move" would have to
 * reallocate and renumber. Delete and recreate, deliberately.
 */
export const updateBuildingSchema = z
  .object({
    name: buildingName.nullable().optional(),
    postedNumber: postedNumber.nullable().optional(),
    structureType: structureTypeSchema.optional(),
    lifecycleStatus: buildingLifecycleSchema.optional(),
    latitude: latitude.nullable().optional(),
    longitude: longitude.nullable().optional(),
    floorsCount: floorsCount.optional(),
    notes: notes.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (!Object.values(value).some((v) => v !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'لا يوجد أي تغيير لحفظه' });
    }
    coordinatePair(value, ctx);
  });

export type UpdateBuildingInput = z.infer<typeof updateBuildingSchema>;

/**
 * How to fill a building's unit matrix.
 *
 * Two shapes, because officers arrive with two different amounts of knowledge
 * and forcing either into the other's form is how a matrix gets filled with
 * fiction:
 *
 *  - `uniform` — "six floors, four flats each". What someone standing outside
 *    a residential block can tell you, and the overwhelmingly common case.
 *  - `explicit` — a row per floor. What someone who has walked the stairwell
 *    knows, where the ground floor is two shops and the fourth is one penthouse.
 *
 * Both produce units at `NOT_SURVEYED`, which is the entire point: generating
 * the matrix is asserting that the flats exist, not that anyone has been in
 * them.
 */
const uniformBlueprint = z.object({
  kind: z.literal('uniform'),
  /** Lowest floor to generate — negative for basements. */
  fromFloor: floorField.default(0),
  toFloor: floorField,
  unitsPerFloor: z.coerce
    .number({ invalid_type_error: 'عدد الوحدات يجب أن يكون رقماً' })
    .int('عدد الوحدات يجب أن يكون رقماً صحيحاً')
    .min(1, 'وحدة واحدة على الأقل في كل طابق')
    .max(20, 'عدد الوحدات في الطابق كبير جداً'),
  unitType: unitTypeSchema,
});

const explicitBlueprint = z.object({
  kind: z.literal('explicit'),
  floors: z
    .array(
      z.object({
        floor: floorField,
        unitCount: z.coerce
          .number({ invalid_type_error: 'عدد الوحدات يجب أن يكون رقماً' })
          .int('عدد الوحدات يجب أن يكون رقماً صحيحاً')
          .min(1, 'وحدة واحدة على الأقل في كل طابق')
          .max(20, 'عدد الوحدات في الطابق كبير جداً'),
        unitType: unitTypeSchema,
      }),
    )
    .min(1, 'يجب تحديد طابق واحد على الأقل')
    .max(60, 'عدد الطوابق كبير جداً')
    .superRefine((floors, ctx) => {
      // A floor listed twice is an editing slip, and silently merging the two
      // rows would generate a different matrix from the one on screen.
      const seen = new Set<number>();
      floors.forEach((entry, index) => {
        if (seen.has(entry.floor)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'floor'],
            message: 'هذا الطابق مذكور أكثر من مرة',
          });
        }
        seen.add(entry.floor);
      });
    }),
});

export const unitBlueprintSchema = z
  .discriminatedUnion('kind', [uniformBlueprint, explicitBlueprint], {
    errorMap: () => ({ message: 'طريقة توليد الوحدات غير صالحة' }),
  })
  .superRefine((blueprint, ctx) => {
    if (blueprint.kind !== 'uniform') return;
    if (blueprint.toFloor < blueprint.fromFloor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toFloor'],
        message: 'الطابق الأعلى يجب ألا يكون أدنى من الطابق الأول',
      });
    }
  });

export type UnitBlueprint = z.infer<typeof unitBlueprintSchema>;

export const updateUnitSchema = upsertUnitSchema
  /*
    Correcting a unit cannot create one, so there is no duplicate to
    acknowledge. Omitted rather than left to be ignored: `.partial()` below
    counts any present key as a change, so a PATCH carrying nothing but this
    flag would pass the "at least one field" guard and then save nothing.
  */
  .omit({ acknowledgedDuplicates: true })
  .partial()
  .superRefine((value, ctx) => {
    if (Object.values(value).some((v) => v !== undefined)) return;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'لا يوجد أي تغيير لحفظه' });
  });

export type UpdateUnitInput = z.infer<typeof updateUnitSchema>;

/**
 * One observation of a structure's condition, appended to the log.
 *
 * `assessedAt` is accepted because a damage assessment is routinely entered
 * days after the visit — from a paper form, or from a phone that was offline in
 * a district with no signal — and back-dating it is the difference between a
 * history that reconstructs what happened and one that records when somebody
 * did their paperwork. It cannot be in the future, which is the one direction
 * that would be a typo rather than a fact.
 */
export const createDamageAssessmentSchema = z
  .object({
    buildingId: uuid.optional(),
    unitId: uuid.optional(),
    level: damageLevelSchema,
    source: damageSourceSchema.default('FIELD_VISIT'),
    observations: z.string().trim().max(2000, 'الوصف طويل جداً').optional(),
    assessedAt: z.coerce
      .date({ invalid_type_error: 'تاريخ الكشف غير صالح' })
      .max(new Date(Date.now() + 60_000), 'تاريخ الكشف في المستقبل')
      .optional(),
  })
  .superRefine((value, ctx) => {
    /*
      Exactly one target, mirroring the CHECK constraint in migration 0030.

      Neither is an observation of nothing. Both would have the building's
      rollup and the unit's own reading counting the same visit twice, which
      quietly inflates a damage figure that aid allocation turns on.
    */
    if (Boolean(value.buildingId) === Boolean(value.unitId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buildingId'],
        message: 'يجب تحديد مبنى واحد أو وحدة واحدة، لا كليهما',
      });
    }
  });

export type CreateDamageAssessmentInput = z.infer<typeof createDamageAssessmentSchema>;

/**
 * Who is in a unit, recorded straight onto the matrix.
 *
 * No `registrationId`: an occupancy created here is by definition one that
 * precedes the citizen's full file — an officer walking a stairwell recording
 * that flat 3 is rented and who owns it. The link is set by the registration
 * path when a file does exist, and the column stays null here rather than
 * inviting a client to assert a registration it does not own.
 */
export const upsertOccupancySchema = z
  .object({
    unitId: uuid,
    citizenId: uuid,
    role: occupancyRoleSchema,
    /** أسهم out of 2400 — owners only; see the refinement below. */
    shares: z.coerce
      .number({ invalid_type_error: 'عدد الأسهم يجب أن يكون رقماً' })
      .int('يجب أن يكون رقماً صحيحاً')
      .min(1, 'يجب أن يكون سهماً واحداً على الأقل')
      .max(2400, 'الحد الأقصى 2400 سهم')
      .optional(),
    fromDate: z.coerce.date({ invalid_type_error: 'تاريخ البدء غير صالح' }).optional(),
    toDate: z.coerce.date({ invalid_type_error: 'تاريخ الانتهاء غير صالح' }).optional(),
  })
  .superRefine((value, ctx) => {
    // Shares are a fraction of ownership. A tenant holding 400 of them is a
    // contradiction, and storing it would corrupt any later sum over a unit.
    if (value.shares !== undefined && value.role !== 'OWNER') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shares'],
        message: 'الأسهم تُسجَّل للمالك فقط',
      });
    }

    if (value.fromDate && value.toDate && value.toDate < value.fromDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toDate'],
        message: 'تاريخ الانتهاء قبل تاريخ البدء',
      });
    }
  });

export type UpsertOccupancyInput = z.infer<typeof upsertOccupancySchema>;

/** Ends a tenancy without deleting it — the history is the point (D2). */
export const endOccupancySchema = z.object({
  toDate: z.coerce.date({ invalid_type_error: 'تاريخ الانتهاء غير صالح' }).optional(),
});

export type EndOccupancyInput = z.infer<typeof endOccupancySchema>;

/**
 * One attempt to survey a unit, logged from the matrix.
 *
 * `outcome` is a `SurveyStatus` — every state a visit can produce is already in
 * that enum, and a second vocabulary beside it is the trap D15 names. The one
 * value excluded is `NOT_SURVEYED`: it means nobody went, so a *visit* carrying
 * it is a contradiction rather than a finding.
 */
export const logVisitSchema = z.object({
  unitId: uuid,
  outcome: surveyStatusSchema.refine((value) => value !== 'NOT_SURVEYED', {
    message: 'نتيجة الزيارة لا يمكن أن تكون «غير ممسوحة»',
  }),
  /**
   * Back-datable from a paper form or a phone that was offline, and refused in
   * the future for the same reason `assessedAt` is: that direction is a typo,
   * never a fact.
   */
  visitedAt: z.coerce
    .date({ invalid_type_error: 'تاريخ الزيارة غير صالح' })
    .max(new Date(Date.now() + 60_000), 'تاريخ الزيارة في المستقبل')
    .optional(),
  notes: z.string().trim().max(1000, 'الملاحظات طويلة جداً').optional(),
});

export type LogVisitInput = z.infer<typeof logVisitSchema>;

/**
 * What the census ledger filters on.
 *
 * Every field optional and composable — the page's filters are checkboxes and
 * selects that stack, so any subset has to be a valid query.
 */
export const buildingFilterSchema = z.object({
  parcelNumber: z.string().trim().max(40).optional(),
  zoneId: uuid.optional(),
  structureType: structureTypeSchema.optional(),
  lifecycleStatus: buildingLifecycleSchema.optional(),
  surveyStatus: surveyStatusSchema.optional(),
  damageLevel: damageLevelSchema.optional(),
  /** Matches `code`, `name` or `postedNumber` — what a clerk actually types. */
  search: z.string().trim().max(120).optional(),
  /**
   * «بلا مدخل مُثبت» — structures nobody has stood at and pinned.
   *
   * A building may be created from a desk, and one created from the
   * registration form always is: D19 refuses to guess an entrance, because the
   * parcel centroid is the middle of a plot where no building stands and is
   * identical for every structure on it. A null pin is therefore the honest
   * record of "nobody has located this yet" — but left unlistable it is
   * invisible debt. This is what turns it into a dispatch list.
   */
  hasEntrance: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type BuildingFilter = z.infer<typeof buildingFilterSchema>;

import { z } from 'zod';
import { normalizeDigits, uuid } from './primitives';
import {
  CITIZEN_RESIDENCE,
  OWNER_BILLING_MODE,
  UNIT_STATUS,
  UNIT_TYPE,
  UNOCCUPIED_UNIT_STATUS,
  type UnitStatus,
} from './enums';
import { ADJUSTMENT_REASON_MIN, municipalToday } from './cash-policy';
import { hasAtMostTwoDecimals } from './money-amount';
import { canSpanLevels, levelFactorsSchema, unitLevels, unitLevelsField } from './unit-levels';

/**
 * Fees, and the per-citizen invoices they produce.
 *
 * The money type is the thing to get right here. Amounts are Lebanese pounds,
 * where a routine municipal fee is six or seven digits — `500000` is an
 * ordinary garbage charge. They travel as **integers**: LBP has no minor unit
 * in practice, and a float would eventually render someone's bill as
 * 499999.99999.
 */

export const FEE_FREQUENCY = ['ONCE', 'MONTHLY', 'HALF_YEARLY', 'ANNUALLY'] as const;
export const feeFrequencySchema = z.enum(FEE_FREQUENCY, {
  errorMap: () => ({ message: 'دورية الرسم مطلوبة' }),
});
export type FeeFrequency = (typeof FEE_FREQUENCY)[number];

/**
 * The currencies a Lebanese municipality quotes in.
 *
 * Here rather than in the frontend so the settings form and the endpoint that
 * validates it cannot drift — a currency the form offers and the schema rejects
 * is a save that fails with a validation error naming a field the user chose
 * from a list we gave them.
 */
export const CURRENCY_CODES = ['LBP', 'USD', 'EUR'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

/** The documents this portal issues a reference number for. */
export const SEQUENCE_KEYS = [
  'invoice',
  'serviceOrder',
  'permit',
  'taxReceipt',
  'refund',
] as const;
export type SequenceKey = (typeof SEQUENCE_KEYS)[number];

/** One document type's reference format, as stored and as sent. */
export interface NumberingSequence {
  prefix: string;
  nextNumber: number;
  padding: number;
}

/** When automatic backups should run. Read by no scheduler yet. */
export interface BackupSchedule {
  frequency: 'off' | 'daily' | 'weekly' | 'monthly';
  timeOfDay: string;
  dayOfWeek: number;
  dayOfMonth: number;
  keepCopies: number;
}

export const FEE_TARGET_TYPE = [
  'ALL_CITIZENS',
  'BUILDING_CATEGORY',
  'INDIVIDUAL_CITIZEN',
] as const;
export const feeTargetTypeSchema = z.enum(FEE_TARGET_TYPE, {
  errorMap: () => ({ message: 'الفئة المستهدفة مطلوبة' }),
});
export type FeeTargetType = (typeof FEE_TARGET_TYPE)[number];

/**
 * `CANCELLED` (migration 0090): a bill the manager withdrew before any money was
 * taken on it — issued twice, or by mistake. It owes nothing and takes nothing;
 * the row stays, with who cancelled it and why (`cancelBillSchema`).
 */
export const PAYMENT_STATUS = ['UNPAID', 'PENDING_REVIEW', 'PAID', 'OVERDUE', 'CANCELLED'] as const;
export const paymentStatusSchema = z.enum(PAYMENT_STATUS);
export type PaymentStatus = (typeof PAYMENT_STATUS)[number];

export const PAYMENT_METHOD = ['CASH', 'WHISH_MONEY', 'COLLECTOR'] as const;
export const paymentMethodSchema = z.enum(PAYMENT_METHOD);
export type PaymentMethod = (typeof PAYMENT_METHOD)[number];

/**
 * What `targetCategory` may hold when targeting a building category.
 *
 * Drawn from the property taxonomy the registry already uses rather than free
 * text: a fee aimed at "المحلات التجارية" has to resolve to rows the database
 * can actually find, and `PropertyType`/`UnitType` are what those rows carry.
 */
export const FEE_TARGET_CATEGORY = [
  'BUILDING',
  'HOUSE',
  'LAND',
  'TENT',
  'APARTMENT',
  'INDEPENDENT_HOUSE',
  'CLINIC',
  'OFFICE',
  'SHOP',
  'WAREHOUSE',
  /* Mirrors `UNIT_TYPE.GARAGE`. The two lists have to move together:
     `matchesCategory` compares a category to `unit.unitType` directly, so a
     unit type with no category here is one no per-category fee can reach. */
  'GARAGE',
  /*
    `UNIT_TYPE.PILOTIS` is deliberately **not** here, and this note exists
    because the comment above says the two lists have to move together.

    They do, for every value that names premises. A طابق أعمدة names none: it
    is the open level a block stands on, it can hold no occupant (see
    `isStructuralUnitType`), and a fee is owed by somebody for something. Adding
    it would create a category that resolves to rows no notice can lawfully be
    addressed to — the failure mode being a municipality that aims a fee at
    «طوابق الأعمدة», matches every pilotis in town, and finds no one to bill.

    So the invariant is narrower than «every unit type appears here»: every
    *occupiable* unit type does. A new structural type belongs in
    `STRUCTURAL_UNIT_TYPE` and out of this list, for the same reason.
  */
] as const;
export const feeTargetCategorySchema = z.enum(FEE_TARGET_CATEGORY);
export type FeeTargetCategory = (typeof FEE_TARGET_CATEGORY)[number];

/**
 * What the notice's amount is *per*.
 *
 * The register has always been able to say that a citizen owns six shops; the
 * biller could not, and charged the same for six as for one. `amount` was the
 * whole invoice, so the only question asked of a citizen's holdings was a
 * boolean — do they have at least one of these — and a rate schedule that
 * distinguishes a kiosk from a warehouse had no way to express itself.
 *
 * `FLAT` is that original behaviour, unchanged and still the default: one
 * notice, one amount, one invoice per citizen. The other two make `amount` a
 * *rate* and let the register decide the total:
 *
 *  - `PER_UNIT` — the rate times how many matching units the citizen holds.
 *  - `PER_AREA` — the rate times their total area in square metres.
 *
 * `TIERED_AREA` (0098) has no rate at all: the notice carries a table of area
 * brackets the assessment committee set («A» up to 100 m², «B» from 100 to
 * 150 m², …, `feeMatrixSchema`), and each unit is charged the bracket its area
 * falls in. `amount` is 0 under it. A unit two or more citizens are charged for
 * is billed once, in full, as a shared unit bill (decision D5,
 * docs/fees-system-rearchitecture-specification.md).
 *
 * Which of these is right is a municipal decision with a legal basis
 * behind it, not an engineering one, which is why none of them is imposed and
 * why every notice written before this existed keeps billing exactly as it did.
 */
export const FEE_BASIS = ['FLAT', 'PER_UNIT', 'PER_AREA', 'TIERED_AREA'] as const;
export const feeBasisSchema = z.enum(FEE_BASIS).default('FLAT');
export type FeeBasis = (typeof FEE_BASIS)[number];

/**
 * Who a fee is levied on — الرسم على الشاغل أم على المالك.
 *
 * This replaced a boolean called `chargesUnoccupied`, and the replacement is
 * the point rather than a rename. That flag asked "does this notice charge
 * empty units?", which is a symptom of the real question and cannot answer its
 * companion: whether a landlord is billed for the flats other people live in.
 * Both fall out of one fact about the fee, and Lebanese practice states it
 * plainly — a شاغرة unit is relieved of رسوم الإشغال والنفايات and still owes
 * الرسوم التأسيسية كالأرصفة والمجاري. Those are not one fee with an exception;
 * they are two fees with different bearers.
 *
 *  - `OCCUPANT` — رسم النظافة, القيمة التأجيرية, and the annual رسم صيانة
 *    المجارير والأرصفة. Falls on whoever is actually
 *    in the unit. An owner pays for what they live in; a مستأجر and a شاغل
 *    بتسامح pay for what they occupy; a flat the owner has let is billed to
 *    its tenant on the tenant's own card, not twice; an empty or unfinished
 *    unit is billed to nobody.
 *  - `OWNER` — the one-off رسم إنشاء المجارير والأرصفة and the rest of the
 *    الرسوم التأسيسية.
 *    Falls on the deed holder for everything they own, whether it is occupied,
 *    let, empty or still being built. Tenants owe none of it.
 *
 * **Maintenance is not construction.** Law 60/1988 splits the pavement and
 * sewer fee in two: Art. 78 charges the *construction* fee to the owner who
 * applies for a building permit, once; Art. 79 charges the annual
 * *maintenance* fee (1.5% of the rental value) to the occupant, «أيا كانت صفته»,
 * collected with the rental-value fee — and, per جمعية العمل البلدي's reading
 * of the same law, not owed for a vacant building. An annual الأرصفة notice set
 * to `OWNER` would bill absent owners for empty flats against the text of the
 * law. This docblock and the labels used to call الأرصفة والمجاري owner-borne
 * without the distinction; see `feeBearerHint`.
 *
 * There is deliberately no third value meaning "charge everyone who holds it".
 * That was the behaviour before this existed, and it is not a policy any
 * municipality would choose: it bills the landlord and the tenant for the same
 * flat, which is double taxation of one unit. It survived only because the
 * register could not tell the two apart.
 *
 * `OCCUPANT` is the default because it is both the commoner case and, on a
 * register where nobody has recorded حالة الوحدة yet, byte-for-byte the old
 * behaviour: an unmarked unit reads as occupied by its owner, so the owner is
 * billed for all of them and each tenant for their own — exactly what happened
 * before. The correction switches itself on as landlords actually mark units
 * مؤجرة, which is the only honest mechanism available. See §12.
 */
export const FEE_BEARER = ['OCCUPANT', 'OWNER'] as const;
export const feeBearerSchema = z.enum(FEE_BEARER).default('OCCUPANT');
export type FeeBearer = (typeof FEE_BEARER)[number];

/**
 * «من يشمل الإشعار» (0100; the user's decision, 2026-10-26) — the filters a
 * notice applies on top of its bearer and its target type, asked in this order:
 *
 *  1. **حالة الوحدة** — which of the six `UNIT_STATUS` values it charges. A unit
 *     with no recorded status counts as `OWNER_OCCUPIED`, as it always has; a
 *     tenant's or a شاغل بتسامح's own card counts as `RENTED` or
 *     `FREE_OCCUPIED` (`feeUnitState`). Who pays for a unit in scope is still
 *     the bearer rule: under `OCCUPANT` the one inside, under `OWNER` the deed
 *     holder — and a شاغرة or قيد الإنجاز unit has nobody inside, so ticking
 *     either under `OCCUPANT` charges its owner.
 *  2. **نوع الإقامة** — which kinds of file (`CITIZEN_RESIDENCE`) it reaches.
 *  3. **نوع العقار / الوحدة** — several `FEE_TARGET_CATEGORY` values at once.
 *
 * Absent is the behaviour before any of this: the statuses the bearer has
 * always charged (`defaultUnitStates`), every kind of file, the one category
 * `targetCategory` names. Ignored under FLAT, as the bearer is: a flat amount is
 * a person's charge, not a unit's, so only the residence and the categories
 * narrow it.
 *
 * Departing from what the law charges is allowed, with a warning the clerk
 * confirms before issuing (`feeScopeWarnings`): Law 60/1988 does not levy
 * القيمة التأجيرية or النظافة on an empty unit, and exempts no status the
 * bearer charges and no file by where its holder lives.
 */
export const FEE_SCOPE_WARNING = [
  /** شاغرة or قيد الإنجاز ticked under OCCUPANT: an occupancy fee on a unit nobody occupies. */
  'UNOCCUPIED_CHARGED',
  /** A status the bearer charges left unticked: less is collected than the law levies. */
  'STATE_LEFT_OUT',
  /** A kind of file left unticked: the law does not exempt by where a person lives. */
  'RESIDENCE_LEFT_OUT',
] as const;
export type FeeScopeWarning = (typeof FEE_SCOPE_WARNING)[number];

/**
 * The حالة الوحدة values a notice charges when it names none — what each
 * bearer has always charged: an occupancy fee every occupied unit, an
 * owner-borne fee every unit whatever its state.
 */
export function defaultUnitStates(bearer: FeeBearer): UnitStatus[] {
  return bearer === 'OWNER'
    ? [...UNIT_STATUS]
    : UNIT_STATUS.filter((state) => !(UNOCCUPIED_UNIT_STATUS as readonly string[]).includes(state));
}

/**
 * The state a unit is judged by under a notice's «حالة الوحدة» filter: a
 * tenant's or a شاغل بتسامح's own card is the occupancy it records, an owner's
 * card the status it carries, and no recorded status is «مشغولة من المالك» —
 * a unit nobody was asked about is billed (`isUnoccupied`).
 */
export function feeUnitState(unit: { occupancyType: string; unitStatus: string | null }): string {
  if (unit.occupancyType === 'TENANT') return 'RENTED';
  if (unit.occupancyType === 'FREE_OCCUPANT') return 'FREE_OCCUPIED';
  return unit.unitStatus ?? 'OWNER_OCCUPIED';
}

/**
 * What the clerk must confirm before a notice with this scope is issued, in the
 * order the step asks: none for a notice that charges what the law charges.
 * Under FLAT only the residence is read, as the statuses decide nothing there.
 */
export function feeScopeWarnings(notice: {
  basis: FeeBasis;
  bearer: FeeBearer;
  unitStates?: readonly string[];
  residences?: readonly string[];
}): FeeScopeWarning[] {
  const warnings: FeeScopeWarning[] = [];
  if (notice.basis !== 'FLAT' && notice.unitStates) {
    const states = notice.unitStates;
    if (notice.bearer === 'OCCUPANT' && UNOCCUPIED_UNIT_STATUS.some((state) => states.includes(state))) {
      warnings.push('UNOCCUPIED_CHARGED');
    }
    if (defaultUnitStates(notice.bearer).some((state) => !states.includes(state))) {
      warnings.push('STATE_LEFT_OUT');
    }
  }
  if (notice.residences && CITIZEN_RESIDENCE.some((kind) => !notice.residences!.includes(kind))) {
    warnings.push('RESIDENCE_LEFT_OUT');
  }
  return warnings;
}

/** A list of distinct enum values, at least one. */
function distinctChoice<T extends readonly [string, ...string[]]>(values: T, required: string) {
  return z
    .array(z.enum(values), { invalid_type_error: required })
    .min(1, required)
    .refine((chosen) => new Set(chosen).size === chosen.length, 'قيمة مكرّرة في الاختيار');
}

/**
 * The notice's scope as stored (`fee_notices.scope`, 0100), read back by the
 * biller through this schema as the bracket table is through `feeMatrixSchema`.
 * Each key absent is its default; see `FEE_SCOPE_WARNING` above.
 */
export const feeNoticeScopeSchema = z.object({
  categories: distinctChoice(FEE_TARGET_CATEGORY, 'اختر نوعاً واحداً على الأقل').optional(),
  unitStates: distinctChoice(UNIT_STATUS, 'اختر حالة واحدة على الأقل').optional(),
  residences: distinctChoice(CITIZEN_RESIDENCE, 'اختر نوع إقامة واحداً على الأقل').optional(),
  acknowledgedWarnings: z.array(z.enum(FEE_SCOPE_WARNING)).optional(),
});
export type FeeNoticeScope = z.infer<typeof feeNoticeScopeSchema>;

/**
 * How one citizen's invoice was arrived at.
 *
 * Stored on the payment rather than recomputed on demand, because the register
 * moves: a citizen who sells a shop the week after being billed would, on a
 * recomputed breakdown, see an invoice whose lines no longer add up to the
 * amount they are being asked to pay. What a bill says about itself has to
 * stay true to the moment it was raised — that is the whole difference between
 * a receipt and a report.
 *
 * It is also the answer to the only question that matters at the counter,
 * which nobody could answer before: «ليش عليّ هالمبلغ؟»
 */
export const feeAssessmentLineSchema = z.object({
  /** رقم العقار the unit sits on, when it has one. */
  propertyNumber: z.string().nullable(),
  propertyType: z.string(),
  unitType: z.string().nullable(),
  /** Square metres, when established. Null under a PER_UNIT basis. */
  unitArea: z.number().nullable(),
  /**
   * The census unit's code («0201»), when the line is a flat the census
   * holds. Absent on every bill raised before co-owner billing (0075).
   */
  unitCode: z.string().nullable().optional(),
  /**
   * The part of a co-owned flat this bill charges («توزيع الرسم على
   * المالكين», `ownerShareOf`): the line's area, or its one unit, is
   * multiplied by numerator/denominator. Absent on a flat billed whole.
   */
  ownerShare: z
    .object({
      mode: z.enum(OWNER_BILLING_MODE),
      numerator: z.number().int().min(0),
      denominator: z.number().int().min(1),
    })
    .nullable()
    .optional(),
  /**
   * The unit's levels when it spans more than one — a «دوبلكس» is 2
   * (`Unit.levels`, 0095). Absent on a one-level unit and on every bill
   * raised before 0095.
   */
  levels: z.number().int().min(2).optional(),
  /**
   * How many roofs this unit counted for under PER_UNIT when that is not 1 — a
   * duplex flat at the municipality's factor (1.8 by default), a house at one
   * roof per storey (decision D28). `chargedUnits` is the sum of these.
   */
  levelFactor: z.number().positive().optional(),
  /**
   * Under TIERED_AREA, the bracket this unit's area fell in — its code («B») and
   * label as the notice's table had them when the bill was raised. Absent under
   * every other basis.
   */
  bracketCode: z.string().optional(),
  bracketLabel: z.string().optional(),
  /**
   * Under TIERED_AREA, the census unit the line charges, when it has one. A
   * period's recurring run reads it back to keep a unit already billed in that
   * period off every later bill of the period (decision D8, 2026-10-26): a code
   * like «0201» repeats in every building, so only the id can say "this flat".
   * Absent on a card-only unit and under every other basis.
   */
  unitId: z.string().optional(),
});

export const feeAssessmentSchema = z.object({
  basis: z.enum(FEE_BASIS),
  /** The rate `amount` held on the notice, before multiplication. */
  rate: z.number(),
  /** Units counted, under PER_UNIT. */
  unitCount: z.number(),
  /** Square metres summed, under PER_AREA. */
  totalArea: z.number(),
  /**
   * Units the citizen holds that this notice did not charge them for.
   *
   * One number covering every reason the bearer rule can decline a unit — let
   * to a tenant who is billed for it themselves, empty, still being built, or
   * (under an owner-borne fee) not theirs at all. They are deliberately not
   * broken out: what the person holding the invoice needs to know is that the
   * count on the bill is smaller than the count in the register and that this
   * was on purpose. *Why* each one was dropped is a question for the property
   * card, which is where the answer is recorded and can be corrected.
   *
   * Stored so the exclusion is visible on the bill itself. An invoice that
   * silently omits three flats reads as an invoice for a smaller building, and
   * neither the resident who thinks they were charged for them nor the clerk
   * checking the round can tell the difference. «٦ محل × ١٠٠٬٠٠٠ (٣ وحدات غير
   * محتسبة)» is a sentence both of them can argue with.
   *
   * Defaulted for every assessment stored before any of this existed.
   */
  excludedUnitCount: z.number().default(0),
  /**
   * Flats whose occupancy fee this bill holds because their records disagree
   * and are under review — a «تعارض في حالة الوحدة» (`settleUnitStatus`). Not
   * charged to anybody until the disagreement is settled (the user's decision,
   * 2026-09-30), and counted here so the bill says so rather than reading as a
   * smaller holding. Owner-borne fees are never held: they follow the deed.
   */
  heldUnitCount: z.number().default(0),
  /**
   * Flats this bill charges nothing for because their current damage reading
   * says nobody can live in them — «غير صالحة للسكن» (`isUninhabitableReading`).
   * Exempt from every rate-based fee, owner-borne ones included, until a
   * re-inspection reads them habitable (the user's decisions of 2026-10-05 and
   * 2026-10-07: «not habitable → exempt»), and counted here so the bill says
   * so. Counted apart from `heldUnitCount`: the clerk settles a review in the
   * register and an uninhabitable flat in the field.
   */
  uninhabitableUnitCount: z.number().default(0),
  /**
   * Co-owned flats charged on this bill at this owner's part rather than whole
   * («توزيع الرسم على المالكين», migration 0075). Their lines carry the
   * fraction; `totalArea` (PER_AREA) and `chargedUnits` (PER_UNIT) are already
   * the shared figures the rate multiplies.
   */
  sharedUnitCount: z.number().default(0),
  /**
   * Co-owned flats this owner holds but another owner pays for — the
   * responsible owner named on the flat. Not charged here, and counted so the
   * bill says so rather than reading as a smaller holding.
   */
  coOwnerPaidUnitCount: z.number().default(0),
  /**
   * Units this bill charges nothing for because they are «معفاة من الرسوم» —
   * the mosque on a waqf parcel, a public building (migration 0077). Every
   * rate-based fee, whoever bears it, and counted so the bill says so.
   */
  exemptUnitCount: z.number().default(0),
  /**
   * Units whose حالة الوحدة the notice does not charge («من يشمل الإشعار»,
   * 0100): a شاغرة flat under an occupancy fee, or any status the clerk left
   * unticked. Counted apart from `excludedUnitCount`, which is a unit in scope
   * that another person pays for. Absent on every bill raised before 0100,
   * where an empty unit was counted in `excludedUnitCount`.
   */
  outOfScopeUnitCount: z.number().default(0),
  /**
   * The unit count the rate multiplies under PER_UNIT when it is not simply the
   * number of units: a co-owned flat charged at a part — 2.25 for two whole
   * shops and a quarter of a third — or a unit on several levels weighed in
   * roofs (a duplex at 1.8, `levelFactor`). Absent when every charged unit
   * counts exactly one, where it equals `unitCount`.
   */
  chargedUnits: z.number().optional(),
  /**
   * TIERED_AREA only (decision D5). On a shared unit bill, how many registered
   * citizens may pay it — the number, never the names (open question O2). On a
   * citizen's own bill, how many of their units went to shared unit bills
   * instead, so the bill says so rather than reading as a smaller holding.
   */
  sharedBillDebtorCount: z.number().int().min(2).optional(),
  sharedBillUnitCount: z.number().int().min(1).optional(),
  /**
   * TIERED_AREA only. Units this person holds that the notice's table does not
   * price at all — a type no bracket names, or a card with no unit type (أرض,
   * خيمة) — so not charged by this notice and counted, not refused (decision
   * D11, 2026-10-26).
   */
  outsideTableUnitCount: z.number().int().min(1).optional(),
  /**
   * TIERED_AREA only. Shared units left off this bill and billed to nobody
   * because their holders' records put them in different brackets
   * (`splitSharedUnitBills`), so the bill says so rather than reading as a
   * smaller holding.
   */
  sharedConflictUnitCount: z.number().int().min(1).optional(),
  /**
   * TIERED_AREA only. Units already on another bill of this notice for this
   * period — a holder recorded after the period was billed — so not billed again
   * (decision D8, 2026-10-26: a period's bill stands; a change of holders counts
   * from the next period).
   */
  billedElsewhereUnitCount: z.number().int().min(1).optional(),
  lines: z.array(feeAssessmentLineSchema),
});

export type FeeAssessmentLine = z.infer<typeof feeAssessmentLineSchema>;

/**
 * An accountant's review of a bill a correction affected («فواتير تأثّرت
 * بتصحيحات»). The bill is never changed; this records that it was looked at,
 * at which figure, and what was decided.
 */
export const billBasisReviewSchema = z.object({
  note: z
    .string({ required_error: 'اكتب ما قرّرته' })
    .trim()
    .min(3, 'اكتب ما قرّرته')
    .max(1000, 'الملاحظة طويلة جداً'),
  /** Today's figure as the screen showed it. Refused if it has moved since. */
  figure: z.string().min(1).max(64),
});
export type BillBasisReview = z.infer<typeof billBasisReviewSchema>;
export type FeeAssessment = z.infer<typeof feeAssessmentSchema>;

/** LBP, whole pounds. The ceiling is a typo guard, not a policy limit. */
const lbpAmount = z.coerce
  .number({
    required_error: 'المبلغ مطلوب',
    invalid_type_error: 'المبلغ يجب أن يكون رقماً',
  })
  .int('المبلغ يجب أن يكون رقماً صحيحاً بالليرة')
  .positive('المبلغ يجب أن يكون أكبر من صفر')
  .max(1_000_000_000, 'المبلغ كبير جداً — يرجى المراجعة');

/** Square metres as the census records them: not negative, two decimals at most (`units.unitArea`, DECIMAL(12,2)). */
const bracketArea = z
  .number({ invalid_type_error: 'المساحة يجب أن تكون رقماً' })
  .nonnegative('المساحة لا تكون سالبة')
  .max(1_000_000, 'المساحة كبيرة جداً — يرجى المراجعة')
  .refine(hasAtMostTwoDecimals, 'المساحة بخانتين عشريتين على الأكثر');

/**
 * One row of a TIERED_AREA notice's table: «الفئة B — من 100 إلى 150 م² —
 * 1,500,000 ل.ل», for the unit types and level count it names (decisions D1
 * and D7, docs/fees-system-rearchitecture-specification.md).
 *
 * The range includes `minArea` and stops short of `maxArea`, so 100 m² sits in
 * exactly one of `[50, 100)` and `[100, 150)`, and an area of 100.5 m² cannot
 * fall between two brackets. `maxArea` null is no ceiling: the top bracket.
 *
 * `levels` picks the table: 1 for a one-level unit, 2 for a «دوبلكس», 3 for a
 * «تريبلكس» (`Unit.levels`, 0095). Only a dwelling spans levels, so a bracket
 * for more than one level names dwelling types only. The duplex and triplex
 * brackets replace the roof factor (`levelFactors`), which TIERED_AREA does not
 * read. Amounts are whole pounds, like every notice amount.
 */
export const feeMatrixBracketSchema = z
  .object({
    code: z
      .string({ required_error: 'رمز الفئة مطلوب' })
      .trim()
      .min(1, 'رمز الفئة مطلوب')
      .max(10, 'رمز الفئة طويل جداً'),
    labelAr: z
      .string({ required_error: 'اسم الفئة مطلوب' })
      .trim()
      .min(1, 'اسم الفئة مطلوب')
      .max(80, 'اسم الفئة طويل جداً'),
    unitTypes: z
      .array(z.enum(UNIT_TYPE), { required_error: 'اختر نوع الوحدة' })
      .min(1, 'اختر نوعاً واحداً على الأقل من الوحدات')
      .refine((types) => new Set(types).size === types.length, 'نوع الوحدة مكرّر في الفئة'),
    levels: unitLevelsField.default(1),
    minArea: bracketArea,
    maxArea: bracketArea.nullable(),
    amount: lbpAmount,
  })
  .refine((bracket) => bracket.maxArea === null || bracket.maxArea > bracket.minArea, {
    path: ['maxArea'],
    message: 'الحد الأعلى للمساحة يجب أن يكون أكبر من الحد الأدنى',
  })
  .refine((bracket) => bracket.levels === 1 || bracket.unitTypes.every(canSpanLevels), {
    path: ['levels'],
    message: 'المسكن وحده يمتد على أكثر من طابق: اختر شقة أو منزلاً مستقلاً',
  });
export type FeeMatrixBracket = z.infer<typeof feeMatrixBracketSchema>;

/** The most rows one table may hold. A sanity bound: nine categories over three level counts is 27. */
export const FEE_MATRIX_MAX_BRACKETS = 100;

/**
 * A TIERED_AREA notice's whole table.
 *
 * Each (unit type, level count) a bracket names is its own scale, and on each
 * scale the brackets, sorted by `minArea`, run one into the next: no two
 * overlap, none leaves a gap, and only the last may be open-ended. A scale need
 * not start at 0: a unit smaller than its first bracket is reported, not priced
 * by guess. Codes are unique across the table, since a bill names its bracket
 * by code.
 */
export const feeMatrixSchema = z
  .array(feeMatrixBracketSchema, { required_error: 'جدول الفئات مطلوب' })
  .min(1, 'أضف فئة واحدة على الأقل')
  .max(FEE_MATRIX_MAX_BRACKETS, `الجدول لا يتجاوز ${FEE_MATRIX_MAX_BRACKETS} فئة`)
  .superRefine((brackets, ctx) => {
    const seenCodes = new Map<string, number>();
    brackets.forEach((bracket, index) => {
      const first = seenCodes.get(bracket.code);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'code'],
          message: `الرمز «${bracket.code}» مستعمل لفئة أخرى`,
        });
      } else {
        seenCodes.set(bracket.code, index);
      }
    });

    for (const scale of bracketScales(brackets)) {
      for (let i = 1; i < scale.length; i += 1) {
        const previous = scale[i - 1]!;
        const current = scale[i]!;
        const ceiling = previous.bracket.maxArea;
        if (ceiling === null || current.bracket.minArea < ceiling) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [current.index, 'minArea'],
            message: `الفئة «${current.bracket.code}» تتداخل مع الفئة «${previous.bracket.code}» في المساحة`,
          });
        } else if (current.bracket.minArea > ceiling) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [current.index, 'minArea'],
            message: `بين الفئة «${previous.bracket.code}» والفئة «${current.bracket.code}» مساحات لا تقع في أي فئة`,
          });
        }
      }
    }
  });
export type FeeMatrix = z.infer<typeof feeMatrixSchema>;

/**
 * The table split into its scales: one per (unit type, level count) a bracket
 * names, each sorted by `minArea`, every row with its index in the table.
 * A bracket naming three unit types sits on three scales.
 */
export function bracketScales<B extends Pick<FeeMatrixBracket, 'unitTypes' | 'levels' | 'minArea'>>(
  brackets: readonly B[],
): Array<Array<{ bracket: B; index: number }>> {
  const scales = new Map<string, Array<{ bracket: B; index: number }>>();
  brackets.forEach((bracket, index) => {
    for (const unitType of bracket.unitTypes) {
      const key = `${unitType}:${bracket.levels}`;
      const scale = scales.get(key) ?? [];
      scale.push({ bracket, index });
      scales.set(key, scale);
    }
  });
  return [...scales.values()].map((scale) =>
    scale.sort((a, b) => a.bracket.minArea - b.bracket.minArea || a.index - b.index),
  );
}

/**
 * Why a unit has no bracket:
 *
 *  - `NOT_IN_TABLE`: no bracket names its type at any level count, or it has no
 *    unit type at all (a أرض or خيمة card). The table does not price it, so the
 *    notice does not charge it: the biller counts it as outside the table
 *    (decision D11, 2026-10-26), it does not refuse the citizen over it.
 *  - `NO_AREA`: its type is in the table and it has no recorded area.
 *  - `NO_BRACKET`: its type is in the table, but no bracket covers its level
 *    count (D1) or its area (a scale need not start at 0).
 *
 * The last two are gaps in the record or the table, never priced by guess.
 */
export type BracketMiss = 'NOT_IN_TABLE' | 'NO_AREA' | 'NO_BRACKET';

/**
 * The bracket one unit falls in, or why it falls in none.
 *
 * The scale is the unit's own type and level count (D1, D7); on it, the
 * bracket whose range holds the area, `minArea` included and `maxArea` not.
 * A table that passed `feeMatrixSchema` holds at most one such bracket. A unit
 * the table does not price, or one with no area, is a miss and is never priced
 * by guess: the biller reports it, and the drawer says so.
 */
export function matchBracket<B extends Pick<FeeMatrixBracket, 'unitTypes' | 'levels' | 'minArea' | 'maxArea'>>(
  unit: { unitType: string | null; unitArea: number | null; levels?: number | null },
  brackets: readonly B[],
): { kind: 'matched'; bracket: B } | { kind: 'miss'; reason: BracketMiss } {
  const unitType = unit.unitType;
  if (unitType === null || !brackets.some((row) => (row.unitTypes as readonly string[]).includes(unitType))) {
    return { kind: 'miss', reason: 'NOT_IN_TABLE' };
  }
  if (unit.unitArea === null || !Number.isFinite(unit.unitArea)) return { kind: 'miss', reason: 'NO_AREA' };
  const area = unit.unitArea;
  const levels = unitLevels(unit);
  const bracket = brackets.find(
    (row) =>
      (row.unitTypes as readonly string[]).includes(unitType) &&
      row.levels === levels &&
      area >= row.minArea &&
      (row.maxArea === null || area < row.maxArea),
  );
  return bracket ? { kind: 'matched', bracket } : { kind: 'miss', reason: 'NO_BRACKET' };
}

/**
 * A notice amount: whole pounds and not negative here, because a TIERED_AREA
 * notice's amount is 0 — the brackets carry the money. Under every other basis
 * the refinement below asks for more than zero, with the words `lbpAmount`
 * uses.
 */
const noticeAmount = z.coerce
  .number({
    required_error: 'المبلغ مطلوب',
    invalid_type_error: 'المبلغ يجب أن يكون رقماً',
  })
  .int('المبلغ يجب أن يكون رقماً صحيحاً بالليرة')
  .nonnegative('المبلغ يجب أن يكون أكبر من صفر')
  .max(1_000_000_000, 'المبلغ كبير جداً — يرجى المراجعة');

/**
 * What a notice says, before the wizard's retry key: shared by issuing it
 * (`createFeeNoticeSchema`) and previewing it (`feeNoticePreviewSchema`), so
 * the preview reads exactly what the issue would.
 */
const feeNoticeFields = z.object({
  title: z
    .string({ required_error: 'اسم الرسم مطلوب' })
    .trim()
    .min(3, 'اسم الرسم قصير جداً')
    .max(120, 'اسم الرسم طويل جداً'),
  /** The whole bill under FLAT, the rate under PER_UNIT and PER_AREA, 0 under TIERED_AREA. */
  amount: noticeAmount,
  /** What `amount` is per — see `FEE_BASIS`. Absent means the original flat charge. */
  basis: feeBasisSchema,
  /** The bracket table, under TIERED_AREA and only then (CHECK fee_notices_matrix_brackets_basis). */
  matrixBrackets: feeMatrixSchema.optional(),
  /**
   * Who owes this fee — see `FEE_BEARER`.
   *
   * Meaningless under FLAT, where the amount does not depend on holdings at
   * all, and ignored there rather than refused: a notice switched from
   * PER_UNIT to FLAT and back should not lose the setting in between.
   */
  bearer: feeBearerSchema,
  frequency: feeFrequencySchema,
  targetType: feeTargetTypeSchema,
  targetCategory: feeTargetCategorySchema.optional(),
  /**
   * Several categories at once, under BUILDING_CATEGORY, in place of
   * `targetCategory` («من يشمل الإشعار», 0100). Never both.
   */
  targetCategories: feeNoticeScopeSchema.shape.categories,
  /** The حالة الوحدة values it charges; absent is the bearer's own (`defaultUnitStates`). See `FEE_SCOPE_WARNING`. */
  unitStates: feeNoticeScopeSchema.shape.unitStates,
  /** The kinds of file it reaches; absent is every kind. Not read for one named citizen. */
  residences: feeNoticeScopeSchema.shape.residences,
  /** The warnings the clerk confirmed (`feeScopeWarnings`); the issue refuses a scope with one unconfirmed. */
  acknowledgedWarnings: feeNoticeScopeSchema.shape.acknowledgedWarnings,
  targetCitizenId: uuid.optional(),
  dueDate: z
    .string({ required_error: 'تاريخ الاستحقاق مطلوب' })
    .min(1, 'تاريخ الاستحقاق مطلوب'),
  instructions: z.string().trim().max(1000).optional(),
});

/**
 * The rules across a notice's fields. The three target types each require
 * different companions — an "individual" fee with no citizen attached would
 * fan out to nobody and look like a silent failure — and the basis decides
 * between an amount and a bracket table, never both.
 *
 * A category belongs to a notice aimed at one and to no other (decision D13,
 * 2026-10-26). The assessment filters every unit by it, so a category sent
 * with «جميع المواطنين» quietly charged that category alone: the issue wizard
 * kept its default «محل تجاري» on every target and sent it, and a per-unit
 * notice to all citizens billed their shops and nothing else. Refused here, on
 * the server, so no caller can do it again.
 */
function refineFeeNotice(data: z.infer<typeof feeNoticeFields>, ctx: z.RefinementCtx): void {
  if (data.targetType === 'BUILDING_CATEGORY' && !data.targetCategory && !data.targetCategories) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetCategory'],
      message: 'اختر فئة العقارات المستهدفة',
    });
  }
  if (data.targetCategory && data.targetCategories) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetCategories'],
      message: 'أرسل فئة واحدة أو قائمة فئات، لا الاثنتين',
    });
  }
  if (data.targetCategories && data.targetType !== 'BUILDING_CATEGORY') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetCategories'],
      message: 'قائمة الفئات لإشعار موجّه إلى فئات عقارية وحده',
    });
  }
  if (data.targetType !== 'BUILDING_CATEGORY' && data.targetCategory) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetCategory'],
      message: 'الفئة للرسم الموجّه إلى فئة عقارات وحده',
    });
  }
  if (data.targetType === 'INDIVIDUAL_CITIZEN' && !data.targetCitizenId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetCitizenId'],
      message: 'اختر المواطن المستهدف',
    });
  }
  if (data.basis === 'TIERED_AREA') {
    if (!data.matrixBrackets) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['matrixBrackets'],
        message: 'أدخل جدول الفئات',
      });
    }
    if (data.amount !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: 'المبلغ يُحدَّد من جدول الفئات: اتركه صفراً',
      });
    }
  } else {
    if (data.matrixBrackets) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['matrixBrackets'],
        message: 'جدول الفئات للرسم حسب فئة المساحة وحده',
      });
    }
    if (data.amount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: 'المبلغ يجب أن يكون أكبر من صفر',
      });
    }
  }
}

/** Issuing a fee: what the notice says, and the wizard's retry key. */
export const createFeeNoticeSchema = feeNoticeFields
  .extend({
    /**
     * The wizard's id for this issue (migration 0091). A notice bills everyone
     * it targets, so a retry after a lost answer must answer with the first
     * notice rather than bill the town a second time. Required: a press with no
     * key is the one case the server could not tell from a new notice.
     */
    clientRequestId: uuid,
  })
  .superRefine(refineFeeNotice)
  .superRefine((data, ctx) => {
    // Issued only once every warning its scope raises was confirmed; the preview asks nothing of it.
    const unconfirmed = feeScopeWarnings(data).filter((warning) => !data.acknowledgedWarnings?.includes(warning));
    if (unconfirmed.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acknowledgedWarnings'],
        message: 'أكّد التنبيهات على نطاق الإشعار قبل إصداره',
      });
    }
  });

export type CreateFeeNotice = z.infer<typeof createFeeNoticeSchema>;

/**
 * «معاينة قبل الإصدار»: the same notice, asked what it would bill without
 * billing anyone. No retry key, because nothing is written.
 */
export const feeNoticePreviewSchema = feeNoticeFields.superRefine(refineFeeNotice);
export type FeeNoticePreviewInput = z.infer<typeof feeNoticePreviewSchema>;

/**
 * Why a citizen a notice targets cannot be assessed, as a code the screen
 * words and says what to do about (2026-10-27; the server's sentence alone
 * named neither the unit's type, area nor levels, nor the fix, and read in
 * Arabic on an English screen):
 *
 *  - `UNSURVEYED` — a building on their card whose units were never counted;
 *  - `NO_AREA` — a unit charged by area with none recorded;
 *  - `NO_BRACKET` — a unit of a type the table prices, whose level count or
 *    area no bracket covers (`matchBracket`'s miss of the same name). A type
 *    the table never names is not this: it is outside the notice, counted and
 *    not charged (`NOT_IN_TABLE`, decision D11);
 *  - `SHARES_MISSING` — a unit divided «حسب الأسهم» with a co-owner's أسهم
 *    unrecorded;
 *  - `NO_LEVEL_FACTOR` — a unit on more levels than الإعدادات has a roof factor for.
 */
export const FEE_UNASSESSABLE_REASON = [
  'UNSURVEYED',
  'NO_AREA',
  'NO_BRACKET',
  'SHARES_MISSING',
  'NO_LEVEL_FACTOR',
] as const;
export type FeeUnassessableReason = (typeof FEE_UNASSESSABLE_REASON)[number];

/**
 * One citizen the notice cannot assess. `reason` is the server's own sentence,
 * kept for its logs and older readers; `code` and `unit` are what a screen
 * reads — the unit that stopped the assessment, as the register holds it (the
 * building, under `UNSURVEYED`, with no unit of its own).
 */
export const feeUnassessableSchema = z.object({
  citizenId: z.string(),
  name: z.string(),
  reason: z.string(),
  code: z.enum(FEE_UNASSESSABLE_REASON).optional(),
  unit: z
    .object({
      unitCode: z.string().nullable(),
      propertyNumber: z.string().nullable(),
      unitType: z.string().nullable(),
      unitArea: z.number().nullable(),
      levels: z.number().int().positive(),
    })
    .optional(),
});
export type FeeUnassessable = z.infer<typeof feeUnassessableSchema>;

/**
 * What the preview answers: what issuing this notice now would bill, read by
 * the same path the issue takes (`FeesService.planNotice`) and written nowhere.
 *
 * `expectedRevenue` is the citizens' own bills plus the shared unit bills, in
 * whole pounds. `brackets` is empty under every basis but TIERED_AREA, where it
 * counts each unit once, a shared one included, in the table's own order. The
 * `notCharged` counts are each unit once across the run, as the issue counts
 * them. `unassessable` names the citizens the issue would skip and why
 * (`feeUnassessableSchema`) — a staff read, as the issue's own answer is.
 * `conflicts` are units shared by citizens whose records put them in different
 * brackets, billed to nobody (`splitSharedUnitBills`); the people are counted,
 * not named.
 */
export const feeNoticePreviewResultSchema = z.object({
  targetedCitizens: z.number().int().nonnegative(),
  /** Citizens who would get a bill of their own. */
  billedCitizens: z.number().int().nonnegative(),
  /** Units billed once to everyone charged for them (TIERED_AREA, D5). */
  sharedBills: z.number().int().nonnegative(),
  expectedRevenue: z.number().nonnegative(),
  currency: z.string(),
  brackets: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      unitCount: z.number().int().nonnegative(),
      subtotal: z.number().nonnegative(),
    }),
  ),
  notCharged: z.object({
    /** Not this person's to pay under the bearer rule: let, empty, still being built. */
    excludedUnits: z.number().int().nonnegative(),
    heldUnits: z.number().int().nonnegative(),
    uninhabitableUnits: z.number().int().nonnegative(),
    feeExemptUnits: z.number().int().nonnegative(),
    coOwnerPaidUnits: z.number().int().nonnegative(),
    /** Units whose حالة الوحدة the notice does not charge, each once (0100). */
    outOfScopeUnits: z.number().int().nonnegative(),
    /** The same, by state: «شاغرة: 12». A state with none is absent. */
    outOfScopeByState: z.record(z.enum(UNIT_STATUS), z.number().int().positive()),
    /** Files the residence filter left out that the notice would otherwise reach (0100). */
    residenceLeftOut: z.number().int().nonnegative(),
    /** Under TIERED_AREA, units the table does not price at all (D11). Each unit once. */
    outsideTableUnits: z.number().int().nonnegative(),
  }),
  /**
   * The same units by type — `null` for a card with no unit type (أرض, خيمة) —
   * so a type the clerk forgot to put in the table shows before «إصدار», not
   * after. Empty under every other basis.
   */
  outsideTable: z.array(z.object({ unitType: z.string().nullable(), count: z.number().int().min(1) })),
  unassessable: z.array(feeUnassessableSchema),
  conflicts: z.array(
    z.object({
      unitId: z.string(),
      unitCode: z.string().nullable(),
      propertyNumber: z.string().nullable(),
      citizenCount: z.number().int().min(2),
      bracketCodes: z.array(z.string()),
    }),
  ),
});
export type FeeNoticePreviewResult = z.infer<typeof feeNoticePreviewResultSchema>;

/**
 * A shared unit bill as a staff list shows it (0099, D5): the unit it is for
 * and how many registered citizens may pay it. Lists that name a bill's citizen
 * carry this instead, with the citizen fields null, because a shared bill has
 * no one citizen. The debtors are counted, never named (open question O2).
 */
export interface SharedUnitBillView {
  unitId: string;
  /** «0201», formatted from the unit's floor and sequence as the receipt prints it. */
  unitCode: string;
  buildingCode: string;
  debtorCount: number;
}

/**
 * An urgent-payment ceiling as the settings form sends it: greater than zero,
 * at most two decimals and inside the DECIMAL(14,2) column (a CHECK in 0083
 * refuses zero or less), `null` for none.
 */
const urgentCeiling = z
  .number({ invalid_type_error: 'السقف رقم' })
  .finite('السقف رقم')
  .positive('السقف أكبر من صفر')
  .max(999_999_999_999, 'السقف كبير جداً')
  .refine(hasAtMostTwoDecimals, 'خانتان عشريتان على الأكثر')
  .nullable()
  .optional();

/** The municipality-wide settings a clerk edits without a deploy. */
export const systemSettingsSchema = z.object({
  /**
   * Lebanese mobile, same shape as everywhere else in the system — but stored
   * as typed rather than normalised to E.164, because this string is printed
   * for a citizen to copy into the Whish app by hand.
   */
  whishMoneyNumber: z
    .string()
    .trim()
    .max(30, 'الرقم طويل جداً')
    .optional()
    .or(z.literal('')),
  cashOfficeHours: z.string().trim().max(200).optional().or(z.literal('')),
  cashOfficeAddress: z.string().trim().max(300).optional().or(z.literal('')),

  /** The municipality's public number, printed on receipts. */
  contactPhone: z.string().trim().max(30, 'الرقم طويل جداً').optional().or(z.literal('')),

  /**
   * The office WhatsApp account.
   *
   * Stored as typed rather than normalised to E.164 for the same reason as
   * `whishMoneyNumber`: it is printed for a human to read and dial, and
   * rewriting `03 123456` into `+96170123456` makes it unrecognisable to the
   * person who gave it to you. The `wa.me` link builder normalises its own
   * copy at the point of use.
   */
  whatsappNumber: z.string().trim().max(30, 'الرقم طويل جداً').optional().or(z.literal('')),

  // ── Municipality profile ──────────────────────────────────────────────
  nameAr: z.string().trim().max(120, 'الاسم طويل جداً').optional().or(z.literal('')),
  nameEn: z.string().trim().max(120, 'الاسم طويل جداً').optional().or(z.literal('')),
  /**
   * Not `z.string().email()`. Clearing the field posts `''`, which a strict
   * email check rejects — so an administrator could set an address but never
   * remove one. The empty case is allowed through and normalised to NULL
   * server-side; a non-empty value still has to look like an address.
   */
  contactEmail: z
    .string()
    .trim()
    .max(200)
    .email('البريد الإلكتروني غير صالح')
    .optional()
    .or(z.literal('')),
  website: z.string().trim().max(200).url('الرابط غير صالح').optional().or(z.literal('')),
  governorate: z.string().trim().max(120).optional().or(z.literal('')),
  district: z.string().trim().max(120).optional().or(z.literal('')),
  town: z.string().trim().max(120).optional().or(z.literal('')),

  /**
   * تاريخ ورقم قرار المجلس البلدي adopting the building-numbering scheme.
   *
   * Optional, and §7 Q1 is why: naming public roads needs a council decree
   * (Decreto-Law 118/1977), but internal cadastral indexing and parcel-linked
   * building numbering is an administrative and fiscal survey power the
   * municipality already holds. So a notice is valid without this — it cites
   * the municipal survey authority instead — and carries more weight with it.
   * Free text, because it references somebody else's document.
   */
  councilDecisionRef: z.string().trim().max(200).optional().or(z.literal('')),

  /**
   * The crest as a data URI.
   *
   * The prefix is checked rather than assumed: this string is written into an
   * `<img src>`, and `javascript:` and `data:text/html` are both things a
   * browser will happily execute from there. Restricting the scheme to the
   * three raster/vector image types the upload control offers is what keeps a
   * settings field from becoming a stored-XSS vector for every staff member
   * who opens the page afterwards.
   *
   * 700 KB of base64 ≈ 512 KB of file, matching the client-side cap.
   */
  logoDataUri: z
    .string()
    .trim()
    .max(700_000, 'حجم الصورة كبير جداً')
    .regex(/^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/]+=*$/, 'الصورة غير صالحة')
    .optional()
    .or(z.literal('')),

  // ── Finance defaults ──────────────────────────────────────────────────
  defaultFeeFrequency: feeFrequencySchema.optional(),
  defaultDueDays: z.number().int().min(0).max(365, 'المهلة يجب أن تكون بين 0 و365 يوماً').optional(),
  priceDisplay: z.enum(['compact', 'exact']).optional(),
  defaultRatePercent: z
    .number()
    .min(0, 'النسبة يجب أن تكون بين 0 و100')
    .max(100, 'النسبة يجب أن تكون بين 0 و100')
    .optional(),
  baseCurrency: z.enum(CURRENCY_CODES).optional(),
  /** `null` clears it — which is different from omitting it, i.e. leave as is. */
  secondaryCurrency: z.enum(CURRENCY_CODES).nullable().optional(),
  exchangeRate: z
    .number()
    .positive('سعر الصرف يجب أن يكون أكبر من صفر')
    .max(1_000_000_000)
    .nullable()
    .optional(),
  /** How far an exchange may stray from `exchangeRate` before it needs a reason (0084). */
  exchangeRateTolerancePercent: z
    .number()
    .min(0, 'النسبة يجب أن تكون بين 0 و100')
    .max(100, 'النسبة يجب أن تكون بين 0 و100')
    .optional(),
  /** Above this, on an exchange's non-base side, it is reviewed whatever its rate (0084). */
  largeExchangeThreshold: z
    .number()
    .positive('الحد يجب أن يكون أكبر من صفر')
    .max(999_999_999_999)
    .optional(),

  /**
   * «سقف الدفع العاجل»: the most an accountant may pay, per voucher, before the
   * manager's payment order (decree 5595/1982 art. 35; docs/finance.md §5.1,
   * decision D6). One per currency; anything above it goes to the manager as a
   * request. `null` clears it — no ceiling — and omitting it leaves it as it is.
   * Salaries are not held to it: art. 35 names them. The manager's alone to
   * change (`URGENT_EXPENSE_CEILING_FORBIDDEN`), though the route admits the
   * accountant for the rest of the settings.
   */
  urgentExpenseCeilingLbp: urgentCeiling,
  urgentExpenseCeilingUsd: urgentCeiling,
  /**
   * «سقف صرف الرواتب» (migration 0091, the owner's decision of 2026-10-12): the
   * most an accountant may pay one staff member as a month's salary on the art.
   * 35 path, per currency; above it the manager pays it, or it goes as a
   * request. `null` clears it (no ceiling). The manager's alone, like the
   * urgent ceiling (`URGENT_EXPENSE_CEILING_FORBIDDEN`).
   */
  salaryUrgentCeilingLbp: urgentCeiling,
  salaryUrgentCeilingUsd: urgentCeiling,

  /**
   * «معامل السقوف» (migration 0095, decision D28): what a flat on N levels
   * weighs in roofs under a per-unit notice — `{"2": 1.8}` makes a duplex 1.8
   * roofs. Replaced whole when sent. A level count left out of the table is not
   * priced, and a citizen holding such a flat is reported unassessable.
   */
  levelFactors: levelFactorsSchema.optional(),

  // ── Configuration held as documents ───────────────────────────────────
  /**
   * Validated per document type rather than accepted as free-form JSON: this
   * lands in a `jsonb` column, and a column that accepts any shape is one every
   * later reader has to defend itself against.
   */
  numberingSequences: z
    .record(
      z.enum(SEQUENCE_KEYS),
      z.object({
        prefix: z
          .string()
          .trim()
          .max(16)
          .regex(/^[A-Z0-9-]*$/, 'البادئة تقبل الحروف اللاتينية والأرقام والشرطات فقط'),
        nextNumber: z.number().int().min(1, 'الرقم التالي يجب أن يكون أكبر من صفر').max(1e12),
        padding: z.number().int().min(1).max(12, 'خانات التصفير يجب أن تكون بين 1 و12'),
      }),
    )
    .optional(),

  backupSchedule: z
    .object({
      frequency: z.enum(['off', 'daily', 'weekly', 'monthly']),
      /** `HH:mm`, 24-hour. */
      timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'الوقت غير صالح'),
      /** 0 = Sunday, matching `Date.getDay()`. */
      dayOfWeek: z.number().int().min(0).max(6),
      /**
       * Capped at 28, not 31: a rule that fires on the 31st silently skips five
       * months of the year, and a backup that does not run in February is the
       * kind of gap discovered only when it is needed.
       */
      dayOfMonth: z.number().int().min(1).max(28),
      keepCopies: z.number().int().min(1).max(365),
    })
    .optional(),
});

export type SystemSettingsInput = z.infer<typeof systemSettingsSchema>;

/**
 * A citizen declaring they have paid.
 *
 * This never marks a payment PAID — it moves it to PENDING_REVIEW. Nothing the
 * citizen submits can be verified by this system: the Whish reference is a
 * string they read off their own receipt, and only a clerk holding the
 * municipality's account statement can confirm the money arrived.
 */
export const declarePaymentSchema = z.object({
  /**
   * A Whish Money transfer only, made in the citizen's own app to the
   * municipality's number — the one claim a clerk can check against the
   * statement (open-decisions §21, «Kept»).
   *
   * Not CASH: cash is paid at the office, and «طريقة الدفع» says so as an
   * instruction, not a claim. A cash "declaration" moved the bill to
   * PENDING_REVIEW with no money taken, and a bill in review is not settled at
   * the counter until a clerk rejects the claim (review of PR #122; the server
   * refuses it too, `PAYMENT_DECLARATION_WHISH_ONLY`). Not COLLECTOR either: a
   * citizen who hands notes to a محصّل has nothing to quote, and the collector's
   * own entry is what records that money.
   */
  method: z.literal('WHISH_MONEY', {
    errorMap: () => ({ message: 'يُبلَّغ هنا عن تحويل Whish Money وحده؛ الدفع النقدي في صندوق البلدية' }),
  }),
  whishTransactionRef: z
    .string({ required_error: 'أدخل رقم عملية التحويل' })
    .trim()
    .min(4, 'رقم العملية قصير جداً')
    .max(60, 'رقم العملية طويل جداً'),
});

export type DeclarePayment = z.infer<typeof declarePaymentSchema>;

/**
 * A one-off charge an administrator raises against a single citizen.
 *
 * Separate from `createFeeNoticeSchema` because it is a different act: no
 * rule, no recurrence, nothing to re-issue next month — just this person owes
 * this amount.
 */
export const chargeCitizenSchema = z.object({
  citizenId: uuid,
  title: z
    .string({ required_error: 'اسم الرسم مطلوب' })
    .trim()
    .min(3, 'اسم الرسم قصير جداً')
    .max(120),
  amount: lbpAmount,
  dueDate: z.string({ required_error: 'تاريخ الاستحقاق مطلوب' }).min(1),
});

export type ChargeCitizen = z.infer<typeof chargeCitizenSchema>;

/**
 * A clerk recording money handed over in person.
 *
 * Skips PENDING_REVIEW entirely — see `FeesService.settleInPerson`.
 */
export const noticeActiveSchema = z.object({ isActive: z.boolean() });

export const settlePaymentSchema = z
  .object({
    method: paymentMethodSchema.default('CASH'),
  /**
   * How much was actually handed over.
   *
   * Optional, and omitting it means "the whole outstanding balance" — the
   * common case at the counter, and the behaviour before partial payments
   * existed, so an older client keeps working unchanged. A value below the
   * balance is a partial; above it is refused server-side rather than banked
   * as credit, because nothing here can carry an overpayment forward.
   */
    amount: z.coerce
      .number({ invalid_type_error: 'المبلغ يجب أن يكون رقماً' })
      .positive('المبلغ يجب أن يكون أكبر من صفر')
      .max(1_000_000_000_000, 'المبلغ كبير جداً')
      .optional(),
    note: z.string().trim().max(500).optional(),
    /**
     * The transfer's own number, when the clerk is recording a Whish payment
     * rather than cash.
     *
     * Cash needs nothing of the sort — the money is in the drawer and the وصل
     * is the record. A transfer is only auditable through its reference, which
     * is why `declarePaymentSchema` already demands one from the citizen; the
     * rule is repeated here rather than relaxed, because a clerk banking a
     * transfer they cannot cite is the same gap seen from the other side.
     */
    whishTransactionRef: z.string().trim().max(80).optional(),
    /**
     * The محصّل who took the money, when the method is COLLECTOR.
     *
     * Required for that method and refused for the others, by the same logic
     * as the Whish reference above: each method has exactly one fact that makes
     * it auditable, and a collection nobody is named for is indistinguishable
     * from counter cash — which is the distinction COLLECTOR was added to draw.
     */
    collectedById: uuid.optional(),
    /**
     * On a shared unit bill (0099, D5), which of its debtors paid: the server
     * requires it there (`SHARED_BILL_PAYER_REQUIRED`), checks it is one of the
     * bill's debtors, and refuses it on a citizen's own bill. Kept on the
     * receipt's transaction.
     */
    paidByCitizenId: uuid.optional(),
    /**
     * The day the money was taken, when it was not today — a payment written
     * up the morning after, or a collector's round entered at the end of the
     * week. Never after today on the municipality's own calendar. Omitted
     * means now. How far back, by whom and with what reason is the server's
     * rule (`cash-policy.ts`), because it depends on the role and the bill.
     */
    paidOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ الدفع غير صالح')
      // A day that exists: «2026-02-30» parses — as 2 March — so it must also come back unchanged.
      .refine(
        (day) => {
          const parsed = new Date(`${day}T00:00:00Z`);
          return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
        },
        'تاريخ الدفع غير صالح',
      )
      // Beirut's today, per parse — not UTC's, which is a day behind after midnight.
      .refine((day) => day <= municipalToday(), 'تاريخ الدفع في المستقبل')
      .optional(),
    /**
     * Why this payment departs from the ordinary: a rate other than the
     * municipality's own, or a date before today. Required by the server in
     * either case, kept on the ledger row and in the audit trail.
     */
    adjustmentReason: z
      .string()
      .trim()
      .min(ADJUSTMENT_REASON_MIN, 'اكتب السبب بوضوح')
      .max(300)
      .optional(),
    /**
     * One id per press of «سجّل الدفعة», generated by the page. A retry after a
     * lost response sends the same id and gets the first receipt back instead
     * of a second payment.
     */
    clientRequestId: uuid.optional(),
    /**
     * The notes handed over — «20$ و200,000 ليرة» — and, for the foreign part,
     * the rate. Omitting `exchangeRate` means the municipality's own rate from
     * الإعدادات; sending a different one is an override (finance roles, with a
     * reason).
     *
     * When present the server works the credit out from it (`local` +
     * `foreign` × rate, less any change handed back) and `amount` must be left
     * out: two figures for one payment is one too many to trust. Cash only — a
     * Whish transfer or a collector's round arrives as one sum in one currency.
     */
    tendered: z
      .object({
        // Bounded by the column (DECIMAL(14,2)), so an absurd figure is a 422, not a 500.
        local: z.coerce.number().min(0, 'المبلغ لا يمكن أن يكون سالباً').max(999_999_999_999).default(0),
        foreign: z.coerce.number().min(0, 'المبلغ لا يمكن أن يكون سالباً').max(1_000_000_000).default(0),
        // Never ليرة: the rate is ليرة per one foreign unit, and ليرة as the
        // «foreign» part of a dollar bill would store a rate that rounds to 0.
        foreignCurrency: z.enum(['USD', 'EUR']).default('USD'),
        exchangeRate: z.coerce
          .number({ invalid_type_error: 'سعر الصرف يجب أن يكون رقماً' })
          .positive('سعر الصرف يجب أن يكون أكبر من صفر')
          .max(1_000_000_000)
          .optional(),
      })
      .superRefine((tender, ctx) => {
        if (tender.local <= 0 && tender.foreign <= 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['local'], message: 'أدخل المبلغ المستلم' });
        }
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.tendered && data.method !== 'CASH') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tendered'],
        message: 'الدفع بعملتين متاح للدفع النقدي فقط',
      });
    }
    if (data.tendered && data.amount !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: 'يُحتسب المبلغ من العملتين — لا تُرسله مرتين',
      });
    }
    if (data.method === 'WHISH_MONEY' && !data.whishTransactionRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['whishTransactionRef'],
        message: 'أدخل رقم عملية التحويل',
      });
    }
    if (data.method === 'COLLECTOR' && !data.collectedById) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['collectedById'],
        message: 'اختر المحصّل الذي استلم المبلغ',
      });
    }
  });

export type SettlePayment = z.infer<typeof settlePaymentSchema>;

/** A clerk's verdict on a declared payment. */
export const reviewPaymentSchema = z
  .object({
    confirmed: z.boolean(),
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((data, ctx) => {
    // Sending a payment back to UNPAID without saying why leaves the citizen
    // with a bill they thought they had settled and no way to find out.
    if (!data.confirmed && !data.note) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: 'اذكر سبب رفض الدفعة',
      });
    }
  });

export type ReviewPayment = z.infer<typeof reviewPaymentSchema>;

/**
 * Reversing one recorded movement in the payment ledger.
 *
 * The note is required, unlike on most corrections here: a reversal takes money
 * back off a citizen's record after a receipt has been issued for it, and
 * "why" is the first thing anyone reading the ledger afterwards will ask. The
 * ledger is append-only, so this note is the only place that answer can live.
 */
export const reverseTransactionSchema = z.object({
  note: z.string().trim().min(3, 'اذكر سبب عكس الحركة').max(500),
});

export type ReverseTransaction = z.infer<typeof reverseTransactionSchema>;

/**
 * «إلغاء الفاتورة» — the manager withdraws a bill nothing has been paid on
 * (a notice issued twice, a charge raised in error). The reason is required for
 * the same reason a reversal's is: the bill stays on the citizen's record,
 * struck through, and this is the only place "why" can live.
 */
export const cancelBillSchema = z.object({
  reason: z.string().trim().min(ADJUSTMENT_REASON_MIN, 'اذكر سبب إلغاء الفاتورة').max(500),
});

export type CancelBill = z.infer<typeof cancelBillSchema>;

/**
 * A billing period as `periodKeyFor` writes it: «2026-07», «2026-H2», «2026»,
 * or «ONCE» for a one-off notice.
 */
export const periodKeySchema = z
  .string()
  .regex(/^(ONCE|\d{4}(-(0[1-9]|1[0-2]|H[12]))?)$/, 'فترة غير صالحة');

/**
 * «إلغاء الإشعار» (decisions D6 and D12): the bills of the periods the manager
 * names, each as «إلغاء الفاتورة» would, with the same required reason. The
 * periods are named, never implied: cancelling a period's correct bills to stop
 * a fee would be waiving revenue the law does not let a municipality waive, so
 * stopping is its own switch (`PATCH fees/notices/:id/active`) and cancels nothing.
 */
export const cancelNoticeSchema = cancelBillSchema.extend({
  periodKeys: z
    .array(periodKeySchema, { required_error: 'اختر فترة واحدة على الأقل' })
    .min(1, 'اختر فترة واحدة على الأقل')
    .max(240)
    .refine((keys) => new Set(keys).size === keys.length, 'فترة مكرّرة'),
});

export type CancelNotice = z.infer<typeof cancelNoticeSchema>;

/** One period of a notice as «إلغاء الإشعار» shows it before the press (`GET fees/notices/:id/periods`). */
export interface FeeNoticePeriodSummary {
  periodKey: string;
  /** Every bill of the period, cancelled ones included. */
  bills: number;
  /** What the cancel would cancel: nothing paid on it, no claim waiting, not cancelled. */
  cancellable: number;
  cancellableAmount: number;
  /** What it would leave, and why. */
  withPayments: number;
  underReview: number;
  alreadyCancelled: number;
  currency: string;
}

/**
 * Citizen sign-in by رقم مرجعي.
 *
 * The phone is required alongside it, not optional. A reference number is
 * printed on a receipt and quoted at a counter — treating it as a lone
 * credential would make every citizen record readable by anyone who saw a
 * slip of paper. Two facts that must agree is the weakest defensible bar.
 */
export const referenceLoginSchema = z.object({
  referenceNumber: z
    .string({ required_error: 'الرقم المرجعي مطلوب' })
    .trim()
    .min(4, 'الرقم المرجعي غير صالح')
    .max(40)
    .transform((value) => value.toUpperCase()),
  phone: z.string({ required_error: 'رقم الهاتف مطلوب' }).trim().min(6, 'رقم الهاتف غير صالح'),
});

export type ReferenceLogin = z.infer<typeof referenceLoginSchema>;

/**
 * Citizen sign-in by رقم مرجعي **alone**, for the municipality's front door.
 *
 * A deliberate, documented relaxation of the rule above, made at the
 * municipality's request: the portal's landing page asks for one thing, the
 * number printed on the citizen's own paperwork, because the population it
 * serves does not reliably reach a second factor — the household phone is
 * shared, off, or out of credit, and an SMS code that never arrives is a door
 * that never opens.
 *
 * What makes it defensible rather than merely convenient:
 *
 *  - The suffix is six characters from a 32-symbol alphabet — 2³⁰, about 1.07
 *    billion — so guessing one at the rate limit below would take millennia.
 *    The reference is not a weak secret; it is a *disclosed* one.
 *  - The real exposure is therefore a reference someone **sees**: a receipt
 *    left on a counter, a number read aloud. That is a physical-custody risk
 *    the municipality accepts, not a cryptographic one.
 *  - The format is validated before any lookup, so a malformed guess costs a
 *    regex rather than a query.
 *
 * `referenceLoginSchema` is left exactly as it was. The payments portal keeps
 * asking for both, so this relaxation reaches only the route that opted into it.
 */
export const referenceOnlyLoginSchema = z.object({
  referenceNumber: z
    .string({ required_error: 'الرقم المرجعي مطلوب' })
    .trim()
    // Spaces and lowercase are what a citizen actually types off a slip; the
    // domain's `ReferenceNumber.parse` normalises the same way.
    .transform((value) => value.toUpperCase().replace(/\s/g, ''))
    .pipe(
      z
        .string()
        .regex(
          /^[A-Z]{3}-\d{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/,
          'الرقم المرجعي غير صالح — مثال: BZR-2608-5HLQBM',
        ),
    ),
});

export type ReferenceOnlyLogin = z.infer<typeof referenceOnlyLoginSchema>;

/**
 * «ما المستحق على العقار» — what is still owed on one رقم العقار, before a
 * براءة ذمّة (the user's guidance of 2026-10-07: a debt attaches to the
 * property, whoever the owner of record is now). Read-only; it issues no
 * certificate.
 */
export const parcelDuesQuerySchema = z.object({
  /*
    Latin digits whatever was typed: an Arabic keyboard gives «٤٢٠», and the
    bill lines hold «420» — read as typed, the answer would be a false «لا شيء
    مستحق» on the one check a clearance rests on.
  */
  propertyNumber: z
    .string({ required_error: 'رقم العقار مطلوب' })
    .trim()
    .min(1, 'رقم العقار مطلوب')
    .max(40)
    .transform((value) => normalizeDigits(value)),
});
export type ParcelDuesQuery = z.infer<typeof parcelDuesQuerySchema>;

/** One open bill, and the part of what remains on it that is this parcel's. */
export interface ParcelDuesBill {
  paymentId: string;
  /** Null on a shared unit bill (0099), which has no one citizen: see `sharedDebtorCount`. */
  citizenId: string | null;
  /** «ورثة المرحوم …» for an estate. Null on a shared unit bill. */
  citizenName: string | null;
  /** On a shared unit bill, how many registered citizens may pay it; null on a citizen's own bill. */
  sharedDebtorCount: number | null;
  title: string;
  dueDate: string;
  paymentStatus: 'UNPAID' | 'OVERDUE' | 'PENDING_REVIEW';
  /** What is still unpaid on the whole bill. */
  remaining: number;
  /** This parcel's part of `remaining`, by the bill's own lines (area or units, and owners' parts). */
  onParcel: number;
  /** The census units on this parcel the bill charged for, where it names them. */
  unitCodes: string[];
  /** Every line on the bill is on this parcel. */
  wholeBill: boolean;
}

export interface ParcelDues {
  propertyNumber: string;
  /** Sum of `onParcel` — what is owed on the parcel by its bills' own lines. */
  total: number;
  bills: ParcelDuesBill[];
  /**
   * Open bills of the people on this parcel that name no unit — a flat amount,
   * or a bill from before itemised billing. Shown apart: they are the holders'
   * debts, not demonstrably the parcel's.
   */
  unlinked: Array<Omit<ParcelDuesBill, 'onParcel' | 'unitCodes' | 'wholeBill'>>;
  unlinkedTotal: number;
}

import { z } from 'zod';

/**
 * Domain enums. Values are stable machine identifiers (never translated);
 * Arabic display labels live in `labels.ts` so the wire format stays language-neutral.
 */

/**
 * Every enum in this file is driven by a fixed choice control (a `ChoiceCard`
 * or `Select`) in the wizard, never free text — so the only failure a citizen
 * can actually produce is "nothing chosen yet". One Arabic message covers that
 * (and, defensively, an unexpected value) rather than leaning on Zod's default
 * English "Required" / "Invalid enum value" text, which is what a bare
 * `z.enum(...)` falls back to for both cases.
 */
function arabicEnum<T extends readonly [string, ...string[]]>(values: T, message: string) {
  return z.enum(values as unknown as [T[number], ...T[number][]], {
    errorMap: () => ({ message }),
  });
}

export const GENDER = ['MALE', 'FEMALE'] as const;
export const genderSchema = arabicEnum(GENDER, 'الجنس مطلوب');
export type Gender = z.infer<typeof genderSchema>;

/** صفة الإقامة — classifies the person, never the property. */
export const RESIDENT_STATUS = ['REFUGEE', 'DISPLACED', 'VILLAGE_RESIDENT'] as const;
export const residentStatusSchema = arabicEnum(RESIDENT_STATUS, 'صفة الإقامة مطلوبة');
export type ResidentStatus = z.infer<typeof residentStatusSchema>;

export const IDENTITY_DOC_TYPE = [
  'NATIONAL_ID',
  'FAMILY_RECORD',
  'DRIVER_LICENSE',
  'PASSPORT',
] as const;
export const identityDocTypeSchema = arabicEnum(IDENTITY_DOC_TYPE, 'نوع وثيقة الإثبات مطلوب');
export type IdentityDocType = z.infer<typeof identityDocTypeSchema>;

/** الحالة الاجتماعية — asked in step 2 alongside the rest of the household picture. */
export const MARITAL_STATUS = ['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED'] as const;
export const maritalStatusSchema = arabicEnum(MARITAL_STATUS, 'الحالة الاجتماعية مطلوبة');
export type MaritalStatus = z.infer<typeof maritalStatusSchema>;

/**
 * How the person registering relates to the property — الشاغل, with a ل.
 *
 * It classifies the *person*, never the building; `UNIT_STATUS` below is the
 * one that describes the building, and the two are one Arabic dot apart on a
 * phone screen. They are kept in different controls, in different parts of the
 * card, and neither is ever rendered as the bare word.
 *
 * `FREE_OCCUPANT` — «شاغل بتسامح» — is the third case Lebanese practice has
 * always had and this register could not write down: a son in his father's
 * flat, a caretaker in the owner's ground floor, a family in a relative's
 * empty house. No بدل is paid, so they are not a مستأجر; no deed names them,
 * so they are not a مالك. Recording them as a tenant (the only prior option)
 * puts a tenancy in the register that does not exist, which is wrong in law
 * and quietly corrupts every count of how much of the town is rented.
 *
 * What they share with a tenant is the part that matters to the municipality:
 * they are the شاغل, so the القيمة التأجيرية and رسم النظافة fall on them,
 * and the owner still has to be named. What differs is that there is no عقد
 * إيجار to attach and often no phone number for a relative abroad — see
 * `occupancyBranch` in `property.schema.ts`, which requires the name and not
 * the number.
 */
export const OCCUPANCY_TYPE = ['OWNER', 'TENANT', 'FREE_OCCUPANT'] as const;
export const occupancyTypeSchema = arabicEnum(OCCUPANCY_TYPE, 'نوع الإشغال مطلوب');
export type OccupancyType = z.infer<typeof occupancyTypeSchema>;

/** Every occupancy that is not the owner, and so names someone else's property. */
export const NON_OWNER_OCCUPANCY = ['TENANT', 'FREE_OCCUPANT'] as const;

/**
 * حالة الوحدة — شاغرة, with an ر. A statement about the *unit*.
 *
 * Only an owner is ever asked. A مستأجر or a شاغل بتسامح **is** the occupant
 * of the unit they are filing, so asking them whether it is empty is a
 * contradiction the form does not pose — see `PropertyCard`.
 *
 * `RENTED` is the value that earns this enum its place, and it is not the one
 * anybody asks for first. A مبنى of ten flats is filed once by its owner, and
 * each tenant files their own card for the flat they live in — so the same
 * apartment is in the register twice, under two citizens, by design (ownership
 * and occupancy are different facts about it). Under a `PER_UNIT` notice that
 * is two charges for one flat unless something says which of the two rows is
 * the tenancy. This is that something.
 *
 * `VACANT` and `UNDER_CONSTRUCTION` are the two ways a unit has no شاغل at
 * all, which is what رسم الإشغال and رسم النظافة are levied on. They are kept
 * apart rather than folded into one «فارغة» because they are exempt for
 * different reasons and a municipality may well treat them differently — a
 * finished flat between tenants is not a shell with no roof on it.
 */
export const UNIT_STATUS = [
  'OWNER_OCCUPIED',
  'RENTED',
  'VACANT',
  'UNDER_CONSTRUCTION',
] as const;
export const unitStatusSchema = arabicEnum(UNIT_STATUS, 'حالة الوحدة غير صالحة');
export type UnitStatus = z.infer<typeof unitStatusSchema>;

/**
 * The statuses that mean nobody is in there.
 *
 * One set covering both, because every rule written against vacancy so far
 * wants both: a fee on الإشغال is not owed by an empty flat *or* by an
 * unfinished one. Kept as a named export rather than inlined at each call
 * site so that adding a fourth unoccupied state later is one edit and not a
 * search for `=== 'VACANT'`.
 */
export const UNOCCUPIED_UNIT_STATUS = ['VACANT', 'UNDER_CONSTRUCTION'] as const;

/**
 * Whether this unit has no occupant — and, crucially, **false for null**.
 *
 * A unit whose status was never recorded is not thereby empty; it is a unit
 * nobody was asked about. Reading the absence as vacancy would exempt every
 * row written before this field existed and every row an officer skipped,
 * which is silent under-collection of exactly the kind `isUnsurveyed` exists
 * to refuse. The unmarked unit is billed, and a resident who is owed the
 * exemption comes and says so — an error someone can see and correct.
 */
export function isUnoccupied(status: string | null | undefined): boolean {
  return status != null && (UNOCCUPIED_UNIT_STATUS as readonly string[]).includes(status);
}

export const PROPERTY_TYPE = ['BUILDING', 'HOUSE', 'LAND', 'TENT'] as const;
export const propertyTypeSchema = arabicEnum(PROPERTY_TYPE, 'نوع العقار مطلوب');
export type PropertyType = z.infer<typeof propertyTypeSchema>;

/**
 * What one unit inside a parcel actually is.
 *
 * Wider than the original three (شقة/عيادة/محل) because the list stopped being
 * only a description the moment fees could be assessed per unit: a rate table
 * can only distinguish what this enum distinguishes, so a محل and a مستودع
 * being the same value here means the municipality cannot charge them
 * differently even if its own schedule of fees does.
 *
 * `INDEPENDENT_HOUSE` is the one that looks redundant next to the `HOUSE`
 * property type and is not. `HOUSE` describes a whole card — a dwelling that is
 * the only thing on its parcel. This describes one standalone dwelling among
 * several structures sharing a parcel, which is exactly the case this taxonomy
 * could not express before.
 */
export const UNIT_TYPE = [
  'APARTMENT',
  'INDEPENDENT_HOUSE',
  'CLINIC',
  'OFFICE',
  'SHOP',
  'WAREHOUSE',
] as const;
export const unitTypeSchema = arabicEnum(UNIT_TYPE, 'نوع الوحدة مطلوب');
export type UnitType = z.infer<typeof unitTypeSchema>;

export const LAND_TYPE = ['AGRICULTURAL', 'INDUSTRIAL'] as const;
export const landTypeSchema = arabicEnum(LAND_TYPE, 'نوع الأرض مطلوب');
export type LandType = z.infer<typeof landTypeSchema>;

// ───────────────────────────  Building census  ───────────────────────────
//
// The vocabulary of the *structure*, as opposed to the vocabulary of the
// citizen's property card above it. The two describe the same town and answer
// different questions: a card says what one person filed about what they hold,
// a building row says what stands on a parcel whether or not anyone has ever
// been surveyed inside it. See docs/building-census-plan.md §3.

/**
 * What physically stands on a parcel.
 *
 * Kept separate from `PROPERTY_TYPE` rather than reused, because the two ask
 * different questions and folding them together would produce a third,
 * ambiguous one. `PropertyType.BUILDING` covers an apartment block, a shopping
 * arcade and a hangar alike — adequate for "which fields does this card
 * render", useless for "what is this structure and what units should it have".
 * The explicit correspondence lives in `STRUCTURE_TYPE_MAP` below and nowhere
 * else.
 */
export const STRUCTURE_TYPE = [
  'RESIDENTIAL_BUILDING',
  'INDEPENDENT_HOUSE',
  'COMMERCIAL_CENTER',
  'WAREHOUSE_HANGAR',
  'MIXED_USE',
  /**
   * A mapped informal settlement or shelter cluster, registered deliberately as
   * one structure on a parcel.
   *
   * Not what an ordinary tent card becomes. A خيمة filed by a refugee stays a
   * bare `PropertyEntry`: tents have no permanent cadastral footprint, no fixed
   * entrance to navigate to and no floor matrix, and they move between
   * agricultural plots by season — so minting a one-unit building shell for
   * each would corrupt every building-density, structural-inventory and
   * war-damage figure the census exists to produce. This value is for the
   * opposite case, where a field inspector means to put a whole settlement on
   * the map as something to revisit.
   */
  'TENT_SHELTER',
] as const;
export const structureTypeSchema = arabicEnum(STRUCTURE_TYPE, 'نوع المنشأة مطلوب');
export type StructureType = z.infer<typeof structureTypeSchema>;

/**
 * Per-unit survey progress — the state machine that makes an unsurveyed flat a
 * row rather than an absence.
 *
 * `NOT_SURVEYED` and `VISITED_NO_ANSWER` are the two the whole table exists
 * for. Before it, "nobody has ever tried this door" and "three officers have
 * stood at it and got no answer" were the same thing — nothing — and neither
 * could be dispatched against. A building's figure is a rollup of these; see
 * `isSurveyed` below and D11 in the plan.
 */
export const SURVEY_STATUS = [
  'NOT_SURVEYED',
  'VISITED_NO_ANSWER',
  'PARTIAL',
  'COMPLETE',
  'REFUSED',
  'INACCESSIBLE',
  'VACANT_CONFIRMED',
  'DEMOLISHED',
] as const;
export const surveyStatusSchema = arabicEnum(SURVEY_STATUS, 'حالة المسح غير صالحة');
export type SurveyStatus = z.infer<typeof surveyStatusSchema>;

/**
 * The statuses that count as a unit the municipality has an answer for.
 *
 * Narrow on purpose, and narrower than "the visit is over". `REFUSED` and
 * `INACCESSIBLE` end a visit without producing any of the data the census is
 * collecting, and `PARTIAL` says so in its name; counting any of them as
 * surveyed would let a coverage percentage climb while the register stayed
 * empty, which is precisely the number that would then be worthless. What is
 * left is the three outcomes that are a finding about the unit: it was
 * surveyed, it was confirmed empty, or it is no longer standing.
 *
 * Mirrored in SQL by migration 0030's `sync_building_unit_counts` trigger,
 * which maintains `Building.unitsSurveyed`. Change one and change the other, or
 * the map's colours and the ledger's percentages will quietly disagree.
 */
export const SURVEYED_STATUS = ['COMPLETE', 'VACANT_CONFIRMED', 'DEMOLISHED'] as const;

/** Whether this unit's survey produced an answer. False for null, as ever. */
export function isSurveyed(status: string | null | undefined): boolean {
  return status != null && (SURVEYED_STATUS as readonly string[]).includes(status);
}

/**
 * UN-Habitat's rapid building-level damage scale, verbatim.
 *
 * Not adjusted, not simplified and not extended — it is already the vocabulary
 * of the Beirut Municipality and Bourj Hammoud assessments and of the national
 * Building Destruction and Debris Quantities Assessment, so a municipality
 * using these levels produces figures that aggregate with the national
 * reconstruction datasets instead of standing alone.
 *
 * The split carrying the most weight in practice is `UNSAFE_EVACUATE` against
 * `RESTRICTED_USE`: both are damaged buildings, and only the first means the
 * residents must be out of it tonight. Aid allocation turns on that line, which
 * is why the scale is not collapsed to "damaged / not damaged".
 *
 * `UNDER_CONSTRUCTION` is deliberately absent — it is a lifecycle state, it
 * already exists in `UNIT_STATUS`, and admitting it here would overwrite a
 * building's damage history with a fact about its building permit.
 */
export const DAMAGE_LEVEL = [
  'NOT_AFFECTED',
  'SAFE_MINOR_DAMAGE',
  'RESTRICTED_USE',
  'UNSAFE_EVACUATE',
  'TOTAL_COLLAPSE',
  'UNCLASSIFIED',
] as const;
export const damageLevelSchema = arabicEnum(DAMAGE_LEVEL, 'مستوى الضرر مطلوب');
export type DamageLevel = z.infer<typeof damageLevelSchema>;

/**
 * Where a damage reading came from, and therefore how far to trust it.
 *
 * Recorded on every assessment rather than inferred from who wrote it: a
 * satellite-derived level and an engineer's site visit disagreeing about the
 * same building is ordinary, and is information — not a conflict to be resolved
 * by overwriting one with the other.
 */
export const DAMAGE_SOURCE = [
  'FIELD_VISIT',
  'SATELLITE',
  'SELF_REPORTED',
  'OFFICIAL_REPORT',
] as const;
export const damageSourceSchema = arabicEnum(DAMAGE_SOURCE, 'مصدر التقييم مطلوب');
export type DamageSource = z.infer<typeof damageSourceSchema>;

/**
 * Why a visit did not become a registration.
 *
 * There is no `WAR_DAMAGE` here and there will not be one. A حالة is a *failed
 * visit* — something to do again — and damage is a *fact about a structure*.
 * Merge them and «مُعالجة» stops having an answer: revisited, or repaired? A
 * case may point at the `DamageAssessment` that prompted it instead, which
 * keeps the reference without conflating the two lifecycles.
 */
export const CASE_TYPE = [
  'UNIT_UNREACHABLE',
  'ACCESS_REFUSED',
  'VACANT_UNCONFIRMED',
  'OWNERSHIP_DISPUTE',
  'GENERAL_NOTE',
] as const;
export const caseTypeSchema = arabicEnum(CASE_TYPE, 'نوع الحالة غير صالح');
export type CaseType = z.infer<typeof caseTypeSchema>;

/**
 * A person's relationship to a canonical unit.
 *
 * The same three values as `OCCUPANCY_TYPE`, and deliberately a separate enum:
 * that one is a field on a citizen's property card and cannot exist without a
 * registration behind it, this one is a row on the unit matrix and routinely
 * does — an officer walking a stairwell can record that flat 3 is rented, and
 * who its owner is, before either person has a file. Keeping them apart is what
 * lets the unit-level fact outlive, or precede, the citizen-level one.
 */
export const OCCUPANCY_ROLE = ['OWNER', 'TENANT', 'FREE_OCCUPANT'] as const;
export const occupancyRoleSchema = arabicEnum(OCCUPANCY_ROLE, 'صفة الإشغال مطلوبة');
export type OccupancyRole = z.infer<typeof occupancyRoleSchema>;

/**
 * The one place the three taxonomies are allowed to meet.
 *
 * `StructureType` describes what stands on the parcel, `PropertyType` describes
 * the card a citizen files about it, and `UnitType` describes what is inside.
 * Every conversion between them goes through this table — hand-coding the
 * correspondence at a call site is how three vocabularies drift into
 * disagreeing, and the disagreement surfaces months later as a building that
 * cannot be filtered or a unit generator producing the wrong default.
 *
 * `propertyType` is what the legacy card would have called this structure,
 * which is what the backfill reads to decide which cards become buildings.
 * `defaultUnitType` is what a generated unit is unless the officer says
 * otherwise — a default, never a constraint: a ground-floor محل in a
 * residential block is entirely ordinary, and is set per unit.
 *
 * `LAND` is absent because land has nothing standing on it and never gets a
 * building; a land card stays a bare `PropertyEntry`.
 */
export const STRUCTURE_TYPE_MAP = {
  RESIDENTIAL_BUILDING: { propertyType: 'BUILDING', defaultUnitType: 'APARTMENT' },
  INDEPENDENT_HOUSE: { propertyType: 'HOUSE', defaultUnitType: 'INDEPENDENT_HOUSE' },
  COMMERCIAL_CENTER: { propertyType: 'BUILDING', defaultUnitType: 'SHOP' },
  WAREHOUSE_HANGAR: { propertyType: 'BUILDING', defaultUnitType: 'WAREHOUSE' },
  MIXED_USE: { propertyType: 'BUILDING', defaultUnitType: 'APARTMENT' },
  TENT_SHELTER: { propertyType: 'TENT', defaultUnitType: 'INDEPENDENT_HOUSE' },
} as const satisfies Record<
  StructureType,
  { propertyType: PropertyType; defaultUnitType: UnitType }
>;

/**
 * The structure a legacy property card describes, or null when it describes no
 * structure at all.
 *
 * `LAND` and `TENT` both return null, for different reasons arriving at the
 * same place: land has nothing standing on it, and a tent card is not a mapped
 * settlement — see `TENT_SHELTER` above. Anything backfilling or migrating
 * cards reads this rather than testing `propertyType` for itself.
 */
export function structureTypeForProperty(
  propertyType: string | null | undefined,
): StructureType | null {
  if (propertyType === 'BUILDING') return 'RESIDENTIAL_BUILDING';
  if (propertyType === 'HOUSE') return 'INDEPENDENT_HOUSE';
  return null;
}

/*
 * `REPORT_STATUS` / `reportStatusSchema` / `ReportStatus` were here.
 *
 * The review workflow they described — قيد الانتظار → قيد المراجعة → تم
 * التحقق → مقبول, with مرفوض and a correction round-trip — existed because
 * citizens filed their own طلبات and the municipality had to adjudicate them.
 * Records are now entered by staff directly, so there is nothing to
 * adjudicate: a row exists because a clerk put it there, which is the same
 * thing "مقبول" used to mean.
 *
 * The `ReportStatus` enum and the `registrations.status` column still exist in
 * the tenant schema, defaulted and unread — dropping them is a separate,
 * irreversible migration across every municipality's schema.
 */

export const STAFF_ROLE = [
  'SUPER_ADMIN',
  'AUDITOR',
  'FIELD_INSPECTOR',
  'COLLECTOR',
  'ACCOUNTANT',
  'ADMINISTRATIVE_OFFICER',
] as const;
export const staffRoleSchema = arabicEnum(STAFF_ROLE, 'الصلاحية غير صالحة');
export type StaffRole = z.infer<typeof staffRoleSchema>;

export const DOCUMENT_TYPE = [
  'IDENTITY',
  'OWNERSHIP_PROOF',
  'RENTAL_CONTRACT',
  'RESIDENCY_PROOF',
  'EXTRA_PHOTO',
] as const;
export const documentTypeSchema = arabicEnum(DOCUMENT_TYPE, 'نوع المستند غير صالح');
export type DocumentType = z.infer<typeof documentTypeSchema>;

export const BLOOD_TYPE = [
  'A_POSITIVE',
  'A_NEGATIVE',
  'B_POSITIVE',
  'B_NEGATIVE',
  'AB_POSITIVE',
  'AB_NEGATIVE',
  'O_POSITIVE',
  'O_NEGATIVE',
] as const;
export const bloodTypeSchema = arabicEnum(BLOOD_TYPE, 'فئة الدم مطلوبة');
export type BloodType = z.infer<typeof bloodTypeSchema>;

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

/**
 * Whether this person lives in the town — which decides how much the register
 * asks about them.
 *
 * `RESIDENT` is a household file: identity, household, blood type, the lot.
 *
 * `NON_RESIDENT_OWNER` — «غير مقيم في البلدة» — is somebody who lives elsewhere
 * (Tyre, Beirut, Abidjan) and holds something here: they **own** property, or
 * they **rent or occupy something nobody lives in** — a shop they run, an
 * office, a clinic, a warehouse, a plot they farm. Such a person is recorded so
 * the register can say who owns or runs the property and how to reach them,
 * nothing more. The rental-value fee falls on the occupant whether owner or
 * tenant (Law 60/1988, Art. 3–4), and the occupancy notice names the occupant
 * *and where they live* (Art. 14); nothing in the law needs their household,
 * and asking for it is collection the purpose does not justify (Law 81/2018,
 * Art. 87).
 *
 * **The stored value still says OWNER, and that is a known misnomer.** It was
 * named when the record held owners only (migration 0040), and 0040 was applied
 * before the record was widened to tenants of non-dwelling units on 2026-09-13.
 * Renaming an enum value is a one-way change the deploy rules keep out of a
 * routine release, so the value stays and the label says what it means. Read it
 * as «not resident».
 *
 * The one rule that keeps the record honest: a tenancy or free occupancy on it
 * must be of a unit nobody lives in — see `DWELLING_UNIT_TYPE`. Somebody who
 * rents a flat and lives in it lives in the town.
 *
 * Decided by where the person *lives most of the year*, never by محل القيد:
 * plenty of people registered in the town live in Beirut, and the reverse.
 */
export const CITIZEN_RESIDENCE = ['RESIDENT', 'NON_RESIDENT_OWNER'] as const;
export const citizenResidenceSchema = arabicEnum(CITIZEN_RESIDENCE, 'نوع الملف غير صالح');
export type CitizenResidence = z.infer<typeof citizenResidenceSchema>;

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
 * `FREE_OCCUPIED` — «مشغولة بتسامح» — is the same escape for the third way of
 * being the شاغل, and it was missing. `OCCUPANCY_TYPE.FREE_OCCUPANT` above
 * describes the *person* living in a relative's flat without بدل; this
 * describes the *unit* they are in, from the owner's side. Without it an owner
 * whose son occupies the flat had no true answer: not `RENTED` (there is no
 * lease, and writing one here is the falsehood `FREE_OCCUPANT` exists to
 * refuse), not `VACANT` (somebody is in it), not `UNDER_CONSTRUCTION`. They
 * picked `OWNER_OCCUPIED` or left it blank, and both read as "the owner is the
 * شاغل" — so the owner was charged the occupancy fee *and* the son was charged
 * it on his own card. The same double-count `RENTED` ends for tenancies, left
 * standing for the one arrangement whose occupants are least able to argue.
 *
 * It also made the register's own figures dishonest in whichever direction the
 * owner guessed: a شاغل بتسامح counted as rented stock, or as owner-occupied.
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
  'FREE_OCCUPIED',
  /**
   * «مسكن موسمي» — kept for owners who live outside the town and use it on
   * visits: an expatriate family's flat opened for July and August.
   *
   * Not `VACANT`: it is furnished and at the owner's disposal, so it cannot be
   * offered to let or to shelter a displaced household, which is what vacancy
   * lists get used for. Not `OWNER_OCCUPIED`: nobody lives in it most of the
   * year, and counting it as a resident household inflates the population.
   *
   * Deliberately in **neither** `UNOCCUPIED_UNIT_STATUS` nor
   * `OCCUPIED_BY_OTHERS`, so the owner still bears the occupancy fee. Law
   * 60/1988 levies the fee on actual occupancy (Art. 11), but هيئة التشريع
   * والاستشارات 725/2003 presumes a building occupied until a تصريح بالشغور is
   * filed — so without one the full year is owed, and how a declaration
   * shortens it is the council's decision, not this enum's. The unit records
   * the facts that decision needs: `presenceMonths`, `ownerLastStayAt` and
   * `vacancyDeclaredAt`.
   */
  'SEASONAL',
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
 * The states in which somebody *other than the owner* is the شاغل.
 *
 * The owner's exemption from an occupant-borne fee (النظافة, القيمة التأجيرية)
 * is not "this flat is rented" — it is "somebody else is the one inside, and
 * they are billed on their own card". `RENTED` was the only way to say that,
 * so the exemption was written as `!== 'RENTED'` at its one call site and a
 * شاغل بتسامح fell straight through it.
 *
 * A named set rather than a second inline comparison, for the reason
 * `UNOCCUPIED_UNIT_STATUS` above gives and this enum has now proven twice:
 * the condition grows, and a growing condition spelled out at each call site
 * is a search for `=== 'RENTED'` that somebody eventually loses.
 *
 * Deliberately **disjoint from** `UNOCCUPIED_UNIT_STATUS` rather than a
 * superset of it. Both exempt the owner and they are not the same finding: a
 * vacant flat has nobody to bill, and a tenanted one has somebody else. Fold
 * them together and the register can no longer answer how much of the town is
 * occupied — which is most of what the census is for.
 */
export const OCCUPIED_BY_OTHERS = ['RENTED', 'FREE_OCCUPIED'] as const;

/**
 * Statuses in which the **owner** is still the one billed for occupancy, even
 * though nobody lives there all year.
 *
 * Named so the third way a status can land in `bearsFee` is a decision on the
 * page rather than a value that fell through two lists — the memory of how
 * `FREE_OCCUPIED` once did exactly that is why every status must be classified
 * somewhere. See `SEASONAL` for why the owner bears it.
 */
export const OWNER_BILLED_WHILE_ABSENT = ['SEASONAL'] as const;

/**
 * Whether this unit's شاغل is somebody other than its owner — **false for
 * null**, exactly as `isUnoccupied` is, and for the same reason: a unit nobody
 * was asked about is billed, and the resident who is owed the exemption comes
 * and says so.
 */
export function isOccupiedByOthers(status: string | null | undefined): boolean {
  return status != null && (OCCUPIED_BY_OTHERS as readonly string[]).includes(status);
}

/**
 * The حالة الوحدة implied by a person's capacity in it — the census's answer
 * to a question the owner's card asks separately.
 *
 * Who is in a flat is recorded in `UnitOccupancy`; what the flat's state is
 * lives in `unitStatus` on two other rows. They are two statements of one fact
 * maintained by two different screens, and nothing connected them: recording a
 * مستأجر never made the unit «مؤجرة», so the owner's card went on saying
 * «مشغولة من المالك» and both parties were billed for the flat.
 *
 * `OWNER` returns null on purpose. An owner in the occupancy table says
 * nothing about whether they *live* there — the deed is not a statement of
 * residence, and an owner abroad with a tenant downstairs is the case this
 * whole join table exists for (D2). Only a non-owner spell settles the state.
 */
export function unitStatusForRole(role: string | null | undefined): string | null {
  if (role === 'TENANT') return 'RENTED';
  if (role === 'FREE_OCCUPANT') return 'FREE_OCCUPIED';
  return null;
}

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

/**
 * The unit types somebody *lives* in — شقة and منزل مستقل.
 *
 * The line a non-resident record turns on (see `CITIZEN_RESIDENCE`). A person
 * who lives outside the town may own anything here, and may rent or occupy
 * what nobody lives in — a محل، مكتب، عيادة، مستودع or a plot of land. Renting a
 * dwelling and living in it makes them a household in the town, with a file of
 * their own; renting one and *not* living in it means the unit is being used as
 * something else, and its type is what should be corrected — the rental-value
 * rate itself differs by use (Law 60/1988, Art. 12: 5% residential, 7% other).
 */
export const DWELLING_UNIT_TYPE = ['APARTMENT', 'INDEPENDENT_HOUSE'] as const;

export function isDwellingUnitType(type: string | null | undefined): boolean {
  return type != null && (DWELLING_UNIT_TYPE as readonly string[]).includes(type);
}

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
 * Where a structure stands in its own life, as distinct from what kind of thing
 * it is and from what condition it is in.
 *
 * The third axis the census was missing. `STRUCTURE_TYPE` says *what* is on the
 * parcel and `DAMAGE_LEVEL` says what has happened *to* it — neither can say
 * that the thing is a poured foundation, or a permit nobody ever built against.
 * Before this, an officer standing in front of a half-built shell had two
 * options: invent a `RESIDENTIAL_BUILDING` with a fictional matrix, which then
 * counts in every occupancy and coverage figure the census produces, or record
 * nothing at all and leave the parcel looking unvisited.
 *
 * The ladder is the Dutch BAG's *pand* lifecycle, minus the states that only
 * exist because their register is driven by permit paperwork we do not receive
 * (`Pand in gebruik (niet ingemeten)`, `Verbouwing pand`, `Sloopvergunning
 * verleend`). What is kept is the part a surveyor can establish by looking:
 * whether it is permitted, going up, standing and used, standing and abandoned,
 * gone, or abandoned before it was ever finished.
 *
 * Deliberately **not** merged into `DAMAGE_LEVEL` — that is D5 restated one
 * level up. A building under construction has no damage history to overwrite,
 * and a demolished-by-choice building is a different fact from a collapsed one.
 */
export const BUILDING_LIFECYCLE = [
  /** رخصة بناء صادرة — permitted, nothing on the ground yet. */
  'PERMITTED',
  /** قيد الإنشاء — foundations poured or higher, not yet habitable. */
  'UNDER_CONSTRUCTION',
  /** قائم ومستعمل — standing and in use. The overwhelming default. */
  'IN_USE',
  /**
   * مهجور — standing, structurally there, nobody using it as intended.
   *
   * Counted as occupiable below, and that is not an oversight: an abandoned
   * building with squatters or a displaced family in it is exactly the case a
   * war-damage census exists to find, and excluding it from the denominator
   * would hide those households from every coverage figure.
   */
  'DERELICT',
  /** مهدوم — taken down. Distinct from `TOTAL_COLLAPSE`, which is damage. */
  'DEMOLISHED',
  /** لم يُنفَّذ — permitted, then abandoned or revoked. BAG's `niet gerealiseerd`. */
  'NOT_REALISED',
] as const;
export const buildingLifecycleSchema = arabicEnum(
  BUILDING_LIFECYCLE,
  'حالة المبنى الإنشائية غير صالحة',
);
export type BuildingLifecycle = z.infer<typeof buildingLifecycleSchema>;

/**
 * The lifecycle states in which a structure can hold households.
 *
 * This is the census denominator. A building that is permitted, going up,
 * demolished or never built has no doors to knock on, so counting its units as
 * «غير ممسوحة» would park permanent unreachable work on every dispatch list and
 * hold the municipality's coverage percentage below 100 for ever.
 *
 * `DERELICT` is in, for the reason given on the value itself.
 */
export const OCCUPIABLE_LIFECYCLE = ['IN_USE', 'DERELICT'] as const;

/**
 * Whether this structure's units belong in survey and occupancy figures.
 *
 * Null reads as occupiable, matching every other nullable census field in this
 * file: a building recorded before the column existed is a building somebody
 * surveyed, and defaulting it out of the denominator would silently shrink the
 * census the day the column shipped.
 */
export function isOccupiableLifecycle(status: string | null | undefined): boolean {
  return status == null || (OCCUPIABLE_LIFECYCLE as readonly string[]).includes(status);
}

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
 * Why a spell on a unit ended — asked every time «إنهاء الإشغال» is pressed.
 *
 * The button used to end a spell with no question at all, and field inspectors
 * pressed it by mistake: a small link on the same row as the person's name, on
 * a phone. Worse, it was also pressed on purpose for the wrong reason, because
 * «تأكيد الشغور» told them to end the owner first. A reason is what separates
 * the three things an ended spell can mean, and they are not interchangeable:
 *
 *  - `MOVED_OUT` — the household left. History the municipality keeps.
 *  - `OWNERSHIP_TRANSFERRED` — an owner sold or passed the unit on. Ending an
 *    owner never means «moved out»; the deed is not a statement of residence.
 *  - `RECORDED_IN_ERROR` — the spell should never have existed. Kept, because
 *    the row is still evidence of what was entered and by whom, and hidden from
 *    the unit's history, because it is not history.
 */
export const OCCUPANCY_END_REASON = [
  'MOVED_OUT',
  'OWNERSHIP_TRANSFERRED',
  'RECORDED_IN_ERROR',
] as const;
export const occupancyEndReasonSchema = arabicEnum(
  OCCUPANCY_END_REASON,
  'يرجى تحديد سبب إنهاء الإشغال',
);
export type OccupancyEndReason = z.infer<typeof occupancyEndReasonSchema>;

/**
 * What a «تأكيد الشغور» rests on — asked every time one is recorded.
 *
 * Confirming a vacancy is not a display state: it stops the occupancy fee
 * being charged to the owner (`isUnoccupied` → `bearsFee`), so it is a finding
 * with a consequence, and the law is specific about what may support one. A
 * unit is *presumed occupied* until a تصريح بالشغور is filed on the declarant's
 * responsibility (هيئة التشريع والاستشارات 725/2003), failing to file one does
 * not make an occupied flat vacant (Shura 518/2007), and furniture is not proof
 * of occupancy either way (Shura 122/2003). So the register records which of
 * these an officer actually had:
 *
 *  - `FIELD_INSPECTION` — they stood at the door and found it empty.
 *  - `OWNER_STATEMENT` — the owner says it is empty, with no declaration filed.
 *  - `NEIGHBOUR_OR_CARETAKER` — a neighbour or ناطور said so. The weakest, and
 *    the one whose note has to name who said it.
 *  - `DECLARATION_FILED` — a تصريح بالشغور is on file. The strongest, and the
 *    only one the law itself provides for.
 *
 * Kept apart from `DamageSource` deliberately, though both answer "how do we
 * know": that one grades an engineering reading, this one grades a statement
 * about who is inside, and the two vocabularies share not one value.
 */
export const VACANCY_BASIS = [
  'FIELD_INSPECTION',
  'OWNER_STATEMENT',
  'NEIGHBOUR_OR_CARETAKER',
  'DECLARATION_FILED',
] as const;
export const vacancyBasisSchema = arabicEnum(VACANCY_BASIS, 'يرجى تحديد مستند تأكيد الشغور');
export type VacancyBasis = z.infer<typeof vacancyBasisSchema>;

/**
 * Why a confirmed vacancy was lifted — the undo, which is always available.
 *
 * Two reasons, and they are not interchangeable because they restore different
 * things:
 *
 *  - `RECORDED_IN_ERROR` — the flat was never empty. The unit goes back to
 *    whatever it said before the confirmation, which the confirmation itself
 *    stored for exactly this purpose.
 *  - `NO_LONGER_VACANT` — it was empty and is not any more. The vacancy stays
 *    true for the period it covered, so the record is closed rather than
 *    corrected, and the unit returns to «الإشغال غير محدد»: somebody is in it
 *    and the register does not yet know who, which is the presumption the law
 *    starts from and the state that bills the owner again.
 *
 * Neither deletes the confirmation. A resident disputing a bill is entitled to
 * see that the municipality called their flat empty, when, and on what basis —
 * and that is as true of a confirmation withdrawn as of one that stands.
 */
/**
 * Whether recording this person in this capacity contradicts an empty flat.
 *
 * Shared because both sides of the same question have to give the same answer:
 * the unit panel asks it to decide whether to warn the officer *before* they
 * link somebody, and `recordOccupancy` asks it to decide whether to refuse
 * without an acknowledgement. Two copies of this rule would mean a form that
 * warns about something the server allows, or worse, one that does not warn
 * about something it refuses.
 *
 * A مستأجر or شاغل بتسامح is somebody living there, so recording them ends the
 * vacancy. An owner is not (D2: a deed is not a statement of residence) — an
 * owner recorded on a شاغرة flat is the ordinary case, and the reason «تأكيد
 * الشغور» stopped being refused over owners. What an owner *says* about the flat
 * still can: «مشغولة من المالك» or «مؤجرة» on a unit confirmed empty is the same
 * contradiction arriving through the other field.
 */
export function contradictsVacancy(role: string, unitStatus?: string | null): boolean {
  if (role !== 'OWNER') return true;
  return unitStatus !== undefined && unitStatus !== null && unitStatus !== 'VACANT';
}

export const VACANCY_END_REASON = ['RECORDED_IN_ERROR', 'NO_LONGER_VACANT'] as const;
export const vacancyEndReasonSchema = arabicEnum(
  VACANCY_END_REASON,
  'يرجى تحديد سبب إلغاء تأكيد الشغور',
);
export type VacancyEndReason = z.infer<typeof vacancyEndReasonSchema>;

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
 * What a unit on this floor of this structure most likely is.
 *
 * `STRUCTURE_TYPE_MAP`'s `defaultUnitType` answers it for the building as a
 * whole, and below ground that answer is wrong nearly every time: what is under
 * a residential block is storage, parking and machine rooms, not flats. An
 * officer adding a قبو unit was handed «شقة» and had to correct it on every
 * single one — and a default nobody wants is a default that gets left in place.
 *
 * A suggestion, never a constraint: the select is still free, exactly as it is
 * above ground.
 */
export function defaultUnitTypeFor(structureType: StructureType, floor: number): UnitType {
  if (floor < 0) return 'WAREHOUSE';
  return STRUCTURE_TYPE_MAP[structureType].defaultUnitType;
}

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

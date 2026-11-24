import { getZone, getZones } from './zones';
import { type HouseGrowth, type OwnerBillingFallback, type CitizenResidence, type DamageLevel, type DamageSource, type FeeAssessment, type BuildingTypeView, type UnitTypeView, type CreateUnitTypeInput, type UpdateUnitTypeInput, type CreateBuildingTypeInput, type FeeExemptionCitizenUnits, type FeeExemptionListQuery, type FeeExemptionListResult, type FeeExemptionReason, type FeeExemptionUnitView, type FieldFlag, type SharedUnitBillView, type OccupancyEndReason, type OccupancyRole, type OwnerBillingMode, type OwnerBillingState, type RequestStatus, type RequestType, type SetOwnerBillingInput, type SetUnitFeeExemptionInput, type UpdateBuildingTypeInput, type BuildingLifecycle, type StructureType, type SurveyStatus, type UnitStatus, type UnitType, type VacancyBasis, type VacancyEndReason, type BillArrearsView, type BillWriteOffView } from '@mechanization/shared-schemas';
import { cachedRequest, invalidateRequests, peekCachedRequest } from '../request-cache';
import { ApiRequestError, apiFetch, type DuplicateBuildingCandidate } from './core';

// ─────────────────────────  Buildings (سجل المباني)  ─────────────────────────

/**
 * The census, as the browser sees it.
 *
 * Every shape here is the server's own row with its `Date`s read back as the
 * ISO strings JSON actually carries — `createdAt` is typed `string` rather than
 * `Date` because that is what arrives, and typing it otherwise would have
 * `formatDate` handed something that only looks like a date until it is used.
 *
 * The rule that governs all of them: **the id is the identity and the code is
 * derived** (D9). Nothing here ever sends a `code`, a `unitCode` or a
 * `codeSuffix` — the server allocates them, and a client that could assert one
 * could assert one that contradicts the parcel it names.
 */
export interface BuildingSummary {
  id: string;
  parcelNumber: string;
  codeSuffix: string;
  /** `ZONE-PARCEL-SUFFIX` — `A-1042-B`. Display only; recomputed server-side. */
  code: string;
  name: string | null;
  /** What is painted on the building. Trusted over `code` in the field (D14). */
  postedNumber: string | null;
  /**
   * «هل الوحدة مفروزة على عقار» — whether the structure is legally partitioned.
   *
   * Three states: `true` مفروزة, `false` غير مفروزة, `null` nobody asked.
   * Optional on the wire as well, so a response cached from a build before the
   * column existed reads as «لم يُسأل» rather than leaking `undefined` into a
   * control that would render it as a definite «لا».
   */
  isPartitioned?: boolean | null;
  /**
   * أرقام الأقسام the فرز produced, each with its own صحيفة عقارية.
   *
   * Empty unless `isPartitioned` is true — the server keeps the two in step,
   * because أقسام under a structure with no recorded فرز is a contradiction a
   * deed search would later read as fact.
   */
  partitionNumbers?: string[];
  /**
   * The *other* عقارات this structure stands on, beside `parcelNumber`.
   *
   * Optional for the same reason, and empty for the overwhelming majority of
   * buildings, which stand on exactly one parcel.
   */
  sharedParcelNumbers?: string[];
  structureType: StructureType;
  /**
   * «نوع المبنى» (0106): the municipality's type it was filed as; `structureType`
   * is set from it. Optional on the wire for an answer from before it.
   */
  buildingTypeId?: string | null;
  /**
   * Where the structure is in its own life — permitted, going up, standing,
   * abandoned, gone. The third axis beside *what it is* (`structureType`) and
   * *what happened to it* (its damage level).
   */
  lifecycleStatus: BuildingLifecycle;
  latitude: number | null;
  longitude: number | null;
  floorsCount: number;
  /**
   * How far the structure goes down, as a depth: 2 means B1 and B2.
   *
   * Optional on the wire so a response cached from a build before the column
   * existed reads as "no basement" rather than `undefined` leaking into a
   * floor count.
   */
  basementsCount?: number;
  /** Maintained by a database trigger — never written from the client. */
  unitsTotal: number;
  unitsSurveyed: number;
  notes: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A census ledger row — the building plus the two derived columns it shows. */
export interface BuildingLedgerRow extends BuildingSummary {
  zoneCode: string | null;
  zoneName: string | null;
  /** The *current* level, i.e. the newest assessment. Null = never assessed. */
  damageLevel: DamageLevel | null;
  /** With a search: the retired code the term matched — «كان Z-1-45-A». */
  matchedPreviousCode?: string;
}

/** One occupant of a unit. A `toDate` of null means they are there now (D2). */
export interface UnitOccupant {
  id: string;
  unitId: string;
  citizenId: string;
  citizenName: string | null;
  /** Their phone, shown on the unit. Optional for a server from before it. */
  citizenPhone?: string | null;
  /**
   * Whether their file is open. An archived owner is never billed, so co-owner
   * billing leaves them out of the division. Optional on the wire: absent reads
   * as open.
   */
  citizenActive?: boolean;
  role: OccupancyRole;
  /** أسهم out of 2400 — owners only. */
  shares: number | null;
  fromDate: string;
  toDate: string | null;
  /**
   * Why the spell ended, when an officer said so. `RECORDED_IN_ERROR` spells
   * are kept on the record and left out of the unit's visible history.
   * Optional on the wire for responses from before the field existed.
   */
  endReason?: OccupancyEndReason | null;
  registrationId: string | null;
  /**
   * Whether the citizen's own file claims this flat.
   *
   * `false` means the census records them here but their registration does
   * not name the property — the half-finished state «ربط شخص بالوحدة» can produce,
   * which is legitimate at the doorstep and needs finishing afterwards.
   * Billing reads the file, not this row, so an unbacked occupancy is a flat
   * nobody is charged for.
   *
   * Optional on the wire so a cached response from a build before the field
   * existed reads as "backed" rather than lighting up every occupant in the
   * matrix with a warning.
   */
  backedByFile?: boolean;
  /**
   * When the spell was entered in the register (not `fromDate`, which may be
   * back-dated). A tenant may be linked by picking only to an owner recorded
   * before them. Optional on the wire for responses from before it existed.
   */
  recordedAt?: string;
  /** Who a current tenant holds the flat from, per their own card. Null otherwise. */
  ownerLink?: OccupantOwnerLink | null;
}

/**
 * The tenancy card behind a current tenant's spell, and whether it names an
 * owner of this flat — see `OccupancyOwnerLink` on the server.
 */
export interface OccupantOwnerLink {
  state: 'LINKED' | 'LINKED_ELSEWHERE' | 'UNLINKED' | 'NO_CARD';
  propertyEntryId: string | null;
  ownerId: string | null;
  ownerName: string | null;
  typedName: string | null;
}

/** One canonical unit. It exists whether or not anybody has been surveyed in it. */
export interface UnitRow {
  id: string;
  buildingId: string;
  /** Signed: basement negative, ground 0. `unitCode` is derived from it (D8). */
  floor: number;
  sequence: number;
  /** 1-based inclusive column span this unit was painted on, or both null if
   *  it was never painted on a grid (the blueprint generator, a hand-added
   *  single unit) — see `unit-grid-picker.tsx`'s `GridUnitDraft`. */
  startCol: number | null;
  endCol: number | null;
  unitCode: string;
  postedNumber: string | null;
  unitType: UnitType;
  /**
   * «نوع الوحدة» (0109): the type it was filed as; `unitType` is that type's
   * base. Null on a floor block, and absent on a response from before 0109.
   */
  unitTypeId?: string | null;
  side: string | null;
  unitArea: number | null;
  unitStatus: UnitStatus | null;
  surveyStatus: SurveyStatus;
  /**
   * «مسكن موسمي» — the months (1–12) its owners are usually present, when they
   * last stayed, and when a تصريح بالشغور was filed. Recorded for the council's
   * billing decision; nothing bills from them. Optional on the wire for
   * responses from before migration 0040.
   */
  presenceMonths?: number[];
  ownerLastStayAt?: string | null;
  vacancyDeclaredAt?: string | null;
  /**
   * «توزيع الرسم على المالكين» (migration 0075): how a flat with several
   * owners is billed. Null means nobody chose — split equally. Optional on the
   * wire for responses from before it existed. Each owner's part is computed
   * with the shared `ownerSharesPreview`, the rule billing applies.
   */
  ownerBillingMode?: OwnerBillingMode | null;
  responsibleOwnerId?: string | null;
  /**
   * «معفاة من الرسوم» (0077): why the unit is charged nothing, the reason in
   * words, when and who granted it. Optional on the wire for older responses.
   */
  feeExemption?: FeeExemptionReason | null;
  feeExemptionNote?: string | null;
  feeExemptedAt?: string | null;
  feeExemptedByName?: string | null;
  /**
   * The exemption's last day, `YYYY-MM-DD`, or null for none (0104). Past it the
   * unit is billed again although `feeExemption` is still set (`isFeeExemptOn`).
   */
  feeExemptionValidUntil?: string | null;
  /**
   * How many levels this one home spans upward from `floor` (0095, D28): 2 is
   * a «دوبلكس». Optional on the wire for older responses, where it is 1.
   */
  levels?: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One «تأكيد الشغور» — that a unit was found empty, on what basis, and by whom.
 *
 * `endedAt` null is the one standing: it is why the unit reads «شاغرة» and why
 * its owner is exempt from the occupancy fee. The rest are closed history, kept
 * rather than deleted — a vacancy withdrawn still records what the municipality
 * believed and for how long.
 *
 * `previousUnitStatus` / `previousSurveyStatus` are what the flat said before,
 * carried so the undo can state what it will restore *before* it is pressed.
 * Both null on a row migration 0043 backfilled, where nobody recorded either.
 */
export interface UnitVacancyConfirmation {
  id: string;
  unitId: string;
  /** Null only on a backfilled row — the question did not exist then. */
  basis: VacancyBasis | null;
  observedAt: string;
  notes: string | null;
  confirmedById: string | null;
  confirmedByName: string | null;
  previousUnitStatus: UnitStatus | null;
  previousSurveyStatus: SurveyStatus | null;
  endedAt: string | null;
  endReason: VacancyEndReason | null;
  endNotes: string | null;
  endedById: string | null;
  endedByName: string | null;
  createdAt: string;
}

/** A unit as the matrix draws it — with whoever is, and was, inside it. */
export interface UnitWithOccupants extends UnitRow {
  occupants: UnitOccupant[];
  /** The most recent attempts, newest first. Capped server-side at ten. */
  visits: UnitVisitRow[];
  /** Every attempt ever made, uncapped — this is «٣ محاولات» on the cell. */
  visitCount: number;
  /**
   * حالة الوحدة as the owner's own card states it, sent only when `unitStatus`
   * is unset. The unit's value wins where it has one — the order billing reads
   * them in — so the matrix shows `unitStatus ?? ownerDeclaredStatus`.
   */
  ownerDeclaredStatus?: UnitStatus | null;
  /**
   * «تأكيد الشغور» on this unit, newest first and capped server-side at five.
   *
   * Optional on the wire so a cached response from a build before migration
   * 0043 reads as "none" rather than throwing — a unit with no confirmations is
   * the ordinary case anyway.
   */
  vacancies?: UnitVacancyConfirmation[];
}

/** One building opened in the matrix drawer. */
export interface BuildingDetail extends BuildingSummary {
  /** Resolved from `Zone.parcelNumbers` at read time — never stored (D13). */
  zoneCode: string | null;
  zoneName: string | null;
  /**
   * Codes this building carried before «تصحيح رقم العقار», newest first —
   * still found by search, never given to another building. Absent from a
   * server older than the correction.
   */
  previousCodes?: Array<{ code: string; parcelNumber: string; reason: string; retiredAt: string }>;
  units: UnitWithOccupants[];
}

/** One observation of a structure's condition. Append-only (D3). */
export interface DamageAssessmentRow {
  id: string;
  buildingId: string | null;
  unitId: string | null;
  level: DamageLevel;
  source: DamageSource;
  observations: string | null;
  /** When the visit happened, not when it was typed up — see the schema. */
  assessedAt: string;
  /**
   * «صالحة للسكن؟» — the second axis beside the level (0071): true / false as
   * answered, null on a reading from before the question. Optional for an
   * older server. Read it with `isUninhabitableReading`.
   */
  habitable?: boolean | null;
  /** «موعد إعادة الكشف» — only on a «غير صالحة للسكن» reading. Optional for an older server. */
  reinspectAt?: string | null;
  assessedById: string | null;
  assessedByName: string | null;
  createdAt: string;
}

/**
 * The census totals for whatever the filters currently select — computed by the
 * server over the whole filtered set, not over the page on screen.
 */
export interface CensusSummary {
  /** Every building the filters select, whatever its lifecycle state. */
  buildings: number;
  /**
   * Units in structures that can hold households only — a shell under
   * construction has matrix rows and no doors to knock on.
   */
  unitsTotal: number;
  unitsSurveyed: number;
  unitsUnsurveyed: number;
  /** Units the lifecycle exclusion removed from the three figures above. */
  unitsOutOfScope: number;
  /** Restricted-use, unsafe-evacuate or total-collapse, at the current level. */
  damaged: number;
  /**
   * Structures with no entrance pin — a queue of doors, not an error.
   *
   * A building may be created from a desk, and one created from the
   * registration form always is: no entrance is guessed for it (D19), because
   * the parcel centroid is the middle of a plot where no building stands and is
   * the same point for every structure on it.
   */
  withoutEntrance: number;
}

/**
 * What saving a citizen changed in the building census.
 *
 * Returned by both write paths so the form can say what it linked — an officer
 * who registered a household into a flat has no other way to tell the census
 * heard about it, and "did that work?" is what sends somebody to enter a record
 * a second time.
 *
 * `null` on the citizen response means the census write failed. The citizen is
 * saved either way; the link can be made from the ledger.
 */
export interface CensusSyncResult {
  occupanciesCreated: number;
  occupanciesRefreshed: number;
  /** Spells this registration used to claim and no longer does. */
  occupanciesEnded: number;
  /** Units lifted out of «غير ممسوحة» / «زيارة بلا رد» / «بيانات ناقصة». */
  unitsSurveyed: number;
  casesResolved: number;
  /**
   * Units whose confirmed vacancy this registration lifted, because it recorded
   * a household in a flat the municipality had called empty. Optional on the
   * wire for responses from before migration 0043.
   */
  vacanciesEnded?: number;
  /** Structures that had no name until this card supplied one. */
  buildingsNamed: number;
}

/** Every filter the ledger composes. All optional; any subset is valid. */
export interface BuildingListFilter {
  parcelNumber?: string;
  zoneId?: string;
  structureType?: StructureType;
  /** «نوع المبنى» (0106). */
  buildingTypeId?: string;
  lifecycleStatus?: BuildingLifecycle;
  surveyStatus?: SurveyStatus;
  damageLevel?: DamageLevel;
  /** Matches code, name, posted number or parcel number. */
  search?: string;
  /** `false` selects the structures with no entrance recorded. */
  hasEntrance?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateBuildingInput {
  parcelNumber: string;
  name?: string;
  postedNumber?: string;
  /**
   * «هل الوحدة مفروزة على عقار» — omitted entirely when nobody established it.
   *
   * Absent and `null` are the same answer on a creation, so the wizard sends
   * the key only when the officer actually answered. The column is nullable and
   * the absence is the third state — see the schema.
   */
  isPartitioned?: boolean;
  /**
   * أرقام الأقسام, sent only alongside `isPartitioned: true`.
   *
   * The server drops them otherwise rather than refusing the request — a form
   * whose checkbox was ticked, filled in and then cleared is a correction, and
   * failing the save over the rows somebody abandoned would punish them for
   * changing their mind.
   */
  partitionNumbers?: string[];
  /**
   * The *other* عقارات this structure stands on.
   *
   * `parcelNumber` above names one and cannot name more: the code and the
   * per-parcel suffix derive from it (D9). The server drops the building's own
   * parcel from this list if it appears, so a structure can never be recorded
   * as straddling itself.
   */
  sharedParcelNumbers?: string[];
  /** Sent beside the type for an older server and the offline queue; the server takes the type's. */
  structureType: StructureType;
  /** «نوع المبنى» (0106): an inactive type is refused on a new building. */
  buildingTypeId?: string;
  /** Defaults to `IN_USE` server-side — what an officer is looking at most days. */
  lifecycleStatus?: BuildingLifecycle;
  latitude?: number;
  longitude?: number;
  floorsCount?: number;
  /** Levels below ground, as a depth: 2 means B1 and B2. Omitted means none. */
  basementsCount?: number;
  notes?: string;
  /**
   * The suffix a phone showed while offline. Never trusted — the server
   * re-allocates under a lock (§4.4) and the response says whether the code the
   * officer has been quoting changed.
   */
  provisionalSuffix?: string;
  /** The browser's own id for this creation, which is also the row's id. */
  clientSubmissionId?: string;
  /**
   * «نعم، هذه منشأة مختلفة» — the officer has seen what already stands on this
   * parcel and is asserting this is not one of them.
   *
   * The server refuses a second structure on an occupied parcel without it, and
   * answers the refusal with the candidates (`duplicateBuildingsOf`). Never set
   * by default: the answer is always allowed to be yes, but it has to be given.
   */
  acknowledgedDuplicates?: boolean;
  /**
   * The officer's sentence behind `acknowledgedDuplicates` — what makes this a
   * separate structure. Written into the creation's audit row beside the
   * neighbours and their distances. The editor requires it; the server accepts
   * its absence so that creations already queued on phones still land.
   */
  duplicateReason?: string;
  /** Why the building is created with no entrance pin. See the schema. */
  noPinReason?: string;
  /**
   * The matrix, created in the same transaction as the shell.
   *
   * For the registration form, which creates a structure the officer is
   * standing in front of and must attach a household to it in the same save. A
   * shell alone would be worse than nothing there: the census claims a flat
   * only where the card line carries a `unitId`, so a building with no units
   * links the card and records no occupancy at all.
   *
   * Each unit may carry the id the browser minted, for the same reason the
   * building does — a phone with no signal has to put a `unitId` on a card
   * before the row exists. `sequence` is omitted and allocated server-side.
   */
  units?: Array<{
    id?: string;
    floor: number;
    sequence?: number;
    startCol?: number;
    endCol?: number;
    unitType: UnitType;
    postedNumber?: string;
    side?: string;
    unitArea?: number;
    unitStatus?: UnitStatus;
    surveyStatus?: SurveyStatus;
    notes?: string;
  }>;
}

export type UpdateBuildingInput = Partial<{
  /** The building's `updatedAt` as the editor loaded it — see the schema. */
  expectedUpdatedAt: string;
  name: string | null;
  postedNumber: string | null;
  /**
   * «هل الوحدة مفروزة على عقار» — nullable here, unlike on a creation.
   *
   * An absent key leaves the column as it is; `null` unsets it back to
   * «غير محدد». Both are needed: an officer has to be able to withdraw a فرز
   * they ticked by mistake, and an edit that could only ever set it would make
   * the answer one-way.
   */
  isPartitioned: boolean | null;
  /**
   * Replaces the stored أقسام wholesale, and is cleared outright whenever the
   * فرز flag is not `true` — sending either field makes the server re-resolve
   * both, so a PATCH that unsets the flag cannot leave the numbers behind.
   */
  partitionNumbers: string[];
  /** Replaces the stored list wholesale — an empty array clears it. */
  sharedParcelNumbers: string[];
  structureType: StructureType;
  /** «نوع المبنى» (0106): decides `structureType`; an inactive one is kept only if the building has it. */
  buildingTypeId: string;
  lifecycleStatus: BuildingLifecycle;
  latitude: number | null;
  longitude: number | null;
  floorsCount: number;
  basementsCount: number;
  notes: string | null;
}>;

/**
 * How to fill a matrix. Two shapes, because officers arrive with two different
 * amounts of knowledge — "six floors, four flats each" from the pavement, or a
 * row per floor from someone who has walked the stairwell.
 */
export type UnitBlueprintInput = (
  | {
      kind: 'uniform';
      fromFloor: number;
      toFloor: number;
      unitsPerFloor: number;
      unitType: UnitType;
    }
  | {
      kind: 'explicit';
      floors: Array<{ floor: number; unitCount: number; unitType: UnitType }>;
    }
) & {
  /** See `UpsertUnitInput.houseGrowth`; a blueprint takes only `SEPARATE_UNIT`. */
  houseGrowth?: HouseGrowth;
};

export interface UpsertUnitInput {
  floor: number;
  /** Omitted on create: the server takes the next free spot on the floor. */
  sequence?: number;
  startCol?: number;
  endCol?: number;
  unitType: UnitType;
  postedNumber?: string;
  side?: string;
  unitArea?: number;
  unitStatus?: UnitStatus;
  surveyStatus?: SurveyStatus;
  notes?: string;
  /**
   * «نعم، هذه وحدة مختلفة» — the officer has seen what is already on this
   * floor and is asserting the unit they are adding is not one of them. The
   * server refuses a same-type addition without it; see `upsertUnitSchema`.
   */
  acknowledgedDuplicates?: boolean;
  /**
   * The answer to «هذا المنزل يصبح مبنى» (D28): another level of the same home,
   * or a separate unit. Sent only after the server asked (`houseGrowthQuestionOf`).
   */
  houseGrowth?: HouseGrowth;
}

export interface RecordOccupancyInput {
  unitId: string;
  citizenId: string;
  role: OccupancyRole;
  /** Owners only — the server refuses shares on a tenant. */
  shares?: number;
  /**
   * حالة الوحدة — owners only, for the same reason shares are.
   *
   * A tenant or a شاغل بتسامح *is* the occupant of what is being recorded,
   * so their capacity settles the unit’s state and the server derives it. An
   * owner’s does not: they may live there, let it, lend it, or hold it empty,
   * and those are four different bills.
   */
  unitStatus?: UnitStatus;
  /**
   * «نعم، الوحدة لم تعد شاغرة».
   *
   * Recording somebody in a unit whose vacancy is standing is refused without
   * this — the server answers with the confirmation itself so the officer can
   * see when the flat was called empty and on what basis before overriding it.
   * With it, the vacancy is lifted as «لم تعد شاغرة» in the same request.
   *
   * Not needed to record an owner, who contradicts nothing by holding a deed.
   */
  endsVacancy?: boolean;
  /**
   * مساحة الوحدة — offered only where the census has none.
   *
   * The area belongs to the unit, not to the spell, and the server writes it
   * onto the `Unit` and only where that column is still null: a measured flat
   * is never overwritten by a side effect of recording who lives in it. It is
   * accepted *here* because this is the first moment anyone has been inside —
   * the matrix is painted from the street, so `generateUnits` and the grid both
   * create flats with no area at all, and the card `claimOnFile` then mints for
   * the citizen inherited that absence.
   */
  unitArea?: number;
  /** Why no area is being given for a unit the census has none for. See the schema. */
  unitAreaMissingReason?: string;
  /** Owners: why «ومن يشغلها؟» is left unanswered. See the schema. */
  unitStatusMissingReason?: string;
  fromDate?: string;
  toDate?: string;
  /**
   * «المالك» — non-owners only. One of the owners already recorded on this
   * unit, linked in the same request; among co-owners, the one the tenant deals
   * with. The server refuses an owner recorded after the tenant.
   */
  landlordCitizenId?: string;
  /** The owner as the tenant names them, when not recorded on the unit. */
  landlordName?: string;
  landlordPhone?: string;
}

/** What linking the picked owner did — see `LandlordLinkService.linkRecordedOwner`. */
export interface RecordedOwnerLink {
  linked: boolean;
  alreadyLinked: boolean;
  /** The flat moved onto a tenancy card of its own to carry this owner. */
  split: boolean;
  propertyEntryId: string | null;
  reason: 'TENANT_NO_FILE' | 'UNLINKABLE_STRUCTURE' | null;
}

/**
 * What recording the occupant did to that citizen’s own file.
 *
 * The server now links the two halves by default, so `backed` is true for
 * every citizen who has a file at all. `outcome` is what the officer is told
 * when it is not — and `'NO_FILE'` is the only ordinary way that happens.
 */
export interface OccupancyFileLink {
  backed: boolean;
  outcome:
    | 'ENTRY_CREATED'
    | 'UNIT_ADDED'
    | 'ALREADY_CLAIMED'
    | 'NO_FILE'
    | 'UNLINKABLE_STRUCTURE'
    | 'NO_BUILDING';
}

export interface RecordDamageInput {
  /** Exactly one of these two. Both, or neither, is refused server-side. */
  buildingId?: string;
  unitId?: string;
  level: DamageLevel;
  source?: DamageSource;
  observations?: string;
  assessedAt?: string;
  /** «صالحة للسكن؟» — see `habitabilityFor` for what the level decides and what it leaves to the inspector. */
  habitable?: boolean;
  /** «موعد إعادة الكشف», "YYYY-MM-DD" — only on a «غير صالحة للسكن» reading; refused otherwise. */
  reinspectAt?: string;
}

/**
 * What «سجل المباني»'s selects may offer — every list is the set of values the
 * census actually holds, so choosing one can never return an empty table for
 * the reason that nothing was ever filed under it.
 */
export interface BuildingFilterOptions {
  structureTypes: StructureType[];
  /** The types buildings are filed under (0106). Optional on the wire for an answer from before it. */
  buildingTypeIds?: string[];
  lifecycleStatuses: BuildingLifecycle[];
  surveyStatuses: SurveyStatus[];
  damageLevels: DamageLevel[];
}

/**
 * Every building matching the filters, with the totals for that same set.
 *
 * Not cached: this is what an officer reloads after creating a building from
 * the map, and a stale ledger is how the same structure gets entered twice.
 */
export function getBuildings(
  tenant: string,
  token: string,
  filter: BuildingListFilter = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const qs = query.toString();
  return apiFetch<{
    buildings: BuildingLedgerRow[];
    total: number;
    summary: CensusSummary;
    /**
     * With a `parcelNumber` filter: suffixes «تصحيح رقم العقار» retired on
     * that parcel, which a new building there never gets.
     */
    retiredSuffixes?: string[];
  }>(tenant, `/buildings${qs ? `?${qs}` : ''}`, { token, signal });
}

/**
 * The values «سجل المباني»'s filters may offer, as found in the census.
 *
 * A *reference* read, not a data read: it describes the municipality's
 * vocabulary — which kinds of structure it has entered, which conditions it
 * has assessed — rather than the rows on screen. It changes when somebody
 * records the first building of a kind, which is a handful of times in a
 * register's life, so the caller reads it once per session (see
 * `useStaffQuery`'s `reference` option) instead of on every visit to the page.
 */
export function getBuildingFilterOptions(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<BuildingFilterOptions>(tenant, '/buildings/filter-options', { token, signal });
}

/** One building with its whole unit matrix and each unit's occupants. */
export function getBuilding(tenant: string, token: string, id: string, signal?: AbortSignal) {
  return apiFetch<BuildingDetail>(tenant, `/buildings/${encodeURIComponent(id)}`, {
    token,
    signal,
  });
}

/*
  ── The census as a *form control* reads it ──────────────────────────

  The two readers below answer the same questions as `getBuildings` and
  `getBuilding` above, and differ only in that they remember the answer.

  The ledger screen must not: an officer reloads it precisely to see what a
  colleague just entered, and a stale ledger is how one structure gets created
  twice. `BuildingUnitPicker` is the opposite case. It asks the same two
  questions — "what stands on عقار 403" and "what flats are in this one" —
  every time it mounts, and it mounts far more often than anything changes:
  each card of a multi-property household, each fold and unfold, each open of
  the edit form on a record whose parcel was read a minute ago. Every one of
  those re-asks was a spinner over an answer the tab already had.

  Memory-only and dropped by any census write (see `invalidateCensus`), so the
  window in which this can be wrong is one officer's own tab, between their own
  changes — and a hard reload still goes to the network, which is what makes
  reloading the honest way to demand fresh data.
*/
const CENSUS_TTL_MS = 5 * 60 * 1000;

const parcelKey = (tenant: string, parcelNumber: string) =>
  `census:${tenant}:parcel:${parcelNumber}`;
const buildingKey = (tenant: string, id: string) => `census:${tenant}:building:${id}`;

/**
 * Dropped wholesale rather than surgically.
 *
 * A unit added to one building changes that building's matrix, the parcel
 * listing that counts its units, and — once occupancy is recorded — the
 * occupants on a unit two screens away. Working out which keys a given write
 * touched is a rule that has to be re-derived every time an endpoint grows a
 * field, and the failure mode of getting it wrong is a form showing an officer
 * their own edit as though it had not saved. The prefix is per-tenant, the map
 * holds a handful of entries, and re-reading is one request.
 */
export function invalidateCensus(tenant: string): void {
  invalidateRequests(`census:${tenant}:`);
}

/**
 * Structures standing on one عقار, remembered for the life of the tab.
 *
 * «Standing on» includes a building filed under another parcel that lists this
 * one among its `sharedParcelNumbers` — the server matches both. A caller that
 * needs only the buildings *filed* here (the code-suffix preview) filters on
 * `row.parcelNumber` itself.
 */
export function getParcelBuildings(tenant: string, token: string, parcelNumber: string) {
  return cachedRequest(parcelKey(tenant, parcelNumber), CENSUS_TTL_MS, () =>
    getBuildings(tenant, token, { parcelNumber, limit: 50 }),
  );
}

/** `getBuilding`, remembered — the matrix a picker re-reads on every mount. */
export function getBuildingCached(tenant: string, token: string, id: string) {
  return cachedRequest(buildingKey(tenant, id), CENSUS_TTL_MS, () =>
    getBuilding(tenant, token, id),
  );
}

/**
 * What is already known, for a control seeding its first render.
 *
 * Without these a re-mount renders one frame of «جاري مراجعة سجل المباني…»
 * before the cached promise settles in the next microtask — brief, but it is
 * the frame the officer reads as the work being redone.
 */
export function peekParcelBuildings(tenant: string, parcelNumber: string) {
  return peekCachedRequest<{ buildings: BuildingLedgerRow[]; total: number; summary: CensusSummary }>(
    parcelKey(tenant, parcelNumber),
  );
}

export function peekBuilding(tenant: string, id: string) {
  return peekCachedRequest<BuildingDetail>(buildingKey(tenant, id));
}

/**
 * The condition log for one structure, newest first, plus the current level.
 *
 * Includes its units' own readings: "top three floors gone, ground floor shop
 * still trading" is two rows about one building.
 */
export function getBuildingDamage(
  tenant: string,
  token: string,
  id: string,
  signal?: AbortSignal,
) {
  return apiFetch<{ current: DamageLevel | null; history: DamageAssessmentRow[] }>(
    tenant,
    `/buildings/${encodeURIComponent(id)}/damage`,
    { token, signal },
  );
}

/**
 * Creates the shell. The suffix is allocated server-side, under a lock.
 *
 * `reconciled: true` means the provisional code the phone was showing is not
 * the one it got, and the officer has to be told — they will otherwise keep
 * quoting a code that names nothing. `deduplicated: true` means this exact
 * creation had already been delivered, so nothing new was made.
 */
export async function createBuilding(
  tenant: string,
  token: string,
  input: CreateBuildingInput,
) {
  const result = await apiFetch<{
    building: BuildingSummary;
    reconciled: boolean;
    deduplicated: boolean;
  }>(tenant, '/buildings', { token, method: 'POST', body: JSON.stringify(input) });
  invalidateCensus(tenant);
  return result;
}

/** Omitted fields are left alone. `parcelNumber` cannot be changed — see the schema. */
export async function updateBuilding(
  tenant: string,
  token: string,
  id: string,
  input: UpdateBuildingInput,
) {
  const result = await apiFetch<BuildingSummary>(tenant, `/buildings/${encodeURIComponent(id)}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  invalidateCensus(tenant);
  return result;
}

// ─────────────────────────────  «تصحيح رقم العقار»  ─────────────────────────────

/** What correcting a building's parcel would do — read before anything is asked. */
export interface ParcelCorrectionPreview {
  building: {
    id: string;
    code: string;
    parcelNumber: string;
    sharedParcelNumbers: string[];
    zoneCode: string | null;
    zoneName: string | null;
    hasPin: boolean;
    updatedAt: string;
  };
  next: {
    parcelNumber: string;
    /** Predicted: allocated under the parcel lock on save. */
    codeSuffix: string;
    code: string;
    zoneCode: string | null;
    zoneName: string | null;
    zoneChanged: boolean;
    /** Corrected back to a parcel it had left: it takes its own old code back. */
    reclaimsOwnCode: boolean;
    wasSharedParcel: boolean;
  };
  cadastre: {
    /** null: this municipality has no cadastre loaded. */
    known: boolean | null;
    point: { latitude: number; longitude: number } | null;
    /** null: no pin, or no outline known for the parcel. */
    pinInside: boolean | null;
  };
  neighbours: DuplicateBuildingCandidate[];
  cards: {
    toRewrite: number;
    current: number;
    citizenCount: number;
    citizens: Array<{ citizenId: string; name: string }>;
    underSharedParcel: number;
    otherNumber: number;
  };
  unlinkedOnOldParcel: number;
  unlinkedOnNewParcel: number;
  cases: number;
}

export interface ParcelCorrectionResult {
  building: {
    id: string;
    parcelNumber: string;
    codeSuffix: string;
    code: string;
    sharedParcelNumbers: string[];
    updatedAt: string;
  };
  previousCode: string;
  reclaimedOwnCode: boolean;
  cardsCorrected: number;
  citizensAffected: number;
  casesCorrected: number;
  pinInsideNewParcel: boolean | null;
}

export function getParcelCorrectionPreview(
  tenant: string,
  token: string,
  buildingId: string,
  parcelNumber: string,
  signal?: AbortSignal,
) {
  return apiFetch<ParcelCorrectionPreview>(
    tenant,
    `/buildings/${encodeURIComponent(buildingId)}/parcel-correction?parcelNumber=${encodeURIComponent(parcelNumber)}`,
    { token, signal },
  );
}

/** «تصحيح رقم العقار». Refused with the candidates when the right parcel already carries a structure. */
export async function correctBuildingParcel(
  tenant: string,
  token: string,
  buildingId: string,
  input: {
    parcelNumber: string;
    reason: string;
    acknowledgedDuplicates?: boolean;
    keepOldAsShared?: boolean;
    expectedUpdatedAt?: string;
  },
) {
  const result = await apiFetch<ParcelCorrectionResult>(
    tenant,
    `/buildings/${encodeURIComponent(buildingId)}/parcel-correction`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/** The building editor's save: the shell and the matrix difference, all or nothing. */
export interface BuildingMatrixSave {
  building: Omit<UpdateBuildingInput, 'expectedUpdatedAt'>;
  remove: string[];
  update: Array<{ id: string; floor: number; startCol?: number; endCol?: number; unitType: string }>;
  add: Array<{ floor: number; startCol?: number; endCol?: number; unitType: string }>;
  /** See `UpsertUnitInput.houseGrowth`; forwarded to every unit the save adds. */
  houseGrowth?: HouseGrowth;
  expectedUpdatedAt?: string;
  /** Do it all and roll back — what a save would do, or why it would be refused. */
  dryRun?: boolean;
}

export interface BuildingMatrixSaveResult {
  dryRun: boolean;
  building: BuildingSummary;
  /** Unit codes as they were. */
  removed: string[];
  /** Unit codes after the save. */
  updated: string[];
  added: string[];
}

export async function saveBuildingMatrix(tenant: string, token: string, id: string, input: BuildingMatrixSave) {
  const result = await apiFetch<BuildingMatrixSaveResult>(
    tenant,
    `/buildings/${encodeURIComponent(id)}/matrix-save`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  if (!input.dryRun) invalidateCensus(tenant);
  return result;
}

/** SUPER_ADMIN only. Refused server-side once anyone is recorded as living in it. */
export async function deleteBuilding(tenant: string, token: string, id: string) {
  const result = await apiFetch<{ deleted: boolean }>(
    tenant,
    `/buildings/${encodeURIComponent(id)}`,
    { token, method: 'DELETE' },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Fills the matrix from a blueprint. Additive and idempotent — a floor that
 * already holds the requested number of units is topped up, never doubled, so a
 * re-tap on a slow connection cannot invent flats.
 */
export async function generateUnits(
  tenant: string,
  token: string,
  buildingId: string,
  blueprint: UnitBlueprintInput,
) {
  const result = await apiFetch<{ created: number; skipped: number; units: UnitRow[] }>(
    tenant,
    `/buildings/${encodeURIComponent(buildingId)}/units/generate`,
    { token, method: 'POST', body: JSON.stringify(blueprint) },
  );
  invalidateCensus(tenant);
  return result;
}

/** Adds one unit by hand. Without a `sequence` the server takes the next free one. */
export async function addUnit(
  tenant: string,
  token: string,
  buildingId: string,
  input: UpsertUnitInput,
) {
  const result = await apiFetch<UnitRow>(
    tenant,
    `/buildings/${encodeURIComponent(buildingId)}/units`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Corrects one unit. Not nested under its building — a unit id is unique on its
 * own, and a path carrying both would let the two disagree.
 */
export async function updateUnit(
  tenant: string,
  token: string,
  unitId: string,
  input: Partial<UpsertUnitInput> & {
    /** «عدد طوابق المسكن» — see `UnitRow.levels`. */
    levels?: number;
    /** «مسكن موسمي» facts — see `UnitRow.presenceMonths`. */
    presenceMonths?: number[];
    ownerLastStayAt?: string | null;
    vacancyDeclaredAt?: string | null;
  },
) {
  const result = await apiFetch<UnitRow>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}`,
    { token, method: 'PATCH', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * «تعديل عرض الوحدة» — a unit's new edges on its floor's grid. The server
 * refuses drawing over a neighbour and pins the floor's unpositioned units
 * where the matrix drew them.
 */
export async function resizeUnitSpan(
  tenant: string,
  token: string,
  unitId: string,
  span: { startCol: number; endCol: number },
) {
  const result = await apiFetch<UnitRow>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}/span`,
    { token, method: 'PATCH', body: JSON.stringify(span) },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Removes a flat the matrix says exists and the street does not — a blueprint
 * that overshot a floor, or a محل counted twice.
 *
 * Refused server-side the moment anything has been recorded against the unit:
 * an occupancy current or past, a field visit, a damage assessment, or a
 * citizen's card naming it. Those refusals arrive as a `ConflictError` whose
 * message names the remedy, so callers should surface it verbatim rather than
 * replacing it with a generic failure.
 */
export async function deleteUnit(tenant: string, token: string, unitId: string) {
  const result = await apiFetch<{ deleted: true }>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}`,
    { token, method: 'DELETE' },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Records who is in a unit — and closes whatever case was waiting to find out.
 *
 * `casesResolved` is why this returns anything at all: silently closing
 * somebody else's dispatch item is how a case list stops being believed, so the
 * number is surfaced to the officer who caused it.
 */
export async function recordOccupancy(
  tenant: string,
  token: string,
  input: RecordOccupancyInput,
) {
  const result = await apiFetch<{
    occupancy: UnitOccupant;
    casesResolved: number;
    fileLink: OccupancyFileLink;
    /** Null when no owner was picked. Optional for a server from before it. */
    ownerLink?: RecordedOwnerLink | null;
  }>(
    tenant,
    '/buildings/occupancies',
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * «ربط بالمالك» — links a tenant already on the unit to one of its recorded
 * owners. `confirmRecordedAfter` is required when that owner was recorded on the
 * unit after the tenant, and is sent only once the officer confirmed it.
 */
export async function linkOccupancyOwner(
  tenant: string,
  token: string,
  occupancyId: string,
  landlordCitizenId: string,
  confirmRecordedAfter = false,
) {
  const result = await apiFetch<RecordedOwnerLink>(
    tenant,
    `/buildings/occupancies/${encodeURIComponent(occupancyId)}/owner-link`,
    {
      token,
      method: 'POST',
      body: JSON.stringify({ landlordCitizenId, ...(confirmRecordedAfter ? { confirmRecordedAfter } : {}) }),
    },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * What a flat is once its tenant has gone — asked with the ending, because
 * «مؤجرة» with nobody in it charges nobody. See `AFTER_TENANCY_STATUS`.
 */
export type AfterTenancyStatus = 'OWNER_OCCUPIED' | 'VACANT' | 'RENTED_TO_OTHER' | 'UNKNOWN';

export interface AfterTenancyAnswer {
  afterStatus?: AfterTenancyStatus;
  vacancyBasis?: VacancyBasis;
  vacancyNotes?: string;
}

/** What ending a tenancy changed. */
export interface EndTenancyResult {
  occupanciesEnded: number;
  rowsEnded: number;
  /** The card rows this ending closed. Optional for a server from before it. */
  endedRowIds?: string[];
  cardsEnded: number;
  statusApplied: AfterTenancyStatus | null;
  casesOpened: number;
  vacanciesConfirmed: number;
  link: Array<{ propertyEntryId: string; ownerId: string; kept: boolean }>;
}

/**
 * Ends a spell without deleting it — the history is the point (D2).
 *
 * A tenant's spell ends their tenancy: their card is kept as an ended tenancy,
 * the owner stays owner, and the flat gets `afterStatus` when nobody else is
 * still recorded living there.
 */
export async function endOccupancy(
  tenant: string,
  token: string,
  occupancyId: string,
  input: { reason: OccupancyEndReason; toDate?: string; newOwnerId?: string } & AfterTenancyAnswer,
) {
  const { toDate, ...rest } = input;
  // An owner's spell ends an ownership — `EndOwnershipResult`; anyone else's, a tenancy.
  const result = await apiFetch<EndTenancyResult | EndOwnershipResult>(
    tenant,
    `/buildings/occupancies/${encodeURIComponent(occupancyId)}/end`,
    {
      token,
      method: 'PATCH',
      body: JSON.stringify(toDate ? { ...rest, toDate } : rest),
    },
  );
  invalidateCensus(tenant);
  return result;
}

// ─────────────────────────────  «إنهاء الملكية»  ─────────────────────────────

/** A tenant whose card names this owner as the landlord of a flat. */
export interface OwnershipLinkedTenant {
  citizenId: string;
  name: string;
  propertyEntryId: string;
}

/**
 * What ending an ownership would touch — read before the dialog asks anything,
 * so it asks only what applies to these flats.
 */
export interface OwnershipPreview {
  owner: { id: string; name: string; nonResident: boolean };
  propertyType: string | null;
  propertyNumber: string | null;
  /** When the ownership was recorded — a sale cannot be dated before it. */
  startedAt: string | null;
  units: Array<{
    unitId: string;
    unitCode: string;
    buildingCode: string;
    /** Co-owners keep the flat, and its status. */
    otherOwners: string[];
    /** A buyer among these already owns the flat, and keeps that ownership as it is. */
    otherOwnerIds: string[];
    /** A buyer among these rents the flat: the sale ends that tenancy and records them living there. */
    occupantIds: string[];
    /** «يسكنها المالك» or «مسكن موسمي» — a status about this owner. */
    ownerLivedThere: boolean;
    /** On a sale, what the flat is now has to be said. */
    needsStatus: boolean;
    dwelling: boolean;
    linkedTenants: OwnershipLinkedTenant[];
  }>;
  /** Every current row on the card, in the form's order — what the dialog chooses from. */
  rows: Array<{
    rowId: string;
    unitId: string | null;
    unitCode: string | null;
    unitType: string | null;
    floor: string | null;
    unitArea: number | null;
    needsStatus: boolean;
    otherOwners: string[];
    linkedTenants: OwnershipLinkedTenant[];
  }>;
}

/** What ending an ownership changed. */
export interface EndOwnershipResult {
  reason: 'OWNERSHIP_TRANSFERRED' | 'RECORDED_IN_ERROR';
  endedAt: string;
  occupanciesEnded: number;
  rowsEnded: number;
  endedRowIds: string[];
  cardsEnded: number;
  statusApplied: AfterTenancyStatus | null;
  newOwnerRecorded: boolean;
  casesOpened: number;
  vacanciesConfirmed: number;
  tenantsReleased: Array<{
    tenantId: string;
    tenantName: string;
    propertyEntryId: string;
    mode: 'RELEASED' | 'SPLIT';
  }>;
  /**
   * The flats the buyer rented until the sale — their tenancy ended there, as
   * history. Absent from a server older than the one-step purchase: the
   * frontend and the API deploy separately.
   */
  buyerTenancyEndedOn?: string[];
  /** The flats whose ownership ended — for «سجِّل المالك الجديد الآن». */
  units: Array<{ unitId: string; unitCode: string; buildingId: string }>;
}

export type EndOwnershipAnswer = {
  reason: 'OWNERSHIP_TRANSFERRED' | 'RECORDED_IN_ERROR';
  endedAt?: string;
  rowIds?: string[];
  newOwnerId?: string;
} & AfterTenancyAnswer;

/** Whether a result is an ownership's — the matrix's end returns either kind. */
export function isOwnershipResult(result: EndTenancyResult | EndOwnershipResult): result is EndOwnershipResult {
  return 'tenantsReleased' in result;
}

export function getOwnershipEndPreview(tenant: string, token: string, propertyEntryId: string) {
  return apiFetch<OwnershipPreview>(
    tenant,
    `/citizens/ownerships/${encodeURIComponent(propertyEntryId)}/end-preview`,
    { token },
  );
}

export function getOccupancyOwnershipPreview(tenant: string, token: string, occupancyId: string) {
  return apiFetch<OwnershipPreview>(
    tenant,
    `/buildings/occupancies/${encodeURIComponent(occupancyId)}/ownership-preview`,
    { token },
  );
}

/** «إنهاء الملكية» on an owner's card — the same operation the unit matrix runs for an owner. */
export async function endOwnership(
  tenant: string,
  token: string,
  propertyEntryId: string,
  input: EndOwnershipAnswer,
) {
  const result = await apiFetch<EndOwnershipResult>(
    tenant,
    `/citizens/ownerships/${encodeURIComponent(propertyEntryId)}/end`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/** What ending a tenancy card would touch — for the dialog's questions. */
export interface TenancyPreview {
  tenant: { id: string; name: string };
  occupancyType: string;
  propertyType?: string;
  landlordName: string | null;
  startedAt: string | null;
  /** The card's flats linked to سجل المباني. */
  units: Array<{
    unitId: string;
    unitCode: string;
    /** Nobody else lives there, so what it is now has to be said. */
    needsStatus: boolean;
    othersRemain: boolean;
    ownerNames: string[];
    ownerNonResident: boolean;
    dwelling: boolean;
  }>;
  /**
   * Every current row on the card, in the form's order — linked flats and
   * lines never linked to one alike. What the dialog chooses from. Optional for
   * a server from before it.
   */
  rows?: TenancyPreviewRow[];
}

export interface TenancyPreviewRow {
  rowId: string;
  unitId: string | null;
  unitCode: string | null;
  unitType: string | null;
  floor: string | null;
  side: string | null;
  unitArea: number | null;
  needsStatus: boolean;
  othersRemain: boolean;
  ownerNames: string[];
  ownerNonResident: boolean;
  dwelling: boolean;
}

export function getTenancyEndPreview(tenant: string, token: string, propertyEntryId: string) {
  return apiFetch<TenancyPreview>(
    tenant,
    `/citizens/tenancies/${encodeURIComponent(propertyEntryId)}/end-preview`,
    { token },
  );
}

/** «إنهاء الإيجار» on a card — the same operation the unit matrix runs. */
export async function endTenancy(
  tenant: string,
  token: string,
  propertyEntryId: string,
  input: {
    reason: 'MOVED_OUT' | 'RECORDED_IN_ERROR';
    endedAt?: string;
    /** Exactly the rows left. Required by the server once a card has more than one. */
    rowIds?: string[];
    unitIds?: string[];
  } & AfterTenancyAnswer,
) {
  const result = await apiFetch<EndTenancyResult>(
    tenant,
    `/citizens/tenancies/${encodeURIComponent(propertyEntryId)}/end`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Appends one observation. There is no update and no delete: a building that
 * was unsafe in 2024 and repaired in 2026 is two facts, and the first is what a
 * compensation claim rests on (D3).
 */
export async function recordDamage(tenant: string, token: string, input: RecordDamageInput) {
  const result = await apiFetch<DamageAssessmentRow>(tenant, '/buildings/damage', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  invalidateCensus(tenant);
  return result;
}

/**
 * One logged attempt to survey a unit (P4-T1, D10).
 *
 * `outcome` is a `SurveyStatus` because every state a visit can produce is
 * already in that enum — never `NOT_SURVEYED`, which means nobody went.
 */
export interface UnitVisitRow {
  id: string;
  unitId: string;
  officerId: string | null;
  officerName: string | null;
  visitedAt: string;
  outcome: SurveyStatus;
  notes: string | null;
  createdAt: string;
}

export interface LogVisitInput {
  unitId: string;
  outcome: SurveyStatus;
  visitedAt?: string;
  notes?: string;
  /** This officer already logged this unit in the last twelve hours, and means to again. */
  acknowledgedRepeat?: boolean;
}

/** How recently an officer's own visit makes another one worth a question — the server's window. */
export const REPEAT_VISIT_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Logs one attempt and moves the unit to what it found — two facts, one action.
 *
 * `visitCount` comes back because it is the number the matrix shows: «٣
 * محاولات» is the difference between assigning a door and escalating it.
 */
export async function logUnitVisit(tenant: string, token: string, input: LogVisitInput) {
  const result = await apiFetch<{
    visit: UnitVisitRow;
    visitCount: number;
    /**
     * The unit's confirmed vacancy was left standing, so its حالة المسح did
     * *not* move to this visit's outcome. A locked door on a flat already
     * confirmed empty is not news; a visit that found somebody home means the
     * confirmation needs lifting, and only a person can decide that.
     */
    vacancyStands?: boolean;
  }>(tenant, '/buildings/visits', { token, method: 'POST', body: JSON.stringify(input) });
  invalidateCensus(tenant);
  return result;
}

/**
 * «معفاة من الرسوم» — grants (`reason` set), amends, or lifts (`reason` null,
 * with `liftReason`) a unit's exemption from every fee. SUPER_ADMIN only.
 * Answers the unit as the whitelist shows it (0104).
 */
export async function setUnitFeeExemption(
  tenant: string,
  token: string,
  unitId: string,
  input: SetUnitFeeExemptionInput,
  signal?: AbortSignal,
): Promise<FeeExemptionUnitView> {
  const result = await apiFetch<FeeExemptionUnitView>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}/fee-exemption`,
    { token, method: 'PUT', body: JSON.stringify(input), signal },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * «قائمة الإعفاء من الرسوم» — the exemption periods standing or lifted, searched
 * and paged on the server (`GET fee-exemptions`, `FEE_EXEMPTION_READ_ROLES`).
 */
export async function getFeeExemptions(
  tenant: string,
  token: string,
  query: Partial<FeeExemptionListQuery>,
  signal?: AbortSignal,
): Promise<FeeExemptionListResult> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.reason) params.set('reason', query.reason);
  if (query.status) params.set('status', query.status);
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  const search = params.toString();
  return apiFetch<FeeExemptionListResult>(tenant, `/fee-exemptions${search ? `?${search}` : ''}`, { token, signal });
}

/** One unit with its holders, its standing exemption and every period. */
export async function getFeeExemptionUnit(
  tenant: string,
  token: string,
  unitId: string,
  signal?: AbortSignal,
): Promise<FeeExemptionUnitView> {
  return apiFetch<FeeExemptionUnitView>(tenant, `/fee-exemptions/units/${encodeURIComponent(unitId)}`, { token, signal });
}

/** One unit by its full reference, «<building code>-<unit code>». */
export async function findFeeExemptionUnit(
  tenant: string,
  token: string,
  reference: string,
  signal?: AbortSignal,
): Promise<FeeExemptionUnitView> {
  return apiFetch<FeeExemptionUnitView>(
    tenant,
    `/fee-exemptions/units?reference=${encodeURIComponent(reference)}`,
    { token, signal },
  );
}

/** Every unit one person holds now, structural floors left out, each with its exemption. */
export async function getCitizenFeeExemptionUnits(
  tenant: string,
  token: string,
  citizenId: string,
  signal?: AbortSignal,
): Promise<FeeExemptionCitizenUnits> {
  return apiFetch<FeeExemptionCitizenUnits>(
    tenant,
    `/fee-exemptions/citizens/${encodeURIComponent(citizenId)}/units`,
    { token, signal },
  );
}

/**
 * «توزيع الرسم على المالكين» — saves how a co-owned flat is billed, and the
 * owners' أسهم with it. `mode: null` withdraws a choice (back to the equal split).
 */
export async function setOwnerBilling(
  tenant: string,
  token: string,
  unitId: string,
  input: SetOwnerBillingInput,
  signal?: AbortSignal,
): Promise<OwnerBillingState> {
  const result = await apiFetch<OwnerBillingState>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}/owner-billing`,
    { token, method: 'PUT', body: JSON.stringify(input), signal },
  );
  invalidateCensus(tenant);
  return result;
}

/**
 * Records that a unit was found empty, with what says so.
 *
 * Its own call rather than a `updateUnit({ unitStatus: 'VACANT', surveyStatus:
 * 'VACANT_CONFIRMED' })`, which is what this was and which the server now
 * refuses: a confirmed vacancy exempts the owner from the occupancy fee, so it
 * is recorded as a row carrying its basis, its date and whoever decided it —
 * and it can be lifted again at any time by `endVacancy`.
 *
 * Refused while a مستأجر or شاغل بتسامح is recorded in the unit, while the flat
 * is a مسكن موسمي, and while another confirmation is already standing. Each
 * refusal names its own remedy, so callers should surface it verbatim.
 */
export async function confirmVacancy(
  tenant: string,
  token: string,
  unitId: string,
  input: { basis: VacancyBasis; observedAt?: string; notes?: string },
) {
  const result = await apiFetch<{
    vacancy: UnitVacancyConfirmation;
    unit: UnitRow;
    /** «شاغرة قيد التحقق» cases this answered and closed. */
    casesResolved: number;
  }>(tenant, `/buildings/units/${encodeURIComponent(unitId)}/vacancy`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
  });
  invalidateCensus(tenant);
  return result;
}

/**
 * Lifts the vacancy standing on a unit — the undo, available at any time.
 *
 * `reason` decides what the flat goes back to: «سُجِّل بالخطأ» restores the
 * حالة the confirmation replaced, «لم تعد شاغرة» leaves it occupied by somebody
 * not yet recorded, which is what bills the owner again until they are.
 */
/**
 * «مراجعة حالة الوحدات» — SUPER_ADMIN. Applies the one status rule to every
 * flat whose records disagree, and opens a «تعارض في حالة الوحدة» case on each
 * one a person has to decide. Safe to run again.
 */
export async function settleAllUnitStatuses(tenant: string, token: string) {
  const result = await apiFetch<{
    unitsChecked: number;
    statusesChanged: number;
    casesOpened: number;
    casesResolved: number;
    stillUnderReview: number;
  }>(tenant, '/buildings/units/status-review', { token, method: 'POST' });
  invalidateCensus(tenant);
  return result;
}

export async function endVacancy(
  tenant: string,
  token: string,
  unitId: string,
  input: { reason: VacancyEndReason; endedAt?: string; notes?: string },
) {
  const result = await apiFetch<{ vacancy: UnitVacancyConfirmation; unit: UnitRow }>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}/vacancy/end`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/** Every attempt on one unit, newest first — the panel behind the count. */
export function getUnitVisits(tenant: string, token: string, unitId: string) {
  return apiFetch<{ visits: UnitVisitRow[] }>(
    tenant,
    `/buildings/units/${encodeURIComponent(unitId)}/visits`,
    { token },
  );
}

/**
 * One building pin as the map draws it — three visual channels in one row: icon
 * from `structureType`, fill from `surveyRollup`, ring from `worstDamageLevel`.
 * Only buildings that have been given a location appear.
 */
export interface BuildingMapPin {
  id: string;
  code: string;
  name: string | null;
  latitude: number;
  longitude: number;
  parcelNumber: string;
  structureType: StructureType;
  /** «نوع المبنى» (0106), for the map's type filter and legend. */
  buildingTypeId?: string | null;
  lifecycleStatus: BuildingLifecycle;
  unitsTotal: number;
  unitsSurveyed: number;
  /**
   * The **worst** survey status among the units, never the majority (D11).
   *
   * Null for a structure nobody can be inside. Its units really are
   * `NOT_SURVEYED`, and painting them in that colour would put "send an officer
   * here" on a building with no doors hung yet — so the server withholds the
   * channel and the map draws the lifecycle instead.
   */
  surveyRollup: SurveyStatus | null;
  worstDamageLevel: DamageLevel | null;
}

/** Building pins with their rollups, for the fullscreen map (P3-T5). */
export function getBuildingMapPins(tenant: string, token: string, signal?: AbortSignal) {
  return apiFetch<{ buildings: BuildingMapPin[] }>(tenant, '/dashboard/map/buildings', {
    token,
    signal,
  });
}

/**
 * Which sector owns which parcel, keyed by parcel number.
 *
 * Built from the sector list plus one read per sector, because membership is
 * `Zone.parcelNumbers` and there is no parcel→sector endpoint to ask (D13). The
 * building editor needs it to preview a code before the building exists: the
 * zone half of `ZONE-PARCEL-SUFFIX` is the only part of that code the client
 * cannot derive from what it already has.
 *
 * Cached for five minutes. Sector membership changes when an administrator
 * saves the zone editor, which is not something that happens between two
 * keystrokes in a parcel field.
 */
export function getZoneParcelIndex(tenant: string, token: string) {
  return cachedRequest(`zone-parcels:${tenant}`, 5 * 60 * 1000, async () => {
    const { zones } = await getZones(tenant, token);
    const details = await Promise.all(zones.map((zone) => getZone(tenant, token, zone.id)));

    const index: Record<string, { id: string; code: string; name: string; color: string }> = {};
    for (const zone of details) {
      for (const parcelNumber of zone.parcelNumbers) {
        // First sector wins, matching the server's own `findFirst`.
        index[parcelNumber] ??= {
          id: zone.id,
          code: zone.code,
          name: zone.name,
          color: zone.color,
        };
      }
    }
    return index;
  });
}

/** One unit inside a BUILDING — شقة, عيادة or محل. */
/**
 * One «تأكيد الشغور» still standing on a unit — that the municipality found
 * this flat empty, when, and on what basis.
 *
 * Shown because it is the reason an owner is not being billed for the unit,
 * and therefore the row a person disputing that — in either direction — is
 * entitled to read. Optional on the wire so a response cached from before
 * migration 0043 reads as "none".
 */
export interface CitizenProfileVacancy {
  id: string;
  /** Null only on a row 0043 backfilled — the question did not exist then. */
  basis: VacancyBasis | null;
  observedAt: string;
}

export interface CitizenProfileUnit {
  id: string;
  /** This flat left the tenancy (migration 0046) — history, billed for nothing. */
  endedAt?: string | null;
  endReason?: string | null;
  /** The canonical `Unit` this line was linked to, if any. */
  unitId?: string | null;
  unitCode?: string | null;
  unitPostedNumber?: string | null;
  /**
   * Nullable since migration 0031: a per-unit «غير مؤكَّد» flag blanks the
   * field it excuses, so a flat the officer could not fully describe arrives
   * with no type, no floor and no area. Every reader has to render that as an
   * absence — «الطابق » with nothing after it is what the previous types,
   * which promised a value here, produced on screen.
   */
  unitType: string | null;
  floor: string | null;
  side: string | null;
  /**
   * م², or null where nobody has measured the flat.
   *
   * Nullable since `BuildingUnit.unitArea` became nullable (migration 0031),
   * and typed `number` here long after it stopped being one — the server was
   * coercing with `Number()`, which turns `null` into `0`, so an unmeasured
   * flat arrived claiming a measurement of zero. The commonest way to get one
   * is `claimOnFile`: linking an existing owner to a flat from the unit matrix
   * mints a card line from the canonical unit, which for a matrix painted from
   * the street has no area either.
   */
  unitArea: number | null;
  sharedRights: string[];
  /** حالة الوحدة as the owner's card states it. Null means nobody was asked. */
  unitStatus: string | null;
  /**
   * حالة الوحدة as سجل المباني holds it — which billing reads *first*.
   *
   * Reported alongside the card's own so a disagreement between them can be
   * seen rather than silently resolved: «مشغولة من المالك» on a card over
   * «شاغرة» in the census is either a vacancy to lift or a card to correct.
   * Null when this line was never linked to a censused unit.
   */
  censusUnitStatus?: string | null;
  /**
   * «مسكن موسمي» facts — the months (1–12) the owners are usually present,
   * when they last stayed, and when a تصريح بالشغور was filed.
   *
   * The owner bears the occupancy fee on a seasonal home anyway
   * (`OWNER_BILLED_WHILE_ABSENT`); these are the facts the council weighs when
   * deciding to shorten it. Empty and null on every other unit.
   */
  presenceMonths?: number[];
  ownerLastStayAt?: string | null;
  vacancyDeclaredAt?: string | null;
  /** The «تأكيد الشغور» standing on the censused unit, if one is. */
  vacancy?: CitizenProfileVacancy | null;
  /**
   * Everyone سجل المباني records as a current owner of the linked flat, with
   * their أسهم. On a tenancy card: the flat's whole ownership beside the one
   * co-owner the card is linked to. `citizenId` and every number are absent on
   * the citizen's own portal view.
   */
  owners?: Array<{
    citizenId?: string;
    name: string;
    phone?: string | null;
    /** «لا يملك رقم هاتف». */
    hasNoPhone?: boolean;
    /** «رقم للتواصل» — a relative's number. */
    contactPhone?: string | null;
    shares: number | null;
  }>;
  /**
   * «معفاة من الرسوم» (0077): why the linked unit is charged nothing, or null —
   * as of today: an exemption past its last day reads as none (0104).
   */
  feeExemption?: FeeExemptionReason | null;
  /** Its last day, `YYYY-MM-DD`, or null for none (0104). Optional for a profile cached before it. */
  feeExemptionValidUntil?: string | null;
  /**
   * «توزيع الرسم على المالكين» (0075) when the linked flat has several current
   * owners; null otherwise. `share` is this file's owner's part — under «مالك
   * مسؤول», 1/1 for the owner who pays for all and 0/1 for the others. On the
   * citizen's own portal view `responsibleOwnerId` and `fallback` are absent.
   * Worded by `ownerBillingWording` (`lib/owner-billing.ts`).
   */
  ownerBilling?: {
    mode: OwnerBillingMode | null;
    effectiveMode: OwnerBillingMode;
    responsibleOwnerId?: string | null;
    fallback?: OwnerBillingFallback | null;
    share: { numerator: number; denominator: number } | null;
  } | null;
}

export interface CitizenProfileProperty {
  id: string;
  /**
   * When this tenancy ended, and why (migration 0046). An ended card is kept on
   * the file as history, with its lease, and bills nothing. Optional on the wire
   * for a profile cached before it existed.
   */
  endedAt?: string | null;
  endReason?: string | null;
  /** Null when the officer recorded it as «غير مؤكَّد» — see the registration's flags. */
  neighborhood: string | null;
  propertyNumber: string | null;
  propertyType: string;
  occupancyType: string;
  /**
   * Non-owner occupancies. The phone is required of a tenant only.
   *
   * The confirmed owner's registered name while a link stands — resolved on the
   * server so every screen printing it shows the same person — and what the
   * tenant said otherwise. `landlordNameAsTyped` is always the tenant's words.
   */
  landlordName: string | null;
  landlordNameAsTyped?: string | null;
  landlordPhone: string | null;
  /**
   * The registered citizen this card's owner was confirmed to be, if anyone.
   *
   * Read back so an edit opens with the standing link showing — otherwise the
   * form asks «هل هو المالك؟» about a question somebody already answered, over
   * a name field it has left unlocked and editable.
   */
  landlordCitizenId?: string | null;
  landlordReferenceNumber?: string | null;
  /** HOUSE only, owner only. A BUILDING keeps this per unit. */
  unitStatus: string | null;
  buildingName: string | null;
  /** HOUSE/LAND carry these directly; a BUILDING keeps them per unit. */
  unitType: string | null;
  landType: string | null;
  floor: string | null;
  side: string | null;
  tentLocation: string | null;
  unitArea: number | null;
  /** LAND only — أسهم out of the cadastre's standard 2400-share parcel. */
  shares: number | null;
  sharedRights: string[];
  latitude: number | null;
  longitude: number | null;
  /**
   * The censused structure behind this card, when one was linked.
   *
   * Two codes, and they are not interchangeable (D14): `buildingCode` is the
   * municipality's own `ZONE-PARCEL-SUFFIX`; `buildingPostedNumber` is what is
   * painted on the building. A notice prints both, because where they disagree
   * the collector in the street trusts the paint.
   */
  buildingId: string | null;
  buildingCode: string | null;
  buildingPostedNumber: string | null;
  /**
   * حالة المبنى, and the value this is here for is `WAR_DAMAGED_UNINHABITED`:
   * a structure still standing, war-damaged and established as empty. Its units
   * are recorded like any building's, so without this nothing on the card tells
   * a flat in it from a flat somebody lives in. Optional on the wire; null on a
   * card never linked to a censused building.
   */
  buildingLifecycleStatus?: string | null;
  unitCount: number;
  units: CitizenProfileUnit[];
  /**
   * The census flats a card with no unit lines is billed through — a منزل's
   * one flat, or the flats a مبنى card's holder is recorded on — with what
   * changes their bill. Optional on the wire for a profile cached before it.
   */
  heldUnits?: Array<
    { unitId: string; unitCode: string } & Pick<CitizenProfileUnit, 'feeExemption' | 'feeExemptionValidUntil' | 'ownerBilling'>
  >;
}

export interface CitizenProfileDocument {
  id: string;
  type: string;
  mimeType: string;
  sizeBytes: number;
  propertyEntryId: string | null;
  createdAt: string;
}

export interface CitizenProfileRegistration {
  id: string;
  referenceNumber: string;
  submittedAt: string;
  /** `REQUIRES_REVIEW` when `flags` is non-empty; `PENDING` otherwise. */
  status: string;
  /**
   * Fields the officer could not establish, with the reason given for each.
   *
   * Shown on the profile, not only on the edit form: this is the page a
   * collector opens before setting out, and "no phone number, and here is
   * why" is something to know before knocking rather than to discover by
   * opening the record for editing.
   */
  flags: FieldFlag[];
  /**
   * «ملاحظات» — free text from the visit, or null.
   *
   * Beside the flags rather than among them, because it is a different kind of
   * statement. A flag says a required value is missing and why; a note says
   * something no field asked about, flags nothing, and changes no status.
   */
  notes: string | null;
  properties: CitizenProfileProperty[];
  documents: CitizenProfileDocument[];
}

/** One invoice on the citizen's profile. */
export interface CitizenProfilePayment {
  id: string;
  title: string;
  amount: number;
  /** Received so far — below `amount` on a part-settled invoice. */
  paidAmount: number;
  /** `amount - paidAmount`, floored at zero: what is still owed. */
  remaining: number;
  currency: string;
  dueDate: string;
  /** `OVERDUE` is derived server-side from the due date, never stored. */
  paymentStatus: string;
  paymentMethod: string | null;
  /**
   * «INV-2610-0001» — the number on the bill itself (migration 0079).
   *
   * Null on every bill raised before that migration, which is why the receipt
   * falls back to a reference derived from the id: those documents were issued
   * without a number and inventing one now would be a lie on a printed page.
   */
  invoiceNumber: string | null;
  whishTransactionRef: string | null;
  paidAt: string | null;
  reviewNote: string | null;
  /** Why the manager cancelled the bill (0091); null unless `paymentStatus` is CANCELLED. */
  cancellationReason?: string | null;
  /** «شطب» (0107): when, how much, why and on which decision; null unless WRITTEN_OFF. Optional for an older API. */
  writeOff?: BillWriteOffView | null;
  /**
   * «متأخرات سنوات سابقة»: the year, the fee and the رقم العقار of an «ARR-» bill, with the old books'
   * reference on a staff read (the portal's is null); null on any other bill. Optional for an older API.
   */
  arrears?: BillArrearsView | null;
  /**
   * The municipal request whose fee this bill is (0092), or null. Cancelling the
   * bill cancels the request while it is still open (AWAITING_PAYMENT or
   * IN_REVIEW). Optional: a profile cached before the field existed has none.
   */
  request?: { id: string; requestNumber: string; requestType: RequestType; status: RequestStatus } | null;
  frequency: string | null;
  /**
   * How this amount was arrived at, when it was not simply the notice's own.
   *
   * The answer to «ليش عليّ هالمبلغ؟» — null on a flat charge, which explains
   * itself, and on every invoice raised before per-unit billing existed.
   */
  assessment?: FeeAssessment | null;
  /**
   * On a shared unit bill (0099) this citizen owes with others: the unit and
   * how many may pay it, never who. Null or absent on their own bill.
   */
  sharedUnit?: SharedUnitBillView | null;
}

/**
 * Where a citizen stands with the municipality's fees.
 *
 * `overdueTotal` is the unpaid amount past its due date. The system levies no
 * penalty on top, so a late fee *is* the unpaid fee — it is reported as its own
 * total because "owes 400,000" and "owes 400,000, all of it late" are different
 * conversations at the counter.
 */
export interface CitizenFeeTotals {
  feesTotal: number;
  paidTotal: number;
  outstandingTotal: number;
  overdueTotal: number;
  overdueCount: number;
  pendingReviewCount: number;
}

export interface CitizenProfile {
  id: string;
  fullName: string;
  /**
   * اسم الأم وشهرتها.
   *
   * Optional on the wire and null on households filed before migration 0044 —
   * both mean «لم يُسأل», which every reader must render as such rather than as
   * a difference between two people.
   */
  motherName?: string | null;
  phone: string | null;
  whatsapp: string | null;
  /** «لا يملك رقم هاتف» — a finished answer, not a gap. Absent from an older backend. */
  hasNoPhone?: boolean;
  /** «رقم للتواصل» — a relative's number, never the citizen's own. */
  contactPhone?: string | null;
  gender: string | null;
  nationality: string | null;
  isLebanese: boolean | null;
  residencyNumber: string | null;
  residentStatus: string | null;
  identityDocType: string | null;
  identityDocNumber: string | null;
  civilRecordNumber: string | null;
  totalRegisteredMembers: number | null;
  actualHouseholdMembers: number | null;
  maritalStatus: string | null;
  bloodType: string | null;
  referenceNumber: string | null;
  /** نوع الملف. Optional on the wire for cached responses from before 0040. */
  residence?: CitizenResidence;
  residencePlace?: string | null;
  localContactName?: string | null;
  localContactPhone?: string | null;
  registeredAt: string;
  /** False for a deactivated record — kept for its history, refused a session. */
  isActive: boolean;
  registrations: CitizenProfileRegistration[];
  /**
   * Tenancy cards other households filed that were confirmed as naming this
   * citizen as their landlord — the owner's side of every link. Optional on the
   * wire for a profile cached before it existed.
   */
  landlordOf?: CitizenProfileLandlordOf[];
  payments: CitizenProfilePayment[];
  fees: CitizenFeeTotals;
}

/** One card naming this citizen as its confirmed landlord. */
export interface CitizenProfileLandlordOf {
  propertyEntryId: string;
  occupancyType: string;
  tenant: { id: string; name: string; referenceNumber: string | null };
  buildingName: string | null;
  buildingCode: string | null;
  propertyNumber: string | null;
  unitCodes: string[];
  linkedAt: string | null;
  /** Set when the tenancy ended — the link is then the record of who the landlord was. */
  endedAt?: string | null;
}

/**
 * One citizen and everything they have filed. Staff-only: the response
 * carries identity-document numbers and residency status.
 */
export function getCitizenProfile(tenant: string, token: string, citizenId: string) {
  return apiFetch<CitizenProfile>(tenant, `/citizens/${encodeURIComponent(citizenId)}`, { token });
}

/**
 * The signed-in citizen's own record: what they own and what they owe.
 *
 * Replaces `listMyRegistrations`, which reported the review status of each
 * طلب. Properties arrive flattened across filings — a citizen has no reason to
 * care that their four properties were entered in two sittings, which was an
 * artefact of the submission workflow rather than anything about the property.
 */
export interface MyCitizenSummary {
  fullName: string;
  referenceNumber: string | null;
  registeredAt: string;
  isActive: boolean;

  phone: string | null;
  whatsapp: string | null;
  gender: string | null;
  nationality: string | null;
  isLebanese: boolean | null;
  residentStatus: string | null;
  maritalStatus: string | null;
  bloodType: string | null;
  totalRegisteredMembers: number | null;
  actualHouseholdMembers: number | null;
  identityDocType: string | null;
  /**
   * Tail only — `•••567`. The full number is never sent to this route; see the
   * note on `CitizenController.mySummary` for why.
   */
  identityDocNumberMasked: string | null;
  civilRecordNumberMasked: string | null;

  /**
   * اسم الأم وشهرتها — theirs to check, since it is now the register's only
   * identifying answer for a Lebanese household. Null means «لم يُسأل».
   */
  motherName?: string | null;
  /** نوع الملف, and what a «غير مقيم في البلدة» record holds instead of a household. */
  residence?: CitizenResidence;
  residencePlace?: string | null;
  localContactName?: string | null;
  localContactPhone?: string | null;
  /**
   * Field paths the register could not establish — «رقم الهاتف»,
   * «properties.0.propertyNumber». Paths only: the officer's reason for each
   * stays staff-side. Absent on a response from before this was sent.
   */
  unestablishedFields?: string[];

  properties: CitizenProfileProperty[];
  payments: CitizenProfilePayment[];
  fees: CitizenFeeTotals;
}

export function getMySummary(tenant: string, token: string) {
  return apiFetch<MyCitizenSummary>(tenant, '/citizens/me/summary', { token });
}

// ── «حذف تصحيحي» (SUPER_ADMIN) ──────────────────────────────────────────────

import type {
  DuplexMergeInput,
  DuplexMergePreview,
  DuplexMergeResult,
  UnitCorrectionDeleteInput,
  UnitCorrectionPreview,
  UnitCorrectionResult,
} from '@mechanization/shared-schemas';

export type {
  DuplexMergeBlocker,
  DuplexMergeInput,
  DuplexMergePreview,
  DuplexMergeResult,
  ParcelDues,
  ParcelDuesBill,
  UnitCorrectionBlocker,
  UnitCorrectionDeleteInput,
  UnitCorrectionPreview,
  UnitCorrectionResult,
} from '@mechanization/shared-schemas';

/** What deleting this unit would remove, close and change. Its `fingerprint` is what the delete must quote. */
export function getUnitCorrectionPreview(tenant: string, token: string, unitId: string, signal?: AbortSignal) {
  return apiFetch<UnitCorrectionPreview>(
    tenant,
    `/corrections/units/${encodeURIComponent(unitId)}`,
    { token, signal },
  );
}

/**
 * Deletes the unit exactly as previewed, or changes nothing. Refused with
 * `details.reason` — see `unitCorrectionRefusal` — when the preview is stale,
 * a blocker appeared, or somebody else is writing the same records.
 */
export async function applyUnitCorrection(
  tenant: string,
  token: string,
  unitId: string,
  input: UnitCorrectionDeleteInput,
) {
  const result = await apiFetch<UnitCorrectionResult>(
    tenant,
    `/corrections/units/${encodeURIComponent(unitId)}`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/** «دمج كدوبلكس» (D28): what folding the flat above `lowerUnitId` into it would do. SUPER_ADMIN only. */
export function getDuplexMergePreview(tenant: string, token: string, lowerUnitId: string, signal?: AbortSignal) {
  return apiFetch<DuplexMergePreview>(
    tenant,
    `/corrections/units/${encodeURIComponent(lowerUnitId)}/merge-upper`,
    { token, signal },
  );
}

/** Folds the flat above into this one exactly as previewed, or changes nothing (refusals as `unitCorrectionRefusal`). */
export async function applyDuplexMerge(tenant: string, token: string, lowerUnitId: string, input: DuplexMergeInput) {
  const result = await apiFetch<DuplexMergeResult>(
    tenant,
    `/corrections/units/${encodeURIComponent(lowerUnitId)}/merge-upper`,
    { token, method: 'POST', body: JSON.stringify(input) },
  );
  invalidateCensus(tenant);
  return result;
}

/** Why a correction delete was refused, when the server said in a way the dialog can act on. */
export function unitCorrectionRefusal(
  caught: unknown,
): 'PREVIEW_STALE' | 'BLOCKED' | 'BUSY' | 'UNVERIFIED' | 'CONFIRM_CODE' | null {
  if (!(caught instanceof ApiRequestError)) return null;
  const details = caught.payload.details as { reason?: unknown; confirmCode?: unknown } | undefined;
  if (caught.kind === 'VALIDATION_FAILED' && details && 'confirmCode' in details) return 'CONFIRM_CODE';
  const reason = details?.reason;
  return reason === 'PREVIEW_STALE' || reason === 'BLOCKED' || reason === 'BUSY' || reason === 'UNVERIFIED'
    ? reason
    : null;
}

// ─────────────────────────────  «أنواع المباني» (0106)  ─────────────────────────────

/**
 * The municipality's building types, system types first (`GET building-types`,
 * every staff role). `includeInactive` for the screen that edits the list.
 * Read through `useBuildingTypes`, which keeps it for offline use.
 */
export async function getBuildingTypes(
  tenant: string,
  token: string,
  options: { includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<BuildingTypeView[]> {
  return apiFetch<BuildingTypeView[]>(
    tenant,
    `/building-types${options.includeInactive ? '?includeInactive=true' : ''}`,
    { token, signal },
  );
}

/** Adds a custom type. The manager's (`BUILDING_TYPE_ADMIN_ROLES`). */
export async function createBuildingType(
  tenant: string,
  token: string,
  input: CreateBuildingTypeInput,
  signal?: AbortSignal,
): Promise<BuildingTypeView> {
  return apiFetch<BuildingTypeView>(tenant, '/building-types', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

/** Renames, reorders, switches off or on, or moves a type unused by any building. The manager's. */
export async function updateBuildingType(
  tenant: string,
  token: string,
  id: string,
  input: UpdateBuildingTypeInput,
  signal?: AbortSignal,
): Promise<BuildingTypeView> {
  return apiFetch<BuildingTypeView>(tenant, `/building-types/${encodeURIComponent(id)}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify(input),
    signal,
  });
}

/**
 * The municipality's unit types, system types first (`GET unit-types`, 0109).
 * Every staff role reads it: the matrix and the building editor offer it, and
 * an inspector keeps it for offline use. Read through `useUnitTypes`.
 */
export async function getUnitTypes(
  tenant: string,
  token: string,
  options: { includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<UnitTypeView[]> {
  return apiFetch<UnitTypeView[]>(tenant, `/unit-types${options.includeInactive ? '?includeInactive=true' : ''}`, {
    token,
    signal,
  });
}

/** Adds a custom unit type. The manager's (`UNIT_TYPE_ADMIN_ROLES`). */
export async function createUnitType(
  tenant: string,
  token: string,
  input: CreateUnitTypeInput,
  signal?: AbortSignal,
): Promise<UnitTypeView> {
  return apiFetch<UnitTypeView>(tenant, '/unit-types', {
    token,
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

/** Renames, reorders, switches off or on, or moves a type unused by any unit. The manager's. */
export async function updateUnitType(
  tenant: string,
  token: string,
  id: string,
  input: UpdateUnitTypeInput,
  signal?: AbortSignal,
): Promise<UnitTypeView> {
  return apiFetch<UnitTypeView>(tenant, `/unit-types/${encodeURIComponent(id)}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify(input),
    signal,
  });
}


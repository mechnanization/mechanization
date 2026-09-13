/**
 * The shapes the census speaks in — structures, the units inside them, who
 * occupies them, and what condition they are in.
 *
 * A types module rather than a repository port, and rather than interfaces
 * declared inside `buildings.service.ts`, for two reasons that are both about
 * where the code has to be able to reach:
 *
 *  - `BuildingsService` needs transactional control the port style cannot
 *    express without leaking it — the suffix allocation in §4.4 takes a lock
 *    and reads-then-writes inside one transaction. It therefore uses
 *    `TenantContextService` directly, exactly as `FeesService` and
 *    `ReportingService` already do for the same reason.
 *  - `DamageService` and the controller need these shapes too, and a service
 *    importing from another service is how an import cycle starts.
 */

export interface BuildingRow {
  id: string;
  parcelNumber: string;
  codeSuffix: string;
  code: string;
  name: string | null;
  postedNumber: string | null;
  structureType: string;
  /**
   * Where the structure is in its own life — permitted, going up, standing,
   * abandoned, gone. Distinct from `structureType` (what it is) and from its
   * damage level (what happened to it). See `BUILDING_LIFECYCLE`.
   */
  lifecycleStatus: string;
  latitude: number | null;
  longitude: number | null;
  floorsCount: number;
  /** How far the structure goes down, as a depth: 2 means B1 and B2. */
  basementsCount: number;
  /** Maintained by the trigger in migration 0030 — never written from here. */
  unitsTotal: number;
  unitsSurveyed: number;
  notes: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UnitRow {
  id: string;
  buildingId: string;
  floor: number;
  sequence: number;
  startCol: number | null;
  endCol: number | null;
  unitCode: string;
  postedNumber: string | null;
  unitType: string;
  side: string | null;
  unitArea: number | null;
  unitStatus: string | null;
  surveyStatus: string;
  /** «مسكن موسمي» — months (1–12) its owners are usually present. Empty otherwise. */
  presenceMonths: number[];
  /** When the owners last stayed. */
  ownerLastStayAt: Date | null;
  /** When a تصريح بالشغور was filed for the months they are away. */
  vacancyDeclaredAt: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OccupancyRow {
  id: string;
  unitId: string;
  citizenId: string;
  citizenName: string | null;
  role: string;
  shares: number | null;
  fromDate: Date;
  toDate: Date | null;
  /**
   * Why the spell ended, when an officer said so — see `OCCUPANCY_END_REASON`.
   * Null on a current spell and on every spell ended before the question was
   * asked.
   */
  endReason: string | null;
  registrationId: string | null;
  /**
   * Whether the citizen's own file claims this flat — i.e. whether the other
   * half of the record agrees with this one.
   *
   * The matrix and the register hold the same fact twice: this row says the
   * census found them here, and a `PropertyEntry`/`BuildingUnit` link says
   * their file declares it. A registration writes both. «تسجيل شاغل» writes
   * only this one, deliberately — an officer standing in a stairwell can
   * record who answered the door without having their full file to hand — and
   * that is a legitimate half-finished state, not an error.
   *
   * What was not legitimate was that nothing said so. An occupancy with no
   * card behind it looked exactly like one with, so the flat read as fully
   * registered while billing — which reads the card — had nothing to charge
   * and the citizen's own file named a different property entirely.
   *
   * Populated only by `get`, where the building is already loaded and the
   * question can be answered for every unit in two queries. Left `true` on the
   * write paths, which return the row they just wrote rather than a survey of
   * the register.
   */
  backedByFile: boolean;
}

/**
 * What recording an occupant did to the citizen’s own file.
 *
 * Reported rather than assumed, because every outcome below is a different
 * thing for the officer to be told and two of them are not failures. An
 * occupancy is now backed by default — that is the point of `claimOnFile` — but
 * "by default" is not "always", and the officer who tapped the button is the
 * only person in a position to do anything about the cases where it is not.
 *
 *   • `ENTRY_CREATED` — a property card was minted on their file.
 *   • `UNIT_ADDED` — their existing card gained this flat.
 *   • `ALREADY_CLAIMED` — their file already claimed it; nothing was written.
 *   • `NO_FILE` — the citizen has no registration to attach a card to. The one
 *     state «غير مرتبط بملفه» is now meant to describe.
 *   • `UNLINKABLE_STRUCTURE` — a خيمة, which no property card can point at.
 *   • `NO_BUILDING` — the unit’s building vanished between the two reads.
 */
export interface FileLinkResult {
  /** Whether billing would now read this flat off the citizen’s file. */
  backed: boolean;
  outcome:
    | 'ENTRY_CREATED'
    | 'UNIT_ADDED'
    | 'ALREADY_CLAIMED'
    | 'NO_FILE'
    | 'UNLINKABLE_STRUCTURE'
    | 'NO_BUILDING';
}

/** One logged attempt to survey a unit — P4-T1, D10. */
export interface VisitRow {
  id: string;
  unitId: string;
  officerId: string | null;
  officerName: string | null;
  visitedAt: Date;
  /** A `SurveyStatus`, never `NOT_SURVEYED` — see the model comment. */
  outcome: string;
  notes: string | null;
  createdAt: Date;
}

/**
 * One «تأكيد الشغور» — see the `UnitVacancyConfirmation` model.
 *
 * `endedAt` null is the one standing on the unit now. The snapshot pair is
 * carried to the client so the undo can say what the flat will go back to
 * *before* it is pressed, rather than reporting it afterwards.
 */
export interface VacancyRow {
  id: string;
  unitId: string;
  /** A `VacancyBasis`, or null on a row backfilled by migration 0041. */
  basis: string | null;
  observedAt: Date;
  notes: string | null;
  confirmedById: string | null;
  confirmedByName: string | null;
  previousUnitStatus: string | null;
  previousSurveyStatus: string | null;
  endedAt: Date | null;
  /** A `VacancyEndReason`, set with `endedAt` and never without it. */
  endReason: string | null;
  endNotes: string | null;
  endedById: string | null;
  endedByName: string | null;
  createdAt: Date;
}

export interface DamageRow {
  id: string;
  buildingId: string | null;
  unitId: string | null;
  level: string;
  source: string;
  observations: string | null;
  assessedAt: Date;
  assessedById: string | null;
  assessedByName: string | null;
  createdAt: Date;
}

export interface BuildingListFilter {
  parcelNumber?: string;
  parcelNumbers?: readonly string[];
  /**
   * A sector, resolved to its parcels at query time.
   *
   * There is no `zoneId` on a building to filter on (D13) — membership lives in
   * `Zone.parcelNumbers` and nowhere else — so this is expanded into a parcel
   * list before it reaches the database.
   */
  zoneId?: string;
  structureType?: string;
  /** Permitted / going up / standing / abandoned / gone. See `BUILDING_LIFECYCLE`. */
  lifecycleStatus?: string;
  surveyStatus?: string;
  /** False selects the structures with no entrance recorded — see the schema. */
  hasEntrance?: boolean;
  damageLevel?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * A census ledger row: the stored building plus the two things the ledger shows
 * that are not columns on it.
 *
 * Both are derived rather than stored, and for the same reason in each case —
 * the zone because membership is `Zone.parcelNumbers` (D13), the damage level
 * because it is the newest row in an append-only log (D3). Resolving them once
 * per page here is what keeps the ledger from asking per row.
 */
export interface BuildingLedgerRow extends BuildingRow {
  zoneCode: string | null;
  zoneName: string | null;
  /** The current level — the latest assessment — or null if never assessed. */
  damageLevel: string | null;
}

/**
 * The census totals for whatever the filters currently select.
 *
 * Computed over the whole filtered set rather than the page, because a KPI tile
 * that silently described the first hundred rows would read as an answer about
 * the municipality and be one about the pagination.
 */
export interface CensusSummary {
  /** Every building the filters select, whatever its lifecycle state. */
  buildings: number;
  /**
   * Units in structures that can hold households — see `OCCUPIABLE_LIFECYCLE`.
   *
   * Not every unit in `buildings` above. A shell under construction has rows in
   * the matrix and no doors to knock on, and counting them would hold the
   * coverage percentage below 100 for as long as the scaffolding is up.
   */
  unitsTotal: number;
  unitsSurveyed: number;
  /** `unitsTotal - unitsSurveyed` — the work still outstanding. */
  unitsUnsurveyed: number;
  /**
   * Units the lifecycle exclusion removed from the three figures above.
   *
   * Reported rather than dropped: a coverage percentage that improved because
   * a building was marked demolished needs to be explainable on the screen
   * showing it, not only in the audit log.
   */
  unitsOutOfScope: number;
  /** Buildings whose *current* level is restricted-use, unsafe, or collapsed. */
  damaged: number;
  /**
   * Buildings with no entrance pin, counted over the whole filtered predicate.
   *
   * Work, not an error. A structure created from a desk or from a registration
   * form has no pin by design (D19), so this is the queue of doors somebody
   * still has to stand at — and a tile is what stops it being a gap nobody can
   * see.
   */
  withoutEntrance: number;
}

export interface CreateBuildingRow {
  parcelNumber: string;
  codeSuffix: string;
  code: string;
  name: string | null;
  postedNumber: string | null;
  structureType: string;
  latitude: number | null;
  longitude: number | null;
  floorsCount: number;
  notes: string | null;
  createdById: string | null;
}

export interface CreateUnitRow {
  buildingId: string;
  floor: number;
  sequence: number;
  unitCode: string;
  unitType: string;
  postedNumber?: string | null;
  side?: string | null;
  unitArea?: number | null;
  unitStatus?: string | null;
  surveyStatus?: string;
  notes?: string | null;
}

/** One building pin as the map draws it — see the rollup rules in D11. */
export interface BuildingMapPin {
  id: string;
  code: string;
  name: string | null;
  latitude: number;
  longitude: number;
  parcelNumber: string;
  structureType: string;
  /** Permitted / going up / standing / abandoned / gone — the map's fourth channel. */
  lifecycleStatus: string;
  unitsTotal: number;
  unitsSurveyed: number;
  /**
   * The **worst** survey status among the units, never the majority (D11).
   *
   * Null for a structure that cannot hold households: a shell under
   * construction is honestly `NOT_SURVEYED` and must not be painted in the one
   * colour that means "send an officer here".
   */
  surveyRollup: string | null;
  /** The worst *current* damage level across the building and its units. */
  worstDamageLevel: string | null;
}

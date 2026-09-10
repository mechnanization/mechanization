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
  unitCode: string;
  postedNumber: string | null;
  unitType: string;
  side: string | null;
  unitArea: number | null;
  unitStatus: string | null;
  surveyStatus: string;
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
  registrationId: string | null;
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

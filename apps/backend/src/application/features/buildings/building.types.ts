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
  structureType?: string;
  surveyStatus?: string;
  damageLevel?: string;
  search?: string;
  limit?: number;
  offset?: number;
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
  unitsTotal: number;
  unitsSurveyed: number;
  /** The **worst** survey status among the units, never the majority (D11). */
  surveyRollup: string;
  /** The worst *current* damage level across the building and its units. */
  worstDamageLevel: string | null;
}

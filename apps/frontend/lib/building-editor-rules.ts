import type { BuildingLifecycle } from '@mechanization/shared-schemas';
import type { DuplicateBuildingCandidate, UnitWithOccupants } from '@/lib/api-client';
import type { GridUnitDraft } from '@/lib/building-draft';
import { emptyTopFloors } from '@/lib/floor-count';
import { haversineDistance } from '@/lib/map-geometry';

/*
  The building editor's rules that need no component (GOD-21, phase 1, 2026-11-24).

  Each is the body of a `useMemo` or a constant expression that sat inside the
  3,240-line `BuildingEditor`, moved here with its text unchanged and given a
  name, so it can be tested without rendering the wizard. The component still
  decides when one runs.
*/

/** The same four-character floor every other reason in the app has. */
export const MIN_DUPLICATE_REASON = 4;

/** The partition numbers as they will be sent: trimmed, blanks and repeats dropped, and none unless the box is ticked. */
export function cleanPartitionNumbers(partitionNumbers: readonly string[], isPartitioned: boolean): string[] {
  if (!isPartitioned) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of partitionNumbers) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** The other parcels a structure covers: trimmed, blanks and repeats dropped, and never the parcel it is filed under. */
export function cleanSharedParcels(sharedParcels: readonly string[], trimmedParcel: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of sharedParcels) {
    const value = raw.trim();
    if (!value || value === trimmedParcel || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * The highest floor the floor count allows (floor 0 is the ground, so «3» is 0, 1, 2).
 * Unreadable or empty counts as one floor.
 */
export function topFloorFor(floorsCount: string): number {
  return Math.max(0, (Number(floorsCount) || 1) - 1);
}

/** The lowest floor the basement count allows, as a negative number. */
export function bottomFloorFor(basementsCount: string): number {
  return -Math.max(0, Number(basementsCount) || 0);
}

/**
 * Top rows with nothing in them — the roof counted as a floor. Not asked for a
 * building that is only permitted or still being built, which has no floors to
 * fill yet.
 */
export function topGapOf(
  gridUnits: readonly GridUnitDraft[],
  hiddenUnits: readonly UnitWithOccupants[],
  floorsCount: string,
  lifecycleStatus: BuildingLifecycle,
) {
  return lifecycleStatus === 'PERMITTED' || lifecycleStatus === 'UNDER_CONSTRUCTION'
    ? null
    : emptyTopFloors([...gridUnits, ...hiddenUnits], Number(floorsCount) || 1);
}

/**
 * Confirmed grid units left stranded if the officer narrows the building past
 * where they were painted — above the top floor or below the deepest basement.
 * Never silently dropped.
 */
export function orphanedUnitsOf(
  gridUnits: readonly GridUnitDraft[],
  topFloor: number,
  bottomFloor: number,
): GridUnitDraft[] {
  return gridUnits.filter((unit) => unit.floor > topFloor || unit.floor < bottomFloor);
}

/**
 * A new building either has its entrance pinned, or says why not (at least
 * `MIN_DUPLICATE_REASON` characters). A correction is not held to this: the building
 * is already on file, pinned or not.
 */
export function pinIsAnswered(editing: boolean, pin: readonly [number, number] | null, noPinReason: string | null): boolean {
  return editing || Boolean(pin) || (noPinReason !== null && noPinReason.trim().length >= MIN_DUPLICATE_REASON);
}

/**
 * The structures already on the parcel, nearest first.
 *
 * Measured from the officer's own pin when there is one and the row has a
 * position, else the distance the server worked out. A row that cannot be
 * measured goes after every row that can, and ties keep the server's order.
 */
export function rankDuplicates(
  duplicates: readonly DuplicateBuildingCandidate[] | null,
  pin: readonly [number, number] | null,
) {
  if (!duplicates?.length) return [];
  const measured = duplicates.map((row, index) => {
    const distance =
      pin && row.latitude != null && row.longitude != null
        ? Math.round(haversineDistance(pin as [number, number], [row.longitude, row.latitude]))
        : row.distanceMetres;
    return { row, distance, index };
  });
  return measured.sort((a, b) => {
    if (a.distance != null && b.distance != null) return a.distance - b.distance || a.index - b.index;
    if (a.distance != null) return -1;
    if (b.distance != null) return 1;
    return a.index - b.index;
  });
}

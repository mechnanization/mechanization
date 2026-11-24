import type { UnitType } from '@mechanization/shared-schemas';
import type { UnitWithOccupants } from '@/lib/api-client';
import { effectiveUnitStatus } from '../building-unit-forms';
import { DEFAULT_GRID_SIZE, MAX_HORIZONTAL_BLOCKS, type GridUnitDraft } from '../unit-grid-picker';

/** What the grid holds about a unit that already exists, as it was loaded —
 *  the baseline a save diffs against so an untouched cell writes nothing. */
export interface UnitBaseline {
  unitCode: string;
  floor: number;
  startCol: number;
  endCol: number;
  unitType: UnitType;
  /** «نوع الوحدة» (0109), as loaded: a change of type alone is a change even when the base stays. */
  unitTypeId?: string | null;
}

/**
 * Why the census will refuse to delete this unit, in the officer's words.
 *
 * The same two facts `deleteUnit` guards on that the matrix carries: an
 * occupancy current *or* ended (D2 keeps the history precisely so the
 * municipality outlives the card) and a logged visit. The server also refuses
 * on a damage assessment or a citizen's card, which this payload cannot see —
 * so this hides the button where it is certainly futile, and the server's own
 * refusal is surfaced verbatim for the rest.
 */
export function undeletableReason(unit: UnitWithOccupants, en: boolean): string | undefined {
  if (unit.occupants.length > 0) {
    return en
      ? `Unit ${unit.unitCode} has occupancy on record and cannot be removed. Correct it from the unit matrix instead.`
      : `الوحدة ${unit.unitCode} مسجَّل عليها إشغال ولا يمكن حذفها. صحّحها من مصفوفة الوحدات.`;
  }
  if (unit.visitCount > 0) {
    return en
      ? `Unit ${unit.unitCode} has field visits on record and cannot be removed.`
      : `الوحدة ${unit.unitCode} مسجَّلة عليها زيارات ميدانية ولا يمكن حذفها.`;
  }
  return undefined;
}

/**
 * The census matrix, redrawn on the wizard's grid.
 *
 * Units painted through the grid carry their exact span and keep it. Ones
 * created any other way — the hand-added unit on the matrix page, a card's
 * inline flat — have no span at all, and are laid out one column each in
 * `sequence` order beside whatever is already positioned. That is the same
 * honest default `building-unit-matrix-view.tsx` draws them with, rather than a
 * guess at a layout nobody ever drew.
 *
 * Basements are drawn like any other floor — the grid extends below ground by
 * `basementsCount` — and the depth they imply comes back beside the height.
 * Only what will not fit the grid's *width* comes back as `hidden`, because a
 * unit the grid cannot draw must never be one the save then treats as deleted.
 */
export function gridFromUnits(
  units: UnitWithOccupants[],
  en: boolean,
): {
  drafts: GridUnitDraft[];
  hidden: UnitWithOccupants[];
  columns: number;
  floors: number;
  basements: number;
} {
  const drafts: GridUnitDraft[] = [];
  const hidden: UnitWithOccupants[] = [];

  const byFloor = new Map<number, UnitWithOccupants[]>();
  for (const unit of units) {
    byFloor.set(unit.floor, [...(byFloor.get(unit.floor) ?? []), unit]);
  }

  let colorIndex = 0;
  /** Columns a home's upper levels take on the floors above its entrance (0095). */
  const rising = new Map<number, Set<number>>();
  let columns = 0;
  let floors = 0;
  let basements = 0;

  for (const [floor, floorUnits] of [...byFloor.entries()].sort((a, b) => a[0] - b[0])) {
    const taken = new Set<number>(rising.get(floor) ?? []);
    const ordered = [...floorUnits].sort((a, b) => a.sequence - b.sequence);
    const positioned = ordered.filter((unit) => unit.startCol != null && unit.endCol != null);
    const loose = ordered.filter((unit) => unit.startCol == null || unit.endCol == null);

    const place = (unit: UnitWithOccupants, startCol: number, endCol: number) => {
      for (let col = startCol; col <= endCol; col += 1) taken.add(col);
      drafts.push({
        clientId: crypto.randomUUID(),
        floor,
        startCol,
        endCol,
        unitType: unit.unitType,
        unitTypeId: unit.unitTypeId ?? undefined,
        colorIndex: colorIndex++,
        existingId: unit.id,
        unitCode: unit.unitCode,
        undeletableReason: undeletableReason(unit, en),
        unitStatus: effectiveUnitStatus(unit),
        levels: unit.levels ?? 1,
      });
      const levels = unit.levels ?? 1;
      for (let level = 1; level < levels; level += 1) {
        const above = rising.get(floor + level) ?? new Set<number>();
        for (let col = startCol; col <= endCol; col += 1) above.add(col);
        rising.set(floor + level, above);
      }
      columns = Math.max(columns, endCol);
      if (floor < 0) basements = Math.max(basements, -floor);
      else floors = Math.max(floors, floor + levels);
    };

    for (const unit of positioned) {
      const startCol = Math.min(Math.max(1, unit.startCol as number), MAX_HORIZONTAL_BLOCKS);
      const endCol = Math.min(Math.max(startCol, unit.endCol as number), MAX_HORIZONTAL_BLOCKS);
      let clashes = false;
      for (let col = startCol; col <= endCol; col += 1) if (taken.has(col)) clashes = true;
      // Two units drawn over one cell is not a layout. The later one falls back
      // to being placed beside the rest rather than on top of them.
      if (clashes) loose.push(unit);
      else place(unit, startCol, endCol);
    }

    for (const unit of loose) {
      let col = 1;
      while (col <= MAX_HORIZONTAL_BLOCKS && taken.has(col)) col += 1;
      if (col > MAX_HORIZONTAL_BLOCKS) hidden.push(unit);
      else place(unit, col, col);
    }
  }

  return {
    drafts,
    hidden,
    columns: Math.max(DEFAULT_GRID_SIZE, columns),
    floors: Math.max(1, floors),
    basements,
  };
}

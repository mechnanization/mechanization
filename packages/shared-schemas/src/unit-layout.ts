import { z } from 'zod';
import { unitLevels } from './unit-levels';

/**
 * The widest a floor plan may be drawn — the same bound `upsertUnitSchema`
 * puts on `startCol`/`endCol` and the creation grid on its width.
 */
export const MAX_UNIT_COLUMN = 20;

/** One unit placed on its floor's column grid — 1-based, inclusive. */
export interface UnitSpan<T> {
  unit: T;
  startCol: number;
  endCol: number;
  /**
   * The unit enters on a lower floor and this is one of its upper levels — a
   * «دوبلكس» or «تريبلكس» (`Unit.levels`, 0095). It occupies these columns
   * exactly as an entrance block does, so nothing else may be drawn there; it
   * is drawn joined to the block below and opens the same unit.
   */
  continuation?: true;
}

/**
 * Reconstructs the floor plan a unit was painted on. Units carrying a stored
 * `startCol`/`endCol` (painted through the creation wizard's grid, or resized
 * on the matrix) keep their exact span; a unit with neither (the blueprint
 * generator, a hand-added single unit) is laid out as one column, appended
 * after the highest positioned column, in the order given — an honest default
 * rather than a guess at a layout that was never drawn.
 *
 * Shared because the server has to agree with the screen about where an
 * unpositioned unit *is*: resizing its neighbour pins it there, and pinning it
 * anywhere else would move a flat the officer never touched.
 *
 * `width` is this floor's own extent. A matrix drawn as one building takes the
 * maximum across floors — see `buildingWidth`.
 */
export function layoutFloorSpans<T extends { startCol?: number | null; endCol?: number | null }>(
  units: readonly T[],
  /**
   * Upper levels of units entering below, already placed on their own floor
   * (see `layoutBuildingFloors`). Fixed: an unpositioned unit of this floor is
   * appended after them, never on top of them.
   */
  carried: ReadonlyArray<UnitSpan<T>> = [],
): { blocks: Array<UnitSpan<T>>; width: number } {
  const blocks: Array<UnitSpan<T>> = carried.map((block) => ({
    unit: block.unit,
    startCol: block.startCol,
    endCol: block.endCol,
    continuation: true as const,
  }));
  for (const unit of units) {
    if (unit.startCol != null && unit.endCol != null) {
      blocks.push({ unit, startCol: unit.startCol, endCol: unit.endCol });
    }
  }

  let nextCol = blocks.reduce((max, b) => Math.max(max, b.endCol), 0) + 1;
  for (const unit of units) {
    if (unit.startCol == null || unit.endCol == null) {
      blocks.push({ unit, startCol: nextCol, endCol: nextCol });
      nextCol += 1;
    }
  }

  blocks.sort((a, b) => a.startCol - b.startCol);
  const width = blocks.reduce((max, b) => Math.max(max, b.endCol), 1);
  return { blocks, width };
}

/** A unit as the building-wide layout reads it. */
export interface LevelledUnit {
  floor: number;
  levels?: number | null;
  startCol?: number | null;
  endCol?: number | null;
}

/** One floor of a building as drawn: its own units and the upper levels of units below. */
export interface FloorLayout<T> {
  floor: number;
  blocks: Array<UnitSpan<T>>;
  width: number;
}

/**
 * Lays out every floor of a building at once, so a unit on several levels
 * (`Unit.levels`) takes the same columns on each of them.
 *
 * Floors are placed from the lowest up. A unit's entrance floor decides its
 * columns — stored, or appended like any unpositioned unit — and each floor it
 * rises into receives a `continuation` block in exactly those columns before
 * that floor's own units are placed, so they are laid out around it.
 *
 * Keyed by floor, for every floor any unit enters or reaches. A floor with
 * nothing on it is absent; callers that draw empty rows add them.
 */
export function layoutBuildingFloors<T extends LevelledUnit>(
  units: readonly T[],
): Map<number, FloorLayout<T>> {
  const byFloor = new Map<number, T[]>();
  let top = -Infinity;
  let bottom = Infinity;
  for (const unit of units) {
    const list = byFloor.get(unit.floor) ?? [];
    list.push(unit);
    byFloor.set(unit.floor, list);
    bottom = Math.min(bottom, unit.floor);
    top = Math.max(top, unit.floor + unitLevels(unit) - 1);
  }

  const layouts = new Map<number, FloorLayout<T>>();
  const carried = new Map<number, Array<UnitSpan<T>>>();
  for (let floor = bottom; floor <= top; floor += 1) {
    const own = byFloor.get(floor) ?? [];
    const fromBelow = carried.get(floor) ?? [];
    if (own.length === 0 && fromBelow.length === 0) continue;

    const { blocks, width } = layoutFloorSpans(own, fromBelow);
    layouts.set(floor, { floor, blocks, width });

    for (const block of blocks) {
      if (block.continuation) continue;
      const levels = unitLevels(block.unit);
      for (let level = 1; level < levels; level += 1) {
        const above = carried.get(floor + level) ?? [];
        above.push({ unit: block.unit, startCol: block.startCol, endCol: block.endCol });
        carried.set(floor + level, above);
      }
    }
  }
  return layouts;
}

/** The floors a unit occupies — its entrance and every level above it. */
export function floorsOfUnit(unit: LevelledUnit): number[] {
  return Array.from({ length: unitLevels(unit) }, (_, level) => unit.floor + level);
}

/**
 * The first block a unit's span would overlap on any floor it occupies, if any —
 * `spanOverlap` across levels. `floors` defaults to the unit's own; pass more to
 * ask whether it could rise into floors it does not reach yet.
 */
export function levelSpanOverlap<T extends LevelledUnit>(
  layouts: ReadonlyMap<number, FloorLayout<T>>,
  target: T,
  span: { startCol: number; endCol: number },
  floors: readonly number[] = floorsOfUnit(target),
): UnitSpan<T> | null {
  for (const floor of floors) {
    const layout = layouts.get(floor);
    if (!layout) continue;
    const clash = spanOverlap(layout.blocks, target, span);
    if (clash) return clash;
  }
  return null;
}

/**
 * `spanLimits` for a unit on several levels: an edge may move only as far as
 * every floor it occupies allows. `null` when the unit is not laid out.
 */
export function levelSpanLimits<T extends LevelledUnit>(
  layouts: ReadonlyMap<number, FloorLayout<T>>,
  target: T,
  maxCol: number = MAX_UNIT_COLUMN,
): { minStart: number; maxEnd: number } | null {
  let result: { minStart: number; maxEnd: number } | null = null;
  for (const floor of floorsOfUnit(target)) {
    const layout = layouts.get(floor);
    if (!layout) continue;
    const limits = spanLimits(layout.blocks, target, maxCol);
    if (!limits) continue;
    result = result
      ? { minStart: Math.max(result.minStart, limits.minStart), maxEnd: Math.min(result.maxEnd, limits.maxEnd) }
      : limits;
  }
  return result;
}

/**
 * The column count every floor of one building is drawn on.
 *
 * One grid for the whole structure, as the creation wizard paints it: a floor
 * set back from the one below shows its empty columns rather than stretching
 * across them, and a column on the third floor sits over the same column on the
 * second.
 */
export function buildingWidth(floors: ReadonlyArray<{ width: number }>): number {
  return floors.reduce((max, floor) => Math.max(max, floor.width), 1);
}

/**
 * How far a unit's two edges may move on its floor: from the first column to
 * the grid's limit, stopping at the nearest neighbour on either side.
 *
 * Irregular plans need nothing special here. A gap is just a run of columns no
 * block covers, wherever it falls — the start of a row, its middle, past a
 * setback — and either neighbour can grow into it. The bound is the grid's
 * hard limit, not the building's current width, so a floor can also be drawn
 * wider than any other; the grid widens to follow.
 *
 * `null` when the unit is not on the floor given.
 */
export function spanLimits<T>(
  blocks: ReadonlyArray<UnitSpan<T>>,
  target: T,
  maxCol: number = MAX_UNIT_COLUMN,
): { minStart: number; maxEnd: number } | null {
  const self = blocks.find((block) => block.unit === target);
  if (!self) return null;

  let minStart = 1;
  let maxEnd = maxCol;
  for (const block of blocks) {
    if (block === self) continue;
    if (block.endCol < self.startCol) minStart = Math.max(minStart, block.endCol + 1);
    if (block.startCol > self.endCol) maxEnd = Math.min(maxEnd, block.startCol - 1);
  }
  return { minStart, maxEnd };
}

/** The other block a span would overlap on its floor, if any. */
export function spanOverlap<T>(
  blocks: ReadonlyArray<UnitSpan<T>>,
  target: T,
  span: { startCol: number; endCol: number },
): UnitSpan<T> | null {
  return (
    blocks.find(
      (block) =>
        block.unit !== target && block.startCol <= span.endCol && span.startCol <= block.endCol,
    ) ?? null
  );
}

/**
 * «تعديل عرض الوحدة» — a unit's new place on its floor's grid.
 *
 * Both edges, always together: a span is one fact, and a lone `endCol` would
 * be read against whatever `startCol` the row happened to hold.
 */
export const resizeUnitSpanSchema = z
  .object({
    startCol: z.coerce.number().int('العمود يجب أن يكون رقماً صحيحاً').min(1).max(MAX_UNIT_COLUMN),
    endCol: z.coerce.number().int('العمود يجب أن يكون رقماً صحيحاً').min(1).max(MAX_UNIT_COLUMN),
  })
  .refine((span) => span.endCol >= span.startCol, {
    message: 'نهاية الوحدة قبل بدايتها',
    path: ['endCol'],
  });

export type ResizeUnitSpanInput = z.infer<typeof resizeUnitSpanSchema>;

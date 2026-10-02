import { z } from 'zod';

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
): { blocks: Array<UnitSpan<T>>; width: number } {
  const blocks: Array<UnitSpan<T>> = [];
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

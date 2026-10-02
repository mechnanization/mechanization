import {
  buildingWidth,
  layoutFloorSpans,
  resizeUnitSpanSchema,
  spanLimits,
  spanOverlap,
} from '@mechanization/shared-schemas';

/*
  The floor plan the matrix draws and the resize the server accepts are one
  rule, in shared-schemas. These pin it: where an unpositioned unit lands, how
  far an edge may travel, and that a gap anywhere in a row — not only at its
  end — can be grown into without covering a neighbour.
*/
type U = { id: string; startCol: number | null; endCol: number | null };
const unit = (id: string, startCol: number | null = null, endCol: number | null = startCol): U => ({
  id,
  startCol,
  endCol,
});

describe('layoutFloorSpans', () => {
  it('keeps stored spans and appends unpositioned units after the highest column, in order', () => {
    const a = unit('a', 3, 4);
    const b = unit('b');
    const c = unit('c', 1, 1);
    const d = unit('d');
    const { blocks, width } = layoutFloorSpans([a, b, c, d]);
    expect(blocks.map((block) => [block.unit.id, block.startCol, block.endCol])).toEqual([
      ['c', 1, 1],
      ['a', 3, 4],
      ['b', 5, 5],
      ['d', 6, 6],
    ]);
    expect(width).toBe(6);
  });

  it('draws an empty floor one column wide', () => {
    expect(layoutFloorSpans([]).width).toBe(1);
  });
});

describe('buildingWidth', () => {
  it('is the widest floor, so a setback floor shows its empty columns', () => {
    expect(buildingWidth([{ width: 4 }, { width: 11 }, { width: 1 }])).toBe(11);
  });
});

describe('spanLimits', () => {
  // A ground floor that starts two columns in: the gap in the screenshot.
  const first = unit('first', 3, 3);
  const middle = unit('middle', 4, 5);
  const last = unit('last', 9, 9);
  const { blocks } = layoutFloorSpans([first, middle, last]);

  it('lets the first unit grow left into a leading gap, down to column 1', () => {
    expect(spanLimits(blocks, first)).toEqual({ minStart: 1, maxEnd: 3 });
  });

  it('stops each edge at the nearest neighbour across a middle gap', () => {
    expect(spanLimits(blocks, middle)).toEqual({ minStart: 4, maxEnd: 8 });
    expect(spanLimits(blocks, last)).toEqual({ minStart: 6, maxEnd: 20 });
  });

  it('honours a tighter grid limit', () => {
    expect(spanLimits(blocks, last, 12)?.maxEnd).toBe(12);
  });

  it('is null for a unit not on the floor', () => {
    expect(spanLimits(blocks, unit('elsewhere', 1))).toBeNull();
  });
});

describe('spanOverlap', () => {
  const left = unit('left', 1, 2);
  const right = unit('right', 5, 6);
  const { blocks } = layoutFloorSpans([left, right]);

  it('allows a span that fills the gap exactly', () => {
    expect(spanOverlap(blocks, left, { startCol: 1, endCol: 4 })).toBeNull();
  });

  it('names the neighbour a span would cover', () => {
    expect(spanOverlap(blocks, left, { startCol: 1, endCol: 5 })?.unit).toBe(right);
  });

  it('ignores the unit itself', () => {
    expect(spanOverlap(blocks, right, { startCol: 4, endCol: 6 })).toBeNull();
  });
});

describe('resizeUnitSpanSchema', () => {
  it('refuses an end before the start', () => {
    expect(resizeUnitSpanSchema.safeParse({ startCol: 4, endCol: 3 }).success).toBe(false);
  });

  it('refuses a column past the grid limit', () => {
    expect(resizeUnitSpanSchema.safeParse({ startCol: 1, endCol: 21 }).success).toBe(false);
  });

  it('accepts a one-column span', () => {
    expect(resizeUnitSpanSchema.parse({ startCol: 2, endCol: 2 })).toEqual({ startCol: 2, endCol: 2 });
  });
});

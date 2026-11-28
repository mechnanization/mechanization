import * as turf from '@turf/turf';
import { buildParcelShapes, deriveCityBoundary } from './parcel-geometry';
import type { CadastreLine, ParcelPoint } from './kmz-parser';

/**
 * A 2x1 block of unit-ish squares, drawn the way a survey draws them: as loose
 * edge segments, never as closed rings, with the shared middle edge written once.
 *
 *   (0,1)───(1,1)───(2,1)
 *     │   A   │   B   │
 *   (0,0)───(1,0)───(2,0)
 */
const GRID: CadastreLine[] = [
  { kind: 'LAND_HOOK_LINE', coordinates: [[0, 0], [1, 0]] },
  { kind: 'LAND_HOOK_LINE', coordinates: [[1, 0], [2, 0]] },
  { kind: 'LAND_HOOK_LINE', coordinates: [[0, 1], [1, 1]] },
  { kind: 'LAND_HOOK_LINE', coordinates: [[1, 1], [2, 1]] },
  { kind: 'LAND_HOOK_LINE', coordinates: [[0, 0], [0, 1]] },
  { kind: 'LAND_HOOK_LINE', coordinates: [[1, 0], [1, 1]] },
  { kind: 'LAND_HOOK_LINE', coordinates: [[2, 0], [2, 1]] },
];

const point = (parcelNumber: string, longitude: number, latitude: number): ParcelPoint => ({
  parcelNumber,
  longitude,
  latitude,
});

describe('buildParcelShapes', () => {
  it('recovers a polygon per parcel from unclosed edge segments', () => {
    const { shapes, unmatched } = buildParcelShapes(GRID, [
      point('A', 0.5, 0.5),
      point('B', 1.5, 0.5),
    ]);

    expect(unmatched).toEqual([]);
    expect(shapes.map((s) => s.parcelNumber).sort()).toEqual(['A', 'B']);

    // Each label must land in its own square, not in a merged 2x1 block.
    const a = shapes.find((s) => s.parcelNumber === 'A')!;
    expect(turf.booleanPointInPolygon([0.5, 0.5], turf.polygon([a.ring]))).toBe(true);
    expect(turf.booleanPointInPolygon([1.5, 0.5], turf.polygon([a.ring]))).toBe(false);
  });

  it('reports a parcel whose label falls outside every traced face', () => {
    const { shapes, unmatched } = buildParcelShapes(GRID, [
      point('A', 0.5, 0.5),
      point('ORPHAN', 50, 50),
    ]);

    expect(unmatched).toEqual(['ORPHAN']);
    expect(shapes).toHaveLength(1);
  });

  /**
   * A survey tie line hanging off the grid bounds no parcel. Left in place the
   * traversal walks up and back down it, welding A and B into one ring — so a
   * regression here silently merges neighbouring parcels rather than erroring.
   */
  it('ignores dangling lines instead of merging the parcels either side', () => {
    const withDangle: CadastreLine[] = [
      ...GRID,
      { kind: 'LAND_HOOK_LINE', coordinates: [[1, 1], [1, 5]] },
    ];

    const { shapes } = buildParcelShapes(withDangle, [point('A', 0.5, 0.5), point('B', 1.5, 0.5)]);

    expect(shapes).toHaveLength(2);
    for (const shape of shapes) {
      expect(turf.area(turf.polygon([shape.ring]))).toBeLessThan(
        turf.area(turf.polygon([[[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]]])),
      );
    }
  });

  /**
   * The survey draws one long edge past a corner where a neighbour's boundary
   * meets it. Without splitting that edge at the corner there is no junction
   * there, and the faces on either side leak into one another.
   */
  it('splits a segment where another segment ends part-way along it', () => {
    const unnoded: CadastreLine[] = [
      { kind: 'L', coordinates: [[0, 0], [2, 0]] },
      { kind: 'L', coordinates: [[0, 1], [2, 1]] },
      { kind: 'L', coordinates: [[0, 0], [0, 1]] },
      { kind: 'L', coordinates: [[2, 0], [2, 1]] },
      { kind: 'L', coordinates: [[1, 0], [1, 1]] },
    ];

    const { shapes } = buildParcelShapes(unnoded, [point('A', 0.5, 0.5), point('B', 1.5, 0.5)]);
    expect(shapes).toHaveLength(2);
  });

  it('returns every parcel as unmatched when the survey carries no lines', () => {
    const { shapes, unmatched } = buildParcelShapes([], [point('A', 0.5, 0.5)]);
    expect(shapes).toEqual([]);
    expect(unmatched).toEqual(['A']);
  });
});

describe('deriveCityBoundary', () => {
  /** A ring of points around a centre, in degrees — roughly a small town. */
  const town: ParcelPoint[] = Array.from({ length: 24 }, (_, i) => {
    const angle = (i / 24) * Math.PI * 2;
    return point(`P${i}`, 35.27 + Math.cos(angle) * 0.01, 33.25 + Math.sin(angle) * 0.01);
  });

  it('encloses every parcel it was derived from', () => {
    const boundary = deriveCityBoundary(town);
    expect(boundary).not.toBeNull();

    for (const p of town) {
      expect(turf.booleanPointInPolygon([p.longitude, p.latitude], boundary!)).toBe(true);
    }
  });

  it('excludes a point well outside the cadastre', () => {
    const boundary = deriveCityBoundary(town);
    expect(turf.booleanPointInPolygon([35.5, 33.5], boundary!)).toBe(false);
  });

  /** Callers must distinguish "boundary unknown" from "nothing is inside it". */
  it('returns null rather than an empty polygon when there is nothing to hull', () => {
    expect(deriveCityBoundary([])).toBeNull();
    expect(deriveCityBoundary([point('A', 35.27, 33.25)])).toBeNull();
  });
});

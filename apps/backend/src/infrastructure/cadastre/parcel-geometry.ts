/**
 * Recovers parcel *shapes* from a survey export that only draws *lines*.
 *
 * The KMZ a survey office ships has no polygons in it — it has thousands of
 * boundary segments and a separate label point carrying each رقم العقار. Drawn
 * on a map that reads fine to a human, but nothing in it can answer "which
 * parcels are in this area", which is the whole job of the zone editor.
 *
 * The segments do, however, form a planar graph: every parcel is a face of it.
 * Tracing those faces turns ~9,500 disconnected lines into ~1,800 real parcel
 * polygons, and matching the label points back into them attaches the parcel
 * numbers. Against the reference survey this recovers a shape for 98.5% of
 * parcels; the rest keep their point and are handled as points everywhere.
 *
 * Turf's own `polygonize` is the obvious thing to reach for here and does not
 * survive this input — it throws `Invalid array length` even after the graph is
 * noded and pruned, so the traversal below is hand-rolled.
 */
import * as turf from '@turf/turf';
import type { Feature, Polygon, Position } from 'geojson';
import type { CadastreLine, ParcelPoint } from './kmz-parser';

/**
 * Vertices are matched by their printed coordinate, so two segments meet only
 * if the survey wrote the same value for both. Six decimals is ~0.11 m — the
 * precision the rest of the pipeline already rounds to, and far below the
 * survey's own accuracy, so this cannot merge two genuinely distinct corners.
 */
const VERTEX_PRECISION = 6;

/** Faces below this are slivers from near-duplicate lines, not parcels. */
const MIN_PARCEL_AREA_SQM = 1;

/**
 * Longest edge the municipality outline may bridge. Tuned against the reference
 * survey: at 0.32 km the hull closes over the road corridors and wadis that
 * separate outlying blocks into a single polygon covering every parcel, while
 * staying ~16% tighter than a convex hull, which would swallow land the
 * municipality does not administer.
 */
const BOUNDARY_MAX_EDGE_KM = 0.32;

/** Keeps edge parcels off the hairline so a point on the hull reads as inside. */
const BOUNDARY_PAD_KM = 0.015;

export interface ParcelShape {
  parcelNumber: string;
  ring: Position[];
  areaSqM: number;
}

/**
 * One parcel outline as it is stored on the row, rather than drawn on a map.
 *
 * A bare GeoJSON *geometry*, not a Feature: the row it lands on already carries
 * the parcel number and everything else a Feature's `properties` would repeat,
 * and a wrapper the database never reads is a wrapper every query has to step
 * over.
 *
 * `MultiPolygon` is not defensive typing — the survey genuinely draws some
 * parcels as several disconnected pieces, which is what `Parcel.pointCount > 1`
 * has always recorded. Keeping only the last traced piece would put a building
 * pin "outside its parcel" for every structure standing on one of the others.
 */
export interface ParcelBoundary {
  parcelNumber: string;
  geometry:
    | { type: 'Polygon'; coordinates: Position[][] }
    | { type: 'MultiPolygon'; coordinates: Position[][][] };
}

export interface CadastreGeometryAssets {
  /** Static layer of parcel polygons, or null when no shape could be traced. */
  parcelPolygonsGeoJson: string | null;
  /** Static layer holding the derived municipality outline, or null. */
  cityBoundaryGeoJson: string | null;
  /**
   * The same polygons, per parcel, for `Parcel.boundary`.
   *
   * The identical rings the asset above draws — rounded once, here, so the file
   * and the column cannot disagree about where a parcel's edge is. Empty when
   * nothing could be traced; a parcel absent from this list keeps a null
   * boundary, which means "outline unknown" and never "no area".
   */
  parcelBoundaries: ParcelBoundary[];
  shapeCount: number;
  /** Parcels whose label point landed in no face — they stay point-only. */
  unmatchedCount: number;
}

type Ring = Position[];

interface HalfEdge {
  geom: Position[];
  twin: HalfEdge;
  origin: Node;
  angle: number;
  slot: number;
  visited: boolean;
}

interface Node {
  out: HalfEdge[];
}

const vertexKey = (p: Position): string =>
  `${p[0].toFixed(VERTEX_PRECISION)},${p[1].toFixed(VERTEX_PRECISION)}`;

/**
 * Splits every segment wherever another segment *ends* mid-way along it.
 *
 * A survey draws one long road edge past several parcel corners that touch it.
 * Those corners are interior vertices of the road line but endpoints of the
 * parcel lines, so without this the graph has no junction there and the faces
 * on either side leak into one another.
 */
function nodeSegments(segments: readonly Position[][]): Position[][] {
  const endpoints = new Set<string>();
  for (const s of segments) {
    endpoints.add(vertexKey(s[0]));
    endpoints.add(vertexKey(s[s.length - 1]));
  }

  const out: Position[][] = [];
  for (const s of segments) {
    let run: Position[] = [s[0]];
    for (let i = 1; i < s.length; i += 1) {
      run.push(s[i]);
      if (i < s.length - 1 && endpoints.has(vertexKey(s[i]))) {
        out.push(run);
        run = [s[i]];
      }
    }
    if (run.length > 1) out.push(run);
  }
  return out;
}

/**
 * Drops edges that dead-end, repeatedly.
 *
 * A survey tie line or an overshot boundary hangs off the graph with one free
 * end. It bounds no face, but the traversal would still walk up and back down
 * it, welding two neighbouring parcels into one ring. Removing a dangle can
 * expose another behind it, so this runs to a fixed point.
 */
function pruneDangles(segments: readonly Position[][]): Position[][] {
  let edges = [...segments];

  for (;;) {
    const degree = new Map<string, number>();
    for (const s of edges) {
      for (const key of [vertexKey(s[0]), vertexKey(s[s.length - 1])]) {
        degree.set(key, (degree.get(key) ?? 0) + 1);
      }
    }

    const kept = edges.filter((s) => {
      const a = vertexKey(s[0]);
      const b = vertexKey(s[s.length - 1]);
      if (a === b) return true;
      return (degree.get(a) ?? 0) > 1 && (degree.get(b) ?? 0) > 1;
    });

    if (kept.length === edges.length) return kept;
    edges = kept;
  }
}

/** Two segments between the same pair of corners would trace a zero-width face. */
function dedupe(segments: readonly Position[][]): Position[][] {
  const seen = new Set<string>();
  const out: Position[][] = [];

  for (const s of segments) {
    const a = vertexKey(s[0]);
    const b = vertexKey(s[s.length - 1]);
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** Shoelace on raw lng/lat — sign only, so the projection does not matter. */
function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

/**
 * Walks the graph's faces.
 *
 * Each undirected edge becomes two half-edges. Arriving at a node, taking the
 * next half-edge clockwise from the one you came in on keeps a single face on
 * your left the whole way round, so following that rule until you return to the
 * start traces exactly one face. Doing it from every unvisited half-edge yields
 * every face — each parcel once, plus one outer ring per connected component,
 * which winds the other way and is discarded by the sign test.
 */
function traceFaces(segments: readonly Position[][]): Ring[] {
  const nodes = new Map<string, Node>();
  const nodeAt = (p: Position): Node => {
    const key = vertexKey(p);
    let node = nodes.get(key);
    if (!node) {
      node = { out: [] };
      nodes.set(key, node);
    }
    return node;
  };

  const halfEdges: HalfEdge[] = [];
  for (const s of segments) {
    const from = nodeAt(s[0]);
    const to = nodeAt(s[s.length - 1]);
    if (from === to) continue;

    const forward = { geom: s, origin: from } as HalfEdge;
    const back = { geom: [...s].reverse(), origin: to } as HalfEdge;
    forward.twin = back;
    back.twin = forward;
    forward.visited = false;
    back.visited = false;

    from.out.push(forward);
    to.out.push(back);
    halfEdges.push(forward, back);
  }

  for (const node of nodes.values()) {
    for (const h of node.out) {
      h.angle = Math.atan2(h.geom[1][1] - h.geom[0][1], h.geom[1][0] - h.geom[0][0]);
    }
    node.out.sort((a, b) => a.angle - b.angle);
    node.out.forEach((h, i) => {
      h.slot = i;
    });
  }

  const faces: Ring[] = [];
  for (const start of halfEdges) {
    if (start.visited) continue;

    const ring: Position[] = [];
    let edge = start;
    // Bounded because every half-edge is consumed at most once; the cap is a
    // guard against a malformed graph, not part of the algorithm.
    for (let guard = 0; guard < halfEdges.length + 1; guard += 1) {
      if (edge.visited) break;
      edge.visited = true;
      for (let i = 0; i < edge.geom.length - 1; i += 1) ring.push(edge.geom[i]);

      const arrival = edge.twin;
      const ring_ = arrival.origin.out;
      edge = ring_[(arrival.slot - 1 + ring_.length) % ring_.length];
      if (edge === start) break;
    }

    if (ring.length < 3) continue;
    ring.push(ring[0]);
    faces.push(ring);
  }

  return faces;
}

/**
 * Builds parcel polygons from the survey's line layers and labels them from the
 * parcel points.
 *
 * Every line layer is fed in together rather than just the one named for parcel
 * boundaries: on the reference survey the secondary cadastral layer closes
 * blocks the primary one leaves open, taking coverage from 93.7% to 98.5%.
 */
export function buildParcelShapes(
  lines: readonly CadastreLine[],
  points: readonly ParcelPoint[],
): { shapes: ParcelShape[]; unmatched: string[] } {
  const segments = lines.map((line) => line.coordinates as Position[]).filter((s) => s.length >= 2);
  if (segments.length === 0) return { shapes: [], unmatched: points.map((p) => p.parcelNumber) };

  const faces = traceFaces(dedupe(pruneDangles(nodeSegments(segments))));

  const candidates = faces
    .filter((ring) => signedArea(ring) > 0)
    .map((ring) => {
      const polygon = turf.polygon([ring]);
      return { polygon, bbox: turf.bbox(polygon), areaSqM: turf.area(polygon) };
    })
    .filter((c) => c.areaSqM >= MIN_PARCEL_AREA_SQM);

  const shapes: ParcelShape[] = [];
  const unmatched: string[] = [];

  for (const point of points) {
    const position: Position = [point.longitude, point.latitude];

    // A parcel split across non-adjacent pieces has several label points; the
    // smallest containing face is the one that actually belongs to it, since a
    // larger enclosing face is a block, not the parcel.
    let best: (typeof candidates)[number] | null = null;
    for (const c of candidates) {
      if (
        position[0] < c.bbox[0] ||
        position[0] > c.bbox[2] ||
        position[1] < c.bbox[1] ||
        position[1] > c.bbox[3]
      ) {
        continue;
      }
      if (!turf.booleanPointInPolygon(position, c.polygon)) continue;
      if (!best || c.areaSqM < best.areaSqM) best = c;
    }

    if (!best) {
      unmatched.push(point.parcelNumber);
      continue;
    }

    shapes.push({
      parcelNumber: point.parcelNumber,
      ring: best.polygon.geometry.coordinates[0],
      areaSqM: Math.round(best.areaSqM),
    });
  }

  return { shapes, unmatched };
}

/**
 * Derives the municipality outline from the parcels themselves.
 *
 * The survey ships no boundary polygon, and the layer named as though it were
 * one is a scatter of disconnected fragments. What the municipality administers
 * is exactly the land its cadastre covers, so a concave hull over every parcel
 * point reconstructs the outline without anyone having to supply one.
 *
 * Returns null when the hull cannot close — too few or too scattered a set of
 * points — and callers treat a missing boundary as "unknown", never as "empty".
 */
export function deriveCityBoundary(points: readonly ParcelPoint[]): Feature<Polygon> | null {
  if (points.length < 3) return null;

  const cloud = turf.featureCollection(
    points.map((p) => turf.point([p.longitude, p.latitude])),
  );

  let hull;
  try {
    hull = turf.concave(cloud, { maxEdge: BOUNDARY_MAX_EDGE_KM, units: 'kilometers' });
  } catch {
    hull = null;
  }
  if (!hull) hull = turf.convex(cloud);
  if (!hull) return null;

  const padded = turf.buffer(hull, BOUNDARY_PAD_KM, { units: 'kilometers' });
  if (!padded) return null;

  const simplified = turf.simplify(padded, { tolerance: 0.00003, highQuality: true });

  // A hull over a cadastre split by a wide wadi can still come back multipart;
  // the municipality outline is one shape, so the largest piece wins.
  if (simplified.geometry.type === 'MultiPolygon') {
    const largest = simplified.geometry.coordinates
      .map((coords) => turf.polygon(coords))
      .sort((a, b) => turf.area(b) - turf.area(a))[0];
    return largest ?? null;
  }

  return simplified as Feature<Polygon>;
}

const round = (value: number): number => Number(value.toFixed(VERTEX_PRECISION));
const roundRing = (ring: Position[]): Position[] => ring.map(([x, y]) => [round(x), round(y)]);

/**
 * Produces the two static map layers the zone editor needs, alongside the
 * parcel points and cadastral lines the import already writes.
 *
 * Both are cartography derived from the upload rather than queryable data, so
 * they follow the existing convention of a cacheable file under the frontend's
 * `public/tenants/<slug>/` rather than a table and an endpoint.
 */
export function buildCadastreGeometryAssets(
  lines: readonly CadastreLine[],
  points: readonly ParcelPoint[],
): CadastreGeometryAssets {
  const { shapes, unmatched } = buildParcelShapes(lines, points);
  const boundary = deriveCityBoundary(points);

  /*
    Rounded once, and the same rings feed both consumers below.

    The asset the browser draws and the column the server tests pins against
    have to be the *same* polygon. Rounding them twice is how a pin lands inside
    the parcel the officer can see and outside the one the API checks.
  */
  const rings = shapes.map((shape) => roundRing(shape.ring));

  const parcelPolygonsGeoJson =
    shapes.length > 0
      ? JSON.stringify({
          type: 'FeatureCollection',
          features: shapes.map((shape, index) => ({
            type: 'Feature',
            properties: { parcelNumber: shape.parcelNumber, areaSqM: shape.areaSqM },
            geometry: { type: 'Polygon', coordinates: [rings[index]!] },
          })),
        })
      : null;

  /*
    Grouped by رقم العقار, because a parcel the survey split into pieces has one
    label point per piece and therefore several traced faces — and one row to
    put them on. Two or more become a MultiPolygon rather than the last one
    winning, which would silently shrink the parcel to whichever fragment the
    file happened to list last.
  */
  const ringsByParcel = new Map<string, Position[][]>();
  shapes.forEach((shape, index) => {
    const existing = ringsByParcel.get(shape.parcelNumber);
    if (existing) existing.push(rings[index]!);
    else ringsByParcel.set(shape.parcelNumber, [rings[index]!]);
  });

  const parcelBoundaries: ParcelBoundary[] = [...ringsByParcel.entries()].map(
    ([parcelNumber, parcelRings]) => ({
      parcelNumber,
      geometry:
        parcelRings.length === 1
          ? { type: 'Polygon' as const, coordinates: [parcelRings[0]!] }
          : { type: 'MultiPolygon' as const, coordinates: parcelRings.map((ring) => [ring]) },
    }),
  );

  const cityBoundaryGeoJson = boundary
    ? JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { name: 'حدود البلدية', derived: true },
            geometry: {
              type: 'Polygon',
              coordinates: boundary.geometry.coordinates.map(roundRing),
            },
          },
        ],
      })
    : null;

  return {
    parcelPolygonsGeoJson,
    cityBoundaryGeoJson,
    parcelBoundaries,
    shapeCount: shapes.length,
    unmatchedCount: unmatched.length,
  };
}

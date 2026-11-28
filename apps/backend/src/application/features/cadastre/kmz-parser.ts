/**
 * Reads a survey office's KMZ/KML export into the two things this platform needs
 * from it: the parcel registry (رقم العقار → a point) and the cadastral lines
 * that draw the parcel grid on the staff map.
 *
 * Kept dependency-free on purpose. A KMZ is a ZIP holding one KML, and the KML
 * this comes from is machine-generated with a flat, predictable Placemark shape —
 * so a ~60-line container reader and a scan beat pulling an XML DOM and a ZIP
 * library into the API for a script that runs at onboarding time.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/** One label point from the survey: a parcel number at a coordinate. */
export interface ParcelPoint {
  parcelNumber: string;
  latitude: number;
  longitude: number;
}

/** One cadastral line: a boundary or survey tie line, as [lng, lat] pairs. */
export interface CadastreLine {
  kind: string;
  coordinates: [number, number][];
}

export interface Cadastre {
  points: ParcelPoint[];
  lines: CadastreLine[];
}

/** A parcel after label points sharing a number have been merged. */
export interface Parcel {
  parcelNumber: string;
  latitude: number;
  longitude: number;
  pointCount: number;
}

/**
 * The description each Placemark carries. The source encodes the feature's
 * layer here rather than in the folder structure, so this is how a parcel label
 * is told apart from a boundary segment.
 */
const PARCEL_LAYER = 'PARCEL_NO__FIXED';

// ─────────────────────────────  KMZ container  ─────────────────────────────

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Reads `path` as KML text, unwrapping the ZIP container if it is a KMZ. */
export function readKmlText(path: string): string {
  const bytes = readFileSync(path);

  // A bare .kml is XML; a .kmz starts with the ZIP local header magic "PK\x03\x04".
  if (bytes.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
    return bytes.toString('utf8');
  }

  return extractKmlFromZip(bytes);
}

function extractKmlFromZip(zip: Buffer): string {
  const eocd = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (zip.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error('Malformed KMZ: expected a central directory header');
    }

    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (name.toLowerCase().endsWith('.kml')) {
      return inflateEntry(zip, localOffset, method, compressedSize);
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  throw new Error('No .kml entry found inside the KMZ');
}

function inflateEntry(
  zip: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
): string {
  if (zip.readUInt32LE(localOffset) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error('Malformed KMZ: expected a local file header');
  }

  // The local header repeats the name and extra lengths, and they can differ
  // from the central directory's — the data offset must come from here.
  const nameLength = zip.readUInt16LE(localOffset + 26);
  const extraLength = zip.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const data = zip.subarray(start, start + compressedSize);

  if (method === METHOD_STORE) return data.toString('utf8');
  if (method === METHOD_DEFLATE) return inflateRawSync(data).toString('utf8');
  throw new Error(`Unsupported KMZ compression method ${method}`);
}

/** Scans back from the end: the EOCD is last, but a trailing comment may follow. */
function findEndOfCentralDirectory(zip: Buffer): number {
  for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('Malformed KMZ: no end-of-central-directory record');
}

// ───────────────────────────────  KML scan  ───────────────────────────────

const PLACEMARK = /<Placemark>([\s\S]*?)<\/Placemark>/g;

function tag(body: string, name: string): string {
  const match = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? match[1].trim() : '';
}

/** KML writes `lng,lat[,alt]` tuples separated by whitespace. */
function parseCoordinates(raw: string): [number, number][] {
  const out: [number, number][] = [];

  for (const tuple of raw.trim().split(/\s+/)) {
    if (!tuple) continue;
    const [lng, lat] = tuple.split(',').map(Number);
    if (Number.isFinite(lng) && Number.isFinite(lat)) out.push([lng, lat]);
  }

  return out;
}

export function parseCadastre(kml: string): Cadastre {
  const points: ParcelPoint[] = [];
  const lines: CadastreLine[] = [];

  for (const [, body] of kml.matchAll(PLACEMARK)) {
    const coordinates = parseCoordinates(tag(body, 'coordinates'));
    if (coordinates.length === 0) continue;

    const kind = tag(body, 'description');

    if (body.includes('<Point>')) {
      const parcelNumber = tag(body, 'name');
      // A point outside the parcel layer, or with no number on it, is not a
      // parcel — skipping keeps junk out of the registry the form validates on.
      if (kind !== PARCEL_LAYER || !parcelNumber) continue;

      const [longitude, latitude] = coordinates[0];
      points.push({ parcelNumber, latitude, longitude });
      continue;
    }

    if (body.includes('<LineString>') && coordinates.length >= 2) {
      lines.push({ kind, coordinates });
    }
  }

  return { points, lines };
}

/**
 * Collapses label points that share a parcel number into one parcel at their
 * centroid.
 *
 * The survey draws a second label when a parcel is split across non-adjacent
 * pieces. A registry keyed by parcel number cannot hold both, and the centroid
 * of two nearby labels still lands the staff map on the right block — so the
 * count travels with the row, and a parcel with `pointCount > 1` is flagged as
 * approximate rather than quietly presented as exact.
 */
export function mergeParcelPoints(points: readonly ParcelPoint[]): Parcel[] {
  const grouped = new Map<string, ParcelPoint[]>();

  for (const point of points) {
    const key = point.parcelNumber.trim();
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), point]);
  }

  return [...grouped.entries()]
    .map(([parcelNumber, group]) => ({
      parcelNumber,
      latitude: average(group.map((p) => p.latitude)),
      longitude: average(group.map((p) => p.longitude)),
      pointCount: group.length,
    }))
    .sort((a, b) => a.parcelNumber.localeCompare(b.parcelNumber, 'en', { numeric: true }));
}

function average(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

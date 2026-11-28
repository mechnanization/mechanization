import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeParcelPoints, parseCadastre, readKmlText } from './kmz-parser';

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <Folder>
    <name>Point Features</name>
    <Placemark>
      <description>PARCEL_NO__FIXED</description>
      <name>1553</name>
      <Point><coordinates>35.2767802222,33.2545271048,0</coordinates></Point>
    </Placemark>
    <Placemark>
      <description>PARCEL_NO__FIXED</description>
      <name>121</name>
      <Point><coordinates>35.2000000000,33.2000000000,0</coordinates></Point>
    </Placemark>
    <Placemark>
      <description>PARCEL_NO__FIXED</description>
      <name>121</name>
      <Point><coordinates>35.2100000000,33.2100000000,0</coordinates></Point>
    </Placemark>
    <Placemark>
      <description>SOME_OTHER_LAYER</description>
      <name>999</name>
      <Point><coordinates>35.3000000000,33.3000000000,0</coordinates></Point>
    </Placemark>
    <Placemark>
      <description>PARCEL_NO__FIXED</description>
      <name></name>
      <Point><coordinates>35.4000000000,33.4000000000,0</coordinates></Point>
    </Placemark>
  </Folder>
  <Folder>
    <name>Line Features</name>
    <Placemark>
      <description>CADAST__AREA_B_</description>
      <LineString><coordinates>
        35.2700000000,33.2500000000,0 35.2710000000,33.2510000000,0
      </coordinates></LineString>
    </Placemark>
    <Placemark>
      <description>LAND_HOOK_LINE</description>
      <LineString><coordinates>
        35.2600000000,33.2400000000,0 35.2610000000,33.2410000000,0 35.2620000000,33.2420000000,0
      </coordinates></LineString>
    </Placemark>
  </Folder>
</Document>
</kml>`;

describe('parseCadastre', () => {
  it('reads parcel numbers and coordinates off the parcel layer', () => {
    const { points } = parseCadastre(KML);

    expect(points).toContainEqual({
      parcelNumber: '1553',
      latitude: 33.2545271048,
      longitude: 35.2767802222,
    });
  });

  /**
   * The export mixes several layers into one Placemark list, and only
   * PARCEL_NO__FIXED carries a real parcel number. Letting another layer through
   * would put numbers in the registry that the citizen form then accepts as
   * valid.
   */
  it('ignores points outside the parcel layer, and unnamed ones', () => {
    const { points } = parseCadastre(KML);

    expect(points.map((p) => p.parcelNumber).sort()).toEqual(['121', '121', '1553']);
  });

  it('reads line features with all their vertices', () => {
    const { lines } = parseCadastre(KML);

    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.kind === 'LAND_HOOK_LINE')?.coordinates).toHaveLength(3);
    expect(lines.find((l) => l.kind === 'CADAST__AREA_B_')?.coordinates).toEqual([
      [35.27, 33.25],
      [35.271, 33.251],
    ]);
  });
});

describe('mergeParcelPoints', () => {
  it('collapses repeated parcel numbers to their centroid and counts them', () => {
    const merged = mergeParcelPoints(parseCadastre(KML).points);
    const parcel121 = merged.find((p) => p.parcelNumber === '121');

    expect(parcel121).toEqual({
      parcelNumber: '121',
      latitude: 33.205,
      longitude: 35.205,
      pointCount: 2,
    });
  });

  it('leaves a single-point parcel exactly where the survey put it', () => {
    const merged = mergeParcelPoints(parseCadastre(KML).points);

    expect(merged.find((p) => p.parcelNumber === '1553')).toEqual({
      parcelNumber: '1553',
      latitude: 33.2545271048,
      longitude: 35.2767802222,
      pointCount: 1,
    });
  });

  /** Numeric, because a parcel number reads as a number to whoever holds the deed. */
  it('sorts numerically rather than lexicographically', () => {
    const merged = mergeParcelPoints([
      { parcelNumber: '1000', latitude: 1, longitude: 1 },
      { parcelNumber: '99', latitude: 1, longitude: 1 },
      { parcelNumber: '7', latitude: 1, longitude: 1 },
    ]);

    expect(merged.map((p) => p.parcelNumber)).toEqual(['7', '99', '1000']);
  });
});

describe('readKmlText', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cadastre-'));

  it('reads a plain .kml straight through', () => {
    const path = join(dir, 'plain.kml');
    writeFileSync(path, KML, 'utf8');

    expect(parseCadastre(readKmlText(path)).points).toHaveLength(3);
  });

  /**
   * Exercises the hand-rolled ZIP reader end to end. A KMZ from the survey
   * office is a deflated single-entry archive, which is exactly what this
   * builds — so a regression in the offset arithmetic fails here rather than at
   * a municipality's onboarding.
   */
  it('unwraps a deflated .kmz container', () => {
    const path = join(dir, 'archive.kmz');
    writeFileSync(path, buildKmz('doc.kml', KML));

    expect(parseCadastre(readKmlText(path)).points).toHaveLength(3);
  });

  it('refuses an archive with no .kml inside', () => {
    const path = join(dir, 'wrong.kmz');
    writeFileSync(path, buildKmz('notes.txt', 'nothing here'));

    expect(() => readKmlText(path)).toThrow(/No .kml entry/);
  });
});

/** Minimal single-entry ZIP writer, deflated — the shape a KMZ actually takes. */
function buildKmz(name: string, contents: string): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const raw = Buffer.from(contents, 'utf8');
  const deflated = deflateRawSync(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(8, 8); // method: deflate
  local.writeUInt32LE(0, 14); // crc32 — unchecked by the reader
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const localBlock = Buffer.concat([local, nameBytes, deflated]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42); // local header offset

  const centralBlock = Buffer.concat([central, nameBytes]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // entries total
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);

  return Buffer.concat([localBlock, centralBlock, eocd]);
}

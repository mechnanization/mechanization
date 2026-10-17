import { CadastreImportService } from './cadastre-import.service';

/**
 * The admin panel's cadastre upload writes one registry row per رقم العقار,
 * as the `cadastre:import` CLI does.
 *
 * The survey labels a parcel split into pieces once per piece. Written one row
 * per point, the second label of a number hit the unique `parcelNumber` and
 * the whole upload failed with a 500 — within one file, not only on a
 * re-import. Mocked: the property under test is what is handed to the
 * registry and the map, and the unique index is what made the old shape fail.
 */
describe('CadastreImportService.importGeoJson', () => {
  const point = (parcelNumber: string, longitude: number, latitude: number) => ({
    type: 'Feature',
    properties: { parcelNumber },
    geometry: { type: 'Point', coordinates: [longitude, latitude] },
  });

  function harness() {
    const parcels = { replaceAll: jest.fn().mockResolvedValue(undefined) };
    const uploads = new Map<string, string>();
    const storage = {
      upload: jest.fn(async (_slug: string, name: string, contents: string) => {
        uploads.set(name, contents);
      }),
    };
    const events = { emit: jest.fn() };
    const service = new CadastreImportService(parcels as never, storage as never, events as never);
    return { service, parcels, uploads, events };
  }

  const upload = (features: unknown[]) =>
    Buffer.from(JSON.stringify({ type: 'FeatureCollection', features }), 'utf8');

  it('merges a label repeated in one upload into one parcel at the centroid, flagged approximate', async () => {
    const { service, parcels, uploads, events } = harness();

    const result = await service.importGeoJson({
      tenantSlug: 'zahle',
      buffer: upload([point('15', 35.0, 33.0), point('16', 35.5, 33.5), point(' 15 ', 35.2, 33.2)]),
      actor: { id: 'admin-1', role: 'SUPER_ADMIN' },
    });

    expect(parcels.replaceAll).toHaveBeenCalledTimes(1);
    const rows = parcels.replaceAll.mock.calls[0][0] as Array<{
      parcelNumber: string;
      latitude: number;
      longitude: number;
      pointCount: number;
    }>;
    expect(rows.map((row) => row.parcelNumber)).toEqual(['15', '16']);
    expect(rows[0]).toMatchObject({ parcelNumber: '15', pointCount: 2 });
    expect(rows[0]!.latitude).toBeCloseTo(33.1, 10);
    expect(rows[0]!.longitude).toBeCloseTo(35.1, 10);
    expect(rows[1]).toMatchObject({ parcelNumber: '16', pointCount: 1, latitude: 33.5, longitude: 35.5 });

    const map = JSON.parse(uploads.get('parcels.geojson')!) as {
      features: Array<{ properties: { parcelNumber: string; approximate: boolean } }>;
    };
    expect(map.features.map((feature) => feature.properties)).toEqual([
      { parcelNumber: '15', approximate: true },
      { parcelNumber: '16', approximate: false },
    ]);

    expect(result.parcelsImported).toBe(2);
    expect(events.emit).toHaveBeenCalledWith(
      'cadastre.imported',
      expect.objectContaining({ parcelsImported: 2, parcelsSkipped: 0 }),
    );
  });
});

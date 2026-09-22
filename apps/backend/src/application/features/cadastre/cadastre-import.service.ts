import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CADASTRE_STORAGE_SERVICE,
  PARCEL_REPOSITORY,
} from '../../../domain/interfaces/base-repository.interface';
import type { CadastreStorage } from '../../../domain/interfaces/cadastre-storage.interface';
import type { ParcelRepository } from '../../../domain/interfaces/parcel-repository.interface';
import { ValidationError } from '../../common/exceptions';
import { buildCadastreGeometryAssets } from '../../../infrastructure/cadastre/parcel-geometry';

/** Six decimal places is ~0.11m at this latitude — finer than any survey's own
 * accuracy, and it keeps the static file a fraction of the raw upload's size. */
const COORDINATE_PRECISION = 6;

interface ParsedParcel {
  parcelNumber: string;
  longitude: number;
  latitude: number;
}

interface ParsedLine {
  layer: string;
  coordinates: [number, number][];
}

export interface CadastreImportResult {
  parcelsImported: number;
  parcelsSkipped: number;
  linesImported: number;
  /** Parcels a polygon could be traced for — the rest stay point-only. */
  shapesTraced: number;
  boundaryDerived: boolean;
}

/**
 * Lets a Super Admin refresh a municipality's cadastre by uploading a GeoJSON
 * file from the admin panel — no manual database entry, and no need for the
 * `cadastre:import` CLI's KMZ survey export for a municipality whose data
 * already exists as GeoJSON.
 *
 * A point feature becomes a queryable رقم العقار (rebuilding the `parcels`
 * table wholesale); a line feature becomes cartography only — the boundary
 * grid the staff map draws underneath the registration markers, written as a
 * static asset rather than a table because nothing ever queries it.
 */
@Injectable()
export class CadastreImportService {
  constructor(
    @Inject(PARCEL_REPOSITORY) private readonly parcels: ParcelRepository,
    @Inject(CADASTRE_STORAGE_SERVICE) private readonly storage: CadastreStorage,
    private readonly events: EventEmitter2,
  ) {}

  async importGeoJson(input: {
    tenantSlug: string;
    buffer: Buffer;
    actor: { id: string; role: string };
  }): Promise<CadastreImportResult> {
    const geojson = this.parse(input.buffer);
    const { parcels, lines, skipped } = this.extract(geojson);

    if (parcels.length === 0 && lines.length === 0) {
      throw new ValidationError('لم يتم العثور على أي عقارات أو حدود صالحة في الملف');
    }

    // The upload carries lines and labels but no shapes; the zone editor needs
    // parcels it can click and an outline to draw, so both are reconstructed
    // here. Derived *before* the table is rebuilt, because the outlines are
    // written onto the parcel rows themselves — see `Parcel.boundary`.
    const geometry = buildCadastreGeometryAssets(
      lines.map((line) => ({ kind: line.layer, coordinates: line.coordinates })),
      parcels,
    );

    if (parcels.length > 0) {
      const boundaries = new Map(
        geometry.parcelBoundaries.map((entry) => [entry.parcelNumber, entry.geometry]),
      );

      await this.parcels.replaceAll(
        parcels.map((parcel) => ({
          parcelNumber: parcel.parcelNumber,
          latitude: parcel.latitude,
          longitude: parcel.longitude,
          pointCount: 1,
          // Absent rather than null for a parcel with no traced shape: Prisma
          // omits an undefined field, so the column takes its own null and the
          // two states — "not traced" and "explicitly nothing" — do not have to
          // be told apart later.
          boundary: boundaries.get(parcel.parcelNumber),
        })),
      );
    }

    if (parcels.length > 0) {
      await this.storage.upload(input.tenantSlug, 'parcels.geojson', this.parcelsGeoJson(parcels));
    }
    if (lines.length > 0) {
      await this.storage.upload(input.tenantSlug, 'cadastre.geojson', this.cadastreGeoJson(lines));
    }
    if (geometry.parcelPolygonsGeoJson) {
      await this.storage.upload(
        input.tenantSlug,
        'parcel-polygons.geojson',
        geometry.parcelPolygonsGeoJson,
      );
    }
    if (geometry.cityBoundaryGeoJson) {
      await this.storage.upload(
        input.tenantSlug,
        'city-boundary.geojson',
        geometry.cityBoundaryGeoJson,
      );
    }

    this.events.emit('cadastre.imported', {
      tenantSlug: input.tenantSlug,
      actorId: input.actor.id,
      actorRole: input.actor.role,
      parcelsImported: parcels.length,
      parcelsSkipped: skipped,
      linesImported: lines.length,
    });

    return {
      parcelsImported: parcels.length,
      parcelsSkipped: skipped,
      linesImported: lines.length,
      shapesTraced: geometry.shapeCount,
      boundaryDerived: geometry.cityBoundaryGeoJson !== null,
    };
  }

  private parse(buffer: Buffer): { type: string; features: unknown[] } {
    let json: unknown;
    try {
      json = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new ValidationError('الملف ليس بصيغة JSON صالحة');
    }

    if (
      typeof json !== 'object' ||
      json === null ||
      (json as { type?: unknown }).type !== 'FeatureCollection' ||
      !Array.isArray((json as { features?: unknown }).features)
    ) {
      throw new ValidationError('الملف يجب أن يكون GeoJSON من نوع FeatureCollection');
    }

    return json as { type: string; features: unknown[] };
  }

  /**
   * A malformed individual feature is skipped rather than failing the whole
   * import — a 4,000-parcel survey export with one bad row should not block
   * the other 3,999 from ever reaching the map.
   */
  private extract(geojson: {
    features?: unknown[];
  }): { parcels: ParsedParcel[]; lines: ParsedLine[]; skipped: number } {
    const parcels: ParsedParcel[] = [];
    const lines: ParsedLine[] = [];
    let skipped = 0;

    for (const feature of geojson.features ?? []) {
      if (typeof feature !== 'object' || feature === null) {
        skipped++;
        continue;
      }

      const { geometry, properties } = feature as {
        geometry?: { type?: string; coordinates?: unknown };
        properties?: Record<string, unknown>;
      };

      if (!geometry || typeof geometry.type !== 'string') {
        skipped++;
        continue;
      }

      if (geometry.type === 'Point') {
        const parcelNumber = properties?.parcelNumber;
        const coordinates = geometry.coordinates;
        if (
          typeof parcelNumber !== 'string' ||
          !parcelNumber.trim() ||
          !Array.isArray(coordinates) ||
          typeof coordinates[0] !== 'number' ||
          typeof coordinates[1] !== 'number'
        ) {
          skipped++;
          continue;
        }
        parcels.push({
          parcelNumber: parcelNumber.trim(),
          longitude: coordinates[0],
          latitude: coordinates[1],
        });
        continue;
      }

      if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
        const layer = typeof properties?.layer === 'string' ? properties.layer : 'default';
        const segments: unknown =
          geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;

        if (!Array.isArray(segments)) {
          skipped++;
          continue;
        }

        for (const segment of segments) {
          if (!Array.isArray(segment)) continue;
          const coords = segment.filter(
            (point): point is [number, number] =>
              Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number',
          );
          if (coords.length >= 2) lines.push({ layer, coordinates: coords });
        }
        continue;
      }

      // Polygons and anything else: not a shape this map draws.
      skipped++;
    }

    return { parcels, lines, skipped };
  }

  private round(value: number): number {
    return Number(value.toFixed(COORDINATE_PRECISION));
  }

  private parcelsGeoJson(parcels: readonly ParsedParcel[]): string {
    return JSON.stringify({
      type: 'FeatureCollection',
      features: parcels.map((parcel) => ({
        type: 'Feature',
        properties: { parcelNumber: parcel.parcelNumber, approximate: false },
        geometry: {
          type: 'Point',
          coordinates: [this.round(parcel.longitude), this.round(parcel.latitude)],
        },
      })),
    });
  }

  private cadastreGeoJson(lines: readonly ParsedLine[]): string {
    const byLayer = new Map<string, [number, number][][]>();
    for (const line of lines) {
      const coordinates = line.coordinates.map(
        ([lng, lat]) => [this.round(lng), this.round(lat)] as [number, number],
      );
      byLayer.set(line.layer, [...(byLayer.get(line.layer) ?? []), coordinates]);
    }

    return JSON.stringify({
      type: 'FeatureCollection',
      features: [...byLayer.entries()].map(([layer, coordinates]) => ({
        type: 'Feature',
        properties: { layer },
        geometry: { type: 'MultiLineString', coordinates },
      })),
    });
  }
}

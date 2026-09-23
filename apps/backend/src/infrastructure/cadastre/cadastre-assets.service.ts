import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { CADASTRE_STORAGE_SERVICE } from '../../domain/interfaces/base-repository.interface';
import type { CadastreStorage } from '../../domain/interfaces/cadastre-storage.interface';

/**
 * Reads the derived cadastre layers the import writes — parcel shapes and the
 * municipality outline — for the code that has to reason about them rather than
 * merely draw them.
 *
 * Backed by S3 (the `CADASTRE_STORAGE_SERVICE` port) rather than local disk:
 * the import endpoint and this read may run in different serverless
 * invocations — even different deployments entirely, once the frontend and
 * backend are separate Vercel projects — so nothing on this process's own
 * filesystem can be trusted to hold what the last import wrote.
 *
 * Cached in memory per tenant, since the zone editor reads these shapes on
 * every save. Invalidated on `cadastre.imported` rather than by a file mtime
 * (there is no local file to stat any more) — the same event
 * `CadastreImportService` already emits for the audit trail.
 */
@Injectable()
export class CadastreAssetsService {
  private readonly logger = new Logger(CadastreAssetsService.name);
  private readonly cache = new Map<string, unknown>();

  constructor(@Inject(CADASTRE_STORAGE_SERVICE) private readonly storage: CadastreStorage) {}

  @OnEvent('cadastre.imported')
  handleImported(event: { tenantSlug: string }): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${event.tenantSlug}:`)) this.cache.delete(key);
    }
  }

  /** Parcel shapes by رقم العقار. Empty when the tenant has no cadastre yet. */
  async getParcelPolygons(tenantSlug: string): Promise<Map<string, Feature<Polygon>>> {
    const collection = await this.read<FeatureCollection>(tenantSlug, 'parcel-polygons.geojson');
    if (!collection) return new Map();

    const byNumber = new Map<string, Feature<Polygon>>();
    for (const feature of collection.features) {
      const parcelNumber = feature.properties?.parcelNumber;
      if (typeof parcelNumber !== 'string' || feature.geometry?.type !== 'Polygon') continue;
      byNumber.set(parcelNumber, feature as Feature<Polygon>);
    }
    return byNumber;
  }

  /**
   * The municipality outline, or null when it has not been derived yet. Callers
   * must read null as "boundary unknown" and skip the containment check, never
   * as "nothing is inside the municipality" — the latter would reject every
   * parcel for a tenant whose cadastre predates this feature.
   */
  async getCityBoundary(tenantSlug: string): Promise<Feature<Polygon> | null> {
    const collection = await this.read<FeatureCollection>(tenantSlug, 'city-boundary.geojson');
    const feature = collection?.features?.[0];
    if (!feature || feature.geometry?.type !== 'Polygon') return null;
    return feature as Feature<Polygon>;
  }

  private async read<T>(tenantSlug: string, fileName: string): Promise<T | null> {
    const key = `${tenantSlug}:${fileName}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit as T;

    const raw = await this.storage.read(tenantSlug, fileName);
    if (raw === null) return null;

    try {
      const value = JSON.parse(raw) as T;
      this.cache.set(key, value);
      return value;
    } catch (error) {
      // A corrupt asset must not take the API down with it: the zone editor
      // degrades to "no shapes known", which its callers already handle.
      this.logger.error(`Failed to parse ${key}: ${(error as Error).message}`);
      return null;
    }
  }
}

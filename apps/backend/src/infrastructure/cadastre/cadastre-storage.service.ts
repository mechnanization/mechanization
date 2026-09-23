import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient, createClient } from '@supabase/supabase-js';
import { CadastreStorage } from '../../domain/interfaces/cadastre-storage.interface';

/**
 * Supabase Storage adapter for a municipality's derived cadastre layers —
 * `cadastre.geojson`, `parcels.geojson`, `parcel-polygons.geojson`,
 * `city-boundary.geojson`.
 *
 * These used to be written to and read from local disk, on the assumption
 * that the process serving `cadastre:import`/the admin upload and the process
 * serving the map were the same machine with the same filesystem. That holds
 * in local dev and a single Docker host; it does not hold once the frontend
 * and backend are each their own Vercel deployment, each with its own
 * ephemeral, read-only-outside-`/tmp` filesystem — a write from one process
 * is simply invisible to the other. Supabase Storage is shared state both
 * sides already have credentials for.
 *
 * A separate bucket from `documents` (see `SupabaseStorageService`) rather
 * than a folder inside it: these files are municipality-wide cartography, not
 * a citizen's private upload — `RegistrationController.checkPropertyNumber`
 * already treats the cadastre as "the municipality's own public register" —
 * so the bucket is public, letting anyone with the object path read it
 * without a signed URL, which private documents must never allow.
 */
@Injectable()
export class CadastreStorageService implements CadastreStorage {
  private readonly logger = new Logger(CadastreStorageService.name);
  private readonly client: SupabaseClient;
  private readonly bucket = 'cadastre';

  constructor(config: ConfigService) {
    this.client = createClient(
      config.getOrThrow<string>('SUPABASE_URL'),
      config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }

  private path(tenantSlug: string, assetName: string): string {
    return `${tenantSlug}/${assetName}`;
  }

  /** Overwrites whatever this tenant last imported for `assetName`. */
  async upload(tenantSlug: string, assetName: string, contents: string): Promise<void> {
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(this.path(tenantSlug, assetName), contents, {
        contentType: 'application/geo+json',
        // A re-import replaces last time's layer; it does not sit beside it.
        upsert: true,
      });

    if (error) {
      this.logger.error(`Upload failed for ${tenantSlug}/${assetName}: ${error.message}`);
      throw error;
    }
  }

  /** The raw text, or null when this tenant has not imported this layer yet. */
  async read(tenantSlug: string, assetName: string): Promise<string | null> {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .download(this.path(tenantSlug, assetName));

    if (error || !data) return null;
    return data.text();
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient, createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { ValidationError } from '../../../domain/errors/domain-error';
import {
  ImageStorageService,
  UploadRequest,
} from '../../../domain/interfaces/image-storage-service.interface';

/**
 * Supabase Storage adapter.
 *
 * Supabase is still used for storage after v2 dropped Supabase Auth — the two
 * were independent, and object storage carries none of the two-token-formats
 * problem that made the auth coupling worth removing.
 */
@Injectable()
export class SupabaseStorageService implements ImageStorageService {
  private readonly logger = new Logger(SupabaseStorageService.name);
  private readonly client: SupabaseClient;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    this.client = createClient(
      config.getOrThrow<string>('SUPABASE_URL'),
      // Service-role key: server-side only. If this ever reaches a browser
      // bundle, every municipality's documents are readable by anyone.
      config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    this.bucket = config.get<string>('SUPABASE_STORAGE_BUCKET', 'documents');
  }

  async upload(request: UploadRequest): Promise<{ storagePath: string }> {
    const path = this.buildPath(request);

    const { error } = await this.client.storage.from(this.bucket).upload(path, request.content, {
      contentType: request.mimeType,
      // Never overwrite: a generated UUID collision would otherwise silently
      // replace one citizen's document with another's.
      upsert: false,
    });

    if (error) {
      this.logger.error(`Upload failed for ${path}: ${error.message}`);
      throw new ValidationError({
        code: 'FILE_UPLOAD_FAILED',
        message: 'The upload to Supabase failed',
      });
    }

    return { storagePath: path };
  }

  /**
   * Documents are never public. Staff get a URL that expires in minutes, so a
   * link pasted into a chat or left in browser history stops working long
   * before it can circulate.
   */
  async createSignedUrl(storagePath: string, expiresInSeconds: number): Promise<string> {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(storagePath, expiresInSeconds);

    if (error || !data) {
      this.logger.error(`Signing failed for ${storagePath}: ${error?.message}`);
      throw new ValidationError({
        code: 'FILE_OPEN_FAILED',
        message: 'The signed URL could not be created',
      });
    }

    return data.signedUrl;
  }

  async remove(storagePath: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).remove([storagePath]);
    if (error) {
      this.logger.error(`Delete failed for ${storagePath}: ${error.message}`);
    }
  }

  /**
   * `{tenantSlug}/{citizenId}/{registrationId}/[{propertyId}/]{uuid}{ext}`
   *
   * The tenant slug leads so one municipality's objects can never collide with
   * another's, and so a storage-level policy could be scoped by prefix later
   * without moving a single object.
   */
  private buildPath(request: UploadRequest): string {
    const extension = extname(request.fileName).toLowerCase().slice(0, 10) || '.bin';
    const segments = [
      request.tenantSlug,
      request.citizenId,
      request.registrationId,
      ...(request.propertyEntryId ? [request.propertyEntryId] : []),
      // The citizen's own filename is discarded rather than sanitised —
      // "بطاقة هوية.jpg" is both a path-traversal surface and a description of
      // the contents sitting in an object key.
      `${randomUUID()}${extension}`,
    ];

    return segments.join('/');
  }
}

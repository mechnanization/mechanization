import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ValidationError } from '../../domain/errors/domain-error';
import type { RequestFilePut, RequestFileStorage } from '../../domain/interfaces/request-file-storage.interface';
import { S3Connection, createS3Connection } from './s3-connection';

/**
 * S3 adapter for the papers on a municipal request (migration 0092) — the same
 * private documents bucket as `S3StorageService`, under keys of their own:
 *
 *   `{tenantSlug}/requests/{requestId}/{uuid}{ext}`
 *
 * The tenant leads, as everywhere in the bucket. `requests` cannot collide with
 * the registration documents' keys, whose second segment is a citizen's uuid.
 * The extension comes from the sniffed bytes and the name is a fresh uuid: the
 * citizen's own file name never reaches a key.
 *
 * Like the documents adapter it connects on first use, so the app boots without
 * AWS settings (a developer machine has none, by design) and only a storage
 * call fails, with a coded error the screens translate.
 */
@Injectable()
export class S3RequestFileStorageService implements RequestFileStorage {
  private readonly logger = new Logger(S3RequestFileStorageService.name);
  private connection?: S3Connection;

  constructor(private readonly config: ConfigService) {}

  private get s3(): S3Connection {
    return (this.connection ??= createS3Connection(this.config, 'S3_DOCUMENTS_BUCKET'));
  }

  async put(file: RequestFilePut): Promise<{ storagePath: string }> {
    const path = `${file.tenantSlug}/requests/${file.requestId}/${randomUUID()}${file.extension}`;
    try {
      const { client, bucket } = this.s3;
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: path,
          Body: file.content,
          ContentType: file.mimeType,
          // Written once: a key that exists is refused (412), never overwritten
          // — see `S3StorageService.upload` for the reasoning.
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      // The key goes to the log only: it names the request.
      this.logger.error(`Upload failed for ${path}: ${errorMessage(error)}`);
      throw new ValidationError({ code: 'FILE_UPLOAD_FAILED', message: 'The file could not be stored.' });
    }
    return { storagePath: path };
  }

  /** HEAD first, so a key that does not exist fails here instead of signing a dead link. */
  async createSignedUrl(storagePath: string, expiresInSeconds: number): Promise<string> {
    try {
      const { client, bucket } = this.s3;
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: storagePath }));
      return await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: storagePath }), {
        expiresIn: expiresInSeconds,
      });
    } catch (error) {
      this.logger.error(`Signing failed for ${storagePath}: ${errorMessage(error)}`);
      throw new ValidationError({ code: 'FILE_OPEN_FAILED', message: 'The file could not be opened.' });
    }
  }

  /** Logs and swallows: it only ever undoes a write whose row was not recorded. */
  async remove(storagePath: string): Promise<void> {
    try {
      const { client, bucket } = this.s3;
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storagePath }));
    } catch (error) {
      this.logger.error(`Delete failed for ${storagePath}: ${errorMessage(error)}`);
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
  }
  return String(error);
}

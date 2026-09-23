import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { ValidationError } from '../../domain/errors/domain-error';
import {
  ImageStorageService,
  UploadRequest,
} from '../../domain/interfaces/image-storage-service.interface';
import { S3Connection, createS3Connection } from './s3-connection';

/**
 * S3 adapter for citizen documents — identity scans, civil-record extracts,
 * proof of residence.
 *
 * It stands in for `SupabaseStorageService` object for object. The documents
 * already in the bucket were copied across under the keys `buildPath` below
 * produces, and that function is a verbatim copy for exactly that reason: a
 * reordered segment or a differently-normalised extension would not fail, it
 * would quietly start writing new objects beside the migrated ones and leave
 * every `storagePath` already recorded in the database pointing at nothing.
 *
 * The bucket has "Block all public access" on and nothing here ever sets an
 * ACL. Reads leave only through `createSignedUrl`, so the only way to see a
 * scan of someone's national ID is a URL that stops working within minutes —
 * the cadastre bucket is the public one, and these two must never be confused,
 * which is why the bucket name is read from config and never written down here.
 */
@Injectable()
export class S3StorageService implements ImageStorageService {
  private readonly logger = new Logger(S3StorageService.name);
  private connection?: S3Connection;

  constructor(private readonly config: ConfigService) {}

  /**
   * Resolved on first use. `createS3Connection` explains why this is not the
   * constructor's job — briefly: this provider is built during bootstrap in
   * every environment, including the developer machines that must never hold a
   * credential for the production documents bucket.
   */
  private get s3(): S3Connection {
    return (this.connection ??= createS3Connection(this.config, 'S3_DOCUMENTS_BUCKET'));
  }

  async upload(request: UploadRequest): Promise<{ storagePath: string }> {
    const path = this.buildPath(request);

    try {
      const { client, bucket } = this.s3;
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: path,
          Body: request.content,
          ContentType: request.mimeType,
          // The S3 equivalent of Supabase's `upsert: false` — a conditional
          // write, generally available since November 2024 and present on
          // PutObjectRequest in the installed SDK typings.
          //
          // Without it PutObject overwrites whatever is already at the key,
          // silently and with a 200: a UUID collision would replace one
          // citizen's identity document with another's, and the only trace
          // would be a `documents` row whose scan is now someone else's. With
          // it S3 answers 412 PreconditionFailed and the upload fails, which is
          // the outcome we want — a refused write can be retried, an
          // overwritten object cannot be recovered.
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      // The path goes to the log and never into the thrown error: it carries
      // the citizen id and the registration id, and this message is rendered in
      // a browser. A 412 landing here means either a UUID collision or a
      // replayed write — both worth reading in the log, neither worth
      // explaining to the person at the counter.
      this.logger.error(`Upload failed for ${path}: ${errorMessage(error)}`);
      throw new ValidationError('تعذّر رفع الملف — يرجى المحاولة مرة أخرى');
    }

    return { storagePath: path };
  }

  /**
   * Documents are never public. Staff get a URL that expires in minutes, so a
   * link pasted into a chat or left in browser history stops working long
   * before it can circulate.
   *
   * The `HeadObject` is not ceremony. Presigning is local arithmetic — no call
   * reaches S3 — so a signature over a key that does not exist is minted just
   * as happily as one that does. Without the head request this method cannot
   * fail, and a document whose key did not survive the migration out of
   * Supabase would return a valid-looking URL that renders S3's XML error page
   * in the officer's browser, having already emitted the `document.viewed`
   * audit event for a read that never happened. Supabase's `createSignedUrl`
   * was a round trip and did surface the missing object; this keeps that.
   */
  async createSignedUrl(storagePath: string, expiresInSeconds: number): Promise<string> {
    const { client, bucket } = this.s3;

    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: storagePath }));

      return await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: storagePath }), {
        expiresIn: expiresInSeconds,
      });
    } catch (error) {
      this.logger.error(`Signing failed for ${storagePath}: ${errorMessage(error)}`);
      throw new ValidationError('تعذّر فتح الملف');
    }
  }

  /**
   * Logs and swallows, as the Supabase adapter did — this is the contract the
   * port was written to, not an oversight being carried forward.
   *
   * By the time a delete is issued the decision it belongs to has already been
   * taken and recorded; throwing here would turn a completed operation into a
   * failed one and invite the caller to retry work that has already happened.
   * The object left behind is private, unreferenced and reapable by a lifecycle
   * rule, so the cost of swallowing is a line in the log, and the cost of
   * throwing is a user-visible failure for something that already succeeded.
   */
  async remove(storagePath: string): Promise<void> {
    try {
      const { client, bucket } = this.s3;
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storagePath }));
    } catch (error) {
      this.logger.error(`Delete failed for ${storagePath}: ${errorMessage(error)}`);
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

/**
 * The SDK rejects with an `S3ServiceException` whose `name` is the wire error
 * code ('PreconditionFailed', 'AccessDenied', 'NoSuchBucket'), and that name is
 * usually the only part worth reading — the message for a 412 is boilerplate
 * about preconditions. Anything non-Error is stringified rather than allowed to
 * reach the log as "[object Object]", which is how a misconfiguration ends up
 * costing an afternoon.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
  }

  return String(error);
}

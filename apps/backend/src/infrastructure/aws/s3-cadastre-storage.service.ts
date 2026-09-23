import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CadastreStorage } from '../../domain/interfaces/cadastre-storage.interface';
import { S3Connection, createS3Connection } from './s3-connection';

/**
 * S3 adapter for a municipality's derived cadastre layers.
 *
 * The keys are byte-for-byte the ones the Supabase bucket used, because the
 * objects were copied across unchanged: `{tenantSlug}/{assetName}`, e.g.
 * `albazourieh/cadastre.geojson`. That makes the key shape an address rather
 * than a convention this class may improve on — a tidier layout here does not
 * fail loudly, it reads back as a municipality that never imported a cadastre,
 * and its map comes up blank.
 *
 * Region and bucket come from configuration and never from a literal. The same
 * build runs against more than one bucket, and a name compiled into the source
 * is how one environment quietly serves another's cartography.
 *
 * This bucket is public-read, unlike the documents bucket, which has "block all
 * public access" on. The asymmetry is the whole reason they are two buckets and
 * not two prefixes: these files are the municipality's own published
 * cartography, while a document is a scan of somebody's identity papers.
 * Nothing citizen-identifying may ever be written through this class.
 */
@Injectable()
export class S3CadastreStorageService implements CadastreStorage {
  private readonly logger = new Logger(S3CadastreStorageService.name);
  private connection?: S3Connection;

  constructor(private readonly config: ConfigService) {}

  /**
   * Resolved on first use rather than in the constructor — `createS3Connection`
   * carries the reasoning, which is about developer machines never needing a
   * credential for a production bucket in order to boot the API.
   */
  private get s3(): S3Connection {
    return (this.connection ??= createS3Connection(this.config, 'S3_CADASTRE_BUCKET'));
  }

  /** `{tenantSlug}/{assetName}` — the key the already-uploaded objects live at. */
  private path(tenantSlug: string, assetName: string): string {
    return `${tenantSlug}/${assetName}`;
  }

  /** Overwrites whatever this tenant last imported for `assetName`. */
  async upload(tenantSlug: string, assetName: string, contents: string): Promise<void> {
    const key = this.path(tenantSlug, assetName);

    try {
      const { client, bucket } = this.s3;
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: contents,
          ContentType: 'application/geo+json',
          // Deliberately no `IfNoneMatch: '*'` here, in contrast with the
          // documents adapter, which must never overwrite: a document key ends
          // in a random UUID, so a collision there would replace one citizen's
          // scan with another's. A cadastre key is stable by design and a
          // re-import is a correction — staff redraw a boundary precisely
          // because last time's was wrong. The Supabase version passed
          // `upsert: true` for this reason; refusing the overwrite would freeze
          // every municipality on its first import.
        }),
      );
    } catch (error) {
      // Rethrown raw, as the Supabase version did. Import is a staff action
      // with somebody watching it, and its caller turns the throw into a
      // visible failure — far better than a silent half-imported map.
      this.logger.error(`Upload failed for ${key}: ${(error as Error).message}`);
      throw error;
    }
  }

  /** The raw text, or null when this tenant has not imported this layer yet. */
  async read(tenantSlug: string, assetName: string): Promise<string | null> {
    const key = this.path(tenantSlug, assetName);

    try {
      const { client, bucket } = this.s3;
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );

      if (!response.Body) {
        // A success with no body is not a shape S3 is meant to produce. It is
        // a fault, so it is logged like one rather than filed as an absent
        // layer — see the note below on why that distinction matters.
        this.logger.error(`Read returned no body for ${key}`);
        return null;
      }

      return await response.Body.transformToString();
    } catch (error) {
      // An absent object is the ordinary state of a municipality that has not
      // imported yet, so it is not worth a line in the log on every map load.
      if (this.isMissingObject(error)) return null;

      // Everything else — throttling, expired credentials, an S3 outage — also
      // returns null, because every caller of this port was written against a
      // Supabase version that returned null on any error and none of them
      // handle a throw. But it is logged at error level first, and the missing
      // case above is not, because null erases the difference for everyone
      // downstream: without this line an outage looks exactly like "this
      // municipality has no cadastre". That is the difference between a map
      // that is visibly degraded and one that is confidently wrong.
      this.logger.error(`Read failed for ${key}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * S3 names an absent object `NoSuchKey` on GET, and a HEAD-shaped 404 arrives
   * as `NotFound`; those two, and nothing else, mean "this layer was never
   * imported".
   *
   * The status code alone is deliberately **not** enough. `NoSuchBucket` is
   * also a 404, so matching on `$metadata.httpStatusCode` would file a wrong or
   * inaccessible `S3_CADASTRE_BUCKET` as "this municipality has no cadastre" —
   * silently, on every map load, with no line in the log to find later. The
   * status is consulted only when the error carries no name to judge it by.
   *
   * Both ways of getting this wrong cost something: too narrow and a
   * municipality without a cadastre logs an error on every map load until the
   * noise is ignored; too wide and a real fault is filed as "not imported yet".
   */
  private isMissingObject(error: unknown): boolean {
    const candidate = error as
      | { name?: string; $metadata?: { httpStatusCode?: number } }
      | null
      | undefined;

    // Every `Error` carries the name 'Error', so a bare name is not evidence
    // of anything — only a *specific* one is. The SDK always supplies the wire
    // code here ('NoSuchKey', 'NoSuchBucket', 'AccessDenied'); anything else
    // reaching this point is a generic throw, and for those the status is all
    // there is to go on.
    const name = candidate?.name;
    if (name && name !== 'Error') {
      return name === 'NoSuchKey' || name === 'NotFound';
    }

    return candidate?.$metadata?.httpStatusCode === 404;
  }
}

import { Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BackupService } from '../../application/features/backup/backup.service';
import { CurrentActor } from '../decorators/current-actor.decorator';
import { StaffActor } from '../../application/common/actor';
import { Roles } from '../decorators/roles.decorator';
import { ValidationError } from '../../application/common/exceptions';

/**
 * Taking a restorable snapshot of a municipality, and putting one back.
 *
 * SUPER_ADMIN at the controller. Export is the whole register in one file —
 * every citizen, every document number, every payment — so it is a bigger
 * disclosure than any read route on this system, and restore replaces that
 * register outright. An AUDITOR reads the books; neither of these is reading.
 *
 * The snapshot travels as raw gzip bytes rather than as a file upload. This app
 * has no multipart parser, and adding one for a single route would be a
 * dependency plus an upload surface on every other route. Sending it as
 * `application/gzip` also means no body parser touches it — see `readBody`.
 */
@Roles('SUPER_ADMIN')
@Controller('t/:tenantSlug/backup')
export class BackupController {
  constructor(private readonly backup: BackupService) {}

  /**
   * The restorable snapshot, as a gzip download.
   *
   * Streamed straight to the response rather than returned as JSON: this is a
   * file the municipality keeps, and wrapping it in an envelope would mean the
   * browser saving something no tool can open.
   */
  @Get('export')
  async export(@Res() response: Response): Promise<void> {
    const { buffer, manifest } = await this.backup.exportSnapshot();
    const stamp = manifest.createdAt.slice(0, 19).replace(/[:T]/g, '-');

    response.setHeader('Content-Type', 'application/gzip');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${manifest.tenantSlug}-snapshot-${stamp}.json.gz"`,
    );
    // The row counts, without unpacking the file — enough for the UI to report
    // what it just downloaded, and for an operator to eyeball a suspicious one.
    response.setHeader('X-Snapshot-Counts', JSON.stringify(manifest.counts));
    response.send(buffer);
  }

  /**
   * Writes a snapshot back, replacing what is there.
   *
   * `dryRun` defaults to **true**. A caller that wants the destructive version
   * has to say so, because the failure mode of the other default is a
   * municipality's register replaced by a mis-click, and there is no undo.
   */
  @Post('restore')
  async restore(
    @Req() request: Request,
    @Query('confirm') confirm: string | undefined,
    @Query('dryRun') dryRun: string | undefined,
    @CurrentActor() actor: StaffActor,
  ) {
    const gzipped = await readBody(request);

    return this.backup.restore(
      gzipped,
      {
        confirmTenantSlug: confirm ?? '',
        // Anything other than the exact string `false` is a rehearsal.
        dryRun: dryRun !== 'false',
      },
      actor,
    );
  }
}

/** 64 MB gzipped, which is a very large municipality and a hard stop. */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

/**
 * Collects the raw request body.
 *
 * Read straight off the stream rather than through a body parser. The global
 * JSON parser is registered for `application/json` and skips anything else, so
 * a request sent as `application/gzip` arrives here unconsumed — which is what
 * lets a snapshot exceed the deliberate 1 MB JSON limit without raising that
 * limit for every other route on the system. It also saves the third again in
 * size that base64 inside a JSON envelope would have cost.
 *
 * The cap is enforced as bytes arrive, not after: the point of a limit is to
 * stop reading, and checking the length of a buffer already in memory would
 * have allowed exactly the exhaustion it exists to prevent.
 */
function readBody(request: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_SNAPSHOT_BYTES) {
        request.destroy();
        reject(new ValidationError({
          code: 'BACKUP_TOO_LARGE',
          message: 'The backup is over the size limit',
        }));
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (size === 0) {
        reject(new ValidationError({
          code: 'BACKUP_FILE_MISSING',
          message: 'No backup attached',
        }));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    request.on('error', () => reject(new ValidationError({
      code: 'BACKUP_READ_FAILED',
      message: 'The backup could not be read',
    })));
  });
}

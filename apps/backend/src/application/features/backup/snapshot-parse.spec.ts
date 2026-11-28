import { gzipSync } from 'node:zlib';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { ValidationError } from '../../common/exceptions';
import { BackupService } from './backup.service';

/**
 * Reading a snapshot back in.
 *
 * `BackupController` caps the upload at 64 MB as bytes arrive, which bounds
 * what is *read* and says nothing about what is *allocated*. `parse()` called
 * `gunzipSync` with no output limit, and gzip reaches roughly 1000:1 on
 * repetitive input — so an upload inside the limit could ask for tens of
 * gigabytes of heap in one synchronous call, inside a 1 GB function. The cap
 * that matters is on the decompressed size.
 *
 * `parse` is private, so these go through `restore`, which calls it before it
 * touches the database. Every case here fails during parsing, so the tenant
 * client is never reached and a stub for it is enough.
 */
function build(): BackupService {
  return new BackupService(
    {
      require: () => ({
        tenantSlug: 'albazourieh',
        tenantId: 'tenant-1',
        schemaName: 'tenant_albazourieh',
        prisma: {},
      }),
      get prisma() {
        throw new Error('the database must not be reached while parsing');
      },
    } as unknown as TenantContextService,
    { emit: jest.fn() } as unknown as EventEmitter2,
  );
}

const OPTIONS = { confirmTenantSlug: 'albazourieh', dryRun: true };
const ACTOR = { id: 'staff-1', role: 'SUPER_ADMIN' as const };

/**
 * A zip bomb in the shape this route would actually receive: highly repetitive
 * input, which gzip packs to a tiny fraction of its size.
 *
 * 640 MB rather than a round gigabyte — enough to clear the 512 MB inflate
 * ceiling with margin, and a third less allocation and compression per run.
 * Built once and memoised: constructing it is the slowest thing in this file by
 * two orders of magnitude, and both tests want the identical bytes.
 */
let bombCache: Buffer | undefined;
function bomb(): Buffer {
  bombCache ??= gzipSync(Buffer.alloc(640 * 1024 * 1024));
  return bombCache;
}

describe('BackupService.restore — the snapshot is bounded before it is parsed', () => {
  it('refuses an archive that inflates past the ceiling', async () => {
    // Comfortably inside the 64 MB upload limit, and far past the inflate
    // ceiling — which is precisely why the upload limit was not enough.
    expect(bomb().length).toBeLessThan(64 * 1024 * 1024);

    await expect(build().restore(bomb(), OPTIONS, ACTOR)).rejects.toBeInstanceOf(ValidationError);
  });

  it('reports a bomb as an invalid backup rather than crashing', async () => {
    // The limit lands in the existing catch, so an operator is told the file is
    // not a valid backup instead of the process dying on an allocation.
    await expect(build().restore(bomb(), OPTIONS, ACTOR)).rejects.toThrow(/تعذّر فك الضغط/);
  });

  it('still refuses input that is not gzip at all', async () => {
    await expect(
      build().restore(Buffer.from('not gzip'), OPTIONS, ACTOR),
    ).rejects.toThrow(/تعذّر فك الضغط/);
  });

  it('still refuses gzip that is not JSON', async () => {
    await expect(
      build().restore(gzipSync(Buffer.from('{{{')), OPTIONS, ACTOR),
    ).rejects.toThrow(/غير صالح/);
  });

  it('accepts an ordinary snapshot through the decompression step', async () => {
    // Well under the ceiling: this one gets past `parse` and fails later, on
    // the version check — which is the proof that the limit is not simply
    // rejecting everything.
    const snapshot = gzipSync(
      Buffer.from(
        JSON.stringify({
          manifest: { version: 99, tenantSlug: 'albazourieh', createdAt: '', migrations: [], counts: {} },
          tables: {},
        }),
      ),
    );

    await expect(build().restore(snapshot, OPTIONS, ACTOR)).rejects.toThrow(/إصدار النسخة/);
  });
});

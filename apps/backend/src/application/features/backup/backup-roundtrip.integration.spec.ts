import { gunzipSync, gzipSync } from 'node:zlib';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { BackupService } from './backup.service';

/**
 * Export → mutate → restore, against a real Postgres schema.
 *
 * This is the test that had to exist against a database rather than a mock, and
 * the defect it pins is exactly why. Restore emptied every table in
 * `TABLE_ORDER`, which included `audit_log_entries` — and `0001_init` installs a
 * `BEFORE DELETE` trigger that raises on that table, deliberately, so that a
 * compromised administrator cannot rewrite the trail. Every restore in a
 * municipality that had ever recorded an action therefore aborted.
 *
 * No unit test with a stubbed Prisma client could have caught it: the trigger
 * lives in the database, and a mock has no triggers. The dry run made it worse
 * by only counting rows, so the rehearsal passed and the real run failed — the
 * municipality would have found out at the moment it needed the backup.
 *
 * Set `TEST_DATABASE_URL` to run it. CI always does; locally:
 *   docker run -d --name mech-test-pg -e POSTGRES_PASSWORD=test \
 *     -e POSTGRES_USER=test -e POSTGRES_DB=test -p 55432:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgresql://test:test@localhost:55432/test pnpm test
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_roundtrip_spec';

// `describe.skip` rather than a silent pass: a suite that quietly does nothing
// when a variable is unset is one that stays broken without anyone noticing.
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * The schema-building hook gets its own, larger budget.
 *
 * `beforeAll` drops the spec's schema and replays the **whole migration chain**
 * — thirty-odd hand-written files — against whatever `TEST_DATABASE_URL` points
 * at, which in practice is a hosted Postgres a few hundred milliseconds away.
 * At 60s that hook fails on a slow link while every test in the suite would
 * have passed, and a suite that reports "failed to run" for a network hiccup is
 * a suite people learn to re-run rather than read.
 *
 * The per-test budget stays at 60s: an individual assertion taking a minute is
 * a real problem, and this must not hide it.
 */
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('BackupService — export and restore round-trip', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let service: BackupService;
  let emit: jest.Mock;

  const citizenId = '11111111-1111-4111-8111-111111111111';
  const inspectorId = '33333333-3333-4333-8333-333333333333';

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    // Idempotent: a previous aborted run must not leave this suite unable to
    // start, which is the failure that makes people stop running it.
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);

    emit = jest.fn();
    service = new BackupService(
      {
        require: () => ({
          tenantId: 'tenant-1',
          tenantSlug: 'roundtrip',
          schemaName: SCHEMA,
          prisma: db,
        }),
        get prisma() {
          return db;
        },
        /*
          Read directly by `appliedMigrations`, which qualifies its raw query
          with it rather than trusting `search_path` (`tenant-schema-ref.ts`).
          The `require()` above returns it too, but a getter on the stub is what
          the service actually touches.
        */
        schemaName: SCHEMA,
      } as unknown as TenantContextService,
      { emit } as unknown as EventEmitter2,
    );
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    /*
      The same budget as the hook that built it: this drops the schema CASCADE
      over the same link, and a teardown that times out is reported as "Test
      suite failed to run" even when every test in the file passed — which reads
      as a broken suite rather than a slow one.
    */
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  beforeEach(async () => {
    // Rebuilt per test so each one starts from the same register. The audit
    // trail is deliberately *not* cleared — it cannot be, which is the point.
    /*
      No `paymentTransaction` anywhere in this fixture, and that is not an
      oversight. `0017_payment_ledger` makes the table append-only, so a row
      created here could never be removed — and because
      `payment_transactions.paymentId` cascades from `citizen_payments`, the
      very next `citizenPayment.deleteMany({})` below would raise
      "payment_transactions is append-only" and break every later test.
      That is the same reason `BackupService.restore` cannot currently run for
      a municipality that has taken a payment; see the note beside
      NEVER_RESTORED in backup.service.ts.
    */
    await db.inspectorPayout.deleteMany({});
    await db.citizenPayment.deleteMany({});
    await db.user.deleteMany({});

    await db.user.create({
      data: {
        id: citizenId,
        kind: 'CITIZEN',
        tenantSlug: 'roundtrip',
        firstName: 'علي',
        lastName: 'خليل',
        phone: '+96103123456',
        referenceNumber: 'RTP-2608-ABC234',
      },
    });
    await db.user.create({
      data: {
        id: inspectorId,
        kind: 'STAFF',
        tenantSlug: 'roundtrip',
        firstName: 'سمير',
        lastName: 'حيدر',
      },
    });
    await db.citizenPayment.create({
      data: {
        citizenId,
        title: 'رسم القيمة التأجيرية',
        amount: 100_000,
        dueDate: new Date('2026-01-31T00:00:00.000Z'),
      },
    });

    await db.inspectorPayout.create({
      data: { inspectorId, amount: 1, reference: 'RTP-PAYOUT-1' },
    });
    await db.auditLogEntry.create({
      data: { actorType: 'STAFF', action: 'SNAPSHOT_TAKEN', entityType: 'Tenant' },
    });
  });

  const OPTIONS = { confirmTenantSlug: 'roundtrip', dryRun: false };
  const ACTOR = { id: '22222222-2222-4222-8222-222222222222', role: 'SUPER_ADMIN' };

  it('restores a register that was emptied after the snapshot', async () => {
    const { buffer } = await service.exportSnapshot();

    // Everything gone — the disaster the backup exists for.
    await db.citizenPayment.deleteMany({});
    await db.user.deleteMany({});
    expect(await db.user.count()).toBe(0);

    const report = await service.restore(buffer, OPTIONS, ACTOR);

    expect(report.dryRun).toBe(false);
    // The citizen and the inspector the payout belongs to.
    expect(await db.user.count()).toBe(2);
    expect(await db.citizenPayment.count()).toBe(1);

    const restored = await db.user.findUniqueOrThrow({ where: { id: citizenId } });
    expect(restored.referenceNumber).toBe('RTP-2608-ABC234');
    // Arabic survives the JSON + gzip round trip.
    expect(restored.firstName).toBe('علي');

    const payment = await db.citizenPayment.findFirstOrThrow();
    // Decimal survives it too — as a string through JSON, back to Decimal here.
    expect(Number(payment.amount)).toBe(100_000);
  }, 60_000);

  it('carries inspector payouts through a restore', async () => {
    const { buffer, manifest } = await service.exportSnapshot();

    expect(manifest.counts.inspectorPayout).toBe(1);

    /*
      The disaster as it actually reached this table: nothing deletes a payout
      directly. Emptying `users` cascades into `inspector_payouts` via
      `inspectorId`. Before it was in `TABLE_ORDER`, restore did exactly this
      and then never wrote it back — and reported success.
    */
    await db.citizenPayment.deleteMany({});
    await db.user.deleteMany({});
    expect(await db.inspectorPayout.count()).toBe(0);

    const report = await service.restore(buffer, OPTIONS, ACTOR);

    expect(report.written.inspectorPayout).toBe(1);
    expect(await db.inspectorPayout.count()).toBe(1);

    const payout = await db.inspectorPayout.findFirstOrThrow();
    expect(payout.inspectorId).toBe(inspectorId);
    expect(Number(payout.amount)).toBe(1);
    expect(payout.reference).toBe('RTP-PAYOUT-1');
  }, 60_000);

  it('refuses a v2 snapshot, which predates inspectorPayout', async () => {
    const { buffer } = await service.exportSnapshot();
    const snapshot = JSON.parse(gunzipSync(buffer).toString('utf8')) as {
      manifest: { version: number };
      tables: Record<string, unknown>;
    };

    snapshot.manifest.version = 2;
    delete snapshot.tables.inspectorPayout;
    const stale = gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'));

    /*
      Not a formality. Restore empties every table in `TABLE_ORDER` before it
      writes, so accepting a v2 file would delete every recorded commission and
      write nothing back. The version gate is the whole of what stands between
      a pre-v3 snapshot and that outcome, so it is pinned here.
    */
    await expect(service.restore(stale, OPTIONS, ACTOR)).rejects.toThrow();
    expect(await db.inspectorPayout.count()).toBe(1);
  }, 60_000);

  it('restores over a register that has since been modified', async () => {
    const { buffer } = await service.exportSnapshot();

    await db.user.update({
      where: { id: citizenId },
      data: { firstName: 'اسم-خاطئ' },
    });
    await db.citizenPayment.updateMany({ data: { paidAmount: 40_000 } });

    await service.restore(buffer, OPTIONS, ACTOR);

    const restored = await db.user.findUniqueOrThrow({ where: { id: citizenId } });
    expect(restored.firstName).toBe('علي');
    const payment = await db.citizenPayment.findFirstOrThrow();
    expect(Number(payment.paidAmount)).toBe(0);
  }, 60_000);

  it('leaves the audit trail standing across a restore', async () => {
    const before = await db.auditLogEntry.count();
    expect(before).toBeGreaterThan(0);

    const { buffer } = await service.exportSnapshot();
    await db.auditLogEntry.create({
      data: { actorType: 'STAFF', action: 'SOMETHING_AFTER_THE_SNAPSHOT', entityType: 'Tenant' },
    });

    await service.restore(buffer, OPTIONS, ACTOR);

    // The trail is history, not state: rolling the register back to Tuesday
    // does not make Wednesday's actions un-happen.
    const after = await db.auditLogEntry.findMany({ select: { action: true } });
    expect(after.map((row) => row.action)).toContain('SOMETHING_AFTER_THE_SNAPSHOT');
    expect(after.length).toBeGreaterThanOrEqual(before + 1);
  }, 60_000);

  it('records the restore itself', async () => {
    const { buffer } = await service.exportSnapshot();
    emit.mockClear();

    await service.restore(buffer, OPTIONS, ACTOR);

    // `AuditService` subscribes to this and writes REGISTER_RESTORED; the
    // emission is what this layer owes.
    expect(emit).toHaveBeenCalledWith(
      'backup.restored',
      expect.objectContaining({ actorId: ACTOR.id, tenantSlug: 'roundtrip' }),
    );
  }, 60_000);

  it('keeps the audit trail append-only — the trigger is still armed', async () => {
    // The guard on the fix. Excluding the trail from restore is only correct
    // while deleting from it is still impossible; a later change that "fixed"
    // restore by dropping this trigger would pass every test above and quietly
    // remove the reason the trail is worth anything.
    await expect(db.auditLogEntry.deleteMany({})).rejects.toThrow(/append-only/i);

    const [row] = await db.auditLogEntry.findMany({ take: 1 });
    await expect(
      db.auditLogEntry.update({ where: { id: row.id }, data: { action: 'REWRITTEN' } }),
    ).rejects.toThrow(/append-only/i);
  }, 60_000);

  it('refuses a snapshot carrying an audit table', async () => {
    const { buffer } = await service.exportSnapshot();
    const { gunzipSync, gzipSync } = await import('node:zlib');

    const snapshot = JSON.parse(gunzipSync(buffer).toString('utf8'));
    expect(snapshot.tables.auditLogEntry).toBeUndefined();

    // Hand-edited to smuggle one back in: refused as an unknown table rather
    // than silently ignored.
    snapshot.tables.auditLogEntry = [];
    const tampered = gzipSync(Buffer.from(JSON.stringify(snapshot)));

    await expect(service.restore(tampered, OPTIONS, ACTOR)).rejects.toThrow(/غير معروفة/);
  }, 60_000);

  it('refuses a snapshot from another municipality', async () => {
    const { gunzipSync, gzipSync } = await import('node:zlib');
    const { buffer } = await service.exportSnapshot();

    const snapshot = JSON.parse(gunzipSync(buffer).toString('utf8'));
    snapshot.manifest.tenantSlug = 'somewhere-else';
    const foreign = gzipSync(Buffer.from(JSON.stringify(snapshot)));

    await expect(service.restore(foreign, OPTIONS, ACTOR)).rejects.toThrow(/somewhere-else/);
    // And nothing was touched on the way to refusing.
    expect(await db.user.count()).toBe(2);
  }, 60_000);
});

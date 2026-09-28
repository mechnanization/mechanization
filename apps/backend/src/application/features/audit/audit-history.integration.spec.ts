import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from './audit.service';

/**
 * «سجل التعديلات» against a real Postgres.
 *
 * A record's history is opened to every role that can open the record, so what
 * it leaves out is the point: who viewed the file, how it is being reviewed,
 * and the repair snapshots a trail keeps. Each of those is a row here, and the
 * test is that only the changes come back — redacted, and without the request's
 * origin.
 *
 * Set `TEST_DATABASE_URL` to run it (a throwaway Postgres 17 — never staging).
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_audit_history_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('AuditService.history', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let audit: AuditService;
  const officer = randomUUID();
  const citizen = randomUUID();

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-history', tenantSlug: 'history', schemaName: SCHEMA, prisma: db }, work);

  const entry = (action: string, over: Record<string, unknown> = {}) =>
    db.auditLogEntry.create({
      data: {
        actorId: officer,
        actorType: 'STAFF',
        actorRole: 'FIELD_INSPECTOR',
        actorEmail: 'officer@history.gov.lb',
        action,
        entityType: 'User',
        entityId: citizen,
        ipAddress: '10.0.0.7',
        ...over,
      } as never,
    });

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    audit = new AuditService(
      new PrismaAuditRepository(context),
      context,
      { get: async () => null, set: async () => undefined, invalidatePrefix: async () => undefined } as never,
      { get: () => 1 } as never,
    );

    await db.user.createMany({
      data: [
        { id: officer, kind: 'STAFF', tenantSlug: 'history', email: 'officer@history.gov.lb', firstName: 'موظف', lastName: 'تجربة', role: 'FIELD_INSPECTOR' },
        { id: citizen, kind: 'CITIZEN', tenantSlug: 'history', firstName: 'مواطن', lastName: 'تجربة' },
      ] as never,
    });

    await entry('CITIZEN_UPDATED', {
      before: { maritalStatus: 'MARRIED' },
      after: { maritalStatus: 'SINGLE', changed: ['maritalStatus', 'civilRecordNumber'], phone: '+96171000009' },
    });
    await entry('DATA_CORRECTION', { after: { note: 'تصحيح', snapshot: { phone: '+96171000009', other: 'row' } } });
    // Access and review — not changes to the file.
    await entry('DOCUMENT_VIEW');
    await entry('RECORD_APPROVED');
    await entry('QUALITY_FINDING_DISMISSED');
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('returns the changes, and leaves out views and reviews', async () => {
    const result = await within(() => audit.history({ entityType: 'User', entityId: citizen, limit: 50, offset: 0 }));
    expect(result.items.map((item) => item.action).sort()).toEqual(['CITIZEN_UPDATED', 'DATA_CORRECTION']);
    expect(result.total).toBe(2);
  });

  it('redacts, drops repair snapshots, and hides where the request came from', async () => {
    const result = await within(() => audit.history({ entityType: 'User', entityId: citizen, limit: 50, offset: 0 }));
    const update = result.items.find((item) => item.action === 'CITIZEN_UPDATED')!;
    expect(update.before).toEqual({ maritalStatus: 'MARRIED' });
    expect((update.after as Record<string, unknown>).phone).toBe('[redacted]');
    expect((update.after as Record<string, unknown>).changed).toEqual(['maritalStatus', 'civilRecordNumber']);

    const correction = result.items.find((item) => item.action === 'DATA_CORRECTION')!;
    expect(correction.after).toEqual({ note: 'تصحيح' });
    for (const item of result.items) {
      expect(item.ipAddress).toBeNull();
      expect(item.actor.email).toBeNull();
      expect(item.actor.name).toBe('موظف تجربة');
    }
  });

  it('leaves the full trail as it was for those who may read it', async () => {
    const full = await within(() => audit.query({ entityType: 'User', entityId: citizen, limit: 50, offset: 0 }));
    expect(full.total).toBe(5);
  });
});

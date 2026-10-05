import { randomUUID } from 'node:crypto';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { CitizensService } from './citizens.service';

/**
 * «يتطلب مراجعة» against a real Postgres: the queue holds exactly the citizens
 * whose *latest* filing is flagged, oldest first, and its rows carry nothing
 * the screen does not show.
 *
 * Set `TEST_DATABASE_URL` to run it. Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_review_queue_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('CitizensService.reviewQueue', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let citizens: CitizensService;

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-rq', tenantSlug: 'rq', schemaName: SCHEMA, prisma: db }, work);

  const citizen = async (firstName: string, kind: 'CITIZEN' | 'STAFF' = 'CITIZEN') => {
    const id = randomUUID();
    await db.user.create({
      data: {
        id,
        kind,
        tenantSlug: 'rq',
        firstName,
        lastName: 'اختبار',
        phone: '+96170000000',
        referenceNumber: `RQ-${randomUUID().slice(0, 8)}`,
        ...(kind === 'STAFF' ? { email: `${id}@rq.gov.lb`, role: 'SUPER_ADMIN' } : {}),
      },
    });
    return id;
  };

  const filing = (
    citizenId: string,
    at: string,
    status: 'PENDING' | 'REQUIRES_REVIEW',
    flags = 0,
    createdById?: string,
  ) =>
    db.registration.create({
      data: {
        citizenId,
        ...(createdById ? { createdById } : {}),
        referenceNumber: `R-${randomUUID().slice(0, 10)}`,
        submittedAt: new Date(at),
        status,
        flaggedFields: Array.from({ length: flags }, (_, i) => ({
          path: `personal.field${i}`,
          kind: 'UNESTABLISHED',
          reason: 'لم يُعرف',
        })),
      },
    });

  let older: string;
  let newer: string;
  let finished: string;
  let clean: string;
  let officerA: string;
  let officerB: string;

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    citizens = new CitizensService(
      context,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never),
    );

    older = await citizen('سمير');
    newer = await citizen('نادين');
    finished = await citizen('كريم');
    clean = await citizen('ليلى');
    officerA = await citizen('موظف', 'STAFF');
    officerB = await citizen('مفتش', 'STAFF');

    // Each officer filed one of the two flagged records.
    await filing(older, '2026-09-01T09:00:00Z', 'REQUIRES_REVIEW', 2, officerA);
    await filing(newer, '2026-09-10T09:00:00Z', 'REQUIRES_REVIEW', 1, officerB);
    // Flagged once, then filed again complete: no longer in the queue.
    await filing(finished, '2026-08-01T09:00:00Z', 'REQUIRES_REVIEW', 3);
    await filing(finished, '2026-09-20T09:00:00Z', 'PENDING');
    await filing(clean, '2026-09-05T09:00:00Z', 'PENDING');
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('holds only citizens whose latest filing is flagged, oldest first', async () => {
    const page = await within(() => citizens.reviewQueue());
    expect(page.total).toBe(2);
    expect(page.items.map((row) => row.id)).toEqual([older, newer]);
    expect(page.items[0]).toMatchObject({ status: 'REQUIRES_REVIEW', openFieldCount: 2 });
  });

  it('sends only what the queue shows', async () => {
    const [row] = (await within(() => citizens.reviewQueue({ limit: 1 }))).items;
    expect(Object.keys(row!).sort()).toEqual(
      ['filedByName', 'fullName', 'id', 'motherName', 'openFieldCount', 'phone', 'referenceNumber', 'status', 'submittedAt'].sort(),
    );
  });

  it("shows an officer only the records they filed, and an admin every officer's", async () => {
    const mine = await within(() => citizens.reviewQueue({}, { id: officerA, role: 'FIELD_INSPECTOR' }));
    expect(mine.total).toBe(1);
    expect(mine.items.map((row) => row.id)).toEqual([older]);

    const theirs = await within(() => citizens.reviewQueue({}, { id: officerB, role: 'COLLECTOR' }));
    expect(theirs.items.map((row) => row.id)).toEqual([newer]);

    for (const role of ['SUPER_ADMIN', 'ADMINISTRATIVE_OFFICER', 'AUDITOR', 'VIEWER']) {
      const all = await within(() => citizens.reviewQueue({}, { id: officerA, role }));
      expect(all.items.map((row) => row.id)).toEqual([older, newer]);
    }
    expect((await within(() => citizens.reviewQueue({}, { id: officerA, role: 'SUPER_ADMIN' }))).items[0]?.filedByName).toBe('موظف اختبار');
  });

  it("narrows the register's review filter and its count the same way, and nothing else", async () => {
    const mine = await within(() =>
      citizens.list({ status: 'REQUIRES_REVIEW' }, { id: officerA, role: 'FIELD_INSPECTOR' }),
    );
    expect(mine.items.map((row) => row.id)).toEqual([older]);
    expect(mine.totals.requiringReview).toBe(1);

    // The register itself is not narrowed: every role still reads it whole.
    const register = await within(() => citizens.list({}, { id: officerA, role: 'FIELD_INSPECTOR' }));
    expect(register.total).toBe(4);
    expect(register.totals.requiringReview).toBe(1);

    const admin = await within(() => citizens.list({ status: 'REQUIRES_REVIEW' }, { id: officerA, role: 'SUPER_ADMIN' }));
    expect(admin.items.map((row) => row.id).sort()).toEqual([older, newer].sort());
    expect(admin.totals.requiringReview).toBe(2);
  });

  it('pages and searches without losing the total', async () => {
    const second = await within(() => citizens.reviewQueue({ limit: 1, offset: 1 }));
    expect(second.total).toBe(2);
    expect(second.items.map((row) => row.id)).toEqual([newer]);

    const found = await within(() => citizens.reviewQueue({ search: 'نادين' }));
    expect(found.items.map((row) => row.id)).toEqual([newer]);
    expect(found.total).toBe(1);
  });
});

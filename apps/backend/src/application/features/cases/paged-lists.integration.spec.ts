import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaCaseRepository } from '../../../infrastructure/repositories/case.repository';
import { feeServices } from '../fees/fee-services.testing';
import type { FeeNoticesService } from '../fees/fee-notices.service';

/**
 * PAG-02 and PAG-04 against a real Postgres: «الحالات» and «إشعارات الرسوم»
 * read one page, newest first, with `total` counting every match; pages that
 * follow each other neither repeat a row nor skip one, rows written in the same
 * millisecond included (the `id` tie-break); and the service's own unpaged read
 * of one flat's cases still sees them all.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_paged_lists_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('the paged lists (PAG-02, PAG-04)', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let cases: PrismaCaseRepository;
  let feeNotices: FeeNoticesService;

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-paged', tenantSlug: 'paged', schemaName: SCHEMA, prisma: db }, work);

  /** Seven cases on one moment and five after it, so a page boundary falls inside a tie. */
  const sameMoment = new Date('2026-11-01T08:00:00.000Z');

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    cases = new PrismaCaseRepository(context);
    ({ feeNotices } = feeServices(context, new EventEmitter2(), {} as never, {} as never, {} as never, {} as never));

    for (let index = 0; index < 12; index += 1) {
      await db.case.create({
        data: {
          notes: `زيارة ${index}`,
          propertyNumber: index % 2 === 0 ? 'P-EVEN' : 'P-ODD',
          createdAt: index < 7 ? sameMoment : new Date(sameMoment.getTime() + index * 60_000),
        },
      });
    }
    for (let index = 0; index < 5; index += 1) {
      await db.feeNotice.create({
        data: {
          title: `إشعار ${index}`,
          amount: 10_000,
          frequency: 'ONCE',
          targetType: 'ALL_CITIZENS',
          dueDate: new Date('2026-12-01T00:00:00.000Z'),
          createdAt: sameMoment,
        },
      });
    }
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  });

  it('reads a page of cases, newest first, with the total of every match', async () => {
    const page = await within(() => cases.findPage({}, { limit: 4, offset: 0 }));
    expect(page.total).toBe(12);
    expect(page.items).toHaveLength(4);
    expect(page.items.map((row) => row.notes)).toEqual(['زيارة 11', 'زيارة 10', 'زيارة 9', 'زيارة 8']);
  });

  it('walks every case once across pages, ties on the same moment included', async () => {
    const seen: string[] = [];
    for (let offset = 0; offset < 12; offset += 5) {
      const page = await within(() => cases.findPage({}, { limit: 5, offset }));
      seen.push(...page.items.map((row) => row.id));
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  it('counts the filtered set, not the whole table', async () => {
    const page = await within(() => cases.findPage({ propertyNumber: 'P-ODD' }, { limit: 2, offset: 0 }));
    expect(page.total).toBe(6);
    expect(page.items).toHaveLength(2);
  });

  it('leaves the unpaged read whole, for the service’s own checks on one flat', async () => {
    expect(await within(() => cases.findAll({ propertyNumber: 'P-EVEN' }))).toHaveLength(6);
  });

  it('reads a page of fee notices with their total, and walks them all once', async () => {
    const first = await within(() => feeNotices.listNotices({ limit: 2, offset: 0 }));
    expect(first.total).toBe(5);
    expect(first.items).toHaveLength(2);
    const seen = new Set<string>();
    for (let offset = 0; offset < 5; offset += 2) {
      for (const row of (await within(() => feeNotices.listNotices({ limit: 2, offset }))).items) seen.add(row.id);
    }
    expect(seen.size).toBe(5);
  });
});

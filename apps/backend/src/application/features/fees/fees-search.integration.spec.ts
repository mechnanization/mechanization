import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { FeesService } from './fees.service';

/**
 * The payments ledger's search, against a real Postgres, for «مشاهد فقط».
 *
 * That role is shown a payer's رقم مرجعي masked, so a word of its search must
 * not match on it: a fragment that brings a payment back is a yes-or-no answer
 * about the credential. The payer side of each word goes through the same
 * reference-free text as the register search (`citizenSearchText`).
 *
 * Set `TEST_DATABASE_URL` to run it. Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_fees_search_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('FeesService.listAllPayments — search', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let fees: FeesService;
  let paymentId: string;

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-fs', tenantSlug: 'fs', schemaName: SCHEMA, prisma: db }, work);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    fees = new FeesService(
      context,
      { emit: jest.fn() } as never,
      {} as never,
      {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        invalidatePrefix: jest.fn().mockResolvedValue(undefined),
      } as never,
      {} as never,
      // AuditService: a read never writes a row.
      {} as never,
    );

    const citizenId = randomUUID();
    await db.user.create({
      data: {
        id: citizenId,
        kind: 'CITIZEN',
        tenantSlug: 'fs',
        firstName: 'وسيم',
        lastName: 'المرجعي',
        phone: '+96170000001',
        referenceNumber: 'BZR-2610-NZ58VK',
      },
    });
    const payment = await db.citizenPayment.create({
      data: { citizenId, title: 'رسم النفايات', amount: 100_000, dueDate: new Date('2026-12-31T00:00:00Z') },
    });
    paymentId = payment.id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  });

  const ids = (page: { items: Array<{ id: string }> }) => page.items.map((row) => row.id);

  it.each(['nz5', 'bzr2610n', 'BZR-2610-NZ58VK'])(
    'finds nothing for «مشاهد فقط» by a fragment of the payer’s reference (%s), where an admin does',
    async (term) => {
      expect(ids(await within(() => fees.listAllPayments({ search: term }, { role: 'SUPER_ADMIN' })))).toContain(paymentId);
      expect(ids(await within(() => fees.listAllPayments({ search: term }, { role: 'VIEWER' })))).not.toContain(paymentId);
    },
  );

  it('still finds the payment for «مشاهد فقط» by the payer’s name and by the fee', async () => {
    expect(ids(await within(() => fees.listAllPayments({ search: 'وسيم المرجعي' }, { role: 'VIEWER' })))).toContain(paymentId);
    expect(ids(await within(() => fees.listAllPayments({ search: 'النفايات' }, { role: 'VIEWER' })))).toContain(paymentId);
  });
});

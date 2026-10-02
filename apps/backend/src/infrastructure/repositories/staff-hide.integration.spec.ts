import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../generated/tenant-client';
import { migrateTenantSchema } from '../prisma/tenant-migrator';
import { tenantTestClient } from '../prisma/tenant-test-client';
import { TenantContextService } from '../context/tenant-context.service';
import { PrismaUserRepository } from './user.repository';

/**
 * «حذف موظف» against a real Postgres: the account is hidden — off the staff
 * list, deactivated, its session ended — and its row, its details and its
 * history are all still there.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_staff_hide_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('PrismaUserRepository.hideStaff', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let users: PrismaUserRepository;

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-hide', tenantSlug: 'hide', schemaName: SCHEMA, prisma: db }, work);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    users = new PrismaUserRepository(context);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('hides the account and keeps its details and history', async () => {
    const id = randomUUID();
    const email = `collector-${id}@hide.gov.lb`;
    await db.user.create({
      data: {
        id,
        kind: 'STAFF',
        tenantSlug: 'hide',
        email,
        passwordHash: 'hash',
        phone: '+96170000000',
        firstName: 'سمير',
        lastName: 'خليل',
        role: 'COLLECTOR',
      },
    });
    await db.auditLogEntry.create({
      data: { actorId: id, actorType: 'STAFF', action: 'STAFF_CREATED', entityType: 'User', entityId: id } as never,
    });
    expect((await within(() => users.listStaff())).some((staff) => staff.id === id)).toBe(true);

    await within(() => users.hideStaff(id));

    const row = await db.user.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row).toMatchObject({
      isActive: false,
      tokenVersion: 1,
      // Nothing about the person is touched.
      firstName: 'سمير',
      lastName: 'خليل',
      email,
      phone: '+96170000000',
      passwordHash: 'hash',
    });
    expect(await db.auditLogEntry.count({ where: { actorId: id } })).toBe(1);
    expect((await within(() => users.listStaff())).some((staff) => staff.id === id)).toBe(false);
  });
});

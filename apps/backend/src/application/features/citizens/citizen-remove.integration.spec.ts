import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { ConflictError } from '../../../domain/errors/domain-error';
import { AuditService } from '../audit/audit.service';
import { CitizensService } from './citizens.service';

/**
 * «حذف الملف نهائياً» against a real Postgres: a citizen nothing points at is
 * erased; one that anything still points at is refused, and nothing is lost.
 *
 * The cascade used to take a tenant's landlord link and a case's citizen with
 * it silently (SetNull), so these are the links the refusal now covers.
 *
 * Set `TEST_DATABASE_URL` to run it. Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_citizen_remove_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('CitizensService.remove', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let citizens: CitizensService;
  let officerId: string;

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-rm', tenantSlug: 'rm', schemaName: SCHEMA, prisma: db }, work);
  const actor = () => ({ id: officerId, role: 'ADMINISTRATIVE_OFFICER' });

  const person = async (firstName: string, kind: 'CITIZEN' | 'STAFF' = 'CITIZEN') => {
    const id = randomUUID();
    await db.user.create({
      data: {
        id,
        kind,
        tenantSlug: 'rm',
        firstName,
        lastName: 'اختبار',
        referenceNumber: kind === 'CITIZEN' ? `RM-${randomUUID().slice(0, 8)}` : null,
        ...(kind === 'STAFF' ? { email: `${id}@rm.gov.lb`, role: 'ADMINISTRATIVE_OFFICER' } : {}),
      },
    });
    return id;
  };

  const refusal = (work: () => Promise<unknown>) => within(work).then(() => null, (caught: unknown) => caught);

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
      new EventEmitter2(),
      new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never),
    );
    officerId = await person('موظف', 'STAFF');
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('erases a citizen nothing points at, and records it', async () => {
    const id = await person('ملف خاطئ');
    expect(await within(() => citizens.remove({ tenantSlug: 'rm', citizenId: id, actor: actor() }))).toEqual({
      deleted: true,
    });
    expect(await db.user.findUnique({ where: { id } })).toBeNull();
    expect(await db.auditLogEntry.count({ where: { action: 'CITIZEN_DELETED', entityId: id } })).toBe(1);
  });

  it('refuses a citizen a tenant names as their owner, and keeps the link', async () => {
    const owner = await person('مالك');
    const tenant = await person('مستأجر');
    const filing = await db.registration.create({
      data: {
        citizenId: tenant,
        referenceNumber: `R-${randomUUID().slice(0, 10)}`,
        properties: {
          create: {
            occupancyType: 'TENANT',
            propertyType: 'BUILDING',
            landlordName: 'مالك اختبار',
            landlordCitizenId: owner,
          },
        },
      },
      select: { properties: { select: { id: true } } },
    });

    const caught = await refusal(() => citizens.remove({ tenantSlug: 'rm', citizenId: owner, actor: actor() }));
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).code).toBe('CITIZEN_HAS_LINKS');
    expect((caught as ConflictError).params).toEqual({ count: 1 });
    expect(await db.user.findUnique({ where: { id: owner } })).not.toBeNull();
    expect(
      (await db.propertyEntry.findUniqueOrThrow({ where: { id: filing.properties[0]!.id } })).landlordCitizenId,
    ).toBe(owner);
  });

  it('refuses a citizen a case was resolved by', async () => {
    const id = await person('صاحب حالة');
    await db.case.create({ data: { notes: 'لا أحد في المنزل', resolvedCitizenId: id } });
    const caught = await refusal(() => citizens.remove({ tenantSlug: 'rm', citizenId: id, actor: actor() }));
    expect((caught as ConflictError).code).toBe('CITIZEN_HAS_LINKS');
    expect(await db.user.findUnique({ where: { id } })).not.toBeNull();
  });

  it('still refuses a citizen with a filing, before looking at links', async () => {
    const id = await person('مقدّم طلب');
    await db.registration.create({ data: { citizenId: id, referenceNumber: `R-${randomUUID().slice(0, 10)}` } });
    const caught = await refusal(() => citizens.remove({ tenantSlug: 'rm', citizenId: id, actor: actor() }));
    expect((caught as ConflictError).code).toBe('CITIZEN_HAS_RECORDS');
  });
});

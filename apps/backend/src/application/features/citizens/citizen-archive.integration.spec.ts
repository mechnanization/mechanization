import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { setCitizenActiveSchema } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { CitizensService } from './citizens.service';

/**
 * «أرشفة الملف» against a real Postgres. A citizen is never deleted (decision,
 * 2026-10-05): archiving keeps the row and everything that points at it, and
 * records why and who asked, in the same transaction as the change.
 *
 * Set `TEST_DATABASE_URL` to run it. Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_citizen_archive_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describe('setCitizenActiveSchema — what an archive must say', () => {
  it('refuses to archive without a reason and who asked', () => {
    const parsed = setCitizenActiveSchema.safeParse({ isActive: false });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.')).sort()).toEqual(['reason', 'requestedBy']);
  });

  it('refuses to archive with only one of the two', () => {
    expect(setCitizenActiveSchema.safeParse({ isActive: false, reason: 'ملف مكرّر' }).success).toBe(false);
    expect(setCitizenActiveSchema.safeParse({ isActive: false, requestedBy: 'المختار' }).success).toBe(false);
  });

  it('archives with both, and reactivates with neither', () => {
    expect(
      setCitizenActiveSchema.safeParse({ isActive: false, reason: 'ملف مكرّر', requestedBy: 'المواطن نفسه' }).success,
    ).toBe(true);
    expect(setCitizenActiveSchema.safeParse({ isActive: true }).success).toBe(true);
  });
});

describeIfDb('CitizensService.setActive — «أرشفة الملف»', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let citizens: CitizensService;
  let officerId: string;

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-ar', tenantSlug: 'ar', schemaName: SCHEMA, prisma: db }, work);
  const actor = () => ({ id: officerId, role: 'ADMINISTRATIVE_OFFICER' });

  const person = async (firstName: string, kind: 'CITIZEN' | 'STAFF' = 'CITIZEN') => {
    const id = randomUUID();
    await db.user.create({
      data: {
        id,
        kind,
        tenantSlug: 'ar',
        firstName,
        lastName: 'اختبار',
        referenceNumber: kind === 'CITIZEN' ? `AR-${randomUUID().slice(0, 8)}` : null,
        ...(kind === 'STAFF' ? { email: `${id}@ar.gov.lb`, role: 'ADMINISTRATIVE_OFFICER' } : {}),
      },
    });
    return id;
  };

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

  it('archives a file, and the trail says why and who asked', async () => {
    const id = await person('ملف مكرّر');

    await within(() =>
      citizens.setActive({
        tenantSlug: 'ar',
        citizenId: id,
        isActive: false,
        reason: 'فُتح الملف مرّتين لنفس الشخص',
        requestedBy: 'المختار',
        actor: actor(),
      }),
    );

    expect((await db.user.findUniqueOrThrow({ where: { id } })).isActive).toBe(false);
    const row = await db.auditLogEntry.findFirstOrThrow({ where: { action: 'CITIZEN_DEACTIVATED', entityId: id } });
    expect(row.after).toMatchObject({ reason: 'فُتح الملف مرّتين لنفس الشخص', requestedBy: 'المختار' });
  });

  it('keeps everything an archived file holds — its filing, its landlord link, its case', async () => {
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
      select: { id: true, properties: { select: { id: true } } },
    });
    const ownCase = await db.case.create({ data: { notes: 'لا أحد في المنزل', resolvedCitizenId: owner } });
    const ownFiling = await db.registration.create({
      data: { citizenId: owner, referenceNumber: `R-${randomUUID().slice(0, 10)}` },
    });

    await within(() =>
      citizens.setActive({
        tenantSlug: 'ar',
        citizenId: owner,
        isActive: false,
        reason: 'انتقل للسكن خارج البلدة',
        requestedBy: 'ابنه',
        actor: actor(),
      }),
    );

    expect(await db.user.findUnique({ where: { id: owner } })).not.toBeNull();
    expect(
      (await db.propertyEntry.findUniqueOrThrow({ where: { id: filing.properties[0]!.id } })).landlordCitizenId,
    ).toBe(owner);
    expect((await db.case.findUniqueOrThrow({ where: { id: ownCase.id } })).resolvedCitizenId).toBe(owner);
    expect(await db.registration.findUnique({ where: { id: ownFiling.id } })).not.toBeNull();
  });

  it('brings an archived file back, and records that too', async () => {
    const id = await person('أُرشف خطأً');
    await within(() =>
      citizens.setActive({
        tenantSlug: 'ar',
        citizenId: id,
        isActive: false,
        reason: 'ظُنّ مكرّراً',
        requestedBy: 'موظف الصندوق',
        actor: actor(),
      }),
    );
    await within(() => citizens.setActive({ tenantSlug: 'ar', citizenId: id, isActive: true, actor: actor() }));

    expect((await db.user.findUniqueOrThrow({ where: { id } })).isActive).toBe(true);
    expect(await db.auditLogEntry.count({ where: { action: 'CITIZEN_REACTIVATED', entityId: id } })).toBe(1);
  });

  it('has no way to erase a citizen', () => {
    // The decision, pinned: the service offers no delete for a citizen file.
    expect((citizens as unknown as Record<string, unknown>).remove).toBeUndefined();
  });
});

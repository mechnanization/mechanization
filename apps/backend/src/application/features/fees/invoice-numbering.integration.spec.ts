import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { municipalPeriod } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import type { WhishGateway } from '../../../domain/interfaces/whish-gateway.interface';
import { FeesService } from './fees.service';
import { PaymentLedgerService } from './payment-ledger.service';

/**
 * «INV-2610-0001» on the bills themselves, against real Postgres.
 *
 * `document-number.integration.spec.ts` proves the counter. This proves the
 * half that only exists as SQL: the `UPDATE … FROM ordered, assigned` that puts
 * the drawn block onto the rows `createMany` just wrote. Every test in the
 * project would pass with that statement matching nothing at all and every bill
 * left unnumbered, which is exactly the failure it has to rule out.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_invoice_numbering_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('invoice numbering', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let fees: FeesService;
  let clerkId: string;

  const actor = () => ({ id: clerkId, role: 'SUPER_ADMIN' as const });
  const period = municipalPeriod();

  /** A citizen who can be billed a flat fee. */
  const citizen = async (name: string): Promise<string> => {
    const id = randomUUID();
    await db.user.create({
      data: { id, kind: 'CITIZEN', tenantSlug: 'numbering', firstName: name, lastName: 'الحاج' },
    });
    return id;
  };

  const numbersFor = async (noticeId: string): Promise<Array<string | null>> => {
    const rows = await db.citizenPayment.findMany({
      where: { feeNoticeId: noticeId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { invoiceNumber: true },
    });
    return rows.map((row) => row.invoiceNumber);
  };

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    fees = new FeesService(
      {
        get prisma() {
          return db;
        },
        tenantSlug: 'numbering',
        schemaName: SCHEMA,
        tenantId: 'tenant-1',
      } as unknown as TenantContextService,
      { emit: jest.fn() } as unknown as EventEmitter2,
      {} as WhishGateway,
      {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        invalidatePrefix: jest.fn().mockResolvedValue(undefined),
      } as unknown as RedisCacheService,
      {} as PaymentLedgerService,
      {} as never,
    );

    clerkId = randomUUID();
    await db.user.create({
      data: {
        id: clerkId,
        kind: 'STAFF',
        tenantSlug: 'numbering',
        email: `clerk-${clerkId}@numbering.gov.lb`,
        firstName: 'موظف',
        lastName: 'الجباية',
        role: 'SUPER_ADMIN',
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('numbers every bill a notice raises, in the order they were created', async () => {
    await Promise.all([citizen('أحمد'), citizen('ليلى'), citizen('سمير')]);

    const issued = await fees.issue(
      {
        title: 'رسم النفايات',
        amount: 50_000,
        basis: 'FLAT',
        bearer: 'OWNER',
        frequency: 'ONCE',
        targetType: 'ALL_CITIZENS',
        dueDate: '2026-12-31',
      } as never,
      actor(),
    );

    const numbers = await numbersFor(issued.noticeId);
    expect(numbers).toHaveLength(issued.issued);
    expect(numbers.every((number) => number !== null)).toBe(true);
    // Contiguous, in creation order, all in this month's book.
    expect(numbers).toEqual(
      numbers.map((_, index) => `INV-${period}-${String(index + 1).padStart(4, '0')}`),
    );
  });

  it('carries on from where the last notice stopped', async () => {
    const before = await numbersFor(
      (
        await db.feeNotice.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true } })
      ).id,
    );
    const highest = Number(before[before.length - 1]!.slice(-4));

    const issued = await fees.issue(
      {
        title: 'رسم اللافتات',
        amount: 20_000,
        basis: 'FLAT',
        bearer: 'OWNER',
        frequency: 'ONCE',
        targetType: 'ALL_CITIZENS',
        dueDate: '2026-12-31',
      } as never,
      actor(),
    );

    const numbers = await numbersFor(issued.noticeId);
    expect(numbers[0]).toBe(`INV-${period}-${String(highest + 1).padStart(4, '0')}`);
  });

  /*
    The guard `numberInvoices` takes `since` for. A bill raised before this
    change has no number and must keep none: handing it one now would put a
    document in front of an auditor under a number it was never issued with.
  */
  it('leaves a bill raised before the run unnumbered', async () => {
    const legacyCitizen = await citizen('خالد');
    const notice = await db.feeNotice.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, dueDate: true },
    });

    // A row of the shape 0079 inherited: same notice, same period, no number.
    const legacy = await db.citizenPayment.create({
      data: {
        citizenId: legacyCitizen,
        feeNoticeId: notice.id,
        title: notice.title,
        amount: 1,
        dueDate: notice.dueDate,
        periodKey: 'ONCE',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      select: { id: true },
    });

    await fees.issue(
      {
        title: 'رسم ثالث',
        amount: 10_000,
        basis: 'FLAT',
        bearer: 'OWNER',
        frequency: 'ONCE',
        targetType: 'ALL_CITIZENS',
        dueDate: '2026-12-31',
      } as never,
      actor(),
    );

    const after = await db.citizenPayment.findUniqueOrThrow({
      where: { id: legacy.id },
      select: { invoiceNumber: true },
    });
    expect(after.invoiceNumber).toBeNull();
  });

  it('numbers a one-off charge raised straight against a citizen', async () => {
    const id = await citizen('نادية');

    const created = await fees.chargeIndividual({
      citizenId: id,
      title: 'رسم إشغال رصيف',
      amount: 75_000,
      dueDate: '2026-12-31',
      actor: actor(),
    });

    const bill = await db.citizenPayment.findUniqueOrThrow({
      where: { id: created.id },
      select: { invoiceNumber: true },
    });
    expect(bill.invoiceNumber).toMatch(new RegExp(`^INV-${period}-\\d{4}$`));
  });

  it('never gives two bills the same number', async () => {
    const rows = await db.citizenPayment.findMany({
      where: { invoiceNumber: { not: null } },
      select: { invoiceNumber: true },
    });
    const numbers = rows.map((row) => row.invoiceNumber!);

    expect(numbers.length).toBeGreaterThan(3);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

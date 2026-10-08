import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { ParcelDuesService } from './parcel-dues.service';

/**
 * «ما المستحق على العقار» against a real tenant schema: the JSONB containment
 * that finds a bill by its lines, the estate's name on it, and the holders'
 * bills that name no unit. Synthetic people only.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_parcel_dues_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('what is owed on a parcel', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let dues: ParcelDuesService;

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-pd', tenantSlug: 'pd', schemaName: SCHEMA, prisma: db }, work);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    dues = new ParcelDuesService(context);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  const person = async (firstName: string, lastName: string, residence = 'RESIDENT') => {
    const id = randomUUID();
    await db.user.create({
      data: { id, kind: 'CITIZEN', tenantSlug: 'pd', firstName, lastName, residence: residence as never },
    });
    return id;
  };
  const bill = (citizenId: string, amount: number, assessment: unknown, paid = 0, status = 'UNPAID') =>
    db.citizenPayment.create({
      data: {
        citizenId,
        title: `رسم ${randomUUID().slice(0, 6)}`,
        amount,
        paidAmount: paid,
        dueDate: new Date('2030-12-31'),
        paymentStatus: status as never,
        assessment: assessment as never,
      },
    });
  const lines = (...entries: Array<[string, number | null, string?]>) => ({
    basis: 'PER_AREA',
    rate: 1000,
    unitCount: entries.length,
    totalArea: 0,
    excludedUnitCount: 0,
    heldUnitCount: 0,
    uninhabitableUnitCount: 0,
    lines: entries.map(([propertyNumber, unitArea, unitCode]) => ({
      propertyNumber,
      propertyType: 'BUILDING',
      unitType: 'APARTMENT',
      unitArea,
      ...(unitCode ? { unitCode } : {}),
    })),
  });

  it('lists every open bill with a line on the parcel — the estate’s too — and its part of what remains', async () => {
    const parcel = `7${randomUUID().slice(0, 5)}`;
    const estate = await person('حسن', 'تجربة', 'ESTATE');
    const tenant = await person('سامي', 'تجربة');
    const elsewhere = await person('ليلى', 'تجربة');

    const whole = await bill(estate, 200_000, lines([parcel, 200, '0101']), 50_000);
    const split = await bill(tenant, 100_000, lines([parcel, 75, '0202'], ['99', 25]));
    await bill(tenant, 80_000, lines([parcel, 80]), 80_000, 'PAID');
    await bill(elsewhere, 60_000, lines(['99', 60]));

    const result = await within(() => dues.dues(parcel));
    expect(result.bills.map((entry) => entry.paymentId).sort()).toEqual([whole.id, split.id].sort());
    const byId = new Map(result.bills.map((entry) => [entry.paymentId, entry]));
    expect(byId.get(whole.id)).toMatchObject({
      citizenName: 'ورثة المرحوم حسن تجربة',
      remaining: 150_000,
      onParcel: 150_000,
      unitCodes: ['0101'],
      wholeBill: true,
    });
    expect(byId.get(split.id)).toMatchObject({ remaining: 100_000, onParcel: 75_000, wholeBill: false });
    expect(result.total).toBe(225_000);
  });

  it('lists apart the open bills of the people on the parcel that name no unit', async () => {
    const parcel = `8${randomUUID().slice(0, 5)}`;
    const owner = await person('علي', 'تجربة');
    const registration = await db.registration.create({
      data: { citizenId: owner, referenceNumber: `PD-${randomUUID()}` },
    });
    await db.propertyEntry.create({
      data: { registrationId: registration.id, occupancyType: 'OWNER', propertyType: 'LAND', propertyNumber: parcel },
    });
    const flat = await bill(owner, 30_000, null);

    const result = await within(() => dues.dues(parcel));
    expect(result.bills).toEqual([]);
    expect(result.unlinked).toEqual([expect.objectContaining({ paymentId: flat.id, remaining: 30_000 })]);
    expect(result.unlinkedTotal).toBe(30_000);
  });
});

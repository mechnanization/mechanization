import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { CreateFeeNotice, FeeNoticePreviewInput } from '@mechanization/shared-schemas';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { FeesService } from './fees.service';

/**
 * «من يشمل الإشعار» (0100) against a real tenant schema: the unit states, the
 * kinds of file and several categories, as the preview reads them, as the
 * issue stores them, and as the recurring run reads them back.
 *
 * The town, synthetic: a resident who owns a shop, an empty flat and a flat
 * marked «مؤجرة» with no tenant on file, in one building; and an owner who
 * lives outside the town and owns a warehouse in it.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_fee_scope_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const EVERY_STATE = ['OWNER_OCCUPIED', 'RENTED', 'FREE_OCCUPIED', 'SEASONAL', 'VACANT', 'UNDER_CONSTRUCTION'] as const;

describeIfDb('the notice scope (0100)', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let fees: FeesService;
  const officerId = randomUUID();
  const actor = { id: officerId, role: 'ACCOUNTANT' };
  const resident = randomUUID();
  const absentee = randomUUID();

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-fs', tenantSlug: 'fs', schemaName: SCHEMA, prisma: db }, work);

  /** One owner with a registration and a مبنى card listing the given census units, each with its status. */
  async function owning(
    citizenId: string,
    residence: 'RESIDENT' | 'NON_RESIDENT_OWNER',
    buildingId: string,
    units: Array<{ id: string; unitType: string; unitStatus: string }>,
  ) {
    await db.user.create({
      data: { id: citizenId, kind: 'CITIZEN', tenantSlug: 'fs', firstName: 'مالك', lastName: 'الاختبار', residence: residence as never },
    });
    const registration = await db.registration.create({
      data: { citizenId, referenceNumber: `FS-${randomUUID()}`, createdById: officerId },
    });
    const card = await db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: 'OWNER' as never,
        propertyType: 'BUILDING' as never,
        buildingId,
        propertyNumber: '88',
      },
    });
    for (const unit of units) {
      await db.buildingUnit.create({
        data: {
          propertyEntryId: card.id,
          unitId: unit.id,
          unitType: unit.unitType as never,
          unitArea: 50,
          unitStatus: unit.unitStatus as never,
        },
      });
      await db.unitOccupancy.create({
        data: { unitId: unit.id, citizenId, role: 'OWNER' as never, registrationId: registration.id },
      });
    }
  }

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    fees = new FeesService(
      context,
      new EventEmitter2(),
      {} as never,
      {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        invalidatePrefix: jest.fn().mockResolvedValue(undefined),
      } as never,
      {} as never,
      {} as never,
    );

    await db.user.create({
      data: {
        id: officerId,
        kind: 'STAFF',
        tenantSlug: 'fs',
        email: `accountant-${officerId}@fs.gov.lb`,
        firstName: 'سارة',
        lastName: 'المحاسبة',
        role: 'ACCOUNTANT' as never,
      },
    });

    const building = await db.building.create({
      data: {
        parcelNumber: '88',
        codeSuffix: 'A',
        code: 'A1-88-A',
        structureType: 'MIXED_USE' as never,
        floorsCount: 2,
        createdById: officerId,
      },
    });
    const unit = (code: string, sequence: number, unitType: string, unitStatus: string) =>
      db.unit.create({
        data: {
          buildingId: building.id,
          unitCode: code,
          floor: sequence <= 2 ? 0 : 1,
          sequence,
          unitType: unitType as never,
          unitArea: 50,
          unitStatus: unitStatus as never,
          surveyStatus: 'COMPLETE' as never,
        },
      });
    const shop = await unit('0001', 1, 'SHOP', 'OWNER_OCCUPIED');
    const warehouse = await unit('0002', 2, 'WAREHOUSE', 'OWNER_OCCUPIED');
    const empty = await unit('0101', 3, 'APARTMENT', 'VACANT');
    const let_ = await unit('0102', 4, 'APARTMENT', 'RENTED');

    await owning(resident, 'RESIDENT', building.id, [
      { id: shop.id, unitType: 'SHOP', unitStatus: 'OWNER_OCCUPIED' },
      { id: empty.id, unitType: 'APARTMENT', unitStatus: 'VACANT' },
      { id: let_.id, unitType: 'APARTMENT', unitStatus: 'RENTED' },
    ]);
    await owning(absentee, 'NON_RESIDENT_OWNER', building.id, [
      { id: warehouse.id, unitType: 'WAREHOUSE', unitStatus: 'OWNER_OCCUPIED' },
    ]);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  const notice: FeeNoticePreviewInput = {
    title: 'رسم النظافة',
    amount: 100_000,
    basis: 'PER_UNIT',
    bearer: 'OCCUPANT',
    frequency: 'ANNUALLY',
    targetType: 'ALL_CITIZENS',
    dueDate: '2026-03-31',
  };
  const issue = (input: FeeNoticePreviewInput, key = randomUUID()) =>
    within(() => fees.issue({ ...input, clientRequestId: key } as CreateFeeNotice, actor));

  it('previews a notice with no scope as before, and says by state what the default left out', async () => {
    const preview = await within(() => fees.previewNotice(notice));

    // The shop and the warehouse; the empty flat is out of scope, and the flat «مؤجرة» with no tenant
    // on file is held for review (`settleUnitStatus`), not counted as a tenant's.
    expect(preview).toMatchObject({ targetedCitizens: 2, billedCitizens: 2, expectedRevenue: 200_000 });
    expect(preview.notCharged).toMatchObject({
      outOfScopeUnits: 1,
      outOfScopeByState: { VACANT: 1 },
      heldUnits: 1,
      excludedUnits: 0,
      residenceLeftOut: 0,
    });
  });

  it('charges the empty flat when every state is ticked, and leaves out the kinds of file unticked', async () => {
    const preview = await within(() =>
      fees.previewNotice({ ...notice, unitStates: [...EVERY_STATE], residences: ['RESIDENT'] }),
    );

    expect(preview).toMatchObject({ targetedCitizens: 1, billedCitizens: 1, expectedRevenue: 200_000 });
    expect(preview.notCharged).toMatchObject({ outOfScopeUnits: 0, outOfScopeByState: {}, residenceLeftOut: 1 });
  });

  it('reaches the holders of any of several categories', async () => {
    const preview = await within(() =>
      fees.previewNotice({ ...notice, targetType: 'BUILDING_CATEGORY', targetCategories: ['SHOP', 'WAREHOUSE'] }),
    );
    expect(preview).toMatchObject({ targetedCitizens: 2, billedCitizens: 2, expectedRevenue: 200_000 });
  });

  it('stores only what departs from the defaults, and the recurring run bills by it', async () => {
    const scoped = {
      ...notice,
      title: `رسم النظافة ${randomUUID().slice(0, 8)}`,
      unitStates: [...EVERY_STATE],
      residences: ['RESIDENT' as const],
      acknowledgedWarnings: ['UNOCCUPIED_CHARGED' as const, 'RESIDENCE_LEFT_OUT' as const],
    };
    const issued = await issue(scoped);
    const plain = await issue({ ...notice, title: `رسم النظافة ${randomUUID().slice(0, 8)}` });

    const stored = await db.feeNotice.findUniqueOrThrow({ where: { id: issued.noticeId }, select: { scope: true } });
    expect(stored.scope).toEqual({
      unitStates: [...EVERY_STATE],
      residences: ['RESIDENT'],
      acknowledgedWarnings: ['UNOCCUPIED_CHARGED', 'RESIDENCE_LEFT_OUT'],
    });
    const before = await db.feeNotice.findUniqueOrThrow({ where: { id: plain.noticeId }, select: { scope: true } });
    expect(before.scope).toBeNull();

    // The next year's run: the scoped notice bills the resident alone, empty flat included.
    await within(() => fees.runRecurringBilling(new Date('2027-04-10T09:00:00.000Z')));
    const nextYear = await db.citizenPayment.findMany({
      where: { feeNoticeId: issued.noticeId, periodKey: '2027' },
      select: { citizenId: true, amount: true },
    });
    expect(nextYear).toEqual([{ citizenId: resident, amount: expect.anything() }]);
    expect(Number(nextYear[0]!.amount)).toBe(200_000);
    // And the notice with no scope as it always billed: both owners, one unit each.
    const plainNextYear = await db.citizenPayment.count({ where: { feeNoticeId: plain.noticeId, periodKey: '2027' } });
    expect(plainNextYear).toBe(2);
  });

  it('refuses a retry key reused for the same notice with another scope', async () => {
    const key = randomUUID();
    const first = { ...notice, title: `رسم النظافة ${randomUUID().slice(0, 8)}` };
    await issue(first, key);
    await expect(
      issue({ ...first, residences: ['RESIDENT'], acknowledgedWarnings: ['RESIDENCE_LEFT_OUT'] }, key),
    ).rejects.toMatchObject({ code: 'FEE_NOTICE_REQUEST_REUSED' });
    // The same notice pressed again is answered from the first.
    await expect(issue(first, key)).resolves.toMatchObject({ replayed: true });
  });
});

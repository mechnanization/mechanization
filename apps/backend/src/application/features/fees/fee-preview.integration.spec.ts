import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { CreateFeeNotice, FeeMatrixBracket, FeeNoticePreviewInput } from '@mechanization/shared-schemas';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { FeesService } from './fees.service';

/**
 * «معاينة قبل الإصدار» against a real tenant schema (0098 and 0099 applied):
 * the preview reads the register exactly as the issue does and writes nothing
 * (T-9 of docs/fees-system-rearchitecture-specification.md).
 *
 * The town, synthetic: three brothers who own one shop together, the eldest
 * also owning a flat of his own; a waqf whose one unit is a mosque «معفاة من
 * الرسوم»; and a citizen whose flat nobody measured.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_fee_preview_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const bracket = (row: Partial<FeeMatrixBracket> & Pick<FeeMatrixBracket, 'code' | 'minArea' | 'maxArea' | 'amount'>): FeeMatrixBracket => ({
  labelAr: `الفئة ${row.code}`,
  unitTypes: ['APARTMENT'],
  levels: 1,
  ...row,
});

const TABLE: FeeMatrixBracket[] = [
  bracket({ code: 'A', minArea: 0, maxArea: 100, amount: 1_000_000 }),
  bracket({ code: 'B', minArea: 100, maxArea: 150, amount: 1_500_000 }),
  bracket({ code: 'C', minArea: 150, maxArea: null, amount: 2_000_000 }),
  bracket({ code: 'S', unitTypes: ['SHOP'], minArea: 0, maxArea: null, amount: 30_000_000 }),
];

describeIfDb('the notice preview', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let fees: FeesService;
  const officerId = randomUUID();
  const actor = { id: officerId, role: 'ACCOUNTANT' };
  const brothers = [randomUUID(), randomUUID(), randomUUID()].sort();
  const waqf = randomUUID();
  const unmeasured = randomUUID();

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-fp', tenantSlug: 'fp', schemaName: SCHEMA, prisma: db }, work);

  /** One citizen with a registration and a مبنى card listing the given census units. */
  async function citizenOwning(citizenId: string, firstName: string, buildingId: string, parcel: string, units: Array<{ id: string; unitType: string; unitArea: number | null }>) {
    await db.user.create({ data: { id: citizenId, kind: 'CITIZEN', tenantSlug: 'fp', firstName, lastName: 'الاختبار' } });
    const registration = await db.registration.create({
      data: { citizenId, referenceNumber: `FP-${randomUUID()}`, createdById: officerId },
    });
    const card = await db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: 'OWNER' as never,
        propertyType: 'BUILDING' as never,
        buildingId,
        propertyNumber: parcel,
      },
    });
    for (const unit of units) {
      await db.buildingUnit.create({
        data: {
          propertyEntryId: card.id,
          unitId: unit.id,
          unitType: unit.unitType as never,
          unitArea: unit.unitArea,
          unitStatus: 'OWNER_OCCUPIED' as never,
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
        tenantSlug: 'fp',
        email: `accountant-${officerId}@fp.gov.lb`,
        firstName: 'سارة',
        lastName: 'المحاسبة',
        role: 'ACCOUNTANT' as never,
      },
    });

    const building = await db.building.create({
      data: {
        parcelNumber: '77',
        codeSuffix: 'A',
        code: 'A1-77-A',
        structureType: 'MIXED_USE' as never,
        floorsCount: 2,
        createdById: officerId,
      },
    });
    const unit = (code: string, sequence: number, unitType: string, unitArea: number | null, extra: object = {}) =>
      db.unit.create({
        data: {
          buildingId: building.id,
          unitCode: code,
          floor: sequence <= 2 ? 0 : 1,
          sequence,
          unitType: unitType as never,
          unitArea,
          unitStatus: 'OWNER_OCCUPIED' as never,
          surveyStatus: 'COMPLETE' as never,
          ...extra,
        },
      });
    const shop = await unit('0001', 1, 'SHOP', 40);
    const mosque = await unit('0002', 2, 'APARTMENT', 300, {
      feeExemption: 'PLACE_OF_WORSHIP' as never,
      feeExemptedById: officerId,
      feeExemptedAt: new Date(),
    });
    const flat = await unit('0101', 3, 'APARTMENT', 120);
    const unknownArea = await unit('0102', 4, 'APARTMENT', null);

    await citizenOwning(brothers[0]!, 'علي', building.id, '77', [
      { id: shop.id, unitType: 'SHOP', unitArea: 40 },
      { id: flat.id, unitType: 'APARTMENT', unitArea: 120 },
    ]);
    await citizenOwning(brothers[1]!, 'معروف', building.id, '77', [{ id: shop.id, unitType: 'SHOP', unitArea: 40 }]);
    await citizenOwning(brothers[2]!, 'عارف', building.id, '77', [{ id: shop.id, unitType: 'SHOP', unitArea: 40 }]);
    await citizenOwning(waqf, 'وقف', building.id, '77', [{ id: mosque.id, unitType: 'APARTMENT', unitArea: 300 }]);
    await citizenOwning(unmeasured, 'حسين', building.id, '77', [{ id: unknownArea.id, unitType: 'APARTMENT', unitArea: null }]);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  const tieredNotice: FeeNoticePreviewInput = {
    title: 'رسم القيمة التأجيرية',
    amount: 0,
    basis: 'TIERED_AREA',
    matrixBrackets: TABLE,
    bearer: 'OCCUPANT',
    frequency: 'ANNUALLY',
    targetType: 'ALL_CITIZENS',
    dueDate: '2026-12-31',
  };

  async function written() {
    return {
      notices: await db.feeNotice.count(),
      bills: await db.citizenPayment.count(),
      debtors: await db.citizenPaymentDebtor.count(),
      audit: await db.auditLogEntry.count(),
    };
  }

  it('previews a bracket notice: the shop once to the three brothers, the flat to its owner, nothing written (T-9)', async () => {
    const before = await written();

    const preview = await within(() => fees.previewNotice(tieredNotice));

    expect(preview).toMatchObject({
      targetedCitizens: 5,
      billedCitizens: 1,
      sharedBills: 1,
      expectedRevenue: 31_500_000,
      currency: 'LBP',
      brackets: [
        { code: 'A', unitCount: 0, subtotal: 0 },
        { code: 'B', unitCount: 1, subtotal: 1_500_000 },
        { code: 'C', unitCount: 0, subtotal: 0 },
        { code: 'S', unitCount: 1, subtotal: 30_000_000 },
      ],
      notCharged: { feeExemptUnits: 1, heldUnits: 0, uninhabitableUnits: 0, coOwnerPaidUnits: 0 },
      conflicts: [],
    });
    expect(preview.unassessable).toEqual([
      {
        citizenId: unmeasured,
        name: expect.any(String),
        reason: 'وحدة 0102 على العقار 77 بلا مساحة مسجّلة',
        code: 'NO_AREA',
        unit: expect.objectContaining({ unitCode: '0102', propertyNumber: '77', unitArea: null }),
      },
    ]);
    expect(await written()).toEqual(before);
  });

  it('previews what a PER_UNIT issue then bills, to the citizen and the pound', async () => {
    const notice = {
      title: `رسم الأرصفة ${randomUUID().slice(0, 8)}`,
      amount: 90_000,
      basis: 'PER_UNIT',
      bearer: 'OWNER',
      frequency: 'ONCE',
      targetType: 'ALL_CITIZENS',
      dueDate: '2026-12-31',
    } as const;

    const preview = await within(() => fees.previewNotice(notice));
    const issued = await within(() => fees.issue({ ...notice, clientRequestId: randomUUID() } as CreateFeeNotice, actor));

    const bills = await db.citizenPayment.findMany({ where: { feeNoticeId: issued.noticeId }, select: { amount: true } });
    expect(issued.issued).toBe(preview.billedCitizens);
    expect(bills.reduce((sum, bill) => sum + Number(bill.amount), 0)).toBe(preview.expectedRevenue);
    expect(preview.sharedBills).toBe(0);
    expect(preview.brackets).toEqual([]);
  });

  it('previews a notice that targets nobody as zeros rather than refusing', async () => {
    const preview = await within(() =>
      fees.previewNotice({ ...tieredNotice, targetType: 'BUILDING_CATEGORY', targetCategory: 'WAREHOUSE' }),
    );
    expect(preview).toMatchObject({ targetedCitizens: 0, billedCitizens: 0, sharedBills: 0, expectedRevenue: 0 });
  });
});

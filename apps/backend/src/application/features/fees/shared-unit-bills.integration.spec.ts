import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { BulkSettlePayments, CreateFeeNotice, FeeAssessment, FeeMatrixBracket } from '@mechanization/shared-schemas';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { CitizensService } from '../citizens/citizens.service';
import { ReportingService } from '../reporting/reporting.service';
import { TreasuryLedgerService } from '../treasury/treasury-ledger.service';
import { FeesService } from './fees.service';
import { ParcelDuesService } from './parcel-dues.service';
import { PaymentLedgerService } from './payment-ledger.service';
import { PaymentSettlementService } from './payment-settlement.service';

/**
 * The shared unit bill, written and paid (0099; decision D5 of 2026-10-23,
 * docs/fees-system-rearchitecture-specification.md): a TIERED_AREA notice
 * issued against a real tenant schema, its recurring run, «المستحق على عقار»,
 * and the counter.
 *
 * The town, synthetic: three brothers who own one shop together, the eldest
 * also owning a flat of his own, and a neighbour who owns nothing here.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_shared_unit_bills_spec';
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
  bracket({ code: 'B', minArea: 100, maxArea: null, amount: 1_500_000 }),
  bracket({ code: 'S', unitTypes: ['SHOP'], minArea: 0, maxArea: null, amount: 30_000_000 }),
];

describeIfDb('shared unit bills', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let fees: FeesService;
  let parcelDues: ParcelDuesService;
  let settlements: PaymentSettlementService;
  let reporting: ReportingService;
  let citizens: CitizensService;
  const accountantId = randomUUID();
  const actor = { id: accountantId, role: 'ACCOUNTANT' };
  const brothers = [randomUUID(), randomUUID(), randomUUID()].sort();
  const neighbour = randomUUID();
  let shopId: string;

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-sub', tenantSlug: 'sub', schemaName: SCHEMA, prisma: db }, work);

  async function citizenOwning(citizenId: string, firstName: string, buildingId: string, units: Array<{ id: string; unitType: string; unitArea: number }>) {
    await db.user.create({ data: { id: citizenId, kind: 'CITIZEN', tenantSlug: 'sub', firstName, lastName: 'الاختبار' } });
    const registration = await db.registration.create({
      data: { citizenId, referenceNumber: `SUB-${randomUUID()}`, createdById: accountantId },
    });
    if (units.length === 0) return;
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
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    const payments = new PaymentLedgerService(context, audit, new TreasuryLedgerService(context));
    fees = new FeesService(
      context,
      new EventEmitter2(),
      {} as never,
      {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        invalidatePrefix: jest.fn().mockResolvedValue(undefined),
      } as never,
      payments,
      audit,
    );
    parcelDues = new ParcelDuesService(context);
    settlements = new PaymentSettlementService(context, new EventEmitter2(), payments, audit, new TreasuryLedgerService(context));
    reporting = new ReportingService(
      context,
      new EventEmitter2(),
      { get: async () => null, set: async () => undefined } as never,
      { get: () => undefined } as never,
    );
    citizens = new CitizensService(
      context,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new EventEmitter2(),
      audit,
    );

    await db.user.create({
      data: {
        id: accountantId,
        kind: 'STAFF',
        tenantSlug: 'sub',
        email: `accountant-${accountantId}@sub.gov.lb`,
        firstName: 'سارة',
        lastName: 'المحاسبة',
        role: 'ACCOUNTANT' as never,
      },
    });
    await db.systemSettings.upsert({
      where: { singleton: true },
      create: { singleton: true, baseCurrency: 'LBP', secondaryCurrency: 'USD', exchangeRate: 89_500 },
      update: {},
    });

    const building = await db.building.create({
      data: { parcelNumber: '88', codeSuffix: 'A', code: 'A1-88-A', structureType: 'MIXED_USE' as never, floorsCount: 2, createdById: accountantId },
    });
    const unit = (code: string, floor: number, sequence: number, unitType: string, unitArea: number) =>
      db.unit.create({
        data: {
          buildingId: building.id,
          unitCode: code,
          floor,
          sequence,
          unitType: unitType as never,
          unitArea,
          unitStatus: 'OWNER_OCCUPIED' as never,
          surveyStatus: 'COMPLETE' as never,
        },
      });
    const shop = await unit('0001', 0, 1, 'SHOP', 40);
    const flat = await unit('0101', 1, 1, 'APARTMENT', 120);
    shopId = shop.id;

    await citizenOwning(brothers[0]!, 'علي', building.id, [
      { id: shop.id, unitType: 'SHOP', unitArea: 40 },
      { id: flat.id, unitType: 'APARTMENT', unitArea: 120 },
    ]);
    await citizenOwning(brothers[1]!, 'معروف', building.id, [{ id: shop.id, unitType: 'SHOP', unitArea: 40 }]);
    await citizenOwning(brothers[2]!, 'عارف', building.id, [{ id: shop.id, unitType: 'SHOP', unitArea: 40 }]);
    await citizenOwning(neighbour, 'حسين', building.id, []);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  const notice = (over: Partial<CreateFeeNotice> = {}): CreateFeeNotice =>
    ({
      title: `رسم القيمة التأجيرية ${randomUUID().slice(0, 6)}`,
      amount: 0,
      basis: 'TIERED_AREA',
      matrixBrackets: TABLE,
      bearer: 'OCCUPANT',
      frequency: 'ONCE',
      targetType: 'ALL_CITIZENS',
      dueDate: '2026-12-31',
      clientRequestId: randomUUID(),
      ...over,
    }) as CreateFeeNotice;

  let issuedNoticeId: string;
  let sharedBillId: string;
  let ownBillId: string;
  let recurringNoticeId: string;

  it('issues a bracket notice: the shop once to the three brothers, the flat to its owner, as previewed (T-8, T-9)', async () => {
    const input = notice();
    const { clientRequestId, ...previewInput } = input;
    expect(clientRequestId).toBeDefined();
    const preview = await within(() => fees.previewNotice(previewInput));

    const issued = await within(() => fees.issue(input, actor));
    issuedNoticeId = issued.noticeId;

    expect(issued).toMatchObject({ issued: 2, sharedBills: 1, sharedUnitConflicts: [] });
    const bills = await db.citizenPayment.findMany({
      where: { feeNoticeId: issued.noticeId },
      include: { debtors: { select: { citizenId: true, role: true } } },
    });
    // What the preview showed is what was billed: the citizens, and the money to the pound.
    expect(bills.filter((bill) => bill.citizenId).length).toBe(preview.billedCitizens);
    expect(bills.filter((bill) => bill.unitId).length).toBe(preview.sharedBills);
    expect(bills.reduce((sum, bill) => sum + Number(bill.amount), 0)).toBe(preview.expectedRevenue);

    const shared = bills.find((bill) => bill.unitId)!;
    sharedBillId = shared.id;
    expect(shared).toMatchObject({ citizenId: null, unitId: shopId, invoiceNumber: expect.stringMatching(/^INV-/) });
    expect(Number(shared.amount)).toBe(30_000_000);
    expect((shared.assessment as FeeAssessment).sharedBillDebtorCount).toBe(3);
    expect(shared.debtors.map((debtor) => [debtor.citizenId, debtor.role]).sort()).toEqual(
      brothers.map((id) => [id, 'OWNER']).sort(),
    );

    const own = bills.find((bill) => bill.citizenId)!;
    ownBillId = own.id;
    expect(own).toMatchObject({ citizenId: brothers[0], invoiceNumber: expect.stringMatching(/^INV-/) });
    expect(Number(own.amount)).toBe(1_500_000);
    expect((own.assessment as FeeAssessment).sharedBillUnitCount).toBe(1);

    const stored = await db.feeNotice.findUniqueOrThrow({ where: { id: issued.noticeId } });
    expect(stored.matrixBrackets).toHaveLength(TABLE.length);
  });

  it('shows the unpaid shared bill on its parcel, so a clearance cannot pass over it', async () => {
    const dues = await within(() => parcelDues.dues('88'));
    const shared = dues.bills.find((bill) => bill.paymentId === sharedBillId);
    expect(shared).toMatchObject({ citizenId: null, citizenName: null, sharedDebtorCount: 3, remaining: 30_000_000 });
  });

  it('shows the shared bill among each debtor’s own — the portal, their file, the ledger and the register — and the register’s total counts it once', async () => {
    const mine = await within(() => fees.listForCitizen(brothers[1]!));
    expect(mine.map((bill) => [bill.id, bill.sharedUnit?.debtorCount ?? null])).toEqual([[sharedBillId, 3]]);
    const eldest = await within(() => fees.listForCitizen(brothers[0]!));
    expect(eldest.map((bill) => bill.id).sort()).toEqual([ownBillId, sharedBillId].sort());
    expect(await within(() => fees.listForCitizen(neighbour))).toEqual([]);

    const profile = await within(() => reporting.getCitizenProfile(brothers[2]!));
    expect(profile!.payments.map((bill) => [bill.id, bill.sharedUnit?.unitCode ?? null])).toEqual([[sharedBillId, '0001']]);

    const ledger = await within(() => fees.listAllPayments({ citizenId: brothers[1]! }));
    expect(ledger.items.map((bill) => bill.id)).toEqual([sharedBillId]);

    const register = await within(() => citizens.list({ limit: 50 }));
    const outstandingOf = (id: string) => register.items.find((row) => row.id === id)?.outstandingTotal;
    expect(brothers.map(outstandingOf)).toEqual([31_500_000, 30_000_000, 30_000_000]);
    // The municipality is owed the shop once and the flat once — not the shop three times.
    expect(register.totals.outstanding).toBe(31_500_000);
  });

  it('refuses a debtor’s claim on a shared bill — it is paid at the office — and answers a stranger as for any bill not theirs', async () => {
    const claim = (citizenId: string) =>
      within(() =>
        fees.declare({ paymentId: sharedBillId, citizenId, method: 'WHISH_MONEY', whishTransactionRef: 'WSH-SHARED-1' }),
      );
    await expect(claim(brothers[1]!)).rejects.toMatchObject({ code: 'SHARED_BILL_PAY_AT_OFFICE' });
    await expect(claim(neighbour)).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND' });
    expect((await db.citizenPayment.findUniqueOrThrow({ where: { id: sharedBillId } })).paymentStatus).toBe('UNPAID');
  });

  it('takes the money on a shared bill from one of its debtors only, and names them on the receipt', async () => {
    const settle = (paymentId: string, paidByCitizenId?: string) =>
      within(() =>
        fees.settleInPerson({ paymentId, method: 'CASH', paidByCitizenId, clientRequestId: randomUUID(), actor }),
      );

    await expect(settle(sharedBillId)).rejects.toMatchObject({ code: 'SHARED_BILL_PAYER_REQUIRED' });
    await expect(settle(sharedBillId, neighbour)).rejects.toMatchObject({ code: 'SHARED_BILL_PAYER_NOT_DEBTOR' });
    await expect(settle(ownBillId, brothers[1])).rejects.toMatchObject({ code: 'SHARED_BILL_PAYER_ON_OWN_BILL' });
    expect(await db.paymentTransaction.count({ where: { paymentId: { in: [sharedBillId, ownBillId] } } })).toBe(0);

    await settle(sharedBillId, brothers[1]);

    // Paid once, for all three.
    expect((await db.citizenPayment.findUniqueOrThrow({ where: { id: sharedBillId } })).paymentStatus).toBe('PAID');
    const receipts = await db.paymentTransaction.findMany({ where: { paymentId: sharedBillId } });
    expect(receipts.map((receipt) => [Number(receipt.amount), receipt.paidByCitizenId])).toEqual([[30_000_000, brothers[1]]]);
  });

  it('bills a recurring bracket notice once a period, the shared bill and its debtors included, however often it runs', async () => {
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const issued = await within(() =>
      fees.issue(notice({ frequency: 'MONTHLY', dueDate: lastMonth.toISOString().slice(0, 10) }), actor),
    );

    await within(() => fees.runRecurringBilling(now));
    await within(() => fees.runRecurringBilling(now));

    const bills = await db.citizenPayment.findMany({
      where: { feeNoticeId: issued.noticeId },
      select: { periodKey: true, citizenId: true, unitId: true, invoiceNumber: true, _count: { select: { debtors: true } } },
    });
    const byPeriod = new Map<string, typeof bills>();
    for (const bill of bills) byPeriod.set(bill.periodKey, [...(byPeriod.get(bill.periodKey) ?? []), bill]);
    // The month it was issued for, and this month: each one own bill and one shared bill.
    expect([...byPeriod.values()].map((period) => period.length)).toEqual([2, 2]);
    for (const period of byPeriod.values()) {
      expect(period.filter((bill) => bill.unitId).map((bill) => bill._count.debtors)).toEqual([3]);
      expect(period.every((bill) => bill.invoiceNumber?.startsWith('INV-'))).toBe(true);
    }
    expect(issuedNoticeId).not.toBe(issued.noticeId);
    recurringNoticeId = issued.noticeId;
  });

  it('settles a debtor’s shared bill with their own in one press, naming them as its payer, and refuses it to a stranger', async () => {
    // One period of the recurring notice: the eldest's own flat and the shop the three share.
    const open = await db.citizenPayment.findMany({
      where: { feeNoticeId: recurringNoticeId, paymentStatus: 'UNPAID', OR: [{ citizenId: brothers[0] }, { unitId: shopId }] },
      select: { id: true, amount: true, unitId: true, periodKey: true },
      orderBy: [{ periodKey: 'asc' }, { createdAt: 'asc' }],
    });
    const period = open.filter((bill) => bill.periodKey === open[0]!.periodKey);
    expect(period.map((bill) => Boolean(bill.unitId)).sort()).toEqual([false, true]);
    const total = period.reduce((sum, bill) => sum + Number(bill.amount), 0);
    const press = (citizenId: string) =>
      within(() =>
        settlements.settle(
          {
            citizenId,
            paymentIds: period.map((bill) => bill.id),
            method: 'CASH',
            tendered: { local: total, foreign: 0, foreignCurrency: 'USD' },
            expectedDue: { LBP: total },
            clientRequestId: randomUUID(),
          } as BulkSettlePayments,
          actor,
        ),
      );

    await expect(press(neighbour)).rejects.toMatchObject({ code: 'BULK_SETTLE_CITIZEN_MISMATCH' });
    await press(brothers[0]!);

    const receipts = await db.paymentTransaction.findMany({
      where: { paymentId: { in: period.map((bill) => bill.id) } },
      select: { paymentId: true, paidByCitizenId: true },
    });
    const sharedId = period.find((bill) => bill.unitId)!.id;
    expect(receipts.map((receipt) => [receipt.paymentId === sharedId, receipt.paidByCitizenId]).sort()).toEqual([
      [false, null],
      [true, brothers[0]],
    ]);
  });
});

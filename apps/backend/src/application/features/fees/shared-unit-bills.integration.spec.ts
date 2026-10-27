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
  let flatId: string;
  let buildingId: string;

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
    flatId = flat.id;
    buildingId = building.id;

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
    // The counter's one bill names its debtors, for the clerk to say which one paid; the lists never do.
    const atCounter = await within(() => fees.getPaymentById(sharedBillId));
    expect(atCounter.sharedDebtors.map((debtor) => debtor.citizenId).sort()).toEqual([...brothers].sort());
    expect(atCounter.sharedDebtors.every((debtor) => debtor.name.length > 0 && debtor.role === 'OWNER')).toBe(true);
    expect(ledger.items[0]).not.toHaveProperty('sharedDebtors');

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

  it('lists each receipt of a shared bill with the debtor who paid it, so a reprint names them (D9)', async () => {
    const receipts = await within(() => fees.listTransactions(sharedBillId));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      amount: 30_000_000,
      paidByCitizenId: brothers[1],
      paidByName: expect.stringContaining('معروف'),
      receiptNumber: expect.any(String),
    });
    // A citizen's own bill names no payer: its receipt names the bill's citizen.
    const recurringOwn = await db.citizenPayment.findFirstOrThrow({
      where: { feeNoticeId: recurringNoticeId, citizenId: brothers[0], paymentStatus: 'PAID' },
    });
    const own = await within(() => fees.listTransactions(recurringOwn.id));
    expect(own.map((row) => [row.paidByCitizenId, row.paidByName])).toEqual([[null, null]]);
  });

  it('cancels a period’s shared bill with the notice, its debtors kept on the record (D12)', async () => {
    const now = new Date();
    const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const periods = await within(() => fees.noticePeriods(recurringNoticeId));
    expect(periods.find((row) => row.periodKey === current)).toMatchObject({ bills: 2, cancellable: 2 });

    const manager = { id: accountantId, role: 'SUPER_ADMIN' };
    const result = await within(() =>
      fees.cancelNoticeBatch(recurringNoticeId, { reason: 'صدر بالجدول الخطأ', periodKeys: [current] }, manager),
    );
    expect(result).toMatchObject({ cancelled: 2, skipped: [] });

    const shared = await db.citizenPayment.findFirstOrThrow({
      where: { feeNoticeId: recurringNoticeId, periodKey: current, unitId: shopId },
      include: { _count: { select: { debtors: true } } },
    });
    expect(shared.paymentStatus).toBe('CANCELLED');
    expect(shared._count.debtors).toBe(3);
    const row = await db.auditLogEntry.findFirstOrThrow({ where: { action: 'FEE_BILL_CANCELLED', entityId: shared.id } });
    expect(row.after).toMatchObject({ citizenId: null, periodKey: current, noticeId: recurringNoticeId });
  });

  it('refuses a merged-away debtor as the payer and does not offer them at the counter (D14)', async () => {
    const issued = await within(() => fees.issue(notice(), actor));
    const shared = await db.citizenPayment.findFirstOrThrow({ where: { feeNoticeId: issued.noticeId, unitId: shopId } });

    // The youngest brother's file is folded into the middle one's: the merge keeps both debtor rows.
    const merge = await db.citizenMerge.create({
      data: { survivorId: brothers[1]!, absorbedId: brothers[2]!, reason: 'ملف مكرّر', footprint: {}, mergedById: accountantId },
    });
    await db.user.update({ where: { id: brothers[2] }, data: { isActive: false } });
    try {
      const atCounter = await within(() => fees.getPaymentById(shared.id));
      expect(atCounter.sharedDebtors.map((debtor) => debtor.citizenId).sort()).toEqual([brothers[0], brothers[1]].sort());

      await expect(
        within(() =>
          fees.settleInPerson({ paymentId: shared.id, method: 'CASH', paidByCitizenId: brothers[2], clientRequestId: randomUUID(), actor }),
        ),
      ).rejects.toMatchObject({ code: 'CITIZEN_MERGED_AWAY' });
      expect(await db.paymentTransaction.count({ where: { paymentId: shared.id } })).toBe(0);

      await within(() =>
        fees.settleInPerson({ paymentId: shared.id, method: 'CASH', paidByCitizenId: brothers[1], clientRequestId: randomUUID(), actor }),
      );
      expect((await db.citizenPayment.findUniqueOrThrow({ where: { id: shared.id } })).paymentStatus).toBe('PAID');
    } finally {
      // Undone as «التراجع عن الدمج» records it: who, when and why move together (CHECK citizen_merges_undo_reason).
      await db.citizenMerge.update({
        where: { id: merge.id },
        data: { undoneAt: new Date(), undoneById: accountantId, undoReason: 'انتهى الاختبار' },
      });
      await db.user.update({ where: { id: brothers[2] }, data: { isActive: true } });
    }
  });

  it('bills a flat once in its period when a co-owner is recorded after the period was billed, and shares it from the next (D8)', async () => {
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15));
    const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const issued = await within(() =>
      fees.issue(notice({ frequency: 'MONTHLY', dueDate: lastMonth.toISOString().slice(0, 10) }), actor),
    );
    // This month, the eldest alone owns the flat: his own bill charges it.
    await within(() => fees.runRecurringBilling(now));
    const thisMonth = () =>
      db.citizenPayment.findMany({
        where: { feeNoticeId: issued.noticeId, periodKey: current },
        select: { citizenId: true, unitId: true, amount: true, assessment: true },
      });
    const before = await thisMonth();
    expect(before.find((bill) => bill.citizenId === brothers[0])).toBeDefined();

    // Mid-month the neighbour is recorded as the flat's co-owner.
    const registration = await db.registration.findFirstOrThrow({ where: { citizenId: neighbour } });
    const card = await db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: 'OWNER' as never,
        propertyType: 'BUILDING' as never,
        buildingId,
        propertyNumber: '88',
      },
    });
    await db.buildingUnit.create({
      data: { propertyEntryId: card.id, unitId: flatId, unitType: 'APARTMENT' as never, unitArea: 120, unitStatus: 'OWNER_OCCUPIED' as never },
    });
    await db.unitOccupancy.create({
      data: { unitId: flatId, citizenId: neighbour, role: 'OWNER' as never, registrationId: registration.id },
    });

    // The next night: nothing more for this month — the flat is not billed a second time.
    await within(() => fees.runRecurringBilling(now));
    const after = await thisMonth();
    expect(after).toHaveLength(before.length);
    expect(after.some((bill) => bill.unitId === flatId)).toBe(false);
    expect(after.some((bill) => bill.citizenId === neighbour)).toBe(false);

    // From the next month the flat is one shared bill, owed by both.
    await within(() => fees.runRecurringBilling(nextMonth));
    const next = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}`;
    const sharedFlat = await db.citizenPayment.findFirstOrThrow({
      where: { feeNoticeId: issued.noticeId, periodKey: next, unitId: flatId },
      include: { debtors: { select: { citizenId: true } } },
    });
    expect(Number(sharedFlat.amount)).toBe(1_500_000);
    expect(sharedFlat.debtors.map((debtor) => debtor.citizenId).sort()).toEqual([brothers[0], neighbour].sort());
  });
});

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { municipalToday, type ArrearsTemplateCells } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { ArrearsBatchService } from '../arrears/arrears-batch.service';
import { ArrearsService } from '../arrears/arrears.service';
import { ReportingService } from '../reporting/reporting.service';
import { TreasuryLedgerService } from '../treasury/treasury-ledger.service';
import { citizenArrears } from './bill-arrears';
import { FeesService } from './fees.service';
import { PaymentLedgerService } from './payment-ledger.service';
import { PaymentSettlementService } from './payment-settlement.service';

/**
 * An old debt's bill on every read of a bill (old debts task 10,
 * docs/old-debts-plan.md §7), against a real Postgres: the portal's list, the
 * staff bill, the citizen's file and the consolidated receipt carry the line
 * of an «ARR-» bill — its year, fee, component and رقم العقار — and a bill the
 * system raised carries none. The old books' reference reaches staff and never
 * the portal.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_bill_arrears_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

/** Read from today, so the spec outlives the calendar: the cutoff is this year, the debts are before it. */
const THIS_YEAR = Number(municipalToday().slice(0, 4));
const LAST = THIS_YEAR - 1;
const OLDER = THIS_YEAR - 2;
const OLD_REFERENCE = 'دفتر 7 ص 41';

describeIfDb('old-debt bills on every read of a bill', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let fees: FeesService;
  let reporting: ReportingService;
  let settlements: PaymentSettlementService;

  const ids = { accountant: randomUUID(), manager: randomUUID() };
  const MANAGER = { id: ids.manager, role: 'SUPER_ADMIN' };
  const citizenId = randomUUID();
  let currentBillId: string;
  let principalBillId: string;
  let penaltyBillId: string;
  let otherFeeBillId: string;

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'arrears-bill', schemaName: SCHEMA, prisma: db }, work);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    const ledger = new TreasuryLedgerService(context);
    const payments = new PaymentLedgerService(context, audit, ledger);
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      invalidatePrefix: jest.fn().mockResolvedValue(undefined),
    } as never;
    fees = new FeesService(context, { emit: jest.fn() } as unknown as EventEmitter2, {} as never, cache, payments, audit);
    reporting = new ReportingService(context, new EventEmitter2(), cache, { getOrThrow: () => 60 } as never);
    settlements = new PaymentSettlementService(context, new EventEmitter2(), payments, audit, ledger);
    const importer = new ArrearsService(context, audit);
    const batches = new ArrearsBatchService(context, audit, importer, new EventEmitter2());

    await db.user.createMany({
      data: [
        { id: citizenId, kind: 'CITIZEN', tenantSlug: 'arrears-bill', firstName: 'أمل', lastName: 'حداد', phone: '71123456' },
        ...[
          [ids.accountant, 'ACCOUNTANT'],
          [ids.manager, 'SUPER_ADMIN'],
        ].map(([id, role]) => ({
          id: id!,
          kind: 'STAFF' as const,
          tenantSlug: 'arrears-bill',
          email: `${role!.toLowerCase()}-${id}@arrears-bill.gov.lb`,
          firstName: role!,
          lastName: 'البلدية',
          role: role as never,
        })),
      ],
    });
    await db.systemSettings.create({ data: { arrearsCutoffYear: THIS_YEAR } });

    // A bill the system raised: it must come back with no old-debt line.
    currentBillId = (
      await db.citizenPayment.create({
        data: { citizenId, title: 'رسم النظافة', amount: 120_000, dueDate: new Date(`${THIS_YEAR}-12-31T00:00:00.000Z`) },
        select: { id: true },
      })
    ).id;

    // One approved batch: a principal with a penalty (two bills) and a fee described as «رسم آخر».
    const batch = await db.arrearsBatch.create({ data: { preparedById: ids.accountant }, select: { id: true } });
    await db.arrearsBatchCitizen.create({ data: { batchId: batch.id, citizenId, rowKey: 1 } });
    const row = (year: number, extra: ArrearsTemplateCells): ArrearsTemplateCells => ({
      rowKey: '1',
      propertyNumber: '1234',
      year: String(year),
      feeType: 'CLEANING',
      principal: '500000',
      ...extra,
    });
    await scoped(() =>
      importer.importLines(
        batch.id,
        {
          rows: [
            row(LAST, { penalty: '50000', oldReference: OLD_REFERENCE }),
            row(OLDER, { feeType: 'OTHER', feeTypeNote: 'رسم إشغال الرصيف', principal: '300000' }),
          ],
          startRow: 1,
          drops: [],
          dryRun: false,
        },
        { id: ids.accountant, role: 'ACCOUNTANT' },
      ),
    );
    const amount = (await db.arrearsLine.findMany({ where: { batchId: batch.id }, select: { amount: true } })).reduce(
      (sum, line) => sum + Math.round(Number(line.amount) * 100),
      0,
    );
    await scoped(() => batches.submit(batch.id, { controlTotal: amount / 100 }, { id: ids.accountant, role: 'ACCOUNTANT' }));
    await scoped(() => batches.approve(batch.id, MANAGER));

    const bills = await db.citizenPayment.findMany({ where: { arrearsLine: { batchId: batch.id } }, include: { arrearsLine: true } });
    const find = (year: number, component: 'PRINCIPAL' | 'PENALTY') =>
      bills.find((bill) => bill.arrearsLine?.year === year && bill.arrearsLine.component === component)!.id;
    principalBillId = find(LAST, 'PRINCIPAL');
    penaltyBillId = find(LAST, 'PENALTY');
    otherFeeBillId = find(OLDER, 'PRINCIPAL');
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  describe('the portal’s own list (`listForCitizen`)', () => {
    it('carries the line of each old debt, with its «ARR-» number and no old reference', async () => {
      const list = await scoped(() => fees.listForCitizen(citizenId));
      const principal = list.find((bill) => bill.id === principalBillId)!;
      expect(principal.invoiceNumber).toMatch(/^ARR-\d{4}-\d{4}$/);
      expect(principal.arrears).toEqual({
        year: LAST,
        feeType: 'CLEANING',
        feeTypeNote: null,
        component: 'PRINCIPAL',
        propertyNumber: '1234',
        unitCode: null,
        oldReference: null,
      });
      expect(list.find((bill) => bill.id === penaltyBillId)!.arrears).toMatchObject({ year: LAST, component: 'PENALTY' });
      expect(list.find((bill) => bill.id === otherFeeBillId)!.arrears).toMatchObject({
        year: OLDER,
        feeType: 'OTHER',
        feeTypeNote: 'رسم إشغال الرصيف',
      });
    });

    it('carries none on a bill the system raised', async () => {
      const current = (await scoped(() => fees.listForCitizen(citizenId))).find((bill) => bill.id === currentBillId)!;
      expect(current.arrears).toBeNull();
    });

    it('never leaks the old books’ reference anywhere in the answer', async () => {
      const list = await scoped(() => fees.listForCitizen(citizenId));
      expect(JSON.stringify(list)).not.toContain(OLD_REFERENCE);
    });
  });

  describe('the staff bill (`getPaymentById`)', () => {
    it('adds the old books’ reference for staff', async () => {
      const bill = await scoped(() => fees.getPaymentById(principalBillId));
      expect(bill.arrears).toMatchObject({ year: LAST, feeType: 'CLEANING', component: 'PRINCIPAL', oldReference: OLD_REFERENCE });
      expect(bill.invoiceNumber).toMatch(/^ARR-/);
    });

    it('carries none on a bill the system raised', async () => {
      expect((await scoped(() => fees.getPaymentById(currentBillId))).arrears).toBeNull();
    });
  });

  describe('the citizen’s file (`getCitizenProfile`), and what the portal makes of it', () => {
    it('gives staff the line with the old reference, and the portal the same line without it', async () => {
      const profile = (await scoped(() => reporting.getCitizenProfile(citizenId)))!;
      const staffView = profile.payments.find((bill) => bill.id === principalBillId)!;
      expect(staffView.arrears).toMatchObject({ year: LAST, oldReference: OLD_REFERENCE });

      // What `CitizenController.mySummary` does to every bill before it answers.
      const portal = profile.payments.map((bill) => ({ ...bill, arrears: citizenArrears(bill.arrears) }));
      expect(portal.find((bill) => bill.id === principalBillId)!.arrears).toMatchObject({ year: LAST, oldReference: null });
      expect(JSON.stringify(portal)).not.toContain(OLD_REFERENCE);
      // …and the staff profile, which is cached and shared, was not touched.
      expect(profile.payments.find((bill) => bill.id === principalBillId)!.arrears?.oldReference).toBe(OLD_REFERENCE);
    });

    it('carries none on a bill the system raised', async () => {
      const profile = (await scoped(() => reporting.getCitizenProfile(citizenId)))!;
      expect(profile.payments.find((bill) => bill.id === currentBillId)!.arrears).toBeNull();
    });
  });

  describe('the consolidated receipt of a settlement of several bills', () => {
    it('labels each old debt on the receipt and leaves the old reference off it', async () => {
      const receipt = await scoped(() =>
        settlements.settle(
          {
            citizenId,
            paymentIds: [otherFeeBillId, principalBillId, currentBillId],
            method: 'WHISH_MONEY',
            whishTransactionRef: `WSH-${randomUUID().slice(0, 8)}`,
            expectedDue: { LBP: 300_000 + 500_000 + 120_000 },
            clientRequestId: randomUUID(),
          } as never,
          MANAGER,
        ),
      );
      const item = (id: string) => receipt.items.find((entry) => entry.paymentId === id)!;
      expect(item(principalBillId).arrears).toMatchObject({ year: LAST, feeType: 'CLEANING', oldReference: null });
      expect(item(otherFeeBillId).arrears).toMatchObject({ year: OLDER, feeType: 'OTHER', feeTypeNote: 'رسم إشغال الرصيف' });
      expect(item(currentBillId).arrears).toBeNull();
      expect(JSON.stringify(receipt)).not.toContain(OLD_REFERENCE);
    });
  });

  describe('a correction of an «ARR-» bill', () => {
    it('reverses a receipt taken on it, and the bill is owed again with its line', async () => {
      // Paid by the settlement above.
      const paid = await scoped(() => fees.getPaymentById(otherFeeBillId));
      expect(paid.paymentStatus).toBe('PAID');
      const receipt = await db.paymentTransaction.findFirstOrThrow({ where: { paymentId: otherFeeBillId, reversalOfId: null } });

      await scoped(() => fees.reverseTransaction({ transactionId: receipt.id, note: 'وصل بالخطأ', actor: MANAGER }));

      const again = await scoped(() => fees.getPaymentById(otherFeeBillId));
      // Owed again, and past its due date (31 December of its year): OVERDUE is derived on read.
      expect(again.paymentStatus).toBe('OVERDUE');
      expect(again.paidAmount).toBe(0);
      expect(again.arrears).toMatchObject({ year: OLDER, feeType: 'OTHER' });
    });

    it('cancels it on a reason that cites the old receipt, and keeps the line on the cancelled bill', async () => {
      const reason = 'سدّده المواطن سابقاً: إيصال رقم 123 في دفتر 7 بتاريخ 2019/05/12';
      await scoped(() => fees.cancelBill(penaltyBillId, reason, MANAGER));

      const cancelled = await scoped(() => fees.getPaymentById(penaltyBillId));
      expect(cancelled).toMatchObject({ paymentStatus: 'CANCELLED', cancellationReason: reason, remaining: 0 });
      // It stays on the file as an old debt, struck through, not as a bill that never was one.
      expect(cancelled.arrears).toMatchObject({ year: LAST, component: 'PENALTY' });
      // The line itself is the municipality's record and is never deleted (docs/old-debts-plan.md decision 10).
      expect(await db.arrearsLine.count({ where: { bill: { id: penaltyBillId } } })).toBe(1);
    });
  });
});

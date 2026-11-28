import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { arrearsReportBalances, municipalToday, type ArrearsTemplateCells } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { FeesService } from '../fees/fees.service';
import { PaymentLedgerService } from '../fees/payment-ledger.service';
import { TreasuryLedgerService } from '../treasury/treasury-ledger.service';
import { ArrearsBatchService } from './arrears-batch.service';
import { ArrearsReportService } from './arrears-report.service';
import { ArrearsService } from './arrears.service';
import { StaffActor } from '../../common/actor';
import { feeServices } from '../fees/fee-services.testing';
import type { BillLifecycleService } from '../fees/bill-lifecycle.service';

/**
 * «تقرير المتأخرات» and a batch's sheet (task 11, docs/old-debts-plan.md §8),
 * against a real Postgres: one approved batch whose bills are paid, cancelled,
 * written off and reversed through the same services the counter uses, so each
 * figure is checked against what the counter does, not against a fixture. Money
 * moves in the current year, which the spec reads from the clock, as the
 * years of the debts are.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_arrears_report_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const THIS_YEAR = Number(municipalToday().slice(0, 4));
const LAST = THIS_YEAR - 1;
const OLDER = THIS_YEAR - 2;
/** Past 31 December of its year + 5: dropped by prescription. */
const PRESCRIBED = THIS_YEAR - 6;

describeIfDb('«تقرير المتأخرات» and the batch sheet', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let fees: FeesService;
  let billLifecycle: BillLifecycleService;
  let reports: ArrearsReportService;
  let importer: ArrearsService;
  let batches: ArrearsBatchService;

  const ids = { accountant: randomUUID(), manager: randomUUID() };
  const ACCOUNTANT: StaffActor = { id: ids.accountant, role: 'ACCOUNTANT' };
  const MANAGER: StaffActor = { id: ids.manager, role: 'SUPER_ADMIN' };
  const person = { amal: randomUUID(), bassem: randomUUID(), elias: randomUUID(), unchecked: randomUUID(), merged: randomUUID() };
  let batchId: string;
  let draftId: string;

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'arrears-report', schemaName: SCHEMA, prisma: db }, work);

  const row = (rowKey: number | null, property: string, year: number, principal: string, extra: ArrearsTemplateCells = {}): ArrearsTemplateCells => ({
    ...(rowKey === null ? {} : { rowKey: String(rowKey) }),
    propertyNumber: property,
    year: String(year),
    feeType: 'CLEANING',
    principal,
    ...extra,
  });

  const billOf = async (property: string, year: number, component: 'PRINCIPAL' | 'PENALTY', feeType = 'CLEANING') =>
    (
      await db.citizenPayment.findFirstOrThrow({
        where: { arrearsLine: { batchId, propertyNumber: property, year, component, feeType } },
        select: { id: true },
      })
    ).id;

  const cash = (paymentId: string, amount: number) =>
    scoped(() => fees.settleInPerson({ paymentId, method: 'CASH', amount, clientRequestId: randomUUID(), actor: MANAGER }));

  const ordinaryBill = async (citizenId: string, amount: number) =>
    (
      await db.citizenPayment.create({
        data: { citizenId, title: 'رسم', amount, dueDate: new Date(`${THIS_YEAR}-12-31T00:00:00.000Z`) },
        select: { id: true },
      })
    ).id;

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
    ({ fees, billLifecycle } = feeServices(context, { emit: jest.fn() } as unknown as EventEmitter2, {} as never, cache, payments, audit));
    importer = new ArrearsService(context, audit);
    batches = new ArrearsBatchService(context, audit, importer, new EventEmitter2());
    reports = new ArrearsReportService(context, batches);

    const citizen = (id: string, firstName: string) => ({
      id, kind: 'CITIZEN' as const, tenantSlug: 'arrears-report', firstName, middleName: 'محمد', lastName: 'حداد',
      referenceNumber: `REF-${id.slice(0, 8)}`, phone: '+96170123456',
    });
    const staff = (id: string, role: string) => ({ id, kind: 'STAFF' as const, tenantSlug: 'arrears-report', email: `${id}@arr.gov.lb`, firstName: role, lastName: 'البلدية', role: role as never });
    await db.user.createMany({
      data: [
        staff(ids.accountant, 'ACCOUNTANT'),
        staff(ids.manager, 'SUPER_ADMIN'),
        citizen(person.amal, 'أمل'),
        citizen(person.bassem, 'باسم'),
        citizen(person.elias, 'إلياس'),
        citizen(person.unchecked, 'سامر'),
        citizen(person.merged, 'نادر'),
      ],
    });
    // A file folded into another is not a citizen of the report's denominator.
    await db.citizenMerge.create({
      data: { survivorId: person.unchecked, absorbedId: person.merged, reason: 'ملف مكرّر', footprint: {}, mergedById: ids.manager },
    });
    await db.systemSettings.create({ data: { arrearsCutoffYear: THIS_YEAR } });
    // The old books' total for LAST: more than was imported, so something remains to import.
    await db.arrearsControlTotal.create({ data: { year: LAST, amount: 1_000_000, enteredById: ids.manager } });

    // The approved batch: a principal with a penalty, a second fee, an unmatched line and a prescribed one.
    batchId = (await db.arrearsBatch.create({ data: { preparedById: ids.accountant }, select: { id: true } })).id;
    await db.arrearsBatchCitizen.createMany({
      data: [
        { batchId, citizenId: person.amal, rowKey: 1 },
        { batchId, citizenId: person.bassem, rowKey: 2 },
      ],
    });
    await scoped(() =>
      importer.importLines(
        batchId,
        {
          rows: [
            row(1, 'P1', LAST, '500000', { penalty: '50000', oldReference: 'دفتر 7 ص 41' }),
            row(1, 'P1', OLDER, '300000', { feeType: 'RENTAL_VALUE' }),
            row(2, 'P2', LAST, '200000'),
            row(null, 'P3', LAST, '80000', { fullName: 'غير مسجّل' }),
            row(2, 'P2', PRESCRIBED, '40000', { feeType: 'RENTAL_VALUE' }),
          ],
          startRow: 1,
          drops: [],
          dryRun: false,
        },
        ACCOUNTANT,
      ),
    );
    const total =
      (await db.arrearsLine.findMany({ where: { batchId }, select: { amount: true } })).reduce((sum, line) => sum + Math.round(Number(line.amount) * 100), 0) / 100;
    await scoped(() => batches.submit(batchId, { controlTotal: total }, ACCOUNTANT));
    await scoped(() => batches.approve(batchId, MANAGER));

    // A draft: not approved, so it must change nothing in the report.
    draftId = (await db.arrearsBatch.create({ data: { preparedById: ids.accountant }, select: { id: true } })).id;
    await db.arrearsBatchCitizen.create({ data: { batchId: draftId, citizenId: person.elias, rowKey: 1 } });
    await scoped(() =>
      importer.importLines(draftId, { rows: [row(1, 'P9', LAST, '999000')], startRow: 1, drops: [], dryRun: false }, ACCOUNTANT),
    );

    // What the counter does to the bills.
    await cash(await billOf('P1', LAST, 'PRINCIPAL'), 500_000); // paid in full
    const penalty = await billOf('P1', LAST, 'PENALTY');
    await scoped(() => billLifecycle.cancelBill(penalty, 'سدّده المواطن سابقاً: إيصال رقم 123', MANAGER)); // a mistake
    const rental = await billOf('P1', OLDER, 'PRINCIPAL', 'RENTAL_VALUE');
    await cash(rental, 100_000); // part-paid, then the rest forgiven
    await scoped(() => billLifecycle.writeOffBill(rental, { reason: 'عفو عن رسوم ما قبل 2020', decisionRef: '45/2026', decisionDate: '2026-11-01' }, MANAGER));

    // Every other bill: one paid and kept, one paid and reversed.
    const kept = await ordinaryBill(person.bassem, 25_000);
    await cash(kept, 25_000);
    const reversed = await ordinaryBill(person.bassem, 30_000);
    await cash(reversed, 30_000);
    const receipt = await db.paymentTransaction.findFirstOrThrow({ where: { paymentId: reversed, reversalOfId: null } });
    await scoped(() => billLifecycle.reverseTransaction({ transactionId: receipt.id, note: 'وصل بالخطأ', actor: MANAGER }));

  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  describe('by year × fee type', () => {
    it('reads every figure off the bills, the way the counter left them', async () => {
      const report = await scoped(() => reports.report());
      const cleaning = report.rows.find((entry) => entry.year === LAST && entry.feeType === 'CLEANING')!;
      expect(cleaning).toMatchObject({
        billedCount: 3, // P1's principal and penalty, P2's principal
        billed: 750_000,
        collected: 500_000,
        cancelled: 50_000,
        writtenOff: 0,
        owed: 200_000,
        // P3 is nobody's file yet: a line in «للمطابقة», no bill.
        waitingCount: 1,
        waiting: 80_000,
      });
      const rental = report.rows.find((entry) => entry.year === OLDER && entry.feeType === 'RENTAL_VALUE')!;
      expect(rental).toMatchObject({ billedCount: 1, billed: 300_000, collected: 100_000, cancelled: 0, writtenOff: 200_000, owed: 0 });
    });

    it('keeps every pound of a bill in one of four places, in each row and in the total', async () => {
      const report = await scoped(() => reports.report());
      for (const entry of report.rows) expect(arrearsReportBalances(entry)).toBe(true);
      expect(arrearsReportBalances(report.totals)).toBe(true);
      expect(report.totals).toMatchObject({ billed: 1_050_000, collected: 600_000, cancelled: 50_000, writtenOff: 200_000, owed: 200_000 });
    });

    it('leaves a prescribed line without a bill, and a draft batch out altogether', async () => {
      const report = await scoped(() => reports.report());
      expect(report.rows.find((entry) => entry.year === PRESCRIBED)).toBeUndefined();
      // The draft's 999,000 is nowhere.
      expect(report.rows.some((entry) => entry.billed === 999_000 || entry.waiting === 999_000)).toBe(false);
    });
  });

  describe('against the old books', () => {
    it('shows what was imported for each year, the prescribed apart, and what remains against the books’ total', async () => {
      const { years } = await scoped(() => reports.report());
      expect(years.find((entry) => entry.year === LAST)).toEqual({
        year: LAST,
        imported: 830_000, // 500,000 + 50,000 + 200,000 + the unmatched 80,000
        prescribed: 0,
        dropped: 0,
        controlTotal: 1_000_000,
        remainingToImport: 170_000,
      });
      expect(years.find((entry) => entry.year === OLDER)).toMatchObject({ imported: 300_000, controlTotal: null, remainingToImport: null });
      expect(years.find((entry) => entry.year === PRESCRIBED)).toMatchObject({ imported: 40_000, prescribed: 40_000, dropped: 0 });
    });
  });

  describe('coverage', () => {
    it('counts the citizens of approved batches over every file but a merged-away one', async () => {
      const { coverage } = await scoped(() => reports.report());
      // Amal and Bassem were checked; Elias is in a draft only. Five files, one of them folded into another.
      expect(coverage).toEqual({ checked: 2, total: 4 });
    });
  });

  describe('collections', () => {
    it('keeps what was taken on old debts apart from every other bill, net of a reversed receipt', async () => {
      const { collections } = await scoped(() => reports.report());
      const thisYear = collections.find((entry) => entry.year === Number(municipalToday().slice(0, 4)) && entry.currency === 'LBP')!;
      // 500,000 in full and 100,000 on the bill later written off; the ordinary 25,000 kept, and 30,000 taken then reversed.
      expect(thisYear).toMatchObject({ arrears: 600_000, other: 25_000 });
    });
  });

  describe('the approved batches', () => {
    it('lists the approved batch, with its code, for roles that cannot list batches', async () => {
      const { batches: listed, approvedBatchCount } = await scoped(() => reports.report());
      expect(listed.map((entry) => entry.id)).toEqual([batchId]);
      // Counted apart from the list, which keeps the latest ARREARS_REPORT_BATCHES_MAX (PAG-06).
      expect(approvedBatchCount).toBe(1);
      expect(listed[0]).toMatchObject({ code: batchId.replace(/-/g, '').slice(0, 8).toUpperCase(), lineCount: 6, citizenCount: 2 });
    });
  });

  describe('the sheet of an approved batch', () => {
    it('carries who prepared, submitted and approved it, its totals and the lines it dropped with their reason', async () => {
      const sheet = await scoped(() => reports.sheet(batchId));
      expect(sheet.code).toBe(batchId.replace(/-/g, '').slice(0, 8).toUpperCase());
      expect(sheet.batch).toMatchObject({ status: 'APPROVED', preparedBy: { id: ids.accountant }, approvedBy: { id: ids.manager } });
      expect(sheet.submittedBy).toMatchObject({ id: ids.accountant });
      expect(sheet.totals).toMatchObject({ unmatched: { count: 1, amount: 80_000 }, fileTotal: 1_170_000, controlTotal: 1_170_000 });
      expect(sheet.totals.prescribed).toMatchObject({ count: 1, amount: 40_000 });
      expect(sheet.dropped).toEqual([
        expect.objectContaining({ year: PRESCRIBED, feeType: 'RENTAL_VALUE', propertyNumber: 'P2', amount: 40_000, prescribed: true }),
      ]);
      expect(sheet.dropped[0]!.reason.length).toBeGreaterThan(0);
      // A penalty is its own line; the unmatched line is in the sums (the pages held it), the dropped prescribed one is not.
      expect(sheet.byYearAndFee.filter((entry) => entry.year === LAST && entry.feeType === 'CLEANING')).toEqual([
        { year: LAST, feeType: 'CLEANING', component: 'PENALTY', count: 1, amount: 50_000 },
        { year: LAST, feeType: 'CLEANING', component: 'PRINCIPAL', count: 3, amount: 780_000 },
      ]);
      expect(sheet.byYearAndFee.some((entry) => entry.year === PRESCRIBED)).toBe(false);
    });

    it('names no citizen', async () => {
      const text = JSON.stringify(await scoped(() => reports.sheet(batchId)));
      for (const name of ['أمل', 'باسم', 'غير مسجّل']) expect(text).not.toContain(name);
    });

    it('refuses a batch that is not approved, and one that does not exist', async () => {
      await expect(scoped(() => reports.sheet(draftId))).rejects.toMatchObject({ code: 'ARREARS_BATCH_NOT_APPROVED' });
      await expect(scoped(() => reports.sheet(randomUUID()))).rejects.toMatchObject({ code: 'ARREARS_BATCH_NOT_FOUND' });
    });
  });
});

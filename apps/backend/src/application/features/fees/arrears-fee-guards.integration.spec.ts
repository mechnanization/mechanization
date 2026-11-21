import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { CitizensService } from '../citizens/citizens.service';
import { ReportingService } from '../reporting/reporting.service';
import { TreasuryLedgerService } from '../treasury/treasury-ledger.service';
import { FeesService } from './fees.service';
import { PaymentLedgerService } from './payment-ledger.service';

/**
 * Old debts and the fee system (task 6, docs/old-debts-plan.md §8), against a
 * real tenant schema:
 *
 * - **No year billed twice.** A notice whose period is a year before
 *   `arrearsCutoffYear` is refused, by the wizard's preview and its issue and by
 *   the recurring run (which skips the period), because that year comes in as
 *   old debt.
 * - **Totals.** An «ARR-» bill has no notice behind it, and every place that
 *   says what a citizen owes must still count it: the register, the citizen's
 *   file, the dashboard, the fees summary, the portal's list and the overdue
 *   tab — and leave out a cancelled bill.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_arrears_fee_guards_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('old debts and the fee system', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let fees: FeesService;
  let reporting: ReportingService;
  let citizens: CitizensService;

  const ids = { accountant: randomUUID(), owes: randomUUID(), other: randomUUID(), third: randomUUID() };
  const ACCOUNTANT = { id: ids.accountant, role: 'ACCOUNTANT' };

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'afg', tenantSlug: 'afg', schemaName: SCHEMA, prisma: db }, work);
  const setCutoff = (year: number | null) =>
    db.systemSettings.updateMany({ data: { arrearsCutoffYear: year } });

  const notice = (over: Record<string, unknown> = {}) => ({
    title: 'رسم نظافة',
    amount: 40_000,
    basis: 'FLAT' as const,
    bearer: 'OCCUPANT' as const,
    frequency: 'ONCE' as const,
    targetType: 'INDIVIDUAL_CITIZEN' as const,
    targetCitizenId: ids.other,
    dueDate: '2026-03-31',
    clientRequestId: randomUUID(),
    acknowledgedDuplicates: [] as string[],
    ...over,
  });
  const issue = (over: Record<string, unknown> = {}) => within(() => fees.issue(notice(over) as never, ACCOUNTANT));
  const noticeCount = () => db.feeNotice.count();

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      invalidatePrefix: jest.fn().mockResolvedValue(undefined),
    } as never;
    const payments = new PaymentLedgerService(context, audit, new TreasuryLedgerService(context));
    fees = new FeesService(context, { emit: jest.fn() } as unknown as EventEmitter2, {} as never, cache, payments, audit);
    reporting = new ReportingService(context, new EventEmitter2(), cache, { get: () => undefined } as never);
    citizens = new CitizensService(context, {} as never, {} as never, {} as never, {} as never, {} as never, new EventEmitter2(), audit);

    await db.user.createMany({
      data: [
        { id: ids.accountant, kind: 'STAFF', tenantSlug: 'afg', email: `${ids.accountant}@afg.gov.lb`, firstName: 'محاسب', lastName: 'البلدية', role: 'ACCOUNTANT' as never },
        { id: ids.owes, kind: 'CITIZEN', tenantSlug: 'afg', firstName: 'علي', lastName: 'خليل', phone: '+96170111111' },
        { id: ids.other, kind: 'CITIZEN', tenantSlug: 'afg', firstName: 'سامي', lastName: 'حداد', phone: '+96170222222' },
        { id: ids.third, kind: 'CITIZEN', tenantSlug: 'afg', firstName: 'نبيل', lastName: 'سلمان', phone: '+96170333333' },
      ],
    });
    await db.systemSettings.create({ data: { arrearsCutoffYear: 2026 } });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  describe('no year is billed twice', () => {
    it('refuses a notice whose period is before the cutoff, and writes nothing', async () => {
      const before = await noticeCount();
      await expect(issue({ dueDate: '2025-12-31' })).rejects.toMatchObject({
        code: 'FEE_PERIOD_BEFORE_ARREARS_CUTOFF',
        params: { year: 2025, cutoffYear: 2026 },
      });
      expect(await noticeCount()).toBe(before);
      expect(await db.citizenPayment.count({ where: { citizenId: ids.other } })).toBe(0);
    });

    it('refuses it at the preview as well, so the clerk learns before the press', async () => {
      await expect(
        within(() => fees.previewNotice({ ...notice({ dueDate: '2024-06-30' }), clientRequestId: undefined } as never)),
      ).rejects.toMatchObject({ code: 'FEE_PERIOD_BEFORE_ARREARS_CUTOFF', params: { year: 2024, cutoffYear: 2026 } });
    });

    it('takes a period from the cutoff year on, and any period while no cutoff is set', async () => {
      await expect(issue({ dueDate: '2026-01-01', title: 'من سنة البدء' })).resolves.toBeDefined();
      try {
        await setCutoff(null);
        await expect(issue({ dueDate: '2019-05-05', title: 'بلا سنة بدء', targetCitizenId: ids.third })).resolves.toBeDefined();
      } finally {
        await setCutoff(2026);
      }
    });

    it('skips a recurring period before the cutoff, and bills it once the cutoff allows', async () => {
      const monthly = await issue({
        title: 'رسم شهري',
        frequency: 'MONTHLY',
        dueDate: '2026-01-15',
        targetCitizenId: ids.other,
        acknowledgedDuplicates: await db.feeNotice.findMany({ select: { id: true } }).then((rows) => rows.map((row) => row.id)),
      });
      const { noticeId } = monthly as { noticeId: string };
      const billsOn = (periodKey: string) => db.citizenPayment.count({ where: { feeNoticeId: noticeId, periodKey } });
      const now = new Date('2026-06-10T09:00:00.000Z');

      try {
        // The manager has since moved the cutoff past this year: June 2026 is an old-debt year.
        await setCutoff(2027);
        await within(() => fees.runRecurringBilling(now));
        expect(await billsOn('2026-06')).toBe(0);
        expect(await db.billingRunEntry.findFirst({ where: { feeNoticeId: noticeId, periodKey: '2026-06' } })).toMatchObject({ outcome: 'SKIPPED' });
      } finally {
        await setCutoff(2026);
      }
      await within(() => fees.runRecurringBilling(now));
      expect(await billsOn('2026-06')).toBe(1);
    });
  });

  describe('every total counts an «ARR-» bill, and leaves a cancelled one out', () => {
    let overdueId: string;
    /** What each total read before the bills below existed: the guard tests above raised some of their own. */
    let before: {
      analytics: Awaited<ReturnType<ReportingService['getAnalytics']>>;
      register: Awaited<ReturnType<CitizensService['list']>>['totals'];
      unpaid: number;
    };

    beforeAll(async () => {
      before = {
        analytics: await within(() => reporting.getAnalytics()),
        register: (await within(() => citizens.list({ limit: 50 }))).totals,
        unpaid: (await within(() => fees.summary())).unpaidTotal,
      };
      const bill = (data: Record<string, unknown>) =>
        db.citizenPayment.create({ data: { citizenId: ids.owes, title: 'x', amount: 0, dueDate: new Date(), ...data } as never, select: { id: true } });
      // The old debt: raised by an approved batch, so no notice, «ARR-», due on 31 December of its year.
      overdueId = (
        await bill({
          title: 'متأخرات 2023 — رسم النظافة',
          amount: 100_000,
          dueDate: new Date('2023-12-31T00:00:00.000Z'),
          periodKey: '2023',
          invoiceNumber: 'ARR-2611-9001',
        })
      ).id;
      // A current bill, not yet due.
      await bill({ title: 'رسم الشهر', amount: 50_000, dueDate: new Date('2999-01-31T00:00:00.000Z'), periodKey: '2999-01', invoiceNumber: 'INV-2611-9001' });
      // A bill withdrawn by mistake: owes nothing, and was never billed.
      await bill({
        title: 'ملغاة',
        amount: 30_000,
        dueDate: new Date('2023-06-30T00:00:00.000Z'),
        periodKey: '2023-06',
        invoiceNumber: 'INV-2611-9002',
        paymentStatus: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: ids.accountant,
        cancellationReason: 'صدرت مرتين',
      });
    });

    it('the register: what the person owes, and what is overdue', async () => {
      const register = await within(() => citizens.list({ limit: 50 }));
      const row = register.items.find((item) => item.id === ids.owes)!;
      expect(row).toMatchObject({ outstandingTotal: 150_000, overdueTotal: 100_000 });
      // The headline figures moved by exactly this person's: the old debt and the current bill, not the cancelled one.
      expect(register.totals.outstanding - before.register.outstanding).toBe(150_000);
      expect(register.totals.overdue - before.register.overdue).toBe(100_000);
      expect(register.totals.inArrears - before.register.inArrears).toBe(1);
    });

    it('the citizen’s file: owed, overdue and billed', async () => {
      const profile = (await within(() => reporting.getCitizenProfile(ids.owes)))!;
      expect(profile.fees).toMatchObject({ outstandingTotal: 150_000, overdueTotal: 100_000, overdueCount: 1, feesTotal: 150_000 });
      const arr = profile.payments.find((payment) => payment.id === overdueId)!;
      expect(arr).toMatchObject({ paymentStatus: 'OVERDUE', remaining: 100_000 });
      expect(profile.payments.find((payment) => payment.paymentStatus === 'CANCELLED')).toMatchObject({ remaining: 0 });
    });

    it('the dashboard: billed, outstanding and overdue', async () => {
      const analytics = await within(() => reporting.getAnalytics());
      // Billed is what was billed and not withdrawn; nothing is paid, so it is all outstanding.
      expect(analytics.billedTotal - before.analytics.billedTotal).toBe(150_000);
      expect(analytics.outstandingTotal - before.analytics.outstandingTotal).toBe(150_000);
      expect(analytics.overdueTotal - before.analytics.overdueTotal).toBe(100_000);
      expect(analytics.overdueCount - before.analytics.overdueCount).toBe(1);
    });

    it('the fees summary and the portal’s list', async () => {
      const summary = await within(() => fees.summary());
      expect(summary.unpaidTotal - before.unpaid).toBe(150_000);
      const mine = await within(() => fees.listForCitizen(ids.owes));
      expect(mine.map((bill) => [bill.title, bill.remaining, bill.paymentStatus]).sort()).toEqual(
        [
          ['رسم الشهر', 50_000, 'UNPAID'],
          ['متأخرات 2023 — رسم النظافة', 100_000, 'OVERDUE'],
          ['ملغاة', 0, 'CANCELLED'],
        ].sort(),
      );
    });

    it('the overdue tab, the «المتأخرات» filter, lists it and not the cancelled bill', async () => {
      const late = await within(() => fees.listAllPayments({ citizenId: ids.owes, status: 'OVERDUE' }));
      expect(late.items.map((bill) => bill.id)).toEqual([overdueId]);
      const open = await within(() => fees.listAllPayments({ citizenId: ids.owes, status: 'UNPAID' }));
      expect(open.items.map((bill) => bill.title)).toEqual(['رسم الشهر']);
    });
  });
});

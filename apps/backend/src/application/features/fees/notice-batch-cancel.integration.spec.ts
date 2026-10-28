import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { CreateFeeNotice } from '@mechanization/shared-schemas';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { TreasuryLedgerService } from '../treasury/treasury-ledger.service';
import { FeesService } from './fees.service';
import { PaymentLedgerService } from './payment-ledger.service';

/**
 * «إلغاء الإشعار» (decisions D6 of 2026-10-23 and D12 of 2026-10-26,
 * docs/fees-system-rearchitecture-specification.md, T-10 and T-14): a notice's
 * bills withdrawn in one step for the periods named — every bill «إلغاء
 * الفاتورة» would cancel, and none it would refuse — and the notice stopped;
 * and «إيقاف الإشعار», which stops it and cancels nothing.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_notice_batch_cancel_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('cancelling a notice’s bills in one step', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let fees: FeesService;
  const managerId = randomUUID();
  const manager = { id: managerId, role: 'SUPER_ADMIN' };
  // Paid in full, part-paid, a Whish claim under review, untouched.
  const [paid, partPaid, claimed, untouched] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-nbc', tenantSlug: 'nbc', schemaName: SCHEMA, prisma: db }, work);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    fees = new FeesService(
      context,
      new EventEmitter2(),
      {} as never,
      {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        invalidatePrefix: jest.fn().mockResolvedValue(undefined),
      } as never,
      new PaymentLedgerService(context, audit, new TreasuryLedgerService(context)),
      audit,
    );

    await db.user.create({
      data: {
        id: managerId,
        kind: 'STAFF',
        tenantSlug: 'nbc',
        email: `manager-${managerId}@nbc.gov.lb`,
        firstName: 'رئيس',
        lastName: 'البلدية',
        role: 'SUPER_ADMIN' as never,
      },
    });
    await db.systemSettings.upsert({
      where: { singleton: true },
      create: { singleton: true, baseCurrency: 'LBP', secondaryCurrency: 'USD', exchangeRate: 89_500 },
      update: {},
    });
    for (const [index, id] of [paid, partPaid, claimed, untouched].entries()) {
      await db.user.create({ data: { id, kind: 'CITIZEN', tenantSlug: 'nbc', firstName: `مواطن${index}`, lastName: 'الاختبار' } });
    }
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('cancels only the untouched bills, reports the rest, stops the notice, and the next run raises nothing (T-10)', async () => {
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const issued = await within(() =>
      fees.issue(
        {
          title: 'رسم النظافة',
          amount: 50_000,
          basis: 'FLAT',
          frequency: 'MONTHLY',
          targetType: 'ALL_CITIZENS',
          dueDate: lastMonth.toISOString().slice(0, 10),
          clientRequestId: randomUUID(),
        } as CreateFeeNotice,
        manager,
      ),
    );
    const billOf = async (citizenId: string) =>
      db.citizenPayment.findFirstOrThrow({ where: { feeNoticeId: issued.noticeId, citizenId } });

    await within(async () => fees.settleInPerson({ paymentId: (await billOf(paid)).id, method: 'CASH', actor: manager }));
    await within(async () =>
      fees.settleInPerson({ paymentId: (await billOf(partPaid)).id, method: 'CASH', amount: 10_000, actor: manager }),
    );
    await within(async () =>
      fees.declare({ paymentId: (await billOf(claimed)).id, citizenId: claimed, method: 'WHISH_MONEY', whishTransactionRef: 'WSH-NBC-1' }),
    );

    const periodKey = (await billOf(untouched)).periodKey;
    const result = await within(() =>
      fees.cancelNoticeBatch(issued.noticeId, { reason: 'أُصدر بالمبلغ الخطأ', periodKeys: [periodKey] }, manager),
    );

    expect(result).toMatchObject({ noticeId: issued.noticeId, cancelled: 1, deactivated: true });
    const reasons = new Map(result.skipped.map((entry) => [entry.paymentId, entry.reason]));
    expect(reasons.get((await billOf(paid)).id)).toBe('BILL_CANCEL_HAS_PAYMENTS');
    expect(reasons.get((await billOf(partPaid)).id)).toBe('BILL_CANCEL_HAS_PAYMENTS');
    expect(reasons.get((await billOf(claimed)).id)).toBe('PAYMENT_CLAIM_UNDER_REVIEW');
    expect(result.skipped.every((entry) => entry.invoiceNumber?.startsWith('INV-'))).toBe(true);

    expect(await billOf(untouched)).toMatchObject({
      paymentStatus: 'CANCELLED',
      cancelledById: managerId,
      cancellationReason: 'أُصدر بالمبلغ الخطأ',
    });
    // Left exactly as they were.
    expect((await billOf(paid)).paymentStatus).toBe('PAID');
    expect((await billOf(partPaid)).paymentStatus).toBe('UNPAID');
    expect((await billOf(claimed)).paymentStatus).toBe('PENDING_REVIEW');

    expect((await db.feeNotice.findUniqueOrThrow({ where: { id: issued.noticeId } })).isActive).toBe(false);
    const trail = await db.auditLogEntry.findMany({
      where: { action: { in: ['FEE_BILL_CANCELLED', 'FEE_NOTICE_CANCELLED'] } },
      select: { action: true, entityId: true },
    });
    expect(trail.map((row) => row.action).sort()).toEqual(['FEE_BILL_CANCELLED', 'FEE_NOTICE_CANCELLED']);
    expect(trail.find((row) => row.action === 'FEE_BILL_CANCELLED')?.entityId).toBe((await billOf(untouched)).id);

    const before = await db.citizenPayment.count({ where: { feeNoticeId: issued.noticeId } });
    await within(() => fees.runRecurringBilling(now));
    expect(await db.citizenPayment.count({ where: { feeNoticeId: issued.noticeId } })).toBe(before);
  });

  it('answers a second press with nothing more to cancel, and an unknown notice with its code', async () => {
    const notice = await db.feeNotice.findFirstOrThrow({ where: { title: 'رسم النظافة' } });
    const periodKeys = [...new Set((await db.citizenPayment.findMany({ where: { feeNoticeId: notice.id } })).map((bill) => bill.periodKey))];
    const again = await within(() => fees.cancelNoticeBatch(notice.id, { reason: 'مرة ثانية', periodKeys }, manager));
    expect(again).toMatchObject({ cancelled: 0, deactivated: false });
    expect(again.skipped.map((entry) => entry.reason).sort()).toEqual([
      'BILL_CANCEL_HAS_PAYMENTS',
      'BILL_CANCEL_HAS_PAYMENTS',
      'PAYMENT_CLAIM_UNDER_REVIEW',
    ]);

    await expect(
      within(() => fees.cancelNoticeBatch(randomUUID(), { reason: 'لا يوجد', periodKeys: ['2026-01'] }, manager)),
    ).rejects.toMatchObject({ code: 'FEE_NOTICE_NOT_FOUND' });
  });

  it('cancels only the periods named: an earlier period billed correctly stays owed (T-14, D12)', async () => {
    const now = new Date();
    const twoMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
    const issued = await within(() =>
      fees.issue(
        {
          title: 'رسم الإنارة',
          amount: 30_000,
          basis: 'FLAT',
          frequency: 'MONTHLY',
          targetType: 'ALL_CITIZENS',
          dueDate: twoMonthsAgo.toISOString().slice(0, 10),
          clientRequestId: randomUUID(),
        } as CreateFeeNotice,
        manager,
      ),
    );
    // The current month's bills, raised by the run: two periods on one notice.
    await within(() => fees.runRecurringBilling(now));
    const bills = await db.citizenPayment.findMany({ where: { feeNoticeId: issued.noticeId } });
    const periods = [...new Set(bills.map((bill) => bill.periodKey))].sort();
    expect(periods).toHaveLength(2);
    const [earlier, latest] = periods as [string, string];

    // What the dialog shows before the press: each period, newest first, and what the cancel would do.
    const summary = await within(() => fees.noticePeriods(issued.noticeId));
    expect(summary.map((row) => row.periodKey)).toEqual([latest, earlier]);
    expect(summary[0]).toMatchObject({ bills: 4, cancellable: 4, cancellableAmount: 120_000, withPayments: 0, underReview: 0, alreadyCancelled: 0 });

    const result = await within(() =>
      fees.cancelNoticeBatch(issued.noticeId, { reason: 'صدر لهذا الشهر خطأً', periodKeys: [latest] }, manager),
    );
    expect(result).toMatchObject({ cancelled: 4, skipped: [], deactivated: true });

    const after = await db.citizenPayment.findMany({ where: { feeNoticeId: issued.noticeId }, select: { periodKey: true, paymentStatus: true } });
    expect(after.filter((bill) => bill.periodKey === latest).every((bill) => bill.paymentStatus === 'CANCELLED')).toBe(true);
    // The earlier, correct period is not waived with it.
    expect(after.filter((bill) => bill.periodKey === earlier).every((bill) => bill.paymentStatus === 'UNPAID')).toBe(true);

    // The notice's own row says which periods were withdrawn.
    const row = await db.auditLogEntry.findFirstOrThrow({ where: { action: 'FEE_NOTICE_CANCELLED', entityId: issued.noticeId } });
    expect(row.after).toMatchObject({ periodKeys: [latest], cancelled: 4 });
  });

  it('stops a notice without cancelling a bill, and the run raises nothing for it until it is resumed (D12)', async () => {
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const issued = await within(() =>
      fees.issue(
        {
          title: 'رسم الصرف الصحي',
          amount: 20_000,
          basis: 'FLAT',
          frequency: 'MONTHLY',
          targetType: 'ALL_CITIZENS',
          dueDate: lastMonth.toISOString().slice(0, 10),
          clientRequestId: randomUUID(),
        } as CreateFeeNotice,
        manager,
      ),
    );
    const billed = await db.citizenPayment.count({ where: { feeNoticeId: issued.noticeId } });

    await within(() => fees.setNoticeActive(issued.noticeId, false, manager));
    // A second press changes nothing and writes nothing.
    await within(() => fees.setNoticeActive(issued.noticeId, false, manager));
    await within(() => fees.runRecurringBilling(now));

    const bills = await db.citizenPayment.findMany({ where: { feeNoticeId: issued.noticeId }, select: { paymentStatus: true } });
    expect(bills).toHaveLength(billed);
    expect(bills.every((bill) => bill.paymentStatus === 'UNPAID')).toBe(true);
    const stops = await db.auditLogEntry.findMany({ where: { entityId: issued.noticeId, action: { in: ['FEE_NOTICE_STOPPED', 'FEE_NOTICE_RESUMED'] } } });
    expect(stops.map((entry) => entry.action)).toEqual(['FEE_NOTICE_STOPPED']);

    await within(() => fees.setNoticeActive(issued.noticeId, true, manager));
    await within(() => fees.runRecurringBilling(now));
    expect(await db.citizenPayment.count({ where: { feeNoticeId: issued.noticeId } })).toBeGreaterThan(billed);
  });
});

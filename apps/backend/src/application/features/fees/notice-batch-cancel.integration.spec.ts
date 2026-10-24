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
 * «إلغاء الإشعار» (decision D6 of 2026-10-23,
 * docs/fees-system-rearchitecture-specification.md, T-10): a notice's bills
 * withdrawn in one step — every bill «إلغاء الفاتورة» would cancel, and none
 * it would refuse — and the notice stopped.
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

    const result = await within(() => fees.cancelNoticeBatch(issued.noticeId, 'أُصدر بالمبلغ الخطأ', manager));

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
    const again = await within(() => fees.cancelNoticeBatch(notice.id, 'مرة ثانية', manager));
    expect(again).toMatchObject({ cancelled: 0, deactivated: false });
    expect(again.skipped.map((entry) => entry.reason).sort()).toEqual([
      'BILL_CANCEL_HAS_PAYMENTS',
      'BILL_CANCEL_HAS_PAYMENTS',
      'PAYMENT_CLAIM_UNDER_REVIEW',
    ]);

    await expect(within(() => fees.cancelNoticeBatch(randomUUID(), 'لا يوجد', manager))).rejects.toMatchObject({
      code: 'FEE_NOTICE_NOT_FOUND',
    });
  });
});

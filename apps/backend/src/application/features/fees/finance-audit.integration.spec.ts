import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { currentSalaryPeriod, salaryPeriodWindow } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { ReportingService } from '../reporting/reporting.service';
import { ExpensesService } from '../treasury/expenses.service';
import { TreasuryLedgerService } from '../treasury/treasury-ledger.service';
import { TreasuryService } from '../treasury/treasury.service';
import { FeesService } from './fees.service';
import { PaymentLedgerService } from './payment-ledger.service';

/**
 * The finance audit's remediation (2026-10-12), against a real Postgres.
 *
 * One block per finding: a collector books only into his own custody (B1); a
 * retry key names one act (B6); one Whish reference is one receipt (B2); a Whish
 * success is banked only for what was quoted, once (B5); the counter reads the
 * rate in its own transaction (B8) and keeps a finance role's rate inside the
 * tolerance (A2); a notice is issued once and a bill can be cancelled (B3); a
 * one-off charge names who raised it (B4); a salary is paid once a month, under
 * the manager's ceiling (A3); and the rate and currencies are the manager's,
 * audited with their values (A1).
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_finance_audit_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;
const OFFICIAL_RATE = 89_500;

describeIfDb('finance audit remediation', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let payments: PaymentLedgerService;
  let expenses: ExpensesService;
  let fees: FeesService;
  /** What the settings cache answers: a stale copy, so a read that trusts it is caught (B8). */
  let staleSettings: Record<string, unknown> | null = null;

  let citizenId: string;
  let safeLbpId: string;
  const ids = { manager: '', accountant: '', collector: '', otherCollector: '', clerk: '' };
  const MANAGER = () => ({ id: ids.manager, role: 'SUPER_ADMIN' });
  const ACCOUNTANT = () => ({ id: ids.accountant, role: 'ACCOUNTANT' });
  const COLLECTOR = () => ({ id: ids.collector, role: 'COLLECTOR' });

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'audit', schemaName: SCHEMA, prisma: db }, work);

  const bill = async (amount: number, status: 'UNPAID' | 'PENDING_REVIEW' = 'UNPAID'): Promise<string> =>
    (
      await db.citizenPayment.create({
        data: {
          citizenId,
          title: 'رسم',
          amount,
          dueDate: new Date('2026-12-31T00:00:00.000Z'),
          createdAt: new Date('2026-01-01T08:00:00.000Z'),
          paymentStatus: status,
        },
        select: { id: true },
      })
    ).id;

  const staff = (role: string) => {
    const id = randomUUID();
    return {
      id,
      row: {
        id,
        kind: 'STAFF' as const,
        tenantSlug: 'audit',
        email: `${role.toLowerCase()}-${id}@audit.gov.lb`,
        firstName: role,
        lastName: 'الموظف',
        role: role as never,
      },
    };
  };

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const auditService = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    const ledger = new TreasuryLedgerService(context);
    payments = new PaymentLedgerService(context, auditService, ledger);
    const treasury = new TreasuryService(context, ledger, auditService);
    expenses = new ExpensesService(context, ledger, auditService);
    fees = new FeesService(
      context,
      { emit: jest.fn() } as unknown as EventEmitter2,
      {} as never,
      {
        get: jest.fn((key: string) => Promise.resolve(key.startsWith('settings:') ? staleSettings : null)),
        set: jest.fn().mockResolvedValue(undefined),
        invalidatePrefix: jest.fn().mockResolvedValue(undefined),
      } as never,
      payments,
      auditService,
    );

    citizenId = randomUUID();
    const people = {
      manager: staff('SUPER_ADMIN'),
      accountant: staff('ACCOUNTANT'),
      collector: staff('COLLECTOR'),
      otherCollector: staff('COLLECTOR'),
      clerk: staff('ADMINISTRATIVE_OFFICER'),
    };
    for (const [key, person] of Object.entries(people)) ids[key as keyof typeof ids] = person.id;
    await db.user.createMany({
      data: [
        { id: citizenId, kind: 'CITIZEN', tenantSlug: 'audit', firstName: 'علي', lastName: 'خليل', phone: '71123456' },
        ...Object.values(people).map((person) => person.row),
      ],
    });

    // The municipality takes dollars at an official rate, and the safe opens with ليرة for change and salaries.
    await db.systemSettings.upsert({
      where: { singleton: true },
      create: { singleton: true, baseCurrency: 'LBP', secondaryCurrency: 'USD', exchangeRate: OFFICIAL_RATE },
      update: { baseCurrency: 'LBP', secondaryCurrency: 'USD', exchangeRate: OFFICIAL_RATE },
    });
    const accounts = await db.treasuryAccount.findMany({ where: { type: { not: 'COLLECTOR_CUSTODY' } } });
    await scoped(() =>
      treasury.activate(
        {
          balances: accounts.map((account) => ({
            accountId: account.id,
            amount: account.type === 'CASH_SAFE' && account.currency === 'LBP' ? 50_000_000 : 0,
          })),
        },
        MANAGER(),
      ),
    );
    safeLbpId = accounts.find((account) => account.type === 'CASH_SAFE' && account.currency === 'LBP')!.id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  });

  // ─────────────────────  B1: a collector books into his own custody  ─────────────────────

  describe('a collector at the counter (B1)', () => {
    it('is refused cash into the safe or another collector’s name, and writes nothing', async () => {
      const paymentId = await bill(100_000);
      const settle = (method: 'CASH' | 'COLLECTOR', extra: Record<string, unknown> = {}) =>
        scoped(() => fees.settleInPerson({ paymentId, method, amount: 100_000, actor: COLLECTOR(), ...extra }));
      await expect(settle('CASH')).rejects.toMatchObject({ code: 'COLLECTOR_CANNOT_SELECT_METHOD' });
      await expect(settle('COLLECTOR', { collectedById: ids.otherCollector })).rejects.toMatchObject({
        code: 'COLLECTOR_CANNOT_SELECT_METHOD',
      });
      expect(await db.paymentTransaction.count({ where: { paymentId } })).toBe(0);
    });

    it('records a Whish transfer taken at the door, into the Whish account and not his custody', async () => {
      const paymentId = await bill(70_000);
      await expect(
        scoped(() =>
          fees.settleInPerson({
            paymentId,
            method: 'WHISH_MONEY',
            whishTransactionRef: 'WSH-B1-DOOR',
            amount: 70_000,
            actor: COLLECTOR(),
          }),
        ),
      ).resolves.toMatchObject({ paymentStatus: 'PAID' });
      const row = await db.paymentTransaction.findFirstOrThrow({ where: { paymentId } });
      const entries = await db.treasuryEntry.findMany({
        where: { sourceId: row.id },
        include: { account: { select: { type: true } } },
      });
      expect(entries.map((entry) => entry.account.type)).toEqual(['WHISH_ACCOUNT']);
    });

    it('records his own collection into his own custody', async () => {
      const paymentId = await bill(120_000);
      await expect(
        scoped(() =>
          fees.settleInPerson({
            paymentId,
            method: 'COLLECTOR',
            collectedById: ids.collector.toUpperCase(),
            amount: 120_000,
            actor: COLLECTOR(),
          }),
        ),
      ).resolves.toMatchObject({ paymentStatus: 'PAID' });
      const custody = await db.treasuryAccount.findFirstOrThrow({
        where: { type: 'COLLECTOR_CUSTODY', ownerId: ids.collector, currency: 'LBP' },
      });
      const held = await db.treasuryEntry.aggregate({ where: { accountId: custody.id }, _sum: { amount: true } });
      expect(Number(held._sum.amount)).toBeGreaterThanOrEqual(120_000);
    });
  });

  // ─────────────────────  B6: a retry key names one act  ─────────────────────

  describe('a counter retry key (B6)', () => {
    it('answers the same act from the first receipt, and refuses a corrected figure under the old key', async () => {
      const paymentId = await bill(500_000);
      const key = randomUUID();
      const settle = (amount: number) =>
        scoped(() =>
          fees.settleInPerson({ paymentId, method: 'CASH', amount, clientRequestId: key, actor: MANAGER() }),
        );
      const first = await settle(200_000);
      await expect(settle(200_000)).resolves.toMatchObject({ replayed: true, receiptNumber: first.receiptNumber });
      await expect(settle(250_000)).rejects.toMatchObject({
        code: 'PAYMENT_IDEMPOTENCY_KEY_REUSED',
        params: { receiptNumber: first.receiptNumber },
      });
      expect(await db.paymentTransaction.count({ where: { paymentId } })).toBe(1);
    });
  });

  // ─────────────────────  B2: one Whish reference, one receipt  ─────────────────────

  describe('a Whish reference (B2)', () => {
    it('settles one bill only, whatever its case or spacing, until that receipt is reversed', async () => {
      const first = await bill(300_000);
      const second = await bill(300_000);
      const settle = (paymentId: string, ref: string) =>
        scoped(() =>
          fees.settleInPerson({ paymentId, method: 'WHISH_MONEY', whishTransactionRef: ref, actor: MANAGER() }),
        );
      const taken = await settle(first, 'WSH-REF-B2');
      await expect(settle(second, '  wsh-ref-b2 ')).rejects.toMatchObject({
        code: 'PAYMENT_EXTERNAL_REF_REUSED',
        params: { receiptNumber: taken.receiptNumber },
      });
      expect(await db.paymentTransaction.count({ where: { paymentId: second } })).toBe(0);

      // Reversed, the reference is free for the bill it really paid.
      const row = await db.paymentTransaction.findFirstOrThrow({ where: { paymentId: first } });
      await scoped(() => fees.reverseTransaction({ transactionId: row.id, note: 'المرجع خاطئ', actor: MANAGER() }));
      await expect(settle(second, 'WSH-REF-B2')).resolves.toMatchObject({ paymentStatus: 'PAID' });
    });

    it('refuses two clerks typing one reference at the same moment, once', async () => {
      const bills = await Promise.all([bill(10_000), bill(10_000)]);
      const results = await Promise.allSettled(
        bills.map((paymentId) =>
          scoped(() =>
            fees.settleInPerson({ paymentId, method: 'WHISH_MONEY', whishTransactionRef: 'WSH-RACE', actor: MANAGER() }),
          ),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'PAYMENT_EXTERNAL_REF_REUSED' },
      });
    });
  });

  // ─────────────────────  B5: the Whish callback  ─────────────────────

  describe('a Whish success callback (B5)', () => {
    const checkout = async (amount: number) => {
      const paymentId = await bill(amount, 'PENDING_REVIEW');
      const externalRef = `WSH-${randomUUID().slice(0, 8)}`;
      await db.citizenPayment.update({ where: { id: paymentId }, data: { whishTransactionRef: externalRef } });
      await db.whishCheckout.create({ data: { externalRef, paymentId, citizenId, amount, currency: 'LBP' } });
      return { paymentId, externalRef };
    };
    const callback = (externalRef: string, amount: number) =>
      scoped(() =>
        fees.settleFromWhishCallback({
          externalRef,
          transactionRef: `TXN-${externalRef}`,
          amount,
          succeeded: true,
        }),
      );

    it('banks nothing for an amount other than the one quoted, and sets the checkout aside for a clerk', async () => {
      const { paymentId, externalRef } = await checkout(400_000);
      await expect(callback(externalRef, 150_000)).resolves.toEqual({ applied: false });
      expect(await db.paymentTransaction.count({ where: { paymentId } })).toBe(0);
      expect((await db.whishCheckout.findUniqueOrThrow({ where: { externalRef } })).state).toBe('MISMATCHED');
      expect((await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } })).paymentStatus).toBe(
        'PENDING_REVIEW',
      );
      expect(await db.auditLogEntry.count({ where: { action: 'WHISH_CHECKOUT_MISMATCHED', entityId: paymentId } })).toBe(1);
    });

    it('banks the quoted amount once when one callback is delivered twice at the same moment', async () => {
      const { paymentId, externalRef } = await checkout(250_000);
      const results = await Promise.all([callback(externalRef, 250_000), callback(externalRef, 250_000)]);
      expect(results.filter((result) => result.applied)).toHaveLength(1);
      expect(await db.paymentTransaction.count({ where: { paymentId } })).toBe(1);
      expect((await db.whishCheckout.findUniqueOrThrow({ where: { externalRef } })).state).toBe('SUCCEEDED');
    });

    it('sets aside a success for a bill settled another way since, instead of dropping it', async () => {
      const { paymentId, externalRef } = await checkout(90_000);
      await db.citizenPayment.update({ where: { id: paymentId }, data: { paymentStatus: 'UNPAID' } });
      await scoped(() => fees.settleInPerson({ paymentId, method: 'CASH', amount: 90_000, actor: MANAGER() }));
      await expect(callback(externalRef, 90_000)).resolves.toEqual({ applied: false });
      expect((await db.whishCheckout.findUniqueOrThrow({ where: { externalRef } })).state).toBe('MISMATCHED');
      expect(await db.paymentTransaction.count({ where: { paymentId } })).toBe(1);
    });

    it('stores the provider’s reference clean, so the counter cannot bank it again (B2)', async () => {
      // The callback's `transactionRef` arrives untrimmed; `btrim` would keep the tab and newline.
      const { paymentId, externalRef } = await checkout(70_000);
      const transactionRef = `TXN-${randomUUID().slice(0, 8)}`;
      await expect(
        scoped(() =>
          fees.settleFromWhishCallback({ externalRef, transactionRef: `${transactionRef}\t\n`, amount: 70_000, succeeded: true }),
        ),
      ).resolves.toEqual({ applied: true });
      const banked = await db.paymentTransaction.findFirstOrThrow({ where: { paymentId } });
      expect(banked.externalRef).toBe(transactionRef);

      const other = await bill(70_000);
      await expect(
        scoped(() =>
          fees.settleInPerson({
            paymentId: other,
            method: 'WHISH_MONEY',
            whishTransactionRef: transactionRef.toLowerCase(),
            actor: MANAGER(),
          }),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_EXTERNAL_REF_REUSED', params: { receiptNumber: banked.receiptNumber } });
      expect(await db.paymentTransaction.count({ where: { paymentId: other } })).toBe(0);
    });

    it('refuses to confirm a set-aside checkout as it stands; the clerk refuses it and records what Whish shows', async () => {
      const { paymentId, externalRef } = await checkout(100_000);
      await expect(callback(externalRef, 50_000)).resolves.toEqual({ applied: false });

      // Confirming would bank 100,000 for the 50,000 the provider reported.
      await expect(scoped(() => fees.review({ paymentId, confirmed: true, actor: MANAGER() }))).rejects.toMatchObject({
        code: 'PAYMENT_CHECKOUT_MISMATCHED',
        params: { reference: `TXN-${externalRef}` },
      });
      expect(await db.paymentTransaction.count({ where: { paymentId } })).toBe(0);

      await expect(
        scoped(() => fees.review({ paymentId, confirmed: false, note: 'المبلغ لا يطابق', actor: MANAGER() })),
      ).resolves.toMatchObject({ paymentStatus: 'UNPAID' });
      await expect(
        scoped(() =>
          fees.settleInPerson({
            paymentId,
            method: 'WHISH_MONEY',
            amount: 50_000,
            whishTransactionRef: `TXN-${externalRef}`,
            actor: MANAGER(),
          }),
        ),
      ).resolves.toMatchObject({ paymentStatus: 'UNPAID' });
      expect(Number((await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } })).paidAmount)).toBe(50_000);
    });

    it('does not bank a late success over a claim the citizen declared after its own was refused', async () => {
      const { paymentId, externalRef } = await checkout(80_000);
      await scoped(() => fees.review({ paymentId, confirmed: false, note: 'لم يصل التحويل', actor: MANAGER() }));
      await scoped(() =>
        fees.declare({ paymentId, citizenId, method: 'WHISH_MONEY', whishTransactionRef: 'MANUAL-CLAIM-1' }),
      );

      await expect(callback(externalRef, 80_000)).resolves.toEqual({ applied: false });
      expect(await db.paymentTransaction.count({ where: { paymentId } })).toBe(0);
      expect((await db.whishCheckout.findUniqueOrThrow({ where: { externalRef } })).state).toBe('MISMATCHED');
      // The citizen's own claim still waits for a clerk, untouched.
      expect(await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } })).toMatchObject({
        paymentStatus: 'PENDING_REVIEW',
        whishTransactionRef: 'MANUAL-CLAIM-1',
      });
    });

    it('banks a delivery once when a second one read the checkout OPEN before the first closed it', async () => {
      /*
        Only the retry key (the checkout's id) can stop this second delivery: it
        is quoted below the balance, so the bill still owes after the first, and
        it carries no provider reference, so B2 has nothing to compare. The
        checkout is put back to OPEN to stand for the second delivery's read,
        made before the first committed.
      */
      const paymentId = await bill(500_000, 'PENDING_REVIEW');
      const externalRef = `WSH-${randomUUID().slice(0, 8)}`;
      await db.citizenPayment.update({ where: { id: paymentId }, data: { whishTransactionRef: externalRef } });
      const row = await db.whishCheckout.create({
        data: { externalRef, paymentId, citizenId, amount: 200_000, currency: 'LBP' },
      });
      const deliver = () =>
        scoped(() => fees.settleFromWhishCallback({ externalRef, transactionRef: '', amount: 200_000, succeeded: true }));

      await expect(deliver()).resolves.toEqual({ applied: true });
      await db.whishCheckout.update({ where: { id: row.id }, data: { state: 'OPEN', settledAt: null, providerTxnRef: null } });
      await expect(deliver()).resolves.toEqual({ applied: false });
      expect(await db.paymentTransaction.count({ where: { paymentId } })).toBe(1);
      expect(Number((await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } })).paidAmount)).toBe(200_000);
      expect(await db.auditLogEntry.count({ where: { action: 'WHISH_CHECKOUT_MISMATCHED', entityId: paymentId } })).toBe(0);
    });
  });

  // ─────────────────────  B8 and A2: the counter's rate  ─────────────────────

  describe('the rate at the counter (B8, A2)', () => {
    const settleDollars = (paymentId: string, actor: { id: string; role: string }, exchangeRate?: number) =>
      scoped(() =>
        fees.settleInPerson({
          paymentId,
          method: 'CASH',
          tendered: { local: 0, foreign: 20, foreignCurrency: 'USD', ...(exchangeRate ? { exchangeRate } : {}) },
          ...(exchangeRate ? { adjustmentReason: 'سعر السوق اليوم' } : {}),
          actor,
        }),
      );

    it('reads the official rate in its own transaction, never a cached copy', async () => {
      staleSettings = { baseCurrency: 'LBP', secondaryCurrency: 'USD', exchangeRate: 1 };
      try {
        const paymentId = await bill(OFFICIAL_RATE * 20);
        await expect(settleDollars(paymentId, MANAGER())).resolves.toMatchObject({
          paymentStatus: 'PAID',
          officialExchangeRate: OFFICIAL_RATE,
        });
      } finally {
        staleSettings = null;
      }
    });

    it('lets an accountant take a rate within the tolerance, with a reason, and not beyond it', async () => {
      // Larger than $20 at any of these rates, so each settles in part and none pays change.
      const near = await bill(2_000_000);
      await expect(settleDollars(near, ACCOUNTANT(), OFFICIAL_RATE * 1.02)).resolves.toMatchObject({
        paymentStatus: 'UNPAID',
      });
      const far = await bill(2_000_000);
      await expect(settleDollars(far, ACCOUNTANT(), OFFICIAL_RATE * 1.1)).rejects.toMatchObject({
        code: 'EXCHANGE_RATE_OVERRIDE_BEYOND_TOLERANCE',
      });
      expect(await db.paymentTransaction.count({ where: { paymentId: far } })).toBe(0);
      // The manager may, with his reason on the receipt.
      await expect(settleDollars(far, MANAGER(), OFFICIAL_RATE * 1.1)).resolves.toMatchObject({
        paymentStatus: 'UNPAID',
      });
    });
  });

  // ─────────────────────  B3 and B4: notices, charges and cancelling a bill  ─────────────────────

  describe('a notice, a charge and a cancelled bill (B3, B4)', () => {
    const notice = (clientRequestId: string, title = 'رسم تنظيفات 2026') =>
      scoped(() =>
        fees.issue(
          {
            title,
            amount: 75_000,
            basis: 'FLAT',
            bearer: 'OCCUPANT',
            frequency: 'ONCE',
            targetType: 'INDIVIDUAL_CITIZEN',
            targetCitizenId: citizenId,
            dueDate: '2026-12-31',
            clientRequestId,
          },
          ACCOUNTANT(),
        ),
      );

    it('issues a notice once per key, and refuses the key for another notice', async () => {
      const key = randomUUID();
      const first = await notice(key);
      expect(first.replayed).toBe(false);
      const again = await notice(key);
      expect(again).toMatchObject({ replayed: true, noticeId: first.noticeId, issued: first.issued });
      await expect(notice(key, 'رسم آخر')).rejects.toMatchObject({ code: 'FEE_NOTICE_REQUEST_REUSED' });
      expect(await db.feeNotice.count({ where: { clientRequestId: key } })).toBe(1);
      const bills = await db.citizenPayment.findMany({ where: { feeNoticeId: first.noticeId } });
      expect(bills.every((row) => row.issuedById === ids.accountant)).toBe(true);
    });

    it('issues once when two presses with one key race', async () => {
      const key = randomUUID();
      const results = await Promise.all([notice(key, 'رسم متزامن'), notice(key, 'رسم متزامن')]);
      expect(new Set(results.map((result) => result.noticeId)).size).toBe(1);
      expect(await db.feeNotice.count({ where: { clientRequestId: key } })).toBe(1);
    });

    it('names who raised a one-off charge, on the bill and in a Tier 1 row', async () => {
      const { id } = await scoped(() =>
        fees.chargeIndividual({ citizenId, title: 'تكليف مالي', amount: 40_000, dueDate: '2026-12-31', actor: ACCOUNTANT() }),
      );
      expect((await db.citizenPayment.findUniqueOrThrow({ where: { id } })).issuedById).toBe(ids.accountant);
      const row = await db.auditLogEntry.findFirstOrThrow({ where: { action: 'FEE_INDIVIDUAL_LEVIED', entityId: id } });
      expect(row.actorId).toBe(ids.accountant);
    });

    it('cancels a bill nothing was paid on, once, and the bill then takes nothing', async () => {
      const paymentId = await bill(60_000);
      await expect(scoped(() => fees.cancelBill(paymentId, 'صدر الرسم مرتين', MANAGER()))).resolves.toMatchObject({
        paymentStatus: 'CANCELLED',
        remaining: 0,
        cancellationReason: 'صدر الرسم مرتين',
        // No municipal request waited on it.
        cancelledRequest: null,
      });
      await expect(scoped(() => fees.cancelBill(paymentId, 'مرة ثانية', MANAGER()))).rejects.toMatchObject({
        code: 'BILL_ALREADY_CANCELLED',
      });
      await expect(
        scoped(() => fees.settleInPerson({ paymentId, method: 'CASH', amount: 60_000, actor: MANAGER() })),
      ).rejects.toMatchObject({ code: 'PAYMENT_BILL_CANCELLED' });
      expect(await db.auditLogEntry.count({ where: { action: 'FEE_BILL_CANCELLED', entityId: paymentId } })).toBe(1);
    });

    it('refuses a bill with money on it, or with a claim waiting, and the database refuses it too', async () => {
      const part = await bill(80_000);
      await scoped(() => fees.settleInPerson({ paymentId: part, method: 'CASH', amount: 10_000, actor: MANAGER() }));
      await expect(scoped(() => fees.cancelBill(part, 'خطأ في الإصدار', MANAGER()))).rejects.toMatchObject({
        code: 'BILL_CANCEL_HAS_PAYMENTS',
      });
      const claimed = await bill(80_000, 'PENDING_REVIEW');
      await expect(scoped(() => fees.cancelBill(claimed, 'خطأ في الإصدار', MANAGER()))).rejects.toMatchObject({
        code: 'PAYMENT_CLAIM_UNDER_REVIEW',
      });
      // 0091's CHECK: a cancelled bill carries no money, whatever the application does.
      await expect(
        db.citizenPayment.update({
          where: { id: part },
          data: {
            paymentStatus: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledById: ids.manager,
            cancellationReason: 'تجاوز',
          },
        }),
      ).rejects.toThrow(/citizen_payments_cancelled_status/);
    });

    it('cancels the municipal request waiting on a cancelled bill, names it before and after, and frees its place (0094)', async () => {
      // A request filed online and billed at the counter, as `CitizenRequestsService.raiseBill` links it.
      const request = await db.citizenRequest.create({
        data: {
          requestNumber: `REQ-${randomUUID().slice(0, 8)}`,
          citizenId,
          channel: 'ONLINE',
          requestType: 'CLEARANCE',
          applicantCapacity: 'OWNER',
          clientRequestId: randomUUID(),
        },
      });
      const paymentId = await bill(200_000);
      await db.citizenRequest.update({ where: { id: request.id }, data: { citizenPaymentId: paymentId } });

      // The bill's page reads it off the citizen's profile, and names the request before the press.
      const reporting = new ReportingService(
        context,
        new EventEmitter2(),
        { get: async () => null, set: async () => undefined } as never,
        { get: () => undefined } as never,
      );
      const onProfile = async () =>
        (await scoped(() => reporting.getCitizenProfile(citizenId)))!.payments.find((row) => row.id === paymentId);
      expect(await onProfile()).toMatchObject({
        request: { id: request.id, requestNumber: request.requestNumber, requestType: 'CLEARANCE', status: 'AWAITING_PAYMENT' },
      });

      // …and the answer names the request cancelled with it, for the toast.
      await expect(scoped(() => fees.cancelBill(paymentId, 'رسم الطلب صدر خطأً', MANAGER()))).resolves.toMatchObject({
        paymentStatus: 'CANCELLED',
        cancelledRequest: { requestId: request.id, requestNumber: request.requestNumber },
      });
      expect(await onProfile()).toMatchObject({ request: { id: request.id, status: 'CANCELLED' } });

      expect(await db.citizenRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({
        status: 'CANCELLED',
        cancelledById: ids.manager,
        citizenPaymentId: paymentId,
      });
      const row = await db.auditLogEntry.findFirstOrThrow({ where: { action: 'REQUEST_CANCELLED', entityId: request.id } });
      expect(row).toMatchObject({ actorId: ids.manager, after: { status: 'CANCELLED', cause: 'BILL_CANCELLED' } });
      // The citizen can file the same request again: `citizen_requests_one_open_key` no longer holds it.
      await expect(
        db.citizenRequest.create({
          data: {
            requestNumber: `REQ-${randomUUID().slice(0, 8)}`,
            citizenId,
            channel: 'ONLINE',
            requestType: 'CLEARANCE',
            applicantCapacity: 'OWNER',
            clientRequestId: randomUUID(),
          },
        }),
      ).resolves.toMatchObject({ status: 'AWAITING_PAYMENT' });
    });

    it('cancels a request left in review by a lost reversal, through the step the reversal missed', async () => {
      // Paid, so in review; then its receipt reversed, and the reversal's reconcile lost (this spec's
      // events go nowhere): the bill is back to unpaid, and the request still says IN_REVIEW.
      const request = await db.citizenRequest.create({
        data: {
          requestNumber: `REQ-${randomUUID().slice(0, 8)}`,
          citizenId,
          channel: 'COUNTER',
          requestType: 'RESIDENCY',
          applicantCapacity: 'OWNER',
          createdById: ids.clerk,
          clientRequestId: randomUUID(),
        },
      });
      const paymentId = await bill(100_000);
      await db.citizenRequest.update({ where: { id: request.id }, data: { citizenPaymentId: paymentId } });
      await db.citizenRequest.update({ where: { id: request.id }, data: { status: 'IN_REVIEW', paidAt: new Date() } });

      await expect(scoped(() => fees.cancelBill(paymentId, 'رسم الطلب صدر خطأً', MANAGER()))).resolves.toMatchObject({
        cancelledRequest: { requestId: request.id, requestNumber: request.requestNumber },
      });

      expect(await db.citizenRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({
        status: 'CANCELLED',
        paidAt: null,
        cancelledById: ids.manager,
      });
      // The reversal's row, which the lost reconcile never wrote, and then the manager's.
      const step = (action: string) => db.auditLogEntry.findFirstOrThrow({ where: { entityId: request.id, action } });
      expect(await step('REQUEST_PAYMENT_REVERSED')).toMatchObject({
        actorType: 'SYSTEM',
        before: { status: 'IN_REVIEW' },
        after: { status: 'AWAITING_PAYMENT' },
      });
      expect(await step('REQUEST_CANCELLED')).toMatchObject({
        actorId: ids.manager,
        before: { status: 'AWAITING_PAYMENT' },
        after: { status: 'CANCELLED', cause: 'BILL_CANCELLED' },
      });
    });
  });

  // ─────────────────────  A3: one salary a month, under the ceiling  ─────────────────────

  describe('a salary (A3)', () => {
    /*
      Months inside the window «صرف راتب» offers (this month and the eleven before
      it), kept away from both of its ends so a run that crosses the first of a
      month on the municipality's clock still lands inside it; and months two
      beyond each end for the refusals.
    */
    const months = salaryPeriodWindow();
    const shift = (period: string, by: number) => {
      const [year, month] = period.split('-').map(Number) as [number, number];
      const index = year * 12 + (month - 1) + by;
      return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
    };
    const pay = (
      staffId: string,
      actor: { id: string; role: string },
      over: { salaryPeriod?: string; amount?: number } = {},
    ) =>
      scoped(() =>
        expenses.recordSalary(
          staffId,
          {
            accountId: safeLbpId,
            amount: over.amount ?? 500_000,
            description: 'راتب شهري',
            salaryPeriod: over.salaryPeriod ?? months[6]!,
            clientRequestId: randomUUID(),
          },
          actor,
        ),
      );

    it('is paid once a month per person, and a cancelled one frees its month', async () => {
      const first = await pay(ids.clerk, MANAGER(), { salaryPeriod: months[2]! });
      await expect(pay(ids.clerk, MANAGER(), { salaryPeriod: months[2]! })).rejects.toMatchObject({
        code: 'SALARY_PERIOD_ALREADY_PAID',
        params: { period: months[2], voucherNumber: first.voucherNumber },
      });
      await scoped(() => expenses.void(first.id, 'المبلغ خاطئ', MANAGER()));
      await expect(pay(ids.clerk, MANAGER(), { salaryPeriod: months[2]! })).resolves.toMatchObject({
        orderStatus: 'ORDERED',
      });
      // Another month is another salary.
      await expect(pay(ids.clerk, MANAGER(), { salaryPeriod: months[3]! })).resolves.toMatchObject({
        orderStatus: 'ORDERED',
      });
    });

    it('is refused for a month that has not begun', async () => {
      // Two months ahead, so the server's own clock reaching the next month mid-test changes nothing.
      await expect(pay(ids.clerk, MANAGER(), { salaryPeriod: shift(currentSalaryPeriod(), 2) })).rejects.toMatchObject({
        code: 'SALARY_PERIOD_IN_FUTURE',
      });
    });

    it('is refused for a month before the window, so months long past cannot stack salaries', async () => {
      const longPast = shift(months[months.length - 1]!, -2);
      const before = await db.expenseVoucher.count({ where: { payeeStaffId: ids.clerk } });
      await expect(pay(ids.clerk, ACCOUNTANT(), { salaryPeriod: longPast })).rejects.toMatchObject({
        code: 'SALARY_PERIOD_TOO_OLD',
        params: { period: longPast },
      });
      expect(await db.expenseVoucher.count({ where: { payeeStaffId: ids.clerk } })).toBe(before);
    });

    it('holds an accountant to the manager’s salary ceiling, and not the manager', async () => {
      await db.systemSettings.update({ where: { singleton: true }, data: { salaryUrgentCeilingLbp: 1_000_000 } });
      try {
        await expect(pay(ids.clerk, ACCOUNTANT(), { salaryPeriod: months[4]!, amount: 1_500_000 })).rejects.toMatchObject({
          code: 'SALARY_OVER_CEILING',
        });
        await expect(pay(ids.clerk, ACCOUNTANT(), { salaryPeriod: months[4]!, amount: 1_000_000 })).resolves.toMatchObject(
          { orderStatus: 'AWAITING_ORDER' },
        );
        await expect(pay(ids.clerk, MANAGER(), { salaryPeriod: months[5]!, amount: 1_500_000 })).resolves.toMatchObject({
          orderStatus: 'ORDERED',
        });
      } finally {
        await db.systemSettings.update({ where: { singleton: true }, data: { salaryUrgentCeilingLbp: null } });
      }
    });
  });

  // ─────────────────────  A1: the rate and the currencies are the manager's  ─────────────────────

  describe('the finance settings (A1)', () => {
    it('refuses the accountant a new rate, writes nothing for the same one, and lets the manager move it on the record', async () => {
      await expect(scoped(() => fees.updateSettings({ exchangeRate: 95_000 }, ACCOUNTANT()))).rejects.toMatchObject({
        code: 'FINANCE_SETTINGS_MANAGER_ONLY',
      });
      await scoped(() => fees.updateSettings({ exchangeRate: OFFICIAL_RATE, defaultDueDays: 20 }, ACCOUNTANT()));
      expect(Number((await db.systemSettings.findFirstOrThrow()).exchangeRate)).toBe(OFFICIAL_RATE);

      await scoped(() => fees.updateSettings({ exchangeRate: 90_000 }, MANAGER()));
      const row = await db.auditLogEntry.findFirstOrThrow({
        where: { action: 'SETTINGS_UPDATED', actorId: ids.manager },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.before).toMatchObject({ exchangeRate: OFFICIAL_RATE });
      expect(row.after).toMatchObject({ exchangeRate: 90_000 });
      await scoped(() => fees.updateSettings({ exchangeRate: OFFICIAL_RATE }, MANAGER()));
    });

    it('refuses the accountant the salary ceiling, and everyone the currencies once the treasury is live', async () => {
      await expect(
        scoped(() => fees.updateSettings({ salaryUrgentCeilingLbp: 2_000_000 }, ACCOUNTANT())),
      ).rejects.toMatchObject({ code: 'URGENT_EXPENSE_CEILING_FORBIDDEN' });
      await expect(scoped(() => fees.updateSettings({ secondaryCurrency: 'EUR' }, MANAGER()))).rejects.toMatchObject({
        code: 'CURRENCIES_LOCKED_AFTER_GO_LIVE',
      });
      // Sent back unchanged, they are not a change.
      await expect(
        scoped(() => fees.updateSettings({ baseCurrency: 'LBP', secondaryCurrency: 'USD' }, MANAGER())),
      ).resolves.toMatchObject({ baseCurrency: 'LBP', secondaryCurrency: 'USD' });
    });
  });
});

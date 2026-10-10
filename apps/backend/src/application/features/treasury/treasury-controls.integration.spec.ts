import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  municipalDayStart,
  municipalToday,
  recordExpenseSchema,
  SALARY_URGENT_REASON,
  systemSettingsSchema,
  updateExpenseCategorySchema,
} from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { FeesService } from '../fees/fees.service';
import { PaymentLedgerService, type LedgerAudit } from '../fees/payment-ledger.service';
import { ExpensesService } from './expenses.service';
import { IncomeService } from './income.service';
import { TransfersService } from './transfers.service';
import { TreasuryLedgerService } from './treasury-ledger.service';
import { TreasuryService } from './treasury.service';

/**
 * The controls the PR #104 review added to the treasury, against a real Postgres.
 *
 * Each block pins one decision or one fix (docs/finance.md §13): a refund after
 * a handover leaves the safe (D1); a payment dated before go-live is a finance
 * role's act (D2); money leaves on the manager's payment order, an urgent
 * payment being regularised after (D3, decree 5595/1982 art. 28, 33, 35);
 * custody is received by someone other than the collector, and never spent;
 * a retry key names one act; an expense and a handover on one safe cannot
 * deadlock; and the documents behind the ledger are written once (0083).
 * Then the controls extended on 2026-10-10: income vouchers under the same
 * lock order, retry-key binding, dating and write-once rule; a salary paid on
 * the art. 35 path; and the manager's urgent-payment ceiling (decision D6).
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_treasury_controls_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;
const OPENING_SAFE_LBP = 5_000_000;

describeIfDb('treasury controls', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let ledger: TreasuryLedgerService;
  let payments: PaymentLedgerService;
  let transfers: TransfersService;
  let treasury: TreasuryService;
  let expenses: ExpensesService;
  let income: IncomeService;
  let fees: FeesService;

  let citizenId: string;
  let safeLbpId: string;
  let categoryId: string;
  const ids = {
    manager: '',
    collector: '',
    clockCollector: '',
    accountant: '',
    otherAccountant: '',
    viewer: '',
    leftCollector: '',
  };
  const MANAGER = () => ({ id: ids.manager, role: 'SUPER_ADMIN' });
  const ACCOUNTANT = () => ({ id: ids.accountant, role: 'ACCOUNTANT' });

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'controls', schemaName: SCHEMA, prisma: db }, work);

  const balance = async (accountId: string): Promise<number> =>
    Number((await db.treasuryEntry.aggregate({ where: { accountId }, _sum: { amount: true } }))._sum.amount ?? 0);

  const audit: LedgerAudit = (movement) => ({
    actorId: ids.manager,
    actorType: 'STAFF',
    action: 'PAYMENT_CONFIRMED',
    entityType: 'Payment',
    after: { receiptNumber: movement.receiptNumber },
  });

  const bill = async (amount: number): Promise<string> =>
    (
      await db.citizenPayment.create({
        data: {
          citizenId,
          title: 'رسم',
          amount,
          dueDate: new Date('2026-12-31T00:00:00.000Z'),
          createdAt: new Date('2026-01-01T08:00:00.000Z'),
        },
        select: { id: true },
      })
    ).id;

  /** A citizen pays a collector at his door. */
  const collect = async (amount: number, by: string, occurredAt?: Date) => {
    const paymentId = await bill(amount);
    return scoped(() =>
      payments.record({
        audit,
        paymentId,
        amount,
        method: 'COLLECTOR',
        collectedById: by,
        recordedById: by,
        ...(occurredAt ? { occurredAt } : {}),
      }),
    );
  };

  const custodyOf = async (owner: string): Promise<string> =>
    (await db.treasuryAccount.findFirstOrThrow({ where: { type: 'COLLECTOR_CUSTODY', ownerId: owner, currency: 'LBP' } }))
      .id;

  const handOver = (owner: string, amount: number, actor = MANAGER()) =>
    custodyOf(owner).then((custodyAccountId) =>
      scoped(() => transfers.receiveCustody({ custodyAccountId, amount }, actor)),
    );

  const staff = (role: string, extra: Record<string, unknown> = {}) => {
    const id = randomUUID();
    return {
      id,
      row: {
        id,
        kind: 'STAFF' as const,
        tenantSlug: 'controls',
        email: `${role.toLowerCase()}-${id}@controls.gov.lb`,
        firstName: role,
        lastName: 'الموظف',
        role: role as never,
        ...extra,
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
    ledger = new TreasuryLedgerService(context);
    payments = new PaymentLedgerService(context, auditService, ledger);
    transfers = new TransfersService(context, ledger, auditService);
    treasury = new TreasuryService(context, ledger, auditService);
    expenses = new ExpensesService(context, ledger, auditService);
    income = new IncomeService(context, ledger, auditService);
    fees = new FeesService(
      context,
      { emit: jest.fn() } as unknown as EventEmitter2,
      {} as never,
      {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        invalidatePrefix: jest.fn().mockResolvedValue(undefined),
      } as never,
      payments,
      auditService,
    );

    citizenId = randomUUID();
    const people = {
      manager: staff('SUPER_ADMIN'),
      collector: staff('COLLECTOR'),
      clockCollector: staff('COLLECTOR'),
      accountant: staff('ACCOUNTANT'),
      otherAccountant: staff('ACCOUNTANT'),
      viewer: staff('VIEWER'),
      leftCollector: staff('COLLECTOR', { isActive: false }),
    };
    for (const [key, person] of Object.entries(people)) ids[key as keyof typeof ids] = person.id;
    await db.user.createMany({
      data: [
        { id: citizenId, kind: 'CITIZEN', tenantSlug: 'controls', firstName: 'علي', lastName: 'خليل', phone: '71123456' },
        ...Object.values(people).map((person) => person.row),
      ],
    });

    // The safe opens with money, so expenses and refunds have something to come out of.
    const accounts = await db.treasuryAccount.findMany({ where: { type: { not: 'COLLECTOR_CUSTODY' } } });
    await scoped(() =>
      treasury.activate(
        {
          balances: accounts.map((account) => ({
            accountId: account.id,
            amount: account.type === 'CASH_SAFE' && account.currency === 'LBP' ? OPENING_SAFE_LBP : 0,
          })),
        },
        MANAGER(),
      ),
    );
    safeLbpId = (await db.treasuryAccount.findFirstOrThrow({ where: { type: 'CASH_SAFE', currency: 'LBP' } })).id;
    categoryId = (await db.expenseCategory.findFirstOrThrow({ where: { key: 'FUEL' } })).id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  // ─────────────────────  D1 — a refund after the handover  ─────────────────────

  describe('a refund of a round payment (decision D1)', () => {
    it('comes out of the safe once the collector has handed the cash in', async () => {
      const recorded = await collect(100_000, ids.collector);
      await handOver(ids.collector, 100_000);
      const custody = await custodyOf(ids.collector);
      const safeBefore = await balance(safeLbpId);

      await scoped(() => payments.reverse({ transactionId: recorded.transactionId, recordedById: ids.manager, audit }));

      expect(await balance(custody)).toBe(0);
      expect(await balance(safeLbpId)).toBe(safeBefore - 100_000);
    });

    it('comes out of his custody while he still holds it', async () => {
      const recorded = await collect(50_000, ids.collector);
      const custody = await custodyOf(ids.collector);
      const safeBefore = await balance(safeLbpId);

      await scoped(() => payments.reverse({ transactionId: recorded.transactionId, recordedById: ids.manager, audit }));

      expect(await balance(custody)).toBe(0);
      expect(await balance(safeLbpId)).toBe(safeBefore);
    });

    it('comes out of the safe when he holds only part of it', async () => {
      const first = await collect(80_000, ids.collector);
      await collect(20_000, ids.collector);
      await handOver(ids.collector, 90_000);
      const custody = await custodyOf(ids.collector);
      const safeBefore = await balance(safeLbpId);

      await scoped(() => payments.reverse({ transactionId: first.transactionId, recordedById: ids.manager, audit }));

      expect(await balance(custody)).toBe(10_000);
      expect(await balance(safeLbpId)).toBe(safeBefore - 80_000);
      await handOver(ids.collector, 10_000);
    });

    it('is given once when two clerks reverse one receipt together, and the other is told why', async () => {
      const paymentId = await bill(9_000);
      const paid = await scoped(() =>
        payments.record({ audit, paymentId, amount: 9_000, method: 'CASH', recordedById: ids.manager }),
      );
      const safeBefore = await balance(safeLbpId);

      const outcomes = await Promise.allSettled([
        scoped(() => payments.reverse({ transactionId: paid.transactionId, recordedById: ids.manager, audit })),
        scoped(() => payments.reverse({ transactionId: paid.transactionId, recordedById: ids.manager, audit })),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const refused = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({ code: 'TRANSACTION_ALREADY_REVERSED' });
      expect(await balance(safeLbpId)).toBe(safeBefore - 9_000);
    });
  });

  // ─────────────────────  D2 — a payment dated before go-live  ─────────────────────

  describe('a payment dated before go-live (decision D2)', () => {
    const dayBeforeGoLive = async (): Promise<string> => {
      const goLive = (await db.systemSettings.findFirstOrThrow({ select: { treasuryGoLiveAt: true } })).treasuryGoLiveAt!;
      return municipalToday(new Date(goLive.getTime() - 86_400_000));
    };

    it("is refused to a collector, who could otherwise keep today's cash off every wallet", async () => {
      const paymentId = await bill(60_000);
      await expect(
        scoped(async () =>
          fees.settleInPerson({
            paymentId,
            method: 'COLLECTOR',
            collectedById: ids.collector,
            paidOn: await dayBeforeGoLive(),
            adjustmentReason: 'جولة الأسبوع الماضي',
            actor: { id: ids.collector, role: 'COLLECTOR' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_DATE_BEFORE_GO_LIVE' });
    });

    it('is a finance role’s act: settled, credited to no wallet, and said so in the audit row', async () => {
      const paymentId = await bill(70_000);
      const entriesBefore = await db.treasuryEntry.count();

      const settled = await scoped(async () =>
        fees.settleInPerson({
          paymentId,
          method: 'CASH',
          paidOn: await dayBeforeGoLive(),
          adjustmentReason: 'نقد من العدّ الافتتاحي',
          actor: ACCOUNTANT(),
        }),
      );

      expect(settled.receiptNumber).toMatch(/^RCP-/);
      expect(await db.treasuryEntry.count()).toBe(entriesBefore);
      const row = await db.auditLogEntry.findFirstOrThrow({
        where: { action: 'PAYMENT_CONFIRMED', entityId: paymentId },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.after).toMatchObject({ treasuryCredited: false });
    });

    it('counts the go-live day itself as live, whatever the hour, and never before the opening entry', async () => {
      const { treasuryGoLiveAt } = await db.systemSettings.findFirstOrThrow({ select: { treasuryGoLiveAt: true } });
      // Activated yesterday evening, after midday UTC — where a back-dated receipt sits.
      const yesterday = municipalToday(new Date(Date.now() - 86_400_000));
      const lateGoLive = new Date(`${yesterday}T16:00:00.000Z`);
      await db.systemSettings.updateMany({ data: { treasuryGoLiveAt: lateGoLive } });
      try {
        const paymentId = await bill(11_000);
        await scoped(() =>
          fees.settleInPerson({
            paymentId,
            method: 'COLLECTOR',
            collectedById: ids.collector,
            paidOn: yesterday,
            adjustmentReason: 'أُدخلت في اليوم التالي',
            actor: { id: ids.collector, role: 'COLLECTOR' },
          }),
        );
        const receipt = await db.paymentTransaction.findFirstOrThrow({ where: { paymentId }, select: { id: true } });
        const entry = await db.treasuryEntry.findFirstOrThrow({
          where: { source: 'CITIZEN_PAYMENT', sourceId: receipt.id },
          select: { amount: true, occurredAt: true },
        });
        expect(Number(entry.amount)).toBe(11_000);
        expect(entry.occurredAt).toEqual(lateGoLive);
      } finally {
        await db.systemSettings.updateMany({ data: { treasuryGoLiveAt } });
      }
      await handOver(ids.collector, 11_000);
    });
  });

  it('tells the counter a retried settlement was already recorded, and takes the money once', async () => {
    const paymentId = await bill(8_000);
    const clientRequestId = randomUUID();
    const settle = () =>
      scoped(() => fees.settleInPerson({ paymentId, method: 'CASH', amount: 3_000, clientRequestId, actor: ACCOUNTANT() }));
    const safeBefore = await balance(safeLbpId);
    const first = await settle();
    const again = await settle();
    expect(first).toMatchObject({ replayed: false });
    expect(again).toMatchObject({ replayed: true, receiptNumber: first.receiptNumber });
    expect(await balance(safeLbpId)).toBe(safeBefore + 3_000);
  });

  describe('the collector named on a round', () => {
    it.each([
      ['a view-only staff member', 'viewer'],
      ['a collector who has been deactivated', 'leftCollector'],
    ] as const)('refuses %s', async (_label, who) => {
      const paymentId = await bill(10_000);
      await expect(
        scoped(() =>
          fees.settleInPerson({
            paymentId,
            method: 'COLLECTOR',
            collectedById: ids[who],
            actor: MANAGER(),
          }),
        ),
      ).rejects.toMatchObject({ code: 'COLLECTOR_NOT_FOUND' });
    });
  });

  // ─────────────────────  custody: received by someone else, never spent  ─────────────────────

  describe('custody', () => {
    it('is never received by the collector himself', async () => {
      await collect(40_000, ids.accountant);
      await expect(handOver(ids.accountant, 40_000, ACCOUNTANT())).rejects.toMatchObject({
        code: 'CUSTODY_SELF_RECEIPT',
      });
      // Someone else may.
      await expect(handOver(ids.accountant, 40_000, MANAGER())).resolves.toMatchObject({ replayed: false });
    });

    it('cannot pay an expense', async () => {
      await collect(30_000, ids.collector);
      const custody = await custodyOf(ids.collector);
      await expect(
        scoped(() =>
          expenses.record(
            { categoryId, accountId: custody, amount: 30_000, payee: 'مورد', description: 'من العهدة' },
            MANAGER(),
          ),
        ),
      ).rejects.toMatchObject({ code: 'EXPENSE_ACCOUNT_NOT_PAYABLE' });
      expect(await balance(custody)).toBe(30_000);
      await handOver(ids.collector, 30_000);
    });
  });

  // ─────────────────────  P0-2 — a retry key names one act  ─────────────────────

  describe('a retry key', () => {
    it('refuses to answer a different handover with an earlier one', async () => {
      await collect(90_000, ids.collector);
      const custodyAccountId = await custodyOf(ids.collector);
      const clientRequestId = randomUUID();
      await scoped(() => transfers.receiveCustody({ custodyAccountId, amount: 10_000, clientRequestId }, MANAGER()));

      await expect(
        scoped(() => transfers.receiveCustody({ custodyAccountId, amount: 80_000, clientRequestId }, MANAGER())),
      ).rejects.toMatchObject({ code: 'TREASURY_REQUEST_KEY_REUSED' });
      expect(await balance(custodyAccountId)).toBe(80_000);
      await handOver(ids.collector, 80_000);
    });

    it('refuses to answer a different voucher with an earlier one', async () => {
      const clientRequestId = randomUUID();
      const input = { categoryId, accountId: safeLbpId, payee: 'محطة', description: 'مازوت', clientRequestId };
      await scoped(() => expenses.record({ ...input, amount: 15_000 }, MANAGER()));

      await expect(scoped(() => expenses.record({ ...input, amount: 16_000 }, MANAGER()))).rejects.toMatchObject({
        code: 'TREASURY_REQUEST_KEY_REUSED',
      });
      // The same act again is answered from the first voucher, as before.
      await expect(scoped(() => expenses.record({ ...input, amount: 15_000 }, MANAGER()))).resolves.toMatchObject({
        replayed: true,
      });
    });

    it('binds a voucher key to its payee, and does not answer a cancelled voucher as recorded', async () => {
      const clientRequestId = randomUUID();
      const input = { categoryId, accountId: safeLbpId, amount: 7_000, description: 'قرطاسية', clientRequestId };
      const first = await scoped(() => expenses.record({ ...input, payee: 'مكتبة' }, MANAGER()));

      await expect(scoped(() => expenses.record({ ...input, payee: 'مطبعة' }, MANAGER()))).rejects.toMatchObject({
        code: 'TREASURY_REQUEST_KEY_REUSED',
      });

      await scoped(() => expenses.void(first.id, 'سُجّل خطأً', MANAGER()));
      await expect(scoped(() => expenses.record({ ...input, payee: 'مكتبة' }, MANAGER()))).rejects.toMatchObject({
        code: 'EXPENSE_ALREADY_VOID',
      });
    });

    it("does not answer the collector's next handover with an earlier one once his custody has moved", async () => {
      const fresh = staff('COLLECTOR');
      await db.user.create({ data: fresh.row });
      await collect(5_000, fresh.id);
      const custodyAccountId = await custodyOf(fresh.id);
      const clientRequestId = randomUUID();
      await scoped(() => transfers.receiveCustody({ custodyAccountId, amount: 5_000, clientRequestId }, MANAGER()));
      await collect(5_000, fresh.id);

      await expect(
        scoped(() => transfers.receiveCustody({ custodyAccountId, amount: 5_000, clientRequestId }, MANAGER())),
      ).rejects.toMatchObject({ code: 'TREASURY_REQUEST_KEY_REUSED' });
      expect(await balance(custodyAccountId)).toBe(5_000);
      await handOver(fresh.id, 5_000);
    });

    it('does not answer a counter retry with a receipt that has since been reversed', async () => {
      const paymentId = await bill(6_000);
      const clientRequestId = randomUUID();
      const settle = () =>
        scoped(() => fees.settleInPerson({ paymentId, method: 'CASH', amount: 6_000, clientRequestId, actor: ACCOUNTANT() }));
      const first = await settle();
      const receipt = await db.paymentTransaction.findFirstOrThrow({ where: { paymentId }, select: { id: true } });
      await scoped(() => payments.reverse({ transactionId: receipt.id, recordedById: ids.manager, audit }));

      await expect(settle()).rejects.toMatchObject({
        code: 'TRANSACTION_ALREADY_REVERSED',
        params: { receiptNumber: first.receiptNumber },
      });
    });

    it('does not answer a cancelled handover as received', async () => {
      await collect(5_000, ids.collector);
      const custodyAccountId = await custodyOf(ids.collector);
      const clientRequestId = randomUUID();
      const received = await scoped(() =>
        transfers.receiveCustody({ custodyAccountId, amount: 5_000, clientRequestId }, MANAGER()),
      );
      await scoped(() => transfers.void(received.id, 'عُدّ خطأً', MANAGER()));

      await expect(
        scoped(() => transfers.receiveCustody({ custodyAccountId, amount: 5_000, clientRequestId }, MANAGER())),
      ).rejects.toMatchObject({ code: 'TRANSFER_ALREADY_VOID' });
      await handOver(ids.collector, 5_000);
    });

    it('answers two simultaneous presses with one key as one handover, not a server error', async () => {
      await collect(60_000, ids.collector);
      const custodyAccountId = await custodyOf(ids.collector);
      const clientRequestId = randomUUID();

      const results = await Promise.allSettled([
        scoped(() => transfers.receiveCustody({ custodyAccountId, amount: 30_000, clientRequestId }, MANAGER())),
        scoped(() => transfers.receiveCustody({ custodyAccountId, amount: 30_000, clientRequestId }, MANAGER())),
      ]);

      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      const fulfilled = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
      expect(new Set(fulfilled.map((value) => value.transferNumber)).size).toBe(1);
      expect(await db.treasuryTransfer.count({ where: { clientRequestId } })).toBe(1);
      expect(await balance(custodyAccountId)).toBe(30_000);
      await handOver(ids.collector, 30_000);
    });
  });

  // ─────────────────────  P1-3 — one lock order across callers  ─────────────────────

  it('lets an expense and a handover on the same safe through together, without a deadlock', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 15; round++) {
      await collect(10_000, ids.collector);
      const custodyAccountId = await custodyOf(ids.collector);
      const results = await Promise.allSettled([
        scoped(() =>
          expenses.record(
            { categoryId, accountId: safeLbpId, amount: 1_000, payee: 'مورد', description: 'سباق' },
            MANAGER(),
          ),
        ),
        scoped(() => transfers.receiveCustody({ custodyAccountId, amount: 10_000 }, MANAGER())),
      ]);
      for (const result of results) {
        outcomes.push(result.status === 'fulfilled' ? 'ok' : String((result.reason as Error).message).slice(0, 80));
      }
    }
    expect(outcomes.filter((outcome) => outcome !== 'ok')).toEqual([]);
  });

  // ─────────────────────  0083 — documents are written once  ─────────────────────

  describe('the documents behind the ledger', () => {
    const table = (name: string) => `"${SCHEMA}"."${name}"`;

    it('refuse a change to anything but their stamps', async () => {
      const recorded = await scoped(() =>
        expenses.record({ categoryId, accountId: safeLbpId, amount: 2_000, payee: 'أ', description: 'ب' }, MANAGER()),
      );
      await expect(
        db.$executeRawUnsafe(`UPDATE ${table('expense_vouchers')} SET "amount" = 1 WHERE "id" = $1::uuid`, recorded.id),
      ).rejects.toThrow(/only its stamps may change/);
      await expect(
        db.$executeRawUnsafe(`UPDATE ${table('expense_vouchers')} SET "payee" = 'ج' WHERE "id" = $1::uuid`, recorded.id),
      ).rejects.toThrow(/only its stamps may change/);
    });

    it('are never deleted', async () => {
      const voucher = await db.expenseVoucher.findFirstOrThrow({ select: { id: true } });
      const transfer = await db.treasuryTransfer.findFirstOrThrow({ select: { id: true } });
      await expect(
        db.$executeRawUnsafe(`DELETE FROM ${table('expense_vouchers')} WHERE "id" = $1::uuid`, voucher.id),
      ).rejects.toThrow(/never removed/);
      await expect(
        db.$executeRawUnsafe(`DELETE FROM ${table('treasury_transfers')} WHERE "id" = $1::uuid`, transfer.id),
      ).rejects.toThrow(/never removed/);
    });

    it('keep a cancellation: a void cannot be undone, and a void voucher takes no order', async () => {
      const recorded = await scoped(() =>
        expenses.record(
          { categoryId, accountId: safeLbpId, amount: 3_000, payee: 'د', description: 'ه', urgentReason: 'عطل طارئ في المولد' },
          ACCOUNTANT(),
        ),
      );
      await scoped(() => expenses.void(recorded.id, 'سُجّل خطأً', MANAGER()));

      await expect(
        db.$executeRawUnsafe(`UPDATE ${table('expense_vouchers')} SET "voidedAt" = NULL WHERE "id" = $1::uuid`, recorded.id),
      ).rejects.toThrow(/cancelled document does not change/);
      await expect(scoped(() => expenses.regularize(recorded.id, MANAGER()))).rejects.toMatchObject({
        code: 'EXPENSE_ALREADY_VOID',
      });
    });

    it('keep a decision: a decided request takes nothing further, not even a reason it never gave', async () => {
      const filed = await scoped(() =>
        expenses.requestPayment({ categoryId, accountId: safeLbpId, amount: 1_500, payee: 'ز', description: 'ح' }, ACCOUNTANT()),
      );
      await scoped(() => expenses.withdrawRequest(filed.id, ACCOUNTANT()));

      await expect(
        db.$executeRawUnsafe(
          `UPDATE ${table('expense_requests')} SET "decisionReason" = 'أُضيف لاحقاً' WHERE "id" = $1::uuid`,
          filed.id,
        ),
      ).rejects.toThrow(/decided request does not change/);
    });
  });

  // ─────────────────────  D3 — the payment order  ─────────────────────

  describe('the payment order (decision D3)', () => {
    const expense = (amount: number, extra: Record<string, unknown> = {}) => ({
      categoryId,
      accountId: safeLbpId,
      amount,
      payee: 'محطة الوفاء',
      description: 'مازوت للمولّد',
      ...extra,
    });

    it("refuses an accountant's expense that is neither ordered nor urgent, and moves nothing", async () => {
      const before = await balance(safeLbpId);
      await expect(scoped(() => expenses.record(expense(25_000), ACCOUNTANT()))).rejects.toMatchObject({
        code: 'EXPENSE_ORDER_REQUIRED',
      });
      expect(await balance(safeLbpId)).toBe(before);
    });

    it('pays an urgent expense at once and leaves it waiting for its order, which is given once', async () => {
      const before = await balance(safeLbpId);
      const paid = await scoped(() =>
        expenses.record(expense(25_000, { urgentReason: 'تعطّل المولّد ليلاً' }), ACCOUNTANT()),
      );

      expect(paid.orderStatus).toBe('AWAITING_ORDER');
      expect(await balance(safeLbpId)).toBe(before - 25_000);
      const waiting = await scoped(() => expenses.list({ awaitingOrder: true }));
      expect(waiting.vouchers.map((voucher) => voucher.id)).toContain(paid.id);

      const ordered = await scoped(() => expenses.regularize(paid.id, MANAGER()));
      expect(ordered).toMatchObject({ orderStatus: 'ORDERED', urgentReason: 'تعطّل المولّد ليلاً' });
      expect(ordered.orderedByName).not.toBeNull();
      await expect(scoped(() => expenses.regularize(paid.id, MANAGER()))).rejects.toMatchObject({
        code: 'EXPENSE_ALREADY_ORDERED',
      });
    });

    it("records the manager's own expense as ordered", async () => {
      const paid = await scoped(() => expenses.record(expense(5_000), MANAGER()));
      expect(paid.orderStatus).toBe('ORDERED');
      expect((await scoped(() => expenses.get(paid.id))).orderedAt).not.toBeNull();
    });

    it('files a request that moves no money until the manager orders it, once', async () => {
      const before = await balance(safeLbpId);
      const filed = await scoped(() => expenses.requestPayment(expense(40_000), ACCOUNTANT()));
      expect(filed).toMatchObject({ status: 'PENDING', replayed: false });
      expect(await balance(safeLbpId)).toBe(before);

      const queue = await scoped(() => expenses.listRequests({}));
      expect(queue.requests.map((request) => request.id)).toContain(filed.id);

      const paid = await scoped(() => expenses.orderRequest(filed.id, MANAGER()));
      expect(paid).toMatchObject({ orderStatus: 'ORDERED', replayed: false });
      expect(paid.voucherNumber).toMatch(/^PV-/);
      expect(await balance(safeLbpId)).toBe(before - 40_000);

      const voucher = await scoped(() => expenses.get(paid.id));
      // Two signatures: the accountant who prepared it, the manager who ordered it.
      expect(voucher.recordedByName).toContain('ACCOUNTANT');
      expect(voucher.orderedByName).toContain('SUPER_ADMIN');

      const decided = await scoped(() => expenses.listRequests({ status: 'ORDERED' }));
      expect(decided.requests.find((request) => request.id === filed.id)).toMatchObject({
        voucherNumber: paid.voucherNumber,
      });
      // His second press is answered with the voucher his order paid, and pays nothing more…
      await expect(scoped(() => expenses.orderRequest(filed.id, MANAGER()))).resolves.toMatchObject({
        id: paid.id,
        voucherNumber: paid.voucherNumber,
        replayed: true,
      });
      expect(await balance(safeLbpId)).toBe(before - 40_000);
      // …while another manager is told it was decided, not answered with an order he did not give.
      const other = staff('SUPER_ADMIN');
      await db.user.create({ data: other.row });
      await expect(
        scoped(() => expenses.orderRequest(filed.id, { id: other.id, role: 'SUPER_ADMIN' })),
      ).rejects.toMatchObject({ code: 'EXPENSE_REQUEST_ALREADY_DECIDED' });
    });

    it('pays once when the manager presses the order twice at the same moment', async () => {
      const filed = await scoped(() => expenses.requestPayment(expense(7_000), ACCOUNTANT()));
      const before = await balance(safeLbpId);
      const [first, second] = await Promise.all([
        scoped(() => expenses.orderRequest(filed.id, MANAGER())),
        scoped(() => expenses.orderRequest(filed.id, MANAGER())),
      ]);
      expect(first.id).toBe(second.id);
      expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
      expect(await db.expenseVoucher.count({ where: { request: { id: filed.id } } })).toBe(1);
      expect(await balance(safeLbpId)).toBe(before - 7_000);
    });

    it('keeps a request waiting when the wallet cannot cover it', async () => {
      const filed = await scoped(() => expenses.requestPayment(expense(900_000_000), ACCOUNTANT()));
      await expect(scoped(() => expenses.orderRequest(filed.id, MANAGER()))).rejects.toMatchObject({
        code: 'TREASURY_INSUFFICIENT_FUNDS',
      });
      const queue = await scoped(() => expenses.listRequests({}));
      expect(queue.requests.find((request) => request.id === filed.id)?.status).toBe('PENDING');
    });

    it('is rejected with a reason, and nothing moves', async () => {
      const before = await balance(safeLbpId);
      const filed = await scoped(() => expenses.requestPayment(expense(8_000), ACCOUNTANT()));
      const rejected = await scoped(() => expenses.rejectRequest(filed.id, 'لا اعتماد في الموازنة', MANAGER()));
      expect(rejected).toMatchObject({ status: 'REJECTED', decisionReason: 'لا اعتماد في الموازنة' });
      expect(await balance(safeLbpId)).toBe(before);
    });

    it('is withdrawn by its author, and by nobody else but the manager', async () => {
      const filed = await scoped(() => expenses.requestPayment(expense(9_000), ACCOUNTANT()));
      await expect(
        scoped(() => expenses.withdrawRequest(filed.id, { id: ids.otherAccountant, role: 'ACCOUNTANT' })),
      ).rejects.toMatchObject({ code: 'EXPENSE_REQUEST_NOT_YOURS' });
      await expect(scoped(() => expenses.withdrawRequest(filed.id, ACCOUNTANT()))).resolves.toMatchObject({
        status: 'WITHDRAWN',
      });
    });

    it('answers a double-pressed request from the first, and refuses its key for another', async () => {
      const clientRequestId = randomUUID();
      const first = await scoped(() => expenses.requestPayment(expense(11_000, { clientRequestId }), ACCOUNTANT()));
      await expect(
        scoped(() => expenses.requestPayment(expense(11_000, { clientRequestId }), ACCOUNTANT())),
      ).resolves.toMatchObject({ id: first.id, replayed: true });
      await expect(
        scoped(() => expenses.requestPayment(expense(12_000, { clientRequestId }), ACCOUNTANT())),
      ).rejects.toMatchObject({ code: 'TREASURY_REQUEST_KEY_REUSED' });
    });

    it('is counted on the treasury overview while it waits', async () => {
      const overview = await scoped(() => treasury.overview());
      const pending = await db.expenseRequest.count({ where: { decision: null } });
      const awaiting = await db.expenseVoucher.count({ where: { orderedAt: null, voidedAt: null } });
      expect(overview).toMatchObject({ pendingExpenseRequests: pending, vouchersAwaitingOrder: awaiting });
      expect(pending).toBeGreaterThan(0);
    });
  });

  // ─────────────────────  P1-8 — the statement reaches the present  ─────────────────────

  it('shows the latest movements of a busy wallet, with an opening balance that adds up', async () => {
    const statement = await scoped(() => treasury.statement(safeLbpId, { limit: 3 }));
    const current = await balance(safeLbpId);

    expect(statement.truncated).toBe(true);
    expect(statement.entries).toHaveLength(3);
    expect(statement.entries[2].balanceAfter).toBe(current);
    const moved = statement.entries.reduce((sum, entry) => sum + entry.amount, 0);
    expect(statement.openingBalance + moved).toBe(current);
    const times = statement.entries.map((entry) => Date.parse(entry.occurredAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  // ─────────────────────  P1-10 / P1-7 — «جولتي» and today's panel  ─────────────────────

  describe("a collector's round", () => {
    it('lists nothing from before go-live, which never reached his custody', async () => {
      const goLive = (await db.systemSettings.findFirstOrThrow({ select: { treasuryGoLiveAt: true } })).treasuryGoLiveAt!;
      const fresh = staff('COLLECTOR');
      await db.user.create({ data: fresh.row });
      await collect(5_000, fresh.id, new Date(goLive.getTime() - 3_600_000));
      await collect(7_000, fresh.id);

      const round = await scoped(() => transfers.myRound(fresh.id));
      expect(round.rows.map((row) => row.amount)).toEqual([7_000]);
      expect(round.currencies).toEqual([{ currency: 'LBP', held: 7_000, listed: 7_000, carriedOver: 0 }]);
    });

    it('lists on his page only what reached his custody, so the gap is what he handed in', async () => {
      const goLive = (await db.systemSettings.findFirstOrThrow({ select: { treasuryGoLiveAt: true } })).treasuryGoLiveAt!;
      const fresh = staff('COLLECTOR');
      await db.user.create({ data: fresh.row });
      await collect(4_000, fresh.id, new Date(goLive.getTime() - 3_600_000));
      await collect(6_000, fresh.id);

      const page = await scoped(() => transfers.collections(fresh.id));
      expect(page.rows.map((row) => row.amount)).toEqual([6_000]);
      expect(page.totals).toEqual([{ currency: 'LBP', amount: 6_000 }]);
      expect(page.custody).toEqual([{ currency: 'LBP', held: 6_000 }]);
      expect(page.since).toBe(goLive.toISOString());
    });

    it('keeps «collected − held» equal to what he handed in after a refund paid from the safe', async () => {
      const fresh = staff('COLLECTOR');
      await db.user.create({ data: fresh.row });
      const paid = await collect(50_000, fresh.id);
      await handOver(fresh.id, 50_000);
      // Refunded after the handover: out of the safe (D1), his custody untouched.
      await scoped(() => payments.reverse({ transactionId: paid.transactionId, recordedById: ids.manager, audit }));

      const page = await scoped(() => transfers.collections(fresh.id));
      expect(page.totals).toEqual([{ currency: 'LBP', amount: 50_000 }]);
      expect(page.custody).toEqual([{ currency: 'LBP', held: 0 }]);
    });

    /*
      The day bucket itself, read straight from the query that builds it: in
      this spec go-live is a moment ago, so a receipt at half past midnight is
      older than it and credits no custody — the board would not list him. The
      bucket counts receipts whatever they credited, which is the thing that was
      six hours off.
    */
    it("counts a receipt taken at half past midnight in Beirut as today's", async () => {
      const halfPastMidnight = Math.min(Date.now(), municipalDayStart(municipalToday()).getTime() + 30 * 60_000);
      await collect(12_000, ids.clockCollector, new Date(halfPastMidnight));

      const today = await scoped(() =>
        (
          transfers as unknown as { collectedToday(): Promise<Map<string, { receipts: number; amount: number }>> }
        ).collectedToday(),
      );
      expect(today.get(`${ids.clockCollector}|LBP`)).toEqual({ receipts: 1, amount: 12_000 });
    });
  });

  // ─────────────────────  rates, and a category edit  ─────────────────────

  describe('the rate each entry keeps', () => {
    it("stamps a reversal with its original entry's rate, not today's", async () => {
      await db.systemSettings.updateMany({ data: { exchangeRate: 89_500 } });
      const paid = await scoped(() =>
        expenses.record({ categoryId, accountId: safeLbpId, amount: 4_000, payee: 'و', description: 'ز' }, MANAGER()),
      );
      await db.systemSettings.updateMany({ data: { exchangeRate: 90_000 } });
      await scoped(() => expenses.void(paid.id, 'سُجّل مرتين', MANAGER()));

      const entries = await db.treasuryEntry.findMany({
        where: { source: 'EXPENSE_VOUCHER', sourceId: paid.id },
        select: { reversalOfId: true, exchangeRateAtPosting: true },
      });
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => Number(entry.exchangeRateAtPosting))).toEqual([89_500, 89_500]);
    });

    it("stamps a handover's two legs with the day's rate", async () => {
      await collect(6_000, ids.collector);
      const received = await handOver(ids.collector, 6_000);
      const legs = await db.treasuryEntry.findMany({
        where: { source: 'TRANSFER', sourceId: received.id },
        select: { exchangeRateAtPosting: true },
      });
      expect(legs.map((leg) => Number(leg.exchangeRateAtPosting))).toEqual([90_000, 90_000]);
    });
  });

  it('changes only what a category edit names', async () => {
    const created = await scoped(() =>
      expenses.createCategory({ name: 'صيانة الطرق', chapterCode: '62', itemCode: '621' }, MANAGER()),
    );
    await scoped(() => expenses.updateCategory(created.id, { name: 'صيانة الطرق', active: false }, MANAGER()));

    const renamed = await scoped(() => expenses.updateCategory(created.id, { name: 'صيانة الطرقات' }, MANAGER()));
    expect(renamed).toMatchObject({ name: 'صيانة الطرقات', chapterCode: '62', itemCode: '621', active: false });

    // Both codes sent empty take them off; one alone would leave the pair half-entered.
    const clear = updateExpenseCategorySchema.parse({ name: 'صيانة الطرقات', chapterCode: '', itemCode: ' ' });
    const cleared = await scoped(() => expenses.updateCategory(created.id, clear, MANAGER()));
    expect(cleared).toMatchObject({ chapterCode: null, itemCode: null, active: false });
    expect(updateExpenseCategorySchema.safeParse({ name: 'صيانة الطرقات', chapterCode: '' }).success).toBe(false);
    expect(updateExpenseCategorySchema.safeParse({ name: 'صيانة الطرقات', chapterCode: '7' }).success).toBe(false);
  });

  // ─────────────────────  income vouchers, under the same controls  ─────────────────────

  describe('an income voucher', () => {
    let incomeCategoryId: string;
    const receive = (over: Record<string, unknown> = {}, actor = MANAGER()) =>
      scoped(() =>
        income.record(
          {
            categoryId: incomeCategoryId,
            accountId: safeLbpId,
            amount: 12_000,
            payerName: 'مستأجر القاعة',
            description: 'إيجار قاعة البلدية',
            clientRequestId: randomUUID(),
            ...over,
          } as Parameters<IncomeService['record']>[0],
          actor,
        ),
      );

    beforeAll(async () => {
      incomeCategoryId = (await db.incomeCategory.findFirstOrThrow({ where: { key: 'MISCELLANEOUS_INCOME' } })).id;
    });

    it('binds its retry key to the act: another amount, payer or clerk is refused, the same act replayed', async () => {
      const clientRequestId = randomUUID();
      const first = await receive({ clientRequestId });
      const before = await balance(safeLbpId);

      await expect(receive({ clientRequestId, amount: 13_000 })).rejects.toMatchObject({
        code: 'TREASURY_REQUEST_KEY_REUSED',
      });
      await expect(receive({ clientRequestId, payerName: 'غيره' })).rejects.toMatchObject({
        code: 'TREASURY_REQUEST_KEY_REUSED',
      });
      await expect(receive({ clientRequestId }, ACCOUNTANT())).rejects.toMatchObject({
        code: 'TREASURY_REQUEST_KEY_REUSED',
      });
      await expect(receive({ clientRequestId })).resolves.toMatchObject({
        replayed: true,
        voucherNumber: first.voucherNumber,
      });
      expect(await balance(safeLbpId)).toBe(before);
      expect(await db.incomeVoucher.count({ where: { clientRequestId } })).toBe(1);
    });

    it('does not answer a cancelled voucher as recorded', async () => {
      const clientRequestId = randomUUID();
      const first = await receive({ clientRequestId });
      await scoped(() => income.void(first.id, 'سُجّل مرتين', MANAGER()));

      await expect(receive({ clientRequestId })).rejects.toMatchObject({
        code: 'INCOME_ALREADY_VOID',
        params: { voucherNumber: first.voucherNumber },
      });
    });

    it('dated the go-live day, never sits before the opening entry (D5)', async () => {
      const { treasuryGoLiveAt } = await db.systemSettings.findFirstOrThrow({ select: { treasuryGoLiveAt: true } });
      // Activated yesterday evening, after midday UTC — where a back-dated voucher would sit.
      const yesterday = municipalToday(new Date(Date.now() - 86_400_000));
      const lateGoLive = new Date(`${yesterday}T16:00:00.000Z`);
      await db.systemSettings.updateMany({ data: { treasuryGoLiveAt: lateGoLive } });
      try {
        const recorded = await receive({ receivedOn: yesterday, adjustmentReason: 'وصل التحويل مساءً وأُدخل اليوم' });
        const voucher = await db.incomeVoucher.findUniqueOrThrow({
          where: { id: recorded.id },
          select: { occurredAt: true },
        });
        const entry = await db.treasuryEntry.findFirstOrThrow({
          where: { source: 'INCOME_VOUCHER', sourceId: recorded.id },
          select: { occurredAt: true },
        });
        expect(voucher.occurredAt).toEqual(lateGoLive);
        expect(entry.occurredAt).toEqual(lateGoLive);
      } finally {
        await db.systemSettings.updateMany({ data: { treasuryGoLiveAt } });
      }
    });

    it('is written once: its amount cannot be changed, nor the row deleted', async () => {
      const recorded = await receive();
      const table = `"${SCHEMA}"."income_vouchers"`;
      await expect(
        db.$executeRawUnsafe(`UPDATE ${table} SET "amount" = 1 WHERE "id" = $1::uuid`, recorded.id),
      ).rejects.toThrow(/only its stamps may change/);
      await expect(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE "id" = $1::uuid`, recorded.id)).rejects.toThrow(
        /never removed/,
      );
      // Its stamps still go on, once: the cancellation is how it is corrected.
      await scoped(() => income.void(recorded.id, 'خطأ في البند', MANAGER()));
      await expect(
        db.$executeRawUnsafe(`UPDATE ${table} SET "voidedAt" = NULL WHERE "id" = $1::uuid`, recorded.id),
      ).rejects.toThrow(/cancelled document does not change/);
    });

    it('goes through with an expense and a handover on the same safe, without a deadlock', async () => {
      const outcomes: string[] = [];
      for (let round = 0; round < 15; round++) {
        await collect(10_000, ids.collector);
        const custodyAccountId = await custodyOf(ids.collector);
        const results = await Promise.allSettled([
          scoped(() =>
            expenses.record(
              { categoryId, accountId: safeLbpId, amount: 1_000, payee: 'مورد', description: 'سباق' },
              MANAGER(),
            ),
          ),
          receive({ amount: 1_000 }),
          scoped(() => transfers.receiveCustody({ custodyAccountId, amount: 10_000 }, MANAGER())),
        ]);
        for (const result of results) {
          outcomes.push(result.status === 'fulfilled' ? 'ok' : String((result.reason as Error).message).slice(0, 80));
        }
      }
      expect(outcomes.filter((outcome) => outcome !== 'ok')).toEqual([]);
    });
  });

  // ─────────────────────  a salary is paid on the art. 35 path  ─────────────────────

  describe('a salary payout', () => {
    const salaryStaff = async (firstName = 'ريما', lastName = 'حداد') => {
      const person = staff('ADMINISTRATIVE_OFFICER', { firstName, lastName });
      await db.user.create({ data: person.row });
      return person.id;
    };
    const paySalary = (staffId: string, actor: { id: string; role: string }, over: Record<string, unknown> = {}) =>
      scoped(() =>
        expenses.recordSalary(
          staffId,
          {
            accountId: safeLbpId,
            amount: 20_000,
            description: 'راتب تشرين الأول',
            clientRequestId: randomUUID(),
            ...over,
          } as Parameters<ExpensesService['recordSalary']>[1],
          actor,
        ),
      );

    it("is refused to an accountant paying himself, and moves nothing", async () => {
      const before = await balance(safeLbpId);
      await expect(paySalary(ids.accountant, ACCOUNTANT())).rejects.toMatchObject({ code: 'SALARY_SELF_PAYOUT' });
      expect(await balance(safeLbpId)).toBe(before);
    });

    it("refuses a day that is not on the calendar instead of storing another one", () => {
      const base = { categoryId, accountId: safeLbpId, amount: 1_000, payee: 'مورد', description: 'قرطاسية' };
      expect(recordExpenseSchema.safeParse({ ...base, paidOn: '2026-09-31' }).success).toBe(false);
      expect(recordExpenseSchema.safeParse({ ...base, paidOn: '2026-10-00' }).success).toBe(false);
      expect(recordExpenseSchema.safeParse({ ...base, paidOn: '2026-09-30' }).success).toBe(true);
    });

    it("by the accountant, is paid at once and waits for the manager's order, with the art. 35 reason", async () => {
      const paid = await paySalary(await salaryStaff(), ACCOUNTANT());
      expect(paid.orderStatus).toBe('AWAITING_ORDER');
      const voucher = await scoped(() => expenses.get(paid.id));
      expect(voucher).toMatchObject({ orderStatus: 'AWAITING_ORDER', urgentReason: SALARY_URGENT_REASON });
      expect(voucher.urgentReason).toBe('راتب — يُدفع قبل الحوالة (المادة 35)');

      const waiting = await scoped(() => expenses.list({ awaitingOrder: true }));
      expect(waiting.vouchers.map((row) => row.id)).toContain(paid.id);
      await expect(scoped(() => expenses.regularize(paid.id, MANAGER()))).resolves.toMatchObject({
        orderStatus: 'ORDERED',
      });
    });

    it('by the manager, is the order itself', async () => {
      const paid = await paySalary(await salaryStaff(), MANAGER());
      expect(paid.orderStatus).toBe('ORDERED');
      expect(await scoped(() => expenses.get(paid.id))).toMatchObject({ orderStatus: 'ORDERED', urgentReason: null });
    });

    it('binds its retry key to the staff account, not only to the name on it', async () => {
      // Two staff members who share a name: the payee text alone cannot tell them apart.
      const first = await salaryStaff('حسن', 'سرور');
      const namesake = await salaryStaff('حسن', 'سرور');
      const clientRequestId = randomUUID();
      await paySalary(first, MANAGER(), { clientRequestId });
      const before = await balance(safeLbpId);

      await expect(paySalary(namesake, MANAGER(), { clientRequestId })).rejects.toMatchObject({
        code: 'TREASURY_REQUEST_KEY_REUSED',
      });
      expect(await balance(safeLbpId)).toBe(before);
      await expect(paySalary(first, MANAGER(), { clientRequestId })).resolves.toMatchObject({ replayed: true });
    });
  });

  // ─────────────────────  D6 — the urgent-payment ceiling  ─────────────────────

  describe('the urgent-payment ceiling (decision D6)', () => {
    const CEILING_LBP = 100_000;
    const CEILING_USD = 50;
    let safeUsdId: string;
    const urgent = (amount: number, accountId = safeLbpId) => ({
      categoryId,
      accountId,
      amount,
      payee: 'كاراج الحي',
      description: 'تصليح عاجل لشاحنة النفايات',
      urgentReason: 'تعطّلت الشاحنة أثناء الجولة',
    });
    const setCeilings = (lbp: number | null, usd: number | null) =>
      db.systemSettings.updateMany({ data: { urgentExpenseCeilingLbp: lbp, urgentExpenseCeilingUsd: usd } });

    beforeAll(async () => {
      safeUsdId = (await db.treasuryAccount.findFirstOrThrow({ where: { type: 'CASH_SAFE', currency: 'USD' } })).id;
      // Dollars in the safe, so a dollar expense has something to come out of.
      const miscIncome = (await db.incomeCategory.findFirstOrThrow({ where: { key: 'MISCELLANEOUS_INCOME' } })).id;
      await scoped(() =>
        income.record(
          { categoryId: miscIncome, accountId: safeUsdId, amount: 1_000, description: 'هبة', clientRequestId: randomUUID() },
          MANAGER(),
        ),
      );
    });

    afterEach(async () => {
      await setCeilings(null, null);
    });

    it("refuses an accountant's urgent payment above it, writing nothing", async () => {
      await setCeilings(CEILING_LBP, null);
      const vouchersBefore = await db.expenseVoucher.count();
      const safeBefore = await balance(safeLbpId);
      await expect(scoped(() => expenses.record(urgent(CEILING_LBP + 1), ACCOUNTANT()))).rejects.toMatchObject({
        code: 'EXPENSE_URGENT_OVER_CEILING',
        params: { ceiling: CEILING_LBP, currency: 'LBP' },
      });
      expect(await db.expenseVoucher.count()).toBe(vouchersBefore);
      expect(await balance(safeLbpId)).toBe(safeBefore);
    });

    it('lets one at the ceiling or under it through, still waiting for the order', async () => {
      await setCeilings(CEILING_LBP, null);
      for (const amount of [CEILING_LBP, CEILING_LBP - 1]) {
        await expect(scoped(() => expenses.record(urgent(amount), ACCOUNTANT()))).resolves.toMatchObject({
          orderStatus: 'AWAITING_ORDER',
        });
      }
    });

    it("does not hold back the manager's own voucher, which is the order", async () => {
      await setCeilings(CEILING_LBP, null);
      await expect(scoped(() => expenses.record(urgent(CEILING_LBP * 2), MANAGER()))).resolves.toMatchObject({
        orderStatus: 'ORDERED',
      });
    });

    it('does not hold back a salary, which art. 35 names', async () => {
      await setCeilings(CEILING_LBP, null);
      const person = staff('ADMINISTRATIVE_OFFICER');
      await db.user.create({ data: person.row });
      await expect(
        scoped(() =>
          expenses.recordSalary(
            person.id,
            { accountId: safeLbpId, amount: CEILING_LBP * 2, description: 'راتب', clientRequestId: randomUUID() },
            ACCOUNTANT(),
          ),
        ),
      ).resolves.toMatchObject({ orderStatus: 'AWAITING_ORDER' });
    });

    it('has no limit while it is not set', async () => {
      await setCeilings(null, null);
      await expect(scoped(() => expenses.record(urgent(CEILING_LBP * 3), ACCOUNTANT()))).resolves.toMatchObject({
        orderStatus: 'AWAITING_ORDER',
      });
    });

    it('is one per currency: a dollar ceiling holds dollars only, a ليرة ceiling ليرة only', async () => {
      await setCeilings(null, CEILING_USD);
      await expect(
        scoped(() => expenses.record(urgent(CEILING_USD + 10, safeUsdId), ACCOUNTANT())),
      ).rejects.toMatchObject({
        code: 'EXPENSE_URGENT_OVER_CEILING',
        params: { ceiling: CEILING_USD, currency: 'USD' },
      });
      await expect(scoped(() => expenses.record(urgent(CEILING_LBP * 3), ACCOUNTANT()))).resolves.toMatchObject({
        orderStatus: 'AWAITING_ORDER',
      });

      await setCeilings(CEILING_LBP, null);
      await expect(
        scoped(() => expenses.record(urgent(CEILING_USD + 10, safeUsdId), ACCOUNTANT())),
      ).resolves.toMatchObject({ orderStatus: 'AWAITING_ORDER' });
    });

    it('is set in الإعدادات by the manager alone, validated, and refused at zero by the database too', async () => {
      // The form's schema: positive, two decimals at most, null clears it.
      for (const bad of [0, -5, 10.123]) {
        expect(systemSettingsSchema.safeParse({ urgentExpenseCeilingLbp: bad }).success).toBe(false);
      }
      expect(systemSettingsSchema.safeParse({ urgentExpenseCeilingUsd: null }).success).toBe(true);
      expect(systemSettingsSchema.safeParse({ urgentExpenseCeilingUsd: 99.5 }).success).toBe(true);

      const saved = await scoped(() =>
        fees.updateSettings({ urgentExpenseCeilingLbp: 250_000, urgentExpenseCeilingUsd: 75.5 }, MANAGER()),
      );
      expect(saved).toMatchObject({ urgentExpenseCeilingLbp: 250_000, urgentExpenseCeilingUsd: 75.5 });

      // The accountant may not move the limit on his own payments…
      await expect(
        scoped(() => fees.updateSettings({ urgentExpenseCeilingLbp: 9_000_000 }, ACCOUNTANT())),
      ).rejects.toMatchObject({ code: 'URGENT_EXPENSE_CEILING_FORBIDDEN' });
      await expect(
        scoped(() => fees.updateSettings({ urgentExpenseCeilingUsd: null }, ACCOUNTANT())),
      ).rejects.toMatchObject({ code: 'URGENT_EXPENSE_CEILING_FORBIDDEN' });
      // …but saving the finance section with the values it read is no change, and he may.
      await expect(
        scoped(() =>
          fees.updateSettings(
            { defaultDueDays: 30, urgentExpenseCeilingLbp: 250_000, urgentExpenseCeilingUsd: 75.5 },
            ACCOUNTANT(),
          ),
        ),
      ).resolves.toMatchObject({ urgentExpenseCeilingLbp: 250_000, urgentExpenseCeilingUsd: 75.5 });

      await expect(
        db.$executeRawUnsafe(`UPDATE "${SCHEMA}"."system_settings" SET "urgentExpenseCeilingLbp" = 0`),
      ).rejects.toThrow(/system_settings_urgent_ceiling_lbp_positive/);
    });
  });
});

/*
  Activation on a municipality that never opened الإعدادات, so has no settings
  row. A payment reads the go-live stamp `FOR SHARE` to wait for activation to
  commit — but a row activation inserted in its own transaction is invisible to
  it, so it did not wait, read NULL, and the cash it took credited no wallet.
  Its own schema: the one above is live before its first test.
*/
describeIfDb('activation on a municipality with no settings row', () => {
  const FRESH = 'tenant_treasury_first_activation_spec';
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let ledger: TreasuryLedgerService;
  let payments: PaymentLedgerService;
  let treasury: TreasuryService;
  const managerId = randomUUID();
  const citizenId = randomUUID();

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'first', schemaName: FRESH, prisma: db }, work);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${FRESH}" CASCADE`);
    await migrateTenantSchema(ddl, FRESH);

    db = tenantTestClient(TEST_DATABASE_URL!, FRESH);
    context = new TenantContextService();
    const auditService = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    ledger = new TreasuryLedgerService(context);
    payments = new PaymentLedgerService(context, auditService, ledger);
    treasury = new TreasuryService(context, ledger, auditService);

    await db.user.createMany({
      data: [
        { id: citizenId, kind: 'CITIZEN', tenantSlug: 'first', firstName: 'سارة', lastName: 'حداد', phone: '71654321' },
        {
          id: managerId,
          kind: 'STAFF',
          tenantSlug: 'first',
          email: `manager-${managerId}@first.gov.lb`,
          firstName: 'المدير',
          lastName: 'العام',
          role: 'SUPER_ADMIN',
        },
      ],
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${FRESH}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('credits a payment taken while activation is still committing', async () => {
    expect(await db.systemSettings.count()).toBe(0);
    const paymentId = (
      await db.citizenPayment.create({
        data: { citizenId, title: 'رسم', amount: 25_000, dueDate: new Date('2026-12-31T00:00:00.000Z') },
        select: { id: true },
      })
    ).id;
    const audit: LedgerAudit = (movement) => ({
      actorId: managerId,
      actorType: 'STAFF',
      action: 'PAYMENT_CONFIRMED',
      entityType: 'Payment',
      after: { receiptNumber: movement.receiptNumber },
    });

    // Halfway through activation — the stamp written, not yet committed — a payment arrives.
    const race: { settingsRowsSeenOutside?: number; paying?: Promise<{ transactionId: string }> } = {};
    const post = ledger.post.bind(ledger);
    const spy = jest.spyOn(ledger, 'post').mockImplementationOnce(async (...args) => {
      const outside = await ddl.query(`SELECT count(*)::int AS n FROM "${FRESH}".system_settings`);
      race.settingsRowsSeenOutside = outside.rows[0].n;
      race.paying = scoped(() =>
        payments.record({ audit, paymentId, amount: 25_000, method: 'CASH', recordedById: managerId }),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      return post(...args);
    });
    try {
      const balances = (await db.treasuryAccount.findMany({ where: { type: { not: 'COLLECTOR_CUSTODY' } } })).map(
        (account) => ({ accountId: account.id, amount: 0 }),
      );
      await scoped(() => treasury.activate({ balances }, { id: managerId, role: 'SUPER_ADMIN' }));
    } finally {
      spy.mockRestore();
    }
    const paid = await race.paying!;

    // Committed before activation's transaction opened: there was a row to wait on…
    expect(race.settingsRowsSeenOutside).toBe(1);
    // …so the payment waited for the stamp, and the safe has the cash.
    expect(await db.treasuryEntry.count({ where: { source: 'CITIZEN_PAYMENT', sourceId: paid.transactionId } })).toBe(1);
  });
});

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Client } from 'pg';
import type { BulkSettlePayments } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient, Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { TreasuryLedgerService } from '../treasury/treasury-ledger.service';
import { TreasuryService } from '../treasury/treasury.service';
import { PaymentLedgerService, type LedgerAudit } from './payment-ledger.service';
import { PaymentSettlementService } from './payment-settlement.service';

/**
 * «تسديد الفواتير المحددة», against a real Postgres (docs/finance.md §3.7).
 *
 * What only a database can show: that a refusal on one bill leaves every other
 * bill, the settlement row, the receipt counter's rows and the wallets exactly
 * as they were; that the settlement table refuses UPDATE and DELETE; that two
 * presses racing over the same bills settle them once and never deadlock.
 *
 * Ordered on purpose, as the treasury suite is: the settlements that need the
 * treasury NOT live run first, then it is activated, then the rest.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_settlement_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;
const RATE = 89_500;

const MIGRATION_SQL = join(
  __dirname,
  '../../../infrastructure/prisma/tenant/migrations/0085_payment_settlements/migration.sql',
);

describeIfDb('Bulk settlement', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let payments: PaymentLedgerService;
  let ledger: TreasuryLedgerService;
  let treasury: TreasuryService;
  let settlements: PaymentSettlementService;

  let citizenId: string;
  let otherCitizenId: string;
  let accountantId: string;
  let collectorId: string;

  const actor = () => ({ id: accountantId, role: 'ACCOUNTANT' });

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'settlement', schemaName: SCHEMA, prisma: db }, work);

  const audit: LedgerAudit = (movement) => ({
    actorId: accountantId,
    actorType: 'STAFF',
    action: 'PAYMENT_CONFIRMED',
    entityType: 'Payment',
    after: { receiptNumber: movement.receiptNumber },
  });

  let dueDay = 0;
  /** A fresh bill, each due a day after the last, so «oldest first» is known. */
  const bill = async (amount: number, currency = 'LBP', owner?: string) => {
    dueDay += 1;
    const due = new Date(Date.UTC(2026, 0, 1) + dueDay * 86_400_000);
    return (
      await db.citizenPayment.create({
        data: {
          citizenId: owner ?? citizenId,
          title: `رسم ${dueDay}`,
          amount,
          currency,
          dueDate: due,
          createdAt: new Date('2026-01-01T08:00:00.000Z'),
          assessment: {
            basis: 'PER_UNIT',
            rate: amount,
            unitCount: 1,
            totalArea: 0,
            lines: [{ propertyNumber: '512', propertyType: 'BUILDING', unitType: 'APARTMENT', unitArea: 90, unitCode: 'B-1' }],
          },
        },
        select: { id: true },
      })
    ).id;
  };

  const settle = (input: Partial<BulkSettlePayments> & Pick<BulkSettlePayments, 'paymentIds' | 'method'>) =>
    scoped(() =>
      settlements.settle(
        { citizenId, clientRequestId: randomUUID(), ...input } as BulkSettlePayments,
        actor(),
      ),
    );

  const account = (type: string, currency: string) =>
    db.treasuryAccount.findFirstOrThrow({ where: { type: type as never, currency, isPrimary: true } });

  const balance = async (accountId: string): Promise<number> =>
    Number((await db.treasuryEntry.aggregate({ where: { accountId }, _sum: { amount: true } }))._sum.amount ?? 0);

  const safe = async (currency: string) => balance((await account('CASH_SAFE', currency)).id);

  const status = async (id: string) =>
    (await db.citizenPayment.findUniqueOrThrow({ where: { id }, select: { paymentStatus: true } })).paymentStatus;

  /** Everything a refused settlement must have left untouched. */
  const snapshot = async () => ({
    settlements: await db.paymentSettlement.count(),
    transactions: await db.paymentTransaction.count(),
    entries: await db.treasuryEntry.count(),
    audits: await db.auditLogEntry.count(),
  });

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
    treasury = new TreasuryService(context, ledger, auditService);
    settlements = new PaymentSettlementService(context, new EventEmitter2(), payments, auditService);

    citizenId = randomUUID();
    otherCitizenId = randomUUID();
    accountantId = randomUUID();
    collectorId = randomUUID();
    await db.user.createMany({
      data: [
        {
          id: citizenId, kind: 'CITIZEN', tenantSlug: 'settlement', firstName: 'غسان', middleName: 'محمد',
          lastName: 'جواد', phone: '+96170123456', referenceNumber: 'SET-2610-ABC123',
        },
        { id: otherCitizenId, kind: 'CITIZEN', tenantSlug: 'settlement', firstName: 'ليلى', lastName: 'حداد' },
        {
          id: accountantId, kind: 'STAFF', tenantSlug: 'settlement', email: `a-${accountantId}@t.gov.lb`,
          firstName: 'سارة', lastName: 'المحاسبة', role: 'ACCOUNTANT',
        },
        {
          id: collectorId, kind: 'STAFF', tenantSlug: 'settlement', email: `c-${collectorId}@t.gov.lb`,
          firstName: 'حسن', lastName: 'الجابي', role: 'COLLECTOR',
        },
      ],
    });
    await db.systemSettings.upsert({
      where: { singleton: true },
      create: { exchangeRate: RATE, secondaryCurrency: 'USD' },
      update: { exchangeRate: RATE, secondaryCurrency: 'USD' },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  // ───────────────────────────────  the schema  ───────────────────────────────

  describe('the schema (migration 0085)', () => {
    it('is idempotent: running the file again changes nothing', async () => {
      const sql = readFileSync(MIGRATION_SQL, 'utf8');
      await ddl.query(`SET search_path TO "${SCHEMA}"`);
      await ddl.query(sql);
      await ddl.query(sql);
      await ddl.query('RESET search_path');
      const { rows } = await ddl.query(
        `SELECT count(*)::int AS n FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = 'payment_settlements' AND NOT tg.tgisinternal`,
        [SCHEMA],
      );
      expect(rows[0].n).toBe(2);
    });

    it('refuses a cash settlement without its notes, and notes on any other method', async () => {
      const base = { number: `X-${randomUUID()}`, citizenId, clientRequestId: randomUUID() };
      await expect(db.paymentSettlement.create({ data: { ...base, method: 'CASH' } })).rejects.toThrow(
        /payment_settlements_tender_is_cash/,
      );
      await expect(
        db.paymentSettlement.create({
          data: { ...base, method: 'WHISH_MONEY', externalRef: 'WH-1', tenderedLocal: 1, tenderedForeign: 0, changeGiven: 0 },
        }),
      ).rejects.toThrow(/payment_settlements_tender_is_cash/);
      await expect(db.paymentSettlement.create({ data: { ...base, method: 'COLLECTOR' } })).rejects.toThrow(
        /payment_settlements_collector_named/,
      );
    });

    it('refuses an update and a delete of a settlement', async () => {
      const paymentId = await bill(10_000);
      const receipt = await settle({ paymentIds: [paymentId], method: 'CASH', tendered: { local: 10_000, foreign: 0, foreignCurrency: 'USD' } });
      await expect(
        ddl.query(`UPDATE "${SCHEMA}"."payment_settlements" SET "number" = 'X' WHERE "id" = $1`, [receipt.id]),
      ).rejects.toThrow(/append-only/);
      await expect(
        ddl.query(`DELETE FROM "${SCHEMA}"."payment_settlements" WHERE "id" = $1`, [receipt.id]),
      ).rejects.toThrow(/append-only/);
    });
  });

  // ─────────────────────────  before the treasury is live  ───────────────────────

  describe('before go-live', () => {
    it('settles every bill, oldest first, on consecutive receipts, and moves no wallet', async () => {
      const older = await bill(300_000);
      const newer = await bill(200_000);
      const receipt = await settle({
        paymentIds: [newer, older],
        method: 'CASH',
        tendered: { local: 500_000, foreign: 0, foreignCurrency: 'USD' },
      });

      expect(receipt.number).toMatch(/^BRC-\d{4}-\d{4}$/);
      expect(receipt.replayed).toBe(false);
      expect(receipt.items.map((item) => item.paymentId)).toEqual([older, newer]);
      const [first, second] = receipt.items.map((item) => Number(item.receiptNumber.slice(-4)));
      expect(second).toBe(first! + 1);
      expect(receipt.totals).toEqual({ LBP: 500_000 });
      expect(receipt.tender).toMatchObject({ local: 500_000, foreign: 0, changeGiven: 0, localCurrency: 'LBP' });
      expect(await status(older)).toBe('PAID');
      expect(await status(newer)).toBe('PAID');

      const rows = await db.paymentTransaction.findMany({ where: { paymentId: { in: [older, newer] } } });
      expect(rows.every((row) => row.settlementId === receipt.id)).toBe(true);
      expect(await db.treasuryEntry.count({ where: { source: 'CITIZEN_PAYMENT' } })).toBe(0);
    });

    it('writes one audit row per bill and one for the set — by id, never naming anyone', async () => {
      const a = await bill(50_000);
      const b = await bill(70_000);
      const receipt = await settle({ paymentIds: [a, b], method: 'CASH', tendered: { local: 120_000, foreign: 0, foreignCurrency: 'USD' } });

      const perBill = await db.auditLogEntry.findMany({ where: { action: 'PAYMENT_CONFIRMED', entityId: { in: [a, b] } } });
      expect(perBill).toHaveLength(2);
      const group = await db.auditLogEntry.findFirstOrThrow({
        where: { action: 'PAYMENT_BULK_SETTLED', entityId: receipt.id },
      });
      expect(group.entityType).toBe('PaymentSettlement');
      const text = JSON.stringify([group, ...perBill]);
      expect(text).not.toContain('غسان');
      expect(text).not.toContain('SET-2610-ABC123');
      expect(text).toContain(receipt.number);
    });

    it('reads back a receipt that carries no رقم مرجعي, and the father\'s name on its own line', async () => {
      const a = await bill(40_000);
      const receipt = await settle({ paymentIds: [a], method: 'CASH', tendered: { local: 40_000, foreign: 0, foreignCurrency: 'USD' } });
      const again = await scoped(() => settlements.get(receipt.id));
      // The exact key set, so a field added later fails here rather than in a browser.
      expect(Object.keys(again.citizen).sort()).toEqual(['fatherName', 'fullName', 'id', 'phone', 'whatsapp']);
      expect(again.citizen).toMatchObject({ fullName: 'غسان جواد', fatherName: 'محمد' });
      expect(JSON.stringify(again)).not.toContain('SET-2610-ABC123');
      expect(again.items[0]!.properties).toEqual([{ propertyNumber: '512', unitType: 'APARTMENT', unitCode: 'B-1' }]);
    });
  });

  // ──────────────────────────────  refusals  ───────────────────────────────

  describe('refusals write nothing', () => {
    it('a bill of another citizen', async () => {
      const mine = await bill(10_000);
      const theirs = await bill(10_000, 'LBP', otherCitizenId);
      const before = await snapshot();
      await expect(
        settle({ paymentIds: [mine, theirs], method: 'CASH', tendered: { local: 20_000, foreign: 0, foreignCurrency: 'USD' } }),
      ).rejects.toMatchObject({ code: 'BULK_SETTLE_CITIZEN_MISMATCH' });
      expect(await snapshot()).toEqual(before);
      expect(await status(mine)).toBe('UNPAID');
    });

    it('a bill settled on its own after it was ticked, named in the refusal', async () => {
      const a = await bill(10_000);
      const b = await bill(20_000);
      await scoped(() => payments.record({ audit, paymentId: b, amount: 20_000, method: 'CASH', recordedById: accountantId }));
      const before = await snapshot();
      await expect(
        settle({ paymentIds: [a, b], method: 'CASH', tendered: { local: 30_000, foreign: 0, foreignCurrency: 'USD' } }),
      ).rejects.toMatchObject({ code: 'BULK_SETTLE_SOME_ALREADY_PAID', params: { invoice: expect.any(String) } });
      expect(await snapshot()).toEqual(before);
      expect(await status(a)).toBe('UNPAID');
    });

    it('notes that do not cover every bill', async () => {
      const a = await bill(100_000);
      const b = await bill(100_000);
      const before = await snapshot();
      await expect(
        settle({ paymentIds: [a, b], method: 'CASH', tendered: { local: 150_000, foreign: 0, foreignCurrency: 'USD' } }),
      ).rejects.toMatchObject({ code: 'BULK_SETTLE_TENDER_SHORT', params: { shortBy: 50_000, currency: 'LBP' } });
      expect(await snapshot()).toEqual(before);
    });

    it('a bill that does not exist', async () => {
      const a = await bill(10_000);
      await expect(
        settle({ paymentIds: [a, randomUUID()], method: 'CASH', tendered: { local: 10_000, foreign: 0, foreignCurrency: 'USD' } }),
      ).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND' });
      expect(await status(a)).toBe('UNPAID');
    });
  });

  // ─────────────────────────────  retries and races  ───────────────────────────

  describe('the retry key', () => {
    it('answers a retry with the first settlement and moves nothing twice', async () => {
      const a = await bill(10_000);
      const b = await bill(15_000);
      const key = randomUUID();
      const input = {
        clientRequestId: key,
        paymentIds: [a, b],
        method: 'CASH' as const,
        tendered: { local: 25_000, foreign: 0, foreignCurrency: 'USD' as const },
      };
      const first = await settle(input);
      const before = await snapshot();
      const second = await settle(input);
      expect(second.replayed).toBe(true);
      expect(second.number).toBe(first.number);
      expect(await snapshot()).toEqual(before);
    });

    it('refuses a key that settled other bills', async () => {
      const a = await bill(10_000);
      const b = await bill(10_000);
      const key = randomUUID();
      await settle({ clientRequestId: key, paymentIds: [a], method: 'CASH', tendered: { local: 10_000, foreign: 0, foreignCurrency: 'USD' } });
      await expect(
        settle({ clientRequestId: key, paymentIds: [b], method: 'CASH', tendered: { local: 10_000, foreign: 0, foreignCurrency: 'USD' } }),
      ).rejects.toMatchObject({ code: 'BULK_SETTLE_REQUEST_REUSED' });
      expect(await status(b)).toBe('UNPAID');
    });

    it('settles once when two identical presses arrive together', async () => {
      const a = await bill(10_000);
      const b = await bill(10_000);
      const input = {
        clientRequestId: randomUUID(),
        paymentIds: [a, b],
        method: 'CASH' as const,
        tendered: { local: 20_000, foreign: 0, foreignCurrency: 'USD' as const },
      };
      const results = await Promise.all([settle(input), settle(input)]);
      expect(new Set(results.map((r) => r.number)).size).toBe(1);
      expect(results.filter((r) => r.replayed)).toHaveLength(1);
      expect(await db.paymentTransaction.count({ where: { paymentId: { in: [a, b] } } })).toBe(2);
    });

    it('settles overlapping sets once, with no deadlock, when two clerks press together', async () => {
      const a = await bill(10_000);
      const b = await bill(10_000);
      const c = await bill(10_000);
      const results = await Promise.allSettled([
        settle({ paymentIds: [a, b], method: 'CASH', tendered: { local: 20_000, foreign: 0, foreignCurrency: 'USD' } }),
        settle({ paymentIds: [c, b], method: 'CASH', tendered: { local: 20_000, foreign: 0, foreignCurrency: 'USD' } }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({ code: 'BULK_SETTLE_SOME_ALREADY_PAID' });
      expect(await db.paymentTransaction.count({ where: { paymentId: b } })).toBe(1);
    });
  });

  // ──────────────────────────────  the treasury live  ───────────────────────────

  describe('with the treasury live', () => {
    beforeAll(async () => {
      const balances = (await db.treasuryAccount.findMany({ where: { type: { not: 'COLLECTOR_CUSTODY' } } })).map(
        (a) => ({
          accountId: a.id,
          amount: a.type === 'CASH_SAFE' ? (a.currency === 'LBP' ? 1_000_000 : 100) : 0,
        }),
      );
      await scoped(() => treasury.activate({ balances }, { id: accountantId, role: 'SUPER_ADMIN' }));
    });

    it('puts the notes in their wallets and takes the change out of the ليرة safe', async () => {
      const lbpOld = await bill(1_000_000);
      const usd = await bill(40, 'USD');
      const lbpNew = await bill(500_000);
      const lbpBefore = await safe('LBP');
      const usdBefore = await safe('USD');

      const receipt = await settle({
        paymentIds: [lbpOld, usd, lbpNew],
        method: 'CASH',
        tendered: { local: 1_200_000, foreign: 50, foreignCurrency: 'USD' },
      });

      // $10 spare is 895,000 ل.ل: 1,200,000 + 895,000 − 1,500,000 = 595,000 back.
      expect(receipt.tender).toMatchObject({ local: 1_200_000, foreign: 50, foreignCurrency: 'USD', exchangeRate: RATE, changeGiven: 595_000 });
      expect(receipt.totals).toEqual({ LBP: 1_500_000, USD: 40 });
      expect(await safe('LBP')).toBe(lbpBefore + 1_200_000 - 595_000);
      expect(await safe('USD')).toBe(usdBefore + 50);
      for (const id of [lbpOld, usd, lbpNew]) expect(await status(id)).toBe('PAID');
    });

    it('keeps both bills whole when one $20 note pays two ليرة bills exactly', async () => {
      const a = await bill(900_000);
      const b = await bill(890_000);
      const lbpBefore = await safe('LBP');
      const usdBefore = await safe('USD');
      const receipt = await settle({ paymentIds: [a, b], method: 'CASH', tendered: { local: 0, foreign: 20, foreignCurrency: 'USD' } });
      expect(receipt.tender?.changeGiven).toBe(0);
      expect(await status(a)).toBe('PAID');
      expect(await status(b)).toBe('PAID');
      expect(await safe('LBP')).toBe(lbpBefore);
      expect(await safe('USD')).toBe(usdBefore + 20);
    });

    it('refuses the whole set when the safe cannot hand back the change, and writes nothing', async () => {
      const lbp = await account('CASH_SAFE', 'LBP');
      const held = await safe('LBP');
      // Empty the ليرة safe the way an expense would.
      await scoped(() =>
        db.$transaction((tx) =>
          ledger.post(tx, [{ accountId: lbp.id, currency: 'LBP', amount: new Prisma.Decimal(-held) }], {
            source: 'EXPENSE_VOUCHER',
            sourceId: null,
            actorId: accountantId,
            occurredAt: new Date(),
          }),
        ),
      );
      const a = await bill(100_000);
      const b = await bill(100_000);
      const before = await snapshot();
      // $10 for 200,000 ل.ل is 695,000 back, from a safe holding nothing.
      await expect(
        settle({ paymentIds: [a, b], method: 'CASH', tendered: { local: 0, foreign: 10, foreignCurrency: 'USD' } }),
      ).rejects.toMatchObject({ code: 'TREASURY_INSUFFICIENT_FUNDS' });
      expect(await snapshot()).toEqual(before);
      expect(await status(a)).toBe('UNPAID');
      expect(await status(b)).toBe('UNPAID');

      // Put it back for the tests after this one.
      await scoped(() =>
        db.$transaction((tx) =>
          ledger.post(tx, [{ accountId: lbp.id, currency: 'LBP', amount: new Prisma.Decimal(held) }], {
            source: 'ADJUSTMENT',
            sourceId: null,
            actorId: accountantId,
            occurredAt: new Date(),
          }),
        ),
      );
    });

    it("credits the collector's custody, per currency, and never the safe", async () => {
      const a = await bill(300_000);
      const b = await bill(25, 'USD');
      const lbpBefore = await safe('LBP');
      const receipt = await settle({ paymentIds: [a, b], method: 'COLLECTOR', collectedById: collectorId });
      expect(receipt.collectorName).toBe('حسن الجابي');
      expect(receipt.tender).toBeNull();
      const custody = await db.treasuryAccount.findMany({ where: { ownerId: collectorId } });
      const byCurrency = Object.fromEntries(await Promise.all(custody.map(async (c) => [c.currency, await balance(c.id)])));
      expect(byCurrency).toMatchObject({ LBP: 300_000, USD: 25 });
      expect(await safe('LBP')).toBe(lbpBefore);
    });

    it('credits the Whish account and keeps the transfer number on every row', async () => {
      const a = await bill(80_000);
      const b = await bill(20_000);
      const whish = await account('WHISH_ACCOUNT', 'LBP');
      const before = await balance(whish.id);
      const receipt = await settle({ paymentIds: [a, b], method: 'WHISH_MONEY', whishTransactionRef: 'WH-778899' });
      expect(receipt.externalRef).toBe('WH-778899');
      expect(await balance(whish.id)).toBe(before + 100_000);
      const rows = await db.paymentTransaction.findMany({ where: { settlementId: receipt.id } });
      expect(rows.map((row) => row.externalRef)).toEqual(['WH-778899', 'WH-778899']);
    });

    it('reverses one bill of a settlement on its own, and the receipt shows it', async () => {
      const a = await bill(60_000);
      const b = await bill(40_000);
      const key = randomUUID();
      const input = {
        clientRequestId: key,
        paymentIds: [a, b],
        method: 'CASH' as const,
        tendered: { local: 100_000, foreign: 0, foreignCurrency: 'USD' as const },
      };
      const receipt = await settle(input);
      const lbpBefore = await safe('LBP');
      const target = receipt.items.find((item) => item.paymentId === b)!;
      await scoped(() =>
        payments.reverse({ transactionId: target.transactionId, recordedById: accountantId, note: 'خطأ', audit }),
      );
      expect(await status(b)).toBe('UNPAID');
      expect(await status(a)).toBe('PAID');
      expect(await safe('LBP')).toBe(lbpBefore - 40_000);

      const again = await scoped(() => settlements.get(receipt.id));
      expect(again.items.find((item) => item.paymentId === b)?.reversed).toBe(true);
      // A retry now would hand over a receipt the ledger has partly cancelled.
      await expect(settle(input)).rejects.toMatchObject({ code: 'TRANSACTION_ALREADY_REVERSED' });
    });
  });
});

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient, Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { PaymentLedgerService, type LedgerAudit } from '../fees/payment-ledger.service';
import { TreasuryLedgerService } from './treasury-ledger.service';
import { TreasuryService } from './treasury.service';

/**
 * The treasury, against a real Postgres.
 *
 * What cannot be tested any other way: the append-only triggers and the
 * (accountId, currency) foreign key live in the schema; the row locks that stop
 * a wallet going below zero only exist in the database; and "the payment and
 * the money it moved commit together" is a claim about one transaction.
 *
 * The file is ordered on purpose. The treasury goes live exactly once per
 * schema, so the tests that need it NOT live run first, then it is activated
 * (itself under test), then everything that needs a live treasury.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_treasury_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const MIGRATION_SQL = join(
  __dirname,
  '../../../infrastructure/prisma/tenant/migrations/0073_treasury_ledger/migration.sql',
);

describeIfDb('Treasury', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let payments: PaymentLedgerService;
  let ledger: TreasuryLedgerService;
  let treasury: TreasuryService;

  let citizenId: string;
  let managerId: string;
  let collectorId: string;
  let otherCollectorId: string;

  /** Runs a call the way a request would: inside the tenant scope. */
  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'treasury', schemaName: SCHEMA, prisma: db }, work);

  const audit: LedgerAudit = (movement) => ({
    actorId: managerId,
    actorType: 'STAFF',
    action: 'PAYMENT_CONFIRMED',
    entityType: 'Payment',
    after: { receiptNumber: movement.receiptNumber },
  });

  /** A fresh invoice, so no test depends on another's balance. */
  const invoice = async (amount: number, currency = 'LBP') =>
    (
      await db.citizenPayment.create({
        data: {
          citizenId,
          title: 'رسم',
          amount,
          currency,
          dueDate: new Date('2026-12-31T00:00:00.000Z'),
          createdAt: new Date('2026-01-01T08:00:00.000Z'),
        },
        select: { id: true },
      })
    ).id;

  const account = (type: string, currency: string) =>
    db.treasuryAccount.findFirstOrThrow({ where: { type: type as never, currency, isPrimary: true } });

  const balance = async (accountId: string): Promise<number> =>
    Number(
      (await db.treasuryEntry.aggregate({ where: { accountId }, _sum: { amount: true } }))._sum.amount ?? 0,
    );

  const safeBalance = async (currency: string) => balance((await account('CASH_SAFE', currency)).id);

  /** Money leaves a wallet the way an expense will: a direct posting. */
  const spend = (accountId: string, currency: string, amount: number) =>
    scoped(() =>
      db.$transaction((tx) =>
        ledger.post(
          tx,
          [{ accountId, currency, amount: new Prisma.Decimal(-amount) }],
          { source: 'EXPENSE_VOUCHER', sourceId: null, actorId: managerId, occurredAt: new Date() },
        ),
      ),
    );

  const pay = (paymentId: string, amount: number, extra: Partial<Parameters<PaymentLedgerService['record']>[0]> = {}) =>
    scoped(() =>
      payments.record({ audit, paymentId, amount, method: 'CASH', recordedById: managerId, ...extra }),
    );

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const auditService = new AuditService(
      new PrismaAuditRepository(context),
      context,
      {} as never,
      {} as never,
    );
    ledger = new TreasuryLedgerService(context);
    payments = new PaymentLedgerService(context, auditService, ledger);
    treasury = new TreasuryService(context, ledger, auditService);

    citizenId = randomUUID();
    managerId = randomUUID();
    collectorId = randomUUID();
    otherCollectorId = randomUUID();
    await db.user.createMany({
      data: [
        { id: citizenId, kind: 'CITIZEN', tenantSlug: 'treasury', firstName: 'علي', lastName: 'خليل' },
        {
          id: managerId, kind: 'STAFF', tenantSlug: 'treasury', email: `m-${managerId}@t.gov.lb`,
          firstName: 'المدير', lastName: 'العام', role: 'SUPER_ADMIN',
        },
        {
          id: collectorId, kind: 'STAFF', tenantSlug: 'treasury', email: `c-${collectorId}@t.gov.lb`,
          firstName: 'حسن', lastName: 'الجابي', role: 'COLLECTOR',
        },
        {
          id: otherCollectorId, kind: 'STAFF', tenantSlug: 'treasury', email: `d-${otherCollectorId}@t.gov.lb`,
          firstName: 'سامر', lastName: 'الجابي', role: 'COLLECTOR',
        },
      ],
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  // ───────────────────────────────  the schema  ───────────────────────────────

  describe('the schema (migration 0073)', () => {
    it('seeds the four everyday wallets as primary accounts', async () => {
      const accounts = await db.treasuryAccount.findMany({ orderBy: [{ type: 'asc' }, { currency: 'asc' }] });
      expect(accounts.map((a) => `${a.type}/${a.currency}/${a.isPrimary}`)).toEqual([
        'CASH_SAFE/LBP/true',
        'CASH_SAFE/USD/true',
        'WHISH_ACCOUNT/LBP/true',
        'WHISH_ACCOUNT/USD/true',
      ]);
    });

    it('is idempotent: running the file again changes nothing', async () => {
      const sql = readFileSync(MIGRATION_SQL, 'utf8');
      await ddl.query(`SET search_path TO "${SCHEMA}"`);
      await ddl.query(sql);
      await ddl.query(sql);
      await ddl.query('RESET search_path');
      expect(await db.treasuryAccount.count()).toBe(4);
    });

    it('refuses an update and a delete of an entry', async () => {
      const lbp = await account('CASH_SAFE', 'LBP');
      const entry = await db.treasuryEntry.create({
        data: { accountId: lbp.id, currency: 'LBP', amount: 1, source: 'ADJUSTMENT' },
      });
      // Net the row back to zero with an opposing entry, so no later test sees it.
      await db.treasuryEntry.create({
        data: { accountId: lbp.id, currency: 'LBP', amount: -1, source: 'ADJUSTMENT', reversalOfId: entry.id },
      });

      await expect(
        ddl.query(`UPDATE "${SCHEMA}"."treasury_entries" SET "amount" = 2 WHERE "id" = $1`, [entry.id]),
      ).rejects.toThrow(/append-only/);
      await expect(
        ddl.query(`DELETE FROM "${SCHEMA}"."treasury_entries" WHERE "id" = $1`, [entry.id]),
      ).rejects.toThrow(/append-only/);
    });

    it("refuses an entry in a currency other than its account's", async () => {
      const lbp = await account('CASH_SAFE', 'LBP');
      await expect(
        db.treasuryEntry.create({
          data: { accountId: lbp.id, currency: 'USD', amount: 10, source: 'ADJUSTMENT' },
        }),
      ).rejects.toThrow();
    });

    it('refuses a zero entry', async () => {
      const lbp = await account('CASH_SAFE', 'LBP');
      await expect(
        db.treasuryEntry.create({
          data: { accountId: lbp.id, currency: 'LBP', amount: 0, source: 'ADJUSTMENT' },
        }),
      ).rejects.toThrow();
    });

    it('lets an entry be reversed once and never twice', async () => {
      const lbp = await account('CASH_SAFE', 'LBP');
      const original = await db.treasuryEntry.create({
        data: { accountId: lbp.id, currency: 'LBP', amount: 5, source: 'ADJUSTMENT' },
      });
      await db.treasuryEntry.create({
        data: { accountId: lbp.id, currency: 'LBP', amount: -5, source: 'ADJUSTMENT', reversalOfId: original.id },
      });
      await expect(
        db.treasuryEntry.create({
          data: { accountId: lbp.id, currency: 'LBP', amount: -5, source: 'ADJUSTMENT', reversalOfId: original.id },
        }),
      ).rejects.toThrow();
    });

    it('allows one primary account per type and currency, and one custody account per collector and currency', async () => {
      await expect(
        db.treasuryAccount.create({
          data: { name: 'مكرر', type: 'CASH_SAFE', currency: 'LBP', isPrimary: true },
        }),
      ).rejects.toThrow();
      await expect(
        db.treasuryAccount.create({
          data: { name: 'عهدة بلا جابٍ', type: 'COLLECTOR_CUSTODY', currency: 'LBP' },
        }),
      ).rejects.toThrow();
      await expect(
        db.treasuryAccount.create({
          data: { name: 'صندوق بجابٍ', type: 'CASH_SAFE', currency: 'LBP', ownerId: collectorId },
        }),
      ).rejects.toThrow();
    });
  });

  // ─────────────────────  before the treasury goes live  ─────────────────────

  describe('before activation', () => {
    it('reports the treasury as not active', async () => {
      const overview = await scoped(() => treasury.overview());
      expect(overview.active).toBe(false);
      expect(overview.goLiveAt).toBeNull();
      expect(overview.accounts).toHaveLength(4);
    });

    it('credits no wallet for a payment', async () => {
      const paymentId = await invoice(100_000);
      await pay(paymentId, 100_000);
      expect(await db.treasuryEntry.count({ where: { source: 'CITIZEN_PAYMENT' } })).toBe(0);
    });
  });

  // ──────────────────────────────  activation  ───────────────────────────────

  describe('activation', () => {
    const all = async (amounts: Record<string, number>) =>
      (await db.treasuryAccount.findMany({ where: { type: { not: 'COLLECTOR_CUSTODY' } } })).map((a) => ({
        accountId: a.id,
        amount: amounts[`${a.type}/${a.currency}`] ?? 0,
      }));

    it('refuses balances that leave a wallet out', async () => {
      const lbp = await account('CASH_SAFE', 'LBP');
      await expect(
        scoped(() =>
          treasury.activate({ balances: [{ accountId: lbp.id, amount: 100 }] }, { id: managerId, role: 'SUPER_ADMIN' }),
        ),
      ).rejects.toMatchObject({ code: 'TREASURY_OPENING_BALANCES_INCOMPLETE' });
      expect((await scoped(() => treasury.overview())).active).toBe(false);
    });

    it('refuses a wallet that does not exist', async () => {
      const balances = await all({});
      balances.push({ accountId: randomUUID(), amount: 1 });
      await expect(
        scoped(() => treasury.activate({ balances }, { id: managerId, role: 'SUPER_ADMIN' })),
      ).rejects.toMatchObject({ code: 'TREASURY_OPENING_BALANCES_INCOMPLETE' });
    });

    it('goes live exactly once when two administrators press the button together', async () => {
      const balances = await all({ 'CASH_SAFE/LBP': 5_000_000, 'CASH_SAFE/USD': 1_000 });
      const results = await Promise.allSettled([
        scoped(() => treasury.activate({ balances, note: 'جرد' }, { id: managerId, role: 'SUPER_ADMIN' })),
        scoped(() => treasury.activate({ balances, note: 'جرد' }, { id: managerId, role: 'SUPER_ADMIN' })),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({ code: 'TREASURY_ALREADY_ACTIVE' });

      // Posted once: the two zero wallets wrote nothing, the two counted ones one entry each.
      expect(await db.treasuryEntry.count({ where: { source: 'OPENING_BALANCE' } })).toBe(2);
      expect(await safeBalance('LBP')).toBe(5_000_000);
      expect(await safeBalance('USD')).toBe(1_000);
    });

    it('stamps the go-live moment and audits it', async () => {
      const overview = await scoped(() => treasury.overview());
      expect(overview.active).toBe(true);
      expect(overview.goLiveAt).not.toBeNull();

      const rows = await db.auditLogEntry.findMany({ where: { action: 'TREASURY_ACTIVATED' } });
      expect(rows).toHaveLength(1);
    });

    it('cannot be activated again', async () => {
      const balances = await all({});
      await expect(
        scoped(() => treasury.activate({ balances }, { id: managerId, role: 'SUPER_ADMIN' })),
      ).rejects.toMatchObject({ code: 'TREASURY_ALREADY_ACTIVE' });
    });
  });

  // ─────────────────────  citizen payments, treasury live  ─────────────────────

  describe('a citizen payment credits the wallets, in the same transaction', () => {
    it('counter cash goes to the safe of the invoice currency', async () => {
      const before = await safeBalance('LBP');
      const paymentId = await invoice(100_000);
      const settled = await pay(paymentId, 100_000);

      expect(await safeBalance('LBP')).toBe(before + 100_000);
      const entries = await db.treasuryEntry.findMany({ where: { source: 'CITIZEN_PAYMENT', sourceId: settled.transactionId } });
      expect(entries).toHaveLength(1);
      expect(entries[0].actorId).toBe(managerId);
    });

    it('stamps the rate of the day on the entry', async () => {
      await db.systemSettings.upsert({
        where: { singleton: true },
        create: { exchangeRate: 89_500 },
        update: { exchangeRate: 89_500 },
      });
      const paymentId = await invoice(10_000);
      const settled = await pay(paymentId, 10_000);
      const entry = await db.treasuryEntry.findFirstOrThrow({ where: { sourceId: settled.transactionId } });
      expect(Number(entry.exchangeRateAtPosting)).toBe(89_500);
    });

    it('a $20 note against a 1,500,000 ل.ل bill: +$20, and the change out of the ليرة safe', async () => {
      const lbpBefore = await safeBalance('LBP');
      const usdBefore = await safeBalance('USD');
      const paymentId = await invoice(1_500_000);

      const settled = await pay(paymentId, 1_790_000, {
        tendered: { local: 0, foreign: 20, foreignCurrency: 'USD', exchangeRate: 89_500, officialExchangeRate: 89_500 },
      });

      expect(settled.changeGiven).toBe(290_000);
      expect(await safeBalance('USD')).toBe(usdBefore + 20);
      expect(await safeBalance('LBP')).toBe(lbpBefore - 290_000);
    });

    it('a confirmed Whish payment goes to the Whish account, in the invoice currency', async () => {
      const whishUsd = await account('WHISH_ACCOUNT', 'USD');
      const before = await balance(whishUsd.id);
      const paymentId = await invoice(50, 'USD');
      await pay(paymentId, 50, { method: 'WHISH_MONEY', externalRef: 'WHISH-1' });
      expect(await balance(whishUsd.id)).toBe(before + 50);
    });

    it("a collector's cash goes to his custody and never touches the safe", async () => {
      const safeBefore = await safeBalance('LBP');
      const paymentId = await invoice(300_000);
      await pay(paymentId, 300_000, { method: 'COLLECTOR', collectedById: collectorId });

      expect(await safeBalance('LBP')).toBe(safeBefore);
      const custody = await db.treasuryAccount.findFirstOrThrow({
        where: { type: 'COLLECTOR_CUSTODY', ownerId: collectorId, currency: 'LBP' },
      });
      expect(await balance(custody.id)).toBe(300_000);
      expect(custody.isPrimary).toBe(false);
    });

    it('reuses the same custody account on his next collection, and keeps a separate one per currency', async () => {
      await pay(await invoice(100_000), 100_000, { method: 'COLLECTOR', collectedById: collectorId });
      await pay(await invoice(20, 'USD'), 20, { method: 'COLLECTOR', collectedById: collectorId });

      const accounts = await db.treasuryAccount.findMany({ where: { ownerId: collectorId } });
      expect(accounts.map((a) => a.currency).sort()).toEqual(['LBP', 'USD']);
      const lbp = accounts.find((a) => a.currency === 'LBP')!;
      expect(await balance(lbp.id)).toBe(400_000);
    });

    it("two first collections racing each other create one custody account, not two", async () => {
      const [a, b] = await Promise.all([invoice(10_000), invoice(20_000)]);
      await Promise.all([
        pay(a, 10_000, { method: 'COLLECTOR', collectedById: otherCollectorId }),
        pay(b, 20_000, { method: 'COLLECTOR', collectedById: otherCollectorId }),
      ]);

      const accounts = await db.treasuryAccount.findMany({ where: { ownerId: otherCollectorId } });
      expect(accounts).toHaveLength(1);
      expect(await balance(accounts[0].id)).toBe(30_000);
    });

    it('shows what collectors hold beside the safe, never counted into it', async () => {
      const overview = await scoped(() => treasury.overview());
      const held = overview.heldByCollectors.find((h) => h.currency === 'LBP');
      expect(held?.amount).toBe(430_000);
      expect(overview.accounts.every((a) => a.type !== 'COLLECTOR_CUSTODY')).toBe(true);
    });

    it('credits nothing for a payment dated before go-live', async () => {
      const before = await safeBalance('LBP');
      const paymentId = await invoice(77_000);
      const settled = await pay(paymentId, 77_000, { occurredAt: new Date('2026-02-01T12:00:00.000Z') });

      expect(await safeBalance('LBP')).toBe(before);
      expect(await db.treasuryEntry.count({ where: { sourceId: settled.transactionId } })).toBe(0);
    });

    it('answers a retry from the first movement and credits the wallet once', async () => {
      const before = await safeBalance('LBP');
      const paymentId = await invoice(40_000);
      const clientRequestId = randomUUID();
      await pay(paymentId, 40_000, { clientRequestId });
      const again = await pay(paymentId, 40_000, { clientRequestId });

      expect(again.replayed).toBe(true);
      expect(await safeBalance('LBP')).toBe(before + 40_000);
    });

    it('takes no payment when a wallet entry is refused, and no wallet entry when the payment fails', async () => {
      const paymentId = await invoice(25_000);
      // Drain the ليرة safe so the change this payment must hand back cannot come out of it.
      const lbp = await account('CASH_SAFE', 'LBP');
      const have = await balance(lbp.id);
      await spend(lbp.id, 'LBP', have);

      const txBefore = await db.paymentTransaction.count({ where: { paymentId } });
      await expect(
        pay(paymentId, 895_000, {
          tendered: { local: 0, foreign: 10, foreignCurrency: 'USD', exchangeRate: 89_500, officialExchangeRate: 89_500 },
        }),
      ).rejects.toMatchObject({ code: 'TREASURY_INSUFFICIENT_FUNDS' });

      expect(await db.paymentTransaction.count({ where: { paymentId } })).toBe(txBefore);
      expect(Number((await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } })).paidAmount)).toBe(0);

      // Put the cash back for the tests that follow.
      await scoped(() =>
        db.$transaction((tx) =>
          ledger.post(
            tx,
            [{ accountId: lbp.id, currency: 'LBP', amount: new Prisma.Decimal(have) }],
            { source: 'ADJUSTMENT', sourceId: null, actorId: managerId, occurredAt: new Date() },
          ),
        ),
      );
    });
  });

  // ────────────────────────────────  reversals  ────────────────────────────────

  describe('reversing a payment', () => {
    const reverse = (transactionId: string) =>
      scoped(() =>
        payments.reverse({
          transactionId,
          recordedById: managerId,
          audit: (movement) => ({
            actorId: managerId,
            actorType: 'STAFF',
            action: 'PAYMENT_REVERSED',
            entityType: 'PaymentTransaction',
            entityId: movement.transactionId,
          }),
        }),
      );

    it('opposes the entries of the original exactly', async () => {
      const before = await safeBalance('LBP');
      const settled = await pay(await invoice(60_000), 60_000);
      expect(await safeBalance('LBP')).toBe(before + 60_000);

      const reversal = await reverse(settled.transactionId);

      expect(await safeBalance('LBP')).toBe(before);
      const original = await db.treasuryEntry.findFirstOrThrow({ where: { sourceId: settled.transactionId } });
      const opposing = await db.treasuryEntry.findFirstOrThrow({ where: { sourceId: reversal.transactionId } });
      expect(opposing.reversalOfId).toBe(original.id);
      expect(Number(opposing.amount)).toBe(-60_000);
    });

    it('opposes both legs of a tendered payment', async () => {
      const lbpBefore = await safeBalance('LBP');
      const usdBefore = await safeBalance('USD');
      const settled = await pay(await invoice(1_500_000), 1_790_000, {
        tendered: { local: 0, foreign: 20, foreignCurrency: 'USD', exchangeRate: 89_500, officialExchangeRate: 89_500 },
      });
      await reverse(settled.transactionId);

      expect(await safeBalance('LBP')).toBe(lbpBefore);
      expect(await safeBalance('USD')).toBe(usdBefore);
    });

    it('is refused, and changes nothing, when the drawer cannot cover the refund', async () => {
      const paymentId = await invoice(90_000);
      const settled = await pay(paymentId, 90_000);
      const lbp = await account('CASH_SAFE', 'LBP');
      await spend(lbp.id, 'LBP', await balance(lbp.id)); // the cash has been spent

      const before = await db.paymentTransaction.count({ where: { paymentId } });
      await expect(reverse(settled.transactionId)).rejects.toMatchObject({ code: 'TREASURY_INSUFFICIENT_FUNDS' });

      // The payment is untouched: still settled, no opposing row.
      expect(await db.paymentTransaction.count({ where: { paymentId } })).toBe(before);
      const invoiceRow = await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(invoiceRow.paymentStatus).toBe('PAID');

      await scoped(() =>
        db.$transaction((tx) =>
          ledger.post(
            tx,
            [{ accountId: lbp.id, currency: 'LBP', amount: new Prisma.Decimal(500_000) }],
            { source: 'ADJUSTMENT', sourceId: null, actorId: managerId, occurredAt: new Date() },
          ),
        ),
      );
    });

    it('takes a refund of a pre-go-live payment out of the drawer, because the cash leaves today', async () => {
      const paymentId = await invoice(80_000);
      const old = await pay(paymentId, 80_000, { occurredAt: new Date('2026-02-01T12:00:00.000Z') });
      expect(await db.treasuryEntry.count({ where: { sourceId: old.transactionId } })).toBe(0);

      const before = await safeBalance('LBP');
      const reversal = await reverse(old.transactionId);

      expect(await safeBalance('LBP')).toBe(before - 80_000);
      const entry = await db.treasuryEntry.findFirstOrThrow({ where: { sourceId: reversal.transactionId } });
      expect(entry.reversalOfId).toBeNull();
      expect(entry.note).toContain('سابقة');
    });

    it('refuses the refund of a pre-go-live payment the drawer cannot cover', async () => {
      const paymentId = await invoice(80_000);
      const old = await pay(paymentId, 80_000, { occurredAt: new Date('2026-02-01T12:00:00.000Z') });
      const lbp = await account('CASH_SAFE', 'LBP');
      const have = await balance(lbp.id);
      await spend(lbp.id, 'LBP', have);

      await expect(reverse(old.transactionId)).rejects.toMatchObject({ code: 'TREASURY_INSUFFICIENT_FUNDS' });

      await scoped(() =>
        db.$transaction((tx) =>
          ledger.post(
            tx,
            [{ accountId: lbp.id, currency: 'LBP', amount: new Prisma.Decimal(have) }],
            { source: 'ADJUSTMENT', sourceId: null, actorId: managerId, occurredAt: new Date() },
          ),
        ),
      );
    });
  });

  // ─────────────────────────  no wallet below zero  ─────────────────────────

  describe('no wallet goes below zero', () => {
    it('lets only one of two simultaneous outflows through when the money covers one', async () => {
      const whishLbp = await account('WHISH_ACCOUNT', 'LBP');
      await scoped(() =>
        db.$transaction((tx) =>
          ledger.post(
            tx,
            [{ accountId: whishLbp.id, currency: 'LBP', amount: new Prisma.Decimal(100_000) }],
            { source: 'ADJUSTMENT', sourceId: null, actorId: managerId, occurredAt: new Date() },
          ),
        ),
      );
      const start = await balance(whishLbp.id);

      const results = await Promise.allSettled([
        spend(whishLbp.id, 'LBP', start - 20_000),
        spend(whishLbp.id, 'LBP', start - 20_000),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
        code: 'TREASURY_INSUFFICIENT_FUNDS',
      });
      expect(await balance(whishLbp.id)).toBe(20_000);
    });

    it('refuses an outflow to a wallet that does not exist', async () => {
      await expect(spend(randomUUID(), 'LBP', 1)).rejects.toMatchObject({ code: 'TREASURY_ACCOUNT_NOT_FOUND' });
    });

    it('judges several entries on one wallet by their net: $20 in and $5 out is fine on an empty wallet', async () => {
      const whishUsd = await account('WHISH_ACCOUNT', 'USD');
      const before = await balance(whishUsd.id);
      await scoped(() =>
        db.$transaction((tx) =>
          ledger.post(
            tx,
            [
              { accountId: whishUsd.id, currency: 'USD', amount: new Prisma.Decimal(-5) },
              { accountId: whishUsd.id, currency: 'USD', amount: new Prisma.Decimal(20) },
            ],
            { source: 'ADJUSTMENT', sourceId: null, actorId: managerId, occurredAt: new Date() },
          ),
        ),
      );
      expect(await balance(whishUsd.id)).toBe(before + 15);
    });
  });

  // ──────────────────────────────  statement  ──────────────────────────────

  describe('the statement', () => {
    it('lists movements oldest first with the balance after each, and flags reversals', async () => {
      const usd = await account('CASH_SAFE', 'USD');
      const statement = await scoped(() => treasury.statement(usd.id, {}));

      expect(statement.account.id).toBe(usd.id);
      expect(statement.entries.length).toBeGreaterThan(0);
      expect(statement.entries[0].source).toBe('OPENING_BALANCE');
      expect(statement.entries[0].balanceAfter).toBe(1_000);
      expect(statement.entries.at(-1)!.balanceAfter).toBe(statement.account.balance);

      const reversed = statement.entries.filter((e) => e.reversed);
      const opposing = statement.entries.filter((e) => e.isReversal);
      expect(reversed.length).toBe(opposing.length);
    });

    it('is cut and flagged, never silently shortened', async () => {
      const lbp = await account('CASH_SAFE', 'LBP');
      const statement = await scoped(() => treasury.statement(lbp.id, { limit: 2 }));
      expect(statement.entries).toHaveLength(2);
      expect(statement.truncated).toBe(true);
    });

    it('opens from the balance before the range', async () => {
      const lbp = await account('CASH_SAFE', 'LBP');
      const full = await scoped(() => treasury.statement(lbp.id, { limit: 500 }));
      const cut = new Date(full.entries[1].occurredAt);
      const part = await scoped(() => treasury.statement(lbp.id, { from: cut, limit: 500 }));

      const before = full.entries.filter((e) => new Date(e.occurredAt) < cut).reduce((s, e) => s + e.amount, 0);
      expect(part.openingBalance).toBe(before);
      expect(part.entries.at(-1)!.balanceAfter).toBe(full.entries.at(-1)!.balanceAfter);
    });

    it('answers a missing account with a coded refusal', async () => {
      await expect(scoped(() => treasury.statement(randomUUID(), {}))).rejects.toMatchObject({
        code: 'TREASURY_ACCOUNT_NOT_FOUND',
      });
    });
  });
});

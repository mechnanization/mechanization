import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { ConflictError } from '../../common/exceptions';
import { PaymentLedgerService, type LedgerAudit } from './payment-ledger.service';
import { TreasuryLedgerService } from '../treasury/treasury-ledger.service';
import { AuditService } from '../audit/audit.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { municipalPeriod } from '@mechanization/shared-schemas';

/**
 * The payment ledger, against a real Postgres.
 *
 * Two of the things it must guarantee cannot be tested any other way. The row
 * lock only exists in the database — a mocked client has no `FOR UPDATE` and no
 * concurrency, so the lost-update defect this fixes is invisible to a unit
 * test. And the append-only trigger likewise lives in the schema, so "the
 * ledger cannot be rewritten" is only a claim until a real DELETE is refused.
 *
 * The defect being pinned: all three settlement paths read `paidAmount`,
 * computed a new total in JavaScript, and wrote it back, with no transaction
 * and no guard in the WHERE. Two clerks taking instalments on the same invoice
 * in the same second both read the same starting figure, and the second write
 * discarded the first — money taken, receipt issued, register short.
 *
 * Set `TEST_DATABASE_URL` to run it; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_ledger_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Jest's 5-second default is a budget for a local socket, and there is no local
 * Postgres in this project — `TARGETS.local` in `scripts/db/targets.mjs` points
 * at the hosted staging database, so "local" describes where the process runs
 * and not where the data is. A reversal test here is three or four round trips
 * a couple of hundred milliseconds apart, which overran the default and failed
 * as a timeout rather than as anything about the ledger.
 */
jest.setTimeout(60_000);

/**
 * The schema-building hook gets its own, larger budget.
 *
 * `beforeAll` drops the spec's schema and replays the **whole migration chain**
 * — thirty-odd hand-written files — against whatever `TEST_DATABASE_URL` points
 * at, which in practice is a hosted Postgres a few hundred milliseconds away.
 * At 60s that hook fails on a slow link while every test in the suite would
 * have passed, and a suite that reports "failed to run" for a network hiccup is
 * a suite people learn to re-run rather than read.
 *
 * The per-test budget stays at 60s: an individual assertion taking a minute is
 * a real problem, and this must not hide it.
 */
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('PaymentLedgerService', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let ledger: PaymentLedgerService;

  /**
   * Fresh ids per test rather than a shared fixture cleared between them.
   *
   * Ledger rows cannot be deleted — that is the guarantee under test — and the
   * foreign keys to staff are RESTRICT, so the citizen and clerk behind a
   * recorded transaction cannot be removed either. Isolation therefore comes
   * from new rows, not from cleanup.
   */
  let citizenId: string;
  let clerkId: string;
  let paymentId: string;

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);

    const context = {
      get prisma() {
        return db;
      },
      tenantSlug: 'ledger',
      /*
        Raw queries now write this into their SQL rather than leaning on
        `search_path` — see `tenant-schema-ref.ts`. Supplying it here is what
        makes these suites exercise the qualified form rather than a shape
        that only works because the test client pins one schema per connection.
      */
      schemaName: SCHEMA,
    } as unknown as TenantContextService;
    ledger = new PaymentLedgerService(
      context,
      new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never),
      new TreasuryLedgerService(context),
    );
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    /*
      The same budget as the hook that built it: this drops the schema CASCADE
      over the same link, and a teardown that times out is reported as "Test
      suite failed to run" even when every test in the file passed — which reads
      as a broken suite rather than a slow one.
    */
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  beforeEach(async () => {
    citizenId = randomUUID();
    clerkId = randomUUID();

    await db.user.createMany({
      data: [
        {
          id: citizenId,
          kind: 'CITIZEN',
          tenantSlug: 'ledger',
          firstName: 'علي',
          lastName: 'خليل',
        },
        {
          id: clerkId,
          kind: 'STAFF',
          tenantSlug: 'ledger',
          email: `clerk-${clerkId}@ledger.gov.lb`,
          firstName: 'موظف',
          lastName: 'الجباية',
          role: 'SUPER_ADMIN',
        },
      ],
    });

    const payment = await db.citizenPayment.create({
      data: {
        citizenId,
        title: 'رسم القيمة التأجيرية',
        amount: 100_000,
        dueDate: new Date('2026-01-31T00:00:00.000Z'),
        // Issued at the start of the year, so a back-dated payment has room.
        createdAt: new Date('2026-01-01T08:00:00.000Z'),
      },
      select: { id: true },
    });
    paymentId = payment.id;
  });

  /** The audit row a clerk's cash entry writes, filled in with what the ledger knows. */
  const audit: LedgerAudit = (movement) => ({
    actorId: clerkId,
    actorType: 'STAFF',
    action: 'PAYMENT_CONFIRMED',
    entityType: 'Payment',
    entityId: paymentId,
    after: { receiptNumber: movement.receiptNumber, amount: movement.received },
  });

  const reversalAudit: LedgerAudit = (movement) => ({
    actorId: clerkId,
    actorType: 'STAFF',
    action: 'PAYMENT_REVERSED',
    entityType: 'PaymentTransaction',
    entityId: movement.transactionId,
    after: { receiptNumber: movement.receiptNumber, amount: movement.received },
  });

  const auditRows = (action: string) =>
    db.auditLogEntry.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });

  const cash = (amount: number) =>
    ledger.record({ audit, paymentId, amount, method: 'CASH', recordedById: clerkId });

  describe('the audit trail (Tier 1)', () => {
    it('writes one row with the movement, in the same transaction', async () => {
      const result = await cash(40_000);

      const rows = await auditRows('PAYMENT_CONFIRMED');
      expect(rows.filter((row) => row.entityId === paymentId)).toHaveLength(1);
      expect(rows.at(-1)?.after).toMatchObject({ receiptNumber: result.receiptNumber, amount: 40_000 });
    });

    it('takes no money when the audit row cannot be written', async () => {
      const before = await db.paymentTransaction.count({ where: { paymentId } });

      await expect(
        ledger.record({
          paymentId,
          amount: 30_000,
          method: 'CASH',
          recordedById: clerkId,
          // Not a uuid: Postgres refuses the audit insert inside the ledger's transaction.
          audit: () => ({ actorId: 'not-a-uuid', actorType: 'STAFF', action: 'PAYMENT_CONFIRMED', entityType: 'Payment' }),
        }),
      ).rejects.toThrow();

      expect(await db.paymentTransaction.count({ where: { paymentId } })).toBe(before);
      const invoice = await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(Number(invoice.paidAmount)).toBe(0);
    });

    it('writes no second row for a retry answered from the first movement', async () => {
      const clientRequestId = randomUUID();
      const first = await ledger.record({ audit, paymentId, amount: 20_000, method: 'CASH', recordedById: clerkId, clientRequestId });
      const again = await ledger.record({ audit, paymentId, amount: 20_000, method: 'CASH', recordedById: clerkId, clientRequestId });

      expect(again.receiptNumber).toBe(first.receiptNumber);
      const rows = (await auditRows('PAYMENT_CONFIRMED')).filter((row) => row.entityId === paymentId);
      expect(rows).toHaveLength(1);
    });

    it('records a reversal, which used to leave no row at all', async () => {
      const taken = await cash(50_000);
      const reversal = await ledger.reverse({ audit: reversalAudit, transactionId: taken.transactionId, recordedById: clerkId });

      const rows = (await auditRows('PAYMENT_REVERSED')).filter((row) => row.entityId === reversal.transactionId);
      expect(rows).toHaveLength(1);
    });
  });

  describe('recording money', () => {
    it('settles an invoice paid in full', async () => {
      const result = await cash(100_000);

      expect(result.paymentStatus).toBe('PAID');
      expect(result.paidAmount).toBe(100_000);
      expect(result.remaining).toBe(0);
      // «RCP-2610-0001»: the book, the month it was issued in, then the counter (0079).
      expect(result.receiptNumber).toMatch(new RegExp(`^RCP-${municipalPeriod()}-\\d{4}$`));

      const row = await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(row.paymentStatus).toBe('PAID');
      expect(row.paidAt).toBeInstanceOf(Date);
    });

    it('carries a balance on a partial payment', async () => {
      const result = await cash(40_000);

      expect(result.paymentStatus).toBe('UNPAID');
      expect(result.remaining).toBe(60_000);

      // A half-paid row marked PAID would drop out of every arrears query.
      const row = await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(row.paymentStatus).toBe('UNPAID');
      expect(row.paidAt).toBeNull();
    });

    it('accumulates instalments into one balance', async () => {
      await cash(30_000);
      await cash(30_000);
      const third = await cash(40_000);

      expect(third.paidAmount).toBe(100_000);
      expect(third.paymentStatus).toBe('PAID');

      // And each instalment is still individually addressable — the thing a
      // running total could never do.
      const history = await ledger.listForPayment(paymentId);
      expect(history).toHaveLength(3);
      expect(history.map((entry) => entry.amount)).toEqual([30_000, 30_000, 40_000]);
      expect(new Set(history.map((entry) => entry.receiptNumber)).size).toBe(3);
    });

    it('keeps method and reference per movement', async () => {
      // The case the old model could not represent: a refused transfer, then
      // cash at the counter. `whishTransactionRef` used to be cleared by the
      // second, erasing any record of the first.
      await ledger.record({
        audit,
        paymentId,
        amount: 60_000,
        method: 'WHISH_MONEY',
        externalRef: 'TX-777',
        recordedById: clerkId,
      });
      await cash(40_000);

      const history = await ledger.listForPayment(paymentId);
      expect(history[0]).toMatchObject({ method: 'WHISH_MONEY', externalRef: 'TX-777' });
      expect(history[1]).toMatchObject({ method: 'CASH', externalRef: null });
    });

    it('keeps the notes handed over beside the credit — «$1 و10,500 ليرة»', async () => {
      // 10,500 + 1 × 89,500 = 100,000: the invoice is settled, and the record
      // still says a dollar changed hands, at what rate.
      const result = await ledger.record({
        audit,
        paymentId,
        amount: 100_000,
        method: 'CASH',
        recordedById: clerkId,
        tendered: { local: 10_500, foreign: 1, foreignCurrency: 'USD', exchangeRate: 89_500, officialExchangeRate: 89_500 },
      });
      expect(result.paymentStatus).toBe('PAID');

      const row = await db.paymentTransaction.findUniqueOrThrow({ where: { id: result.transactionId } });
      expect(Number(row.amount)).toBe(100_000);
      expect(Number(row.tenderedLocal)).toBe(10_500);
      expect(Number(row.tenderedForeign)).toBe(1);
      expect(row.tenderedForeignCurrency).toBe('USD');
      expect(Number(row.exchangeRate)).toBe(89_500);
    });

    it('marks a back-dated full payment paid on its own day, not today', async () => {
      const day = new Date('2026-09-28T12:00:00.000Z');
      const result = await ledger.record({
        audit,
        paymentId,
        amount: 100_000,
        method: 'CASH',
        recordedById: clerkId,
        occurredAt: day,
      });
      expect(result.paymentStatus).toBe('PAID');

      const invoice = await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(invoice.paidAt?.toISOString()).toBe(day.toISOString());
      const row = await db.paymentTransaction.findUniqueOrThrow({ where: { id: result.transactionId } });
      expect(row.occurredAt.toISOString()).toBe(day.toISOString());
    });

    it('refuses a foreign amount with no rate, at the database', async () => {
      // The CHECK from 0064: a tender that cannot be read back is not stored.
      await expect(
        ledger.record({
          audit,
          paymentId,
          amount: 100_000,
          method: 'CASH',
          recordedById: clerkId,
          tendered: { local: 0, foreign: 1, foreignCurrency: 'USD', exchangeRate: null, officialExchangeRate: null },
        }),
      ).rejects.toThrow();
      const invoice = await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(Number(invoice.paidAmount)).toBe(0);
    });

    it('settles from a larger dollar note and records the change handed back', async () => {
      // $2 at 89,500 is 179,000 against 100,000 owed: the bill is paid and
      // 79,000 ل.ل go back. tender − change = credit, on the row itself.
      const result = await ledger.record({
        audit,
        paymentId,
        amount: 179_000,
        method: 'CASH',
        recordedById: clerkId,
        tendered: { local: 0, foreign: 2, foreignCurrency: 'USD', exchangeRate: 89_500, officialExchangeRate: 89_500 },
      });
      expect(result).toMatchObject({ paymentStatus: 'PAID', received: 100_000, changeGiven: 79_000 });
      const row = await db.paymentTransaction.findUniqueOrThrow({ where: { id: result.transactionId } });
      expect(Number(row.amount)).toBe(100_000);
      expect(Number(row.changeGiven)).toBe(79_000);
    });

    it('refuses change on ليرة alone — that is a typing mistake, not a large note', async () => {
      await expect(
        ledger.record({
          audit,
          paymentId,
          amount: 150_000,
          method: 'CASH',
          recordedById: clerkId,
          tendered: { local: 150_000, foreign: null, foreignCurrency: null, exchangeRate: null, officialExchangeRate: null },
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('answers a retry with the first receipt instead of taking the money twice', async () => {
      const clientRequestId = randomUUID();
      const first = await ledger.record({ audit, paymentId, amount: 30_000, method: 'CASH', recordedById: clerkId, clientRequestId });
      const again = await ledger.record({ audit, paymentId, amount: 30_000, method: 'CASH', recordedById: clerkId, clientRequestId });
      expect(again).toMatchObject({ receiptNumber: first.receiptNumber, replayed: true, paidAmount: 30_000 });
      expect(await db.paymentTransaction.count({ where: { paymentId } })).toBe(1);
    });

    it('refuses a payment dated before the bill was issued', async () => {
      await expect(
        ledger.record({
          audit,
          paymentId,
          amount: 10_000,
          method: 'CASH',
          recordedById: clerkId,
          occurredAt: new Date('2025-12-15T12:00:00.000Z'),
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_DATE_BEFORE_INVOICE' });
    });

    it('dates a settled bill by its last money, even when the final entry is back-dated', async () => {
      // 60,000 on 20 Sep, then the remaining 40,000 entered as taken on 10 Sep:
      // the bill was not settled before the 20th.
      await ledger.record({ audit, paymentId, amount: 60_000, method: 'CASH', recordedById: clerkId, occurredAt: new Date('2026-09-20T12:00:00.000Z') });
      await ledger.record({ audit, paymentId, amount: 40_000, method: 'CASH', recordedById: clerkId, occurredAt: new Date('2026-09-10T12:00:00.000Z') });
      const invoice = await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(invoice.paidAt?.toISOString()).toBe('2026-09-20T12:00:00.000Z');
    });

    it('returns the tender when the ledger is read back — the reprint and the cash-up', async () => {
      await ledger.record({
        audit,
        paymentId,
        amount: 100_000,
        method: 'CASH',
        recordedById: clerkId,
        tendered: { local: 10_500, foreign: 1, foreignCurrency: 'USD', exchangeRate: 89_500, officialExchangeRate: 89_500 },
      });
      const [row] = await ledger.listForPayment(paymentId);
      expect(row).toMatchObject({ tenderedLocal: 10_500, tenderedForeign: 1, exchangeRate: 89_500, officialExchangeRate: 89_500, changeGiven: 0 });
    });

    it('refuses more than the outstanding balance', async () => {
      await cash(90_000);
      await expect(cash(20_000)).rejects.toBeInstanceOf(ConflictError);
    });

    it('refuses a payment against a settled invoice', async () => {
      await cash(100_000);
      await expect(cash(1_000)).rejects.toMatchObject({ code: 'PAYMENT_ALREADY_PAID' });
    });

    it('refuses a zero or negative amount', async () => {
      await expect(cash(0)).rejects.toThrow();
      await expect(cash(-5_000)).rejects.toThrow();
    });
  });

  describe('concurrency — the lost update this exists to prevent', () => {
    it('does not lose either of two simultaneous instalments', async () => {
      // Both start before either commits. Under the old read-compute-write
      // both would read paidAmount = 0 and the second would write over the
      // first; the row lock makes the second wait and recompute.
      const [a, b] = await Promise.all([cash(40_000), cash(30_000)]);

      const total = a.paidAmount > b.paidAmount ? a.paidAmount : b.paidAmount;
      expect(total).toBe(70_000);

      const row = await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(Number(row.paidAmount)).toBe(70_000);

      const history = await ledger.listForPayment(paymentId);
      expect(history).toHaveLength(2);
    });

    it('lets exactly one of two racing full settlements win', async () => {
      // Both are for the whole invoice, so one of them must be refused as an
      // overpayment rather than both being banked.
      const results = await Promise.allSettled([cash(100_000), cash(100_000)]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);

      const row = await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(Number(row.paidAmount)).toBe(100_000);
    });

    it('never issues the same receipt number twice', async () => {
      // A sequence rather than MAX+1, precisely so concurrent clerks cannot be
      // handed the same number for two different citizens.
      const settled = await Promise.all([cash(10_000), cash(10_000), cash(10_000)]);
      const numbers = settled.map((s) => s.receiptNumber);
      expect(new Set(numbers).size).toBe(3);
    });
  });

  describe('reversal', () => {
    it('reverses an entry as an opposing row', async () => {
      const original = await cash(100_000);
      expect(original.paymentStatus).toBe('PAID');

      const reversed = await ledger.reverse({
        audit: reversalAudit,
        transactionId: original.transactionId,
        recordedById: clerkId,
        note: 'قيد بالخطأ',
      });

      expect(reversed.paidAmount).toBe(0);
      expect(reversed.paymentStatus).toBe('UNPAID');

      // Both rows survive: what happened, and the correction, each with its
      // own actor and time.
      const history = await ledger.listForPayment(paymentId);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ amount: 100_000, reversed: true });
      expect(history[1]).toMatchObject({ amount: -100_000, isReversal: true });
    });

    it('refuses to reverse the same entry twice', async () => {
      const original = await cash(50_000);
      await ledger.reverse({ audit: reversalAudit, transactionId: original.transactionId });

      // Twice would credit the citizen twice.
      await expect(
        ledger.reverse({ audit: reversalAudit, transactionId: original.transactionId }),
      ).rejects.toMatchObject({ code: 'TRANSACTION_ALREADY_REVERSED' });
    });

    it('refuses to reverse a reversal', async () => {
      const original = await cash(50_000);
      const reversal = await ledger.reverse({ audit: reversalAudit, transactionId: original.transactionId });

      const rows = await db.paymentTransaction.findMany({
        where: { reversalOfId: original.transactionId },
        select: { id: true },
      });
      expect(rows[0].id).toBe(reversal.transactionId);

      await expect(
        ledger.reverse({ audit: reversalAudit, transactionId: reversal.transactionId }),
      ).rejects.toMatchObject({ code: 'TRANSACTION_IS_REVERSAL' });
    });

    it('reopens a settled invoice when its only payment is reversed', async () => {
      const original = await cash(100_000);
      await ledger.reverse({ audit: reversalAudit, transactionId: original.transactionId });

      const row = await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(row.paymentStatus).toBe('UNPAID');
      expect(row.paidAt).toBeNull();
    });
  });

  describe('append-only', () => {
    it('refuses an update to a recorded transaction', async () => {
      const { transactionId } = await cash(25_000);

      await expect(
        db.paymentTransaction.update({
          where: { id: transactionId },
          data: { amount: 1 },
        }),
      ).rejects.toThrow(/append-only/i);
    });

    it('refuses a delete', async () => {
      await cash(25_000);

      await expect(
        db.paymentTransaction.deleteMany({ where: { paymentId } }),
      ).rejects.toThrow(/append-only/i);
    });

    it('keeps the invoice balance equal to the sum of its ledger rows', async () => {
      await cash(30_000);
      const second = await cash(20_000);
      await ledger.reverse({ audit: reversalAudit, transactionId: second.transactionId });
      await cash(10_000);

      const rows = await db.paymentTransaction.findMany({
        where: { paymentId },
        select: { amount: true },
      });
      const sum = rows.reduce((total, row) => total + Number(row.amount), 0);

      const invoice = await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } });
      // The column is a cache of this sum; if the two can drift, the cache is
      // the one people read and the ledger is decoration.
      expect(Number(invoice.paidAmount)).toBe(sum);
      expect(sum).toBe(40_000);
    });
  });
});

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { ConflictError } from '../../common/exceptions';
import { PaymentLedgerService } from './payment-ledger.service';

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

    ledger = new PaymentLedgerService({
      get prisma() {
        return db;
      },
      tenantSlug: 'ledger',
    } as unknown as TenantContextService);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  });

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
      },
      select: { id: true },
    });
    paymentId = payment.id;
  });

  const cash = (amount: number) =>
    ledger.record({ paymentId, amount, method: 'CASH', recordedById: clerkId });

  describe('recording money', () => {
    it('settles an invoice paid in full', async () => {
      const result = await cash(100_000);

      expect(result.paymentStatus).toBe('PAID');
      expect(result.paidAmount).toBe(100_000);
      expect(result.remaining).toBe(0);
      expect(result.receiptNumber).toMatch(/^RCP-\d{6}$/);

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

    it('refuses more than the outstanding balance', async () => {
      await cash(90_000);
      await expect(cash(20_000)).rejects.toBeInstanceOf(ConflictError);
    });

    it('refuses a payment against a settled invoice', async () => {
      await cash(100_000);
      await expect(cash(1_000)).rejects.toThrow(/مسدّدة بالفعل/);
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
      await ledger.reverse({ transactionId: original.transactionId });

      // Twice would credit the citizen twice.
      await expect(
        ledger.reverse({ transactionId: original.transactionId }),
      ).rejects.toThrow(/معكوسة بالفعل/);
    });

    it('refuses to reverse a reversal', async () => {
      const original = await cash(50_000);
      const reversal = await ledger.reverse({ transactionId: original.transactionId });

      const rows = await db.paymentTransaction.findMany({
        where: { reversalOfId: original.transactionId },
        select: { id: true },
      });
      expect(rows[0].id).toBe(reversal.transactionId);

      await expect(
        ledger.reverse({ transactionId: reversal.transactionId }),
      ).rejects.toThrow(/حركة عكسية/);
    });

    it('reopens a settled invoice when its only payment is reversed', async () => {
      const original = await cash(100_000);
      await ledger.reverse({ transactionId: original.transactionId });

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
      await ledger.reverse({ transactionId: second.transactionId });
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

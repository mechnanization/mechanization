import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { municipalToday, type CreateTransferInput, type RecordExpenseInput } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient, Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { PaymentLedgerService, type LedgerAudit } from '../fees/payment-ledger.service';
import { addDays } from './day-closing.plan';
import { ExpensesService } from './expenses.service';
import { TransfersService } from './transfers.service';
import { TreasuryLedgerService } from './treasury-ledger.service';
import { TreasuryService } from './treasury.service';

/**
 * An outflow dated on an earlier day, against a real Postgres (docs/finance.md
 * §3.1, rule 7; the review of 2026-10-11).
 *
 * A back-dated voucher, transfer or cash payment's change lands on its own day
 * and on every close after it, and a day's close is what is counted, closed and
 * signed (§7). It was judged against the balance now: an expense dated three
 * days ago from a bank account opened and funded today was accepted, and that
 * day then closed below zero on the signed register. What only a database can
 * show is the ledger refusing it — and refusing nothing a day's close covers.
 *
 * The services read the real clock, so the days are built back from Beirut's
 * today: the treasury went live six days ago (D0). The file is ordered: each
 * test leaves the wallets as the next one expects.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_backdated_outflow_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;
const RATE = 89_500;

const TODAY = municipalToday();
const D0 = addDays(TODAY, -6);
const D2 = addDays(TODAY, -4);
const D3 = addDays(TODAY, -3);
const D4 = addDays(TODAY, -2);

/** Where a document dated an earlier day sits: midday UTC of it (`documentOccurredAt`). */
const nominal = (day: string) => new Date(`${day}T12:00:00.000Z`);

describeIfDb('An outflow dated on an earlier day', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let ledger: TreasuryLedgerService;
  let payments: PaymentLedgerService;
  let expenses: ExpensesService;
  let transfers: TransfersService;
  let treasury: TreasuryService;

  let managerId: string;
  let citizenId: string;
  let miscId: string;
  let safeLbp: string;
  let safeUsd: string;
  let whishLbp: string;
  let bank: string;

  const manager = () => ({ id: managerId, role: 'SUPER_ADMIN' });

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'backdated', schemaName: SCHEMA, prisma: db }, work);

  const audit: LedgerAudit = (movement) => ({
    actorId: managerId,
    actorType: 'STAFF',
    action: 'PAYMENT_CONFIRMED',
    entityType: 'Payment',
    after: { receiptNumber: movement.receiptNumber },
  });

  /** Money into a wallet at a given instant, written the way every writer writes: through `post`. */
  const deposit = (accountId: string, currency: string, amount: number, occurredAt: Date) =>
    scoped(() =>
      db.$transaction((tx) =>
        ledger.post(tx, [{ accountId, currency, amount: new Prisma.Decimal(amount) }], {
          source: 'ADJUSTMENT',
          sourceId: null,
          actorId: managerId,
          occurredAt,
        }),
      ),
    );

  const expense = (accountId: string, amount: number, paidOn?: string) =>
    scoped(() =>
      expenses.record(
        {
          categoryId: miscId,
          accountId,
          amount,
          payee: 'مورّد محروقات',
          description: 'مازوت للمولّد',
          ...(paidOn && paidOn !== TODAY ? { paidOn, adjustmentReason: 'سُجّلت متأخرة' } : {}),
        } as RecordExpenseInput,
        manager(),
      ),
    );

  const transfer = (fromAccountId: string, toAccountId: string, amount: number, transferredOn?: string) =>
    scoped(() =>
      transfers.create(
        {
          kind: 'SAME_CURRENCY',
          fromAccountId,
          toAccountId,
          amount,
          description: 'مناقلة بين الحسابات',
          clientRequestId: randomUUID(),
          ...(transferredOn && transferredOn !== TODAY ? { transferredOn, backdateReason: 'سُجّلت متأخرة' } : {}),
        } as CreateTransferInput,
        manager(),
      ),
    );

  const balance = async (accountId: string): Promise<number> =>
    Number((await db.treasuryEntry.aggregate({ where: { accountId }, _sum: { amount: true } }))._sum.amount ?? 0);

  /** A wallet's close on a municipal day: its entries up to that day's end, as the count sheet reads it. */
  const closeOf = async (accountId: string, day: string): Promise<number> =>
    Number(
      (
        await ddl.query(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM "${SCHEMA}"."treasury_entries"
            WHERE "accountId" = $1 AND ("occurredAt" AT TIME ZONE 'Asia/Beirut')::date <= $2::date`,
          [accountId, day],
        )
      ).rows[0].total,
    );

  /** Everything a refused outflow must have left untouched. */
  const snapshot = async () => ({
    vouchers: await db.expenseVoucher.count(),
    transfers: await db.treasuryTransfer.count(),
    payments: await db.paymentTransaction.count(),
    entries: await db.treasuryEntry.count(),
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
    expenses = new ExpensesService(context, ledger, auditService);
    transfers = new TransfersService(context, ledger, auditService, expenses);
    treasury = new TreasuryService(context, ledger, auditService);

    managerId = randomUUID();
    citizenId = randomUUID();
    await db.user.createMany({
      data: [
        {
          id: managerId, kind: 'STAFF', tenantSlug: 'backdated', email: `m-${managerId}@t.gov.lb`,
          firstName: 'المدير', lastName: 'العام', role: 'SUPER_ADMIN',
        },
        { id: citizenId, kind: 'CITIZEN', tenantSlug: 'backdated', firstName: 'سامي', lastName: 'عيسى' },
      ],
    });

    // Live since 09:00 Beirut on D0, as if activated then.
    const goLiveAt = new Date(`${D0}T06:00:00.000Z`);
    await ddl.query(
      `INSERT INTO "${SCHEMA}"."system_settings" ("id", "singleton", "updatedAt", "treasuryGoLiveAt", "exchangeRate", "secondaryCurrency")
       VALUES (gen_random_uuid(), true, now(), $1, $2, 'USD')
       ON CONFLICT ("singleton") DO UPDATE
         SET "treasuryGoLiveAt" = EXCLUDED."treasuryGoLiveAt", "exchangeRate" = EXCLUDED."exchangeRate",
             "secondaryCurrency" = EXCLUDED."secondaryCurrency"`,
      [goLiveAt, RATE],
    );
    await ddl.query(`UPDATE "${SCHEMA}"."treasury_accounts" SET "createdAt" = $1::timestamptz - interval '1 day'`, [
      goLiveAt,
    ]);

    const wallet = async (type: string, currency: string) =>
      (await db.treasuryAccount.findFirstOrThrow({ where: { type: type as never, currency, isPrimary: true } })).id;
    safeLbp = await wallet('CASH_SAFE', 'LBP');
    safeUsd = await wallet('CASH_SAFE', 'USD');
    whishLbp = await wallet('WHISH_ACCOUNT', 'LBP');
    miscId = (await db.expenseCategory.findFirstOrThrow({ where: { key: 'MISC' } })).id;

    // The counted opening balances: an empty ليرة safe, $100, and 2,000,000 ل.ل on Whish.
    await scoped(() =>
      db.$transaction((tx) =>
        ledger.post(
          tx,
          [
            { accountId: safeUsd, currency: 'USD', amount: new Prisma.Decimal(100) },
            { accountId: whishLbp, currency: 'LBP', amount: new Prisma.Decimal(2_000_000) },
          ],
          { source: 'OPENING_BALANCE', sourceId: null, actorId: managerId, occurredAt: goLiveAt },
        ),
      ),
    );
    // Today, 30,000,000 ل.ل of citizens' transfers reach Whish.
    await deposit(whishLbp, 'LBP', 30_000_000, new Date());
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('refuses a transfer dated on a day its source could not cover, though it can today', async () => {
    expect(await balance(whishLbp)).toBe(32_000_000);
    expect(await closeOf(whishLbp, D2)).toBe(2_000_000);
    const before = await snapshot();

    await expect(transfer(whishLbp, safeLbp, 25_000_000, D2)).rejects.toMatchObject({
      code: 'TREASURY_INSUFFICIENT_FUNDS_ON_DAY',
      params: { date: D2, available: 2_000_000, required: 25_000_000, currency: 'LBP' },
    });
    expect(await snapshot()).toEqual(before);
    expect(await closeOf(whishLbp, D2)).toBe(2_000_000);

    // What that day's close covers goes through, dated on it.
    await expect(transfer(whishLbp, safeLbp, 1_500_000, D2)).resolves.toMatchObject({ replayed: false });
    expect(await closeOf(whishLbp, D2)).toBe(500_000);
    expect(await closeOf(safeLbp, D2)).toBe(1_500_000);
  });

  it('judges a back-dated transfer and its fee together against the day, and names what both need', async () => {
    // D2 closed with 500,000 on Whish: 400,000 and a 200,000 fee need 600,000 of it.
    const before = await snapshot();
    await expect(
      scoped(() =>
        transfers.create(
          {
            kind: 'SAME_CURRENCY',
            fromAccountId: whishLbp,
            toAccountId: safeLbp,
            amount: 400_000,
            feeAmount: 200_000,
            description: 'مناقلة مع رسم',
            clientRequestId: randomUUID(),
            transferredOn: D2,
            backdateReason: 'سُجّلت متأخرة',
          } as CreateTransferInput,
          manager(),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'TREASURY_INSUFFICIENT_FUNDS_ON_DAY',
      params: { date: D2, available: 500_000, required: 600_000, currency: 'LBP' },
    });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses an expense dated before its wallet held anything — a bank opened and funded today', async () => {
    bank = (
      await scoped(() => treasury.createAccount({ name: 'مصرف التجربة', type: 'BANK_ACCOUNT', currency: 'LBP' }, manager()))
    ).id;
    await transfer(whishLbp, bank, 10_000_000);
    expect(await balance(bank)).toBe(10_000_000);
    const before = await snapshot();

    await expect(expense(bank, 4_000_000, D2)).rejects.toMatchObject({
      code: 'TREASURY_INSUFFICIENT_FUNDS_ON_DAY',
      params: { account: 'مصرف التجربة', date: D2, available: 0, required: 4_000_000, currency: 'LBP' },
    });
    expect(await snapshot()).toEqual(before);
    expect(await closeOf(bank, D2)).toBe(0);

    // Dated today, the same expense is judged by the balance now, as it always was.
    await expect(expense(bank, 4_000_000)).resolves.toMatchObject({ balanceAfter: 6_000_000 });
  });

  it('judges the close of every day since the one it is dated on, not that day alone', async () => {
    // D3: most of the ليرة safe goes on an expense, leaving 300,000 at that day's close.
    await expect(expense(safeLbp, 1_200_000, D3)).resolves.toMatchObject({ replayed: false });
    expect(await closeOf(safeLbp, D3)).toBe(300_000);
    // Today the safe is refilled: it holds plenty now.
    await deposit(safeLbp, 'LBP', 5_000_000, new Date());
    expect(await balance(safeLbp)).toBe(5_300_000);
    const before = await snapshot();

    // D2's close covers 1,000,000; D3's, which the same voucher would also come out of, does not.
    await expect(expense(safeLbp, 1_000_000, D2)).rejects.toMatchObject({
      code: 'TREASURY_INSUFFICIENT_FUNDS_ON_DAY',
      params: { date: D3, available: 300_000, required: 1_000_000 },
    });
    expect(await snapshot()).toEqual(before);

    // What every close since covers goes through.
    await expect(expense(safeLbp, 300_000, D2)).resolves.toMatchObject({ replayed: false });
    expect(await closeOf(safeLbp, D2)).toBe(1_200_000);
    expect(await closeOf(safeLbp, D3)).toBe(0);
    expect(await balance(safeLbp)).toBe(5_000_000);
  });

  it('counts money that reached the wallet later the same day: a day is judged at its close', async () => {
    // $500 arrives at 18:30 in Beirut on D4, after the midday a back-dated voucher sits at.
    await deposit(safeUsd, 'USD', 500, new Date(`${D4}T15:30:00.000Z`));
    expect(await closeOf(safeUsd, D4)).toBe(600);
    await expect(expense(safeUsd, 300, D4)).resolves.toMatchObject({ replayed: false });
    expect(await closeOf(safeUsd, D4)).toBe(300);
  });

  it("refuses a back-dated cash payment whose change that day's safe could not hand back", async () => {
    const bill = (
      await db.citizenPayment.create({
        data: {
          citizenId,
          title: 'رسم',
          amount: 100_000,
          currency: 'LBP',
          dueDate: new Date('2026-12-31T00:00:00.000Z'),
          createdAt: new Date('2026-01-01T08:00:00.000Z'),
        },
        select: { id: true },
      })
    ).id;
    // $20 at 89,500 for a 100,000 ل.ل bill: 1,690,000 ل.ل of change out of the ليرة safe.
    const withNote = (occurredAt?: Date) =>
      scoped(() =>
        payments.record({
          audit,
          paymentId: bill,
          amount: 1_790_000,
          method: 'CASH',
          recordedById: managerId,
          ...(occurredAt ? { occurredAt } : {}),
          tendered: { local: 0, foreign: 20, foreignCurrency: 'USD', exchangeRate: RATE, officialExchangeRate: RATE },
        }),
      );
    expect(await closeOf(safeLbp, D2)).toBe(1_200_000);
    const before = await snapshot();

    await expect(withNote(nominal(D2))).rejects.toMatchObject({
      code: 'TREASURY_INSUFFICIENT_FUNDS_ON_DAY',
      params: { date: D2, available: 1_200_000, required: 1_690_000 },
    });
    expect(await snapshot()).toEqual(before);
    expect((await db.citizenPayment.findUniqueOrThrow({ where: { id: bill } })).paymentStatus).toBe('UNPAID');

    // Taken today, the safe hands the change back.
    await expect(withNote()).resolves.toMatchObject({ paymentStatus: 'PAID', changeGiven: 1_690_000 });
  });

  it('still names the balance now when today cannot cover the outflow either', async () => {
    const before = await snapshot();
    for (const day of [TODAY, D2]) {
      await expect(expense(bank, 7_000_000, day)).rejects.toMatchObject({
        code: 'TREASURY_INSUFFICIENT_FUNDS',
        params: { available: 6_000_000, required: 7_000_000 },
      });
    }
    expect(await snapshot()).toEqual(before);
  });

  it('leaves no day closing below zero on any wallet', async () => {
    const days = Array.from({ length: 7 }, (_, index) => addDays(D0, index));
    for (const accountId of [safeLbp, safeUsd, whishLbp, bank]) {
      for (const day of days) {
        expect({ accountId, day, close: (await closeOf(accountId, day)) >= 0 }).toEqual({ accountId, day, close: true });
      }
    }
  });

  // Last in the file: the day stays closed. A closed day is the first answer, whatever the wallet held on it.
  it('refuses a back-dated outflow on a closed day as closed, not as short', async () => {
    await ddl.query(`INSERT INTO "${SCHEMA}"."treasury_day_closures" ("businessDate", "closedById") VALUES ($1, $2)`, [
      D2,
      managerId,
    ]);
    const before = await snapshot();
    // The bank held nothing on D2, so the day's close would also be short; the closure is what is said.
    await expect(transfer(bank, whishLbp, 1_000, D2)).rejects.toMatchObject({
      code: 'CLOSED_DAY_MUTATION_BLOCKED',
      params: { date: D2 },
    });
    await expect(expense(bank, 1_000, D2)).rejects.toMatchObject({ code: 'CLOSED_DAY_MUTATION_BLOCKED' });
    expect(await snapshot()).toEqual(before);
  });
});

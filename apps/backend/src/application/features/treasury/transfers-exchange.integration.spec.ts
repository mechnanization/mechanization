import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { ExpensesService } from './expenses.service';
import { TransfersService } from './transfers.service';
import { TreasuryLedgerService } from './treasury-ledger.service';
import { TreasuryService } from './treasury.service';
import { municipalPeriod, municipalToday, type CreateTransferInput } from '@mechanization/shared-schemas';

/**
 * المناقلات والمصارفة against a real Postgres (docs/finance.md §6, migration 0084).
 *
 * What only a database can prove: that a transfer, its fee voucher and their
 * ledger entries commit together or not at all; that two transfers with fees
 * over one pair of wallets, opposite ways round, cannot deadlock; that an
 * exchange beyond the tolerance is refused without a reason and flagged with
 * one; that cancelling returns amount and fee together; and that a transfer
 * dated into a closed day is refused by the same lock as everything else.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_transfers_exchange_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const RATE = 89_500;

describeIfDb('TransfersService — transfers, fees and exchange', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let expenses: ExpensesService;
  let transfers: TransfersService;
  let treasury: TreasuryService;

  let safeLbp: string;
  let safeUsd: string;
  let whishLbp: string;
  let whishUsd: string;
  let miscId: string;

  const MANAGER = { id: '', role: 'SUPER_ADMIN' };
  const ACCOUNTANT = { id: '', role: 'ACCOUNTANT' };
  const AUDITOR = { id: '', role: 'AUDITOR' };

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'transfers', schemaName: SCHEMA, prisma: db }, work);

  const balance = async (accountId: string): Promise<number> =>
    Number(
      (await db.treasuryEntry.aggregate({ where: { accountId }, _sum: { amount: true } }))._sum.amount ?? 0,
    );

  const counts = async () => ({
    transfers: await db.treasuryTransfer.count(),
    vouchers: await db.expenseVoucher.count(),
    entries: await db.treasuryEntry.count(),
  });

  const move = (over: Record<string, unknown> = {}, actor = ACCOUNTANT) =>
    scoped(() =>
      transfers.create(
        {
          kind: 'SAME_CURRENCY',
          fromAccountId: whishUsd,
          toAccountId: safeUsd,
          amount: 100,
          description: 'سحب من حساب Whish',
          clientRequestId: randomUUID(),
          ...over,
        } as CreateTransferInput,
        actor,
      ),
    );

  const exchange = (over: Record<string, unknown> = {}) =>
    move({
      kind: 'EXCHANGE',
      fromAccountId: safeUsd,
      toAccountId: safeLbp,
      amount: 100,
      receivedAmount: 100 * RATE,
      description: 'مصارفة دولار إلى ليرة',
      ...over,
    });

  const staff = async (role: string): Promise<string> => {
    const id = randomUUID();
    await db.user.create({
      data: { id, kind: 'STAFF', tenantSlug: 'transfers', email: `${role}-${id}@t.gov.lb`, firstName: role, lastName: 'spec', role: role as never },
    });
    return id;
  };

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    const ledger = new TreasuryLedgerService(context);
    expenses = new ExpensesService(context, ledger, audit);
    transfers = new TransfersService(context, ledger, audit, expenses);
    treasury = new TreasuryService(context, ledger, audit);

    MANAGER.id = await staff('SUPER_ADMIN');
    ACCOUNTANT.id = await staff('ACCOUNTANT');
    AUDITOR.id = await staff('AUDITOR');

    const wallet = async (type: 'CASH_SAFE' | 'WHISH_ACCOUNT', currency: string) =>
      (await db.treasuryAccount.findFirstOrThrow({ where: { type, currency } })).id;
    safeLbp = await wallet('CASH_SAFE', 'LBP');
    safeUsd = await wallet('CASH_SAFE', 'USD');
    whishLbp = await wallet('WHISH_ACCOUNT', 'LBP');
    whishUsd = await wallet('WHISH_ACCOUNT', 'USD');
    miscId = (await db.expenseCategory.findFirstOrThrow({ where: { key: 'MISC' } })).id;

    const opening: Record<string, number> = {
      [safeLbp]: 500_000_000,
      [safeUsd]: 5_000,
      [whishLbp]: 20_000_000,
      [whishUsd]: 1_000,
    };
    await scoped(() =>
      treasury.activate(
        { balances: Object.entries(opening).map(([accountId, amount]) => ({ accountId, amount })) },
        MANAGER,
      ),
    );
    /*
      Live since five days ago, so a back-dated transfer is possible, and the
      official rate the exchanges are judged against. The opening entries keep
      today's date; nothing reads them against the go-live day.
    */
    await db.systemSettings.updateMany({
      data: {
        treasuryGoLiveAt: new Date(Date.now() - 5 * 86_400_000),
        baseCurrency: 'LBP',
        secondaryCurrency: 'USD',
        exchangeRate: RATE,
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  // ────────────────────────────────  the schema  ────────────────────────────────

  describe('the schema (migration 0084)', () => {
    it('defaults the rule to 3% and 1,000', async () => {
      const settings = await db.systemSettings.findFirstOrThrow();
      expect(settings.exchangeRateTolerancePercent.toNumber()).toBe(3);
      expect(settings.largeExchangeThreshold.toNumber()).toBe(1000);
    });

    it('refuses a fee with no voucher, a changer on a same-currency move, and a review stamp on an unflagged one', async () => {
      const base = {
        transferNumber: `X-${randomUUID().slice(0, 8)}`,
        fromAccountId: whishUsd,
        fromCurrency: 'USD',
        toAccountId: safeUsd,
        toCurrency: 'USD',
        amount: 1,
        receivedAmount: 1,
        description: 'x',
      };
      await expect(db.treasuryTransfer.create({ data: { ...base, feeAmount: 1 } })).rejects.toThrow();
      await expect(
        db.treasuryTransfer.create({ data: { ...base, transferNumber: `Y-${randomUUID().slice(0, 8)}`, moneyChangerName: 'x' } }),
      ).rejects.toThrow();
      await expect(
        db.treasuryTransfer.create({
          data: { ...base, transferNumber: `Z-${randomUUID().slice(0, 8)}`, reviewedAt: new Date(), reviewedById: AUDITOR.id },
        }),
      ).rejects.toThrow();
    });
  });

  // ────────────────────────────────  new wallets  ────────────────────────────────

  describe('opening a wallet', () => {
    it('opens a bank account empty, never primary, and audits it', async () => {
      const bank = await scoped(() =>
        treasury.createAccount({ name: 'حساب بنك لبنان والمهجر — ليرة', type: 'BANK_ACCOUNT', currency: 'LBP' }, MANAGER),
      );
      expect(bank).toMatchObject({ type: 'BANK_ACCOUNT', currency: 'LBP', isPrimary: false, active: true, balance: 0 });
      expect(await db.auditLogEntry.count({ where: { action: 'TREASURY_ACCOUNT_CREATED', entityId: bank.id } })).toBe(1);
    });

    it('refuses a currency that is neither the base nor the secondary one', async () => {
      await expect(
        scoped(() => treasury.createAccount({ name: 'يورو', type: 'PETTY_CASH', currency: 'EUR' }, MANAGER)),
      ).rejects.toMatchObject({ code: 'TREASURY_ACCOUNT_CURRENCY_UNSUPPORTED' });
    });

    it('shows the rule on the overview the form reads', async () => {
      const overview = await scoped(() => treasury.overview());
      expect(overview.rate).toMatchObject({ exchangeRate: RATE, tolerancePercent: 3, largeExchangeThreshold: 1000 });
    });
  });

  // ──────────────────────────────  internal transfers  ──────────────────────────────

  describe('an internal transfer', () => {
    it('moves the amount, books the fee as its own voucher, and takes amount + fee from the source', async () => {
      const whishBefore = await balance(whishUsd);
      const safeBefore = await balance(safeUsd);
      const result = await move({ amount: 100, feeAmount: 2 });

      expect(result.transferNumber).toMatch(new RegExp(`^TR-${municipalPeriod()}-\\d{4}$`));
      expect(result.feeVoucherNumber).toMatch(new RegExp(`^PV-${municipalPeriod()}-\\d{4}$`));
      expect(result.requiresReview).toBe(false);
      expect(await balance(whishUsd)).toBe(whishBefore - 102);
      expect(await balance(safeUsd)).toBe(safeBefore + 100);
      expect(result).toMatchObject({ fromBalanceAfter: whishBefore - 102, toBalanceAfter: safeBefore + 100 });

      const view = await scoped(() => transfers.get(result.id));
      expect(view).toMatchObject({ kind: 'SAME_CURRENCY', amount: 100, receivedAmount: 100, exchangeRate: null, review: null });
      expect(view.fee).toMatchObject({ amount: 2, voucherNumber: result.feeVoucherNumber });

      const voucher = await scoped(() => expenses.get(view.fee!.voucherId));
      expect(voucher.category.id).toBe(
        (await db.expenseCategory.findFirstOrThrow({ where: { key: 'TRANSFER_FEES' } })).id,
      );
      expect(voucher.description).toBe(`رسوم المناقلة ${result.transferNumber}`);
      expect(voucher.account.id).toBe(whishUsd);

      const legs = await db.treasuryEntry.findMany({ where: { source: 'TRANSFER', sourceId: result.id } });
      expect(legs.map((entry) => Number(entry.amount)).sort((a, b) => a - b)).toEqual([-100, 100]);
      expect(await db.auditLogEntry.count({ where: { action: 'TRANSFER_RECORDED', entityId: result.id } })).toBe(1);
    });

    it('moves without a fee, writing no voucher', async () => {
      const before = await counts();
      const result = await move({ fromAccountId: safeLbp, toAccountId: whishLbp, amount: 1_000_000 });
      expect(result.feeVoucherNumber).toBeNull();
      expect(await counts()).toEqual({ transfers: before.transfers + 1, vouchers: before.vouchers, entries: before.entries + 2 });
    });

    it('answers a retried press with the first transfer, fee included, moving the money once', async () => {
      const key = randomUUID();
      const before = await counts();
      const first = await move({ amount: 10, feeAmount: 1, clientRequestId: key });
      const again = await move({ amount: 10, feeAmount: 1, clientRequestId: key });
      expect(again).toMatchObject({ id: first.id, feeVoucherNumber: first.feeVoucherNumber, replayed: true });
      expect(await counts()).toEqual({ transfers: before.transfers + 1, vouchers: before.vouchers + 1, entries: before.entries + 3 });
    });

    it('refuses, writing nothing: one wallet, two currencies, a custody end, a stopped wallet', async () => {
      const collector = await staff('COLLECTOR');
      const custody = await db.treasuryAccount.create({
        data: { name: 'عهدة الجابي', type: 'COLLECTOR_CUSTODY', currency: 'USD', ownerId: collector },
      });
      const stopped = await db.treasuryAccount.create({
        data: { name: 'صندوق موقوف', type: 'PETTY_CASH', currency: 'USD', active: false },
      });
      const before = await counts();

      await expect(move({ toAccountId: whishUsd })).rejects.toMatchObject({ code: 'TRANSFER_SAME_ACCOUNT_FORBIDDEN' });
      await expect(move({ toAccountId: safeLbp })).rejects.toMatchObject({
        code: 'TRANSFER_CURRENCY_MISMATCH',
        params: { from: 'USD', to: 'LBP' },
      });
      await expect(move({ toAccountId: custody.id })).rejects.toMatchObject({ code: 'TRANSFER_ACCOUNT_NOT_ALLOWED' });
      await expect(move({ fromAccountId: custody.id })).rejects.toMatchObject({ code: 'TRANSFER_ACCOUNT_NOT_ALLOWED' });
      await expect(move({ toAccountId: stopped.id })).rejects.toMatchObject({ code: 'TRANSFER_ACCOUNT_NOT_ALLOWED' });

      expect(await counts()).toEqual(before);
    });

    it('refuses what the source cannot cover with its fee, naming amount + fee, and leaves no fee voucher', async () => {
      const held = await balance(whishUsd);
      const before = await counts();
      await expect(move({ amount: held, feeAmount: 1 })).rejects.toMatchObject({
        code: 'TREASURY_INSUFFICIENT_FUNDS',
        params: { available: held, required: held + 1 },
      });
      expect(await counts()).toEqual(before);
    });
  });

  // ──────────────────────────────────  exchange  ──────────────────────────────────

  describe('an exchange', () => {
    it('books a fair exchange at the rate its amounts imply, with the official rate beside it, unflagged', async () => {
      const usdBefore = await balance(safeUsd);
      const lbpBefore = await balance(safeLbp);
      const result = await exchange({ amount: 100, receivedAmount: 8_940_000, moneyChangerName: 'صيرفة الأمانة' });

      expect(result.requiresReview).toBe(false);
      expect(await balance(safeUsd)).toBe(usdBefore - 100);
      expect(await balance(safeLbp)).toBe(lbpBefore + 8_940_000);

      const view = await scoped(() => transfers.get(result.id));
      expect(view).toMatchObject({
        kind: 'EXCHANGE',
        amount: 100,
        receivedAmount: 8_940_000,
        exchangeRate: 89_400,
        officialExchangeRate: RATE,
        moneyChangerName: 'صيرفة الأمانة',
        review: null,
      });
      expect(await db.auditLogEntry.count({ where: { action: 'EXCHANGE_RECORDED', entityId: result.id } })).toBe(1);
    });

    it('reads the rate as pounds per dollar when pounds are sold', async () => {
      const result = await exchange({ fromAccountId: safeLbp, toAccountId: safeUsd, amount: 9_000_000, receivedAmount: 100 });
      expect((await scoped(() => transfers.get(result.id))).exchangeRate).toBe(90_000);
    });

    it('refuses a rate beyond the tolerance without a reason, naming the gap, and writes nothing', async () => {
      const before = await counts();
      // 95,000 is 6.15% above 89,500.
      await expect(exchange({ receivedAmount: 9_500_000 })).rejects.toMatchObject({
        code: 'EXCHANGE_RATE_TOLERANCE_EXCEEDED',
        params: { deviation: 6.15, tolerance: 3 },
      });
      expect(await counts()).toEqual(before);
    });

    it('books it with a reason, keeps the reason, and flags it for review', async () => {
      const result = await exchange({ receivedAmount: 9_500_000, adjustmentReason: 'سعر السوق ارتفع صباحاً' });
      expect(result.requiresReview).toBe(true);
      const view = await scoped(() => transfers.get(result.id));
      expect(view.adjustmentReason).toBe('سعر السوق ارتفع صباحاً');
      expect(view.review).toEqual({ reviewedAt: null, reviewedByName: null, note: null });
    });

    it('flags a large exchange whatever its rate', async () => {
      const result = await exchange({ amount: 1_500, receivedAmount: 1_500 * RATE });
      expect(result.requiresReview).toBe(true);
    });

    it('flags an exchange when there is no official rate to compare, without asking a reason', async () => {
      await db.systemSettings.updateMany({ data: { exchangeRate: null } });
      try {
        const result = await exchange({ receivedAmount: 9_900_000 });
        expect(result.requiresReview).toBe(true);
        expect((await scoped(() => transfers.get(result.id))).officialExchangeRate).toBeNull();
      } finally {
        await db.systemSettings.updateMany({ data: { exchangeRate: RATE } });
      }
    });

    it('refuses an exchange between two wallets of one currency', async () => {
      await expect(exchange({ toAccountId: whishUsd, receivedAmount: 100 })).rejects.toMatchObject({
        code: 'EXCHANGE_SAME_CURRENCY_FORBIDDEN',
      });
    });
  });

  // ──────────────────────────────────  review  ──────────────────────────────────

  describe('the review', () => {
    it('stamps a flagged exchange once, with the note, and audits it', async () => {
      const flagged = await exchange({ amount: 2_000, receivedAmount: 2_000 * RATE });
      const pendingBefore = (await scoped(() => transfers.list({ review: 'PENDING' }))).pendingReview;

      const reviewed = await scoped(() => transfers.review(flagged.id, 'طابق إيصال الصرّاف', AUDITOR));
      expect(reviewed.review).toMatchObject({ reviewedByName: 'AUDITOR spec', note: 'طابق إيصال الصرّاف' });
      expect(reviewed.review?.reviewedAt).toBeTruthy();
      expect((await scoped(() => transfers.list())).pendingReview).toBe(pendingBefore - 1);
      expect(await db.auditLogEntry.count({ where: { action: 'TRANSFER_REVIEWED', entityId: flagged.id } })).toBe(1);

      await expect(scoped(() => transfers.review(flagged.id, undefined, MANAGER))).rejects.toMatchObject({
        code: 'TRANSFER_ALREADY_REVIEWED',
      });
    });

    it('refuses to review what was never flagged', async () => {
      const plain = await move({ amount: 1 });
      await expect(scoped(() => transfers.review(plain.id, undefined, AUDITOR))).rejects.toMatchObject({
        code: 'TRANSFER_NOT_FLAGGED',
      });
    });

    it('lists the queue and the kinds apart', async () => {
      const pending = await scoped(() => transfers.list({ review: 'PENDING' }));
      expect(pending.transfers.every((row) => row.review && row.review.reviewedAt === null)).toBe(true);
      const exchanges = await scoped(() => transfers.list({ kind: 'EXCHANGE' }));
      expect(exchanges.transfers.length).toBeGreaterThan(0);
      expect(exchanges.transfers.every((row) => row.kind === 'EXCHANGE')).toBe(true);
      const internal = await scoped(() => transfers.list({ kind: 'SAME_CURRENCY' }));
      expect(internal.transfers.every((row) => row.kind === 'SAME_CURRENCY')).toBe(true);
    });
  });

  // ──────────────────────────────────  cancelling  ──────────────────────────────────

  describe('cancelling', () => {
    it('puts amount and fee back together, and cancels the fee voucher with the transfer', async () => {
      const whishBefore = await balance(whishUsd);
      const safeBefore = await balance(safeUsd);
      const result = await move({ amount: 50, feeAmount: 3 });

      const voided = await scoped(() => transfers.void(result.id, 'سُجّل على الحساب الخطأ', MANAGER));
      expect(voided.status).toBe('VOID');
      expect(await balance(whishUsd)).toBe(whishBefore);
      expect(await balance(safeUsd)).toBe(safeBefore);
      const fee = await scoped(() => expenses.get(voided.fee!.voucherId));
      expect(fee.status).toBe('VOID');
    });

    it('refuses to cancel a fee voucher on its own', async () => {
      const result = await move({ amount: 5, feeAmount: 1 });
      const view = await scoped(() => transfers.get(result.id));
      await expect(scoped(() => expenses.void(view.fee!.voucherId, 'إلغاء الرسم وحده', MANAGER))).rejects.toMatchObject({
        code: 'EXPENSE_IS_TRANSFER_FEE',
        params: { transfer: result.transferNumber },
      });
    });

    it('refuses to cancel once the destination has spent the money, and changes nothing', async () => {
      const bank = await scoped(() =>
        treasury.createAccount({ name: 'حساب مصرفي — دولار', type: 'BANK_ACCOUNT', currency: 'USD' }, MANAGER),
      );
      const deposit = await move({ fromAccountId: safeUsd, toAccountId: bank.id, amount: 40, feeAmount: 1 });
      await scoped(() =>
        expenses.record({ categoryId: miscId, accountId: bank.id, amount: 30, payee: 'مورّد', description: 'دفعة من المصرف' }, MANAGER),
      );
      const before = await counts();
      await expect(scoped(() => transfers.void(deposit.id, 'إيداع خاطئ', MANAGER))).rejects.toMatchObject({
        code: 'TREASURY_INSUFFICIENT_FUNDS',
      });
      expect(await counts()).toEqual(before);
      expect((await scoped(() => transfers.get(deposit.id))).status).toBe('RECORDED');
    });
  });

  // ───────────────────────────────  dates and locks  ───────────────────────────────

  describe('dates', () => {
    const daysAgo = (n: number): string => municipalToday(new Date(Date.now() - n * 86_400_000));

    it('books a back-dated transfer with its reason, fee voucher on the same day', async () => {
      const result = await move({ amount: 7, feeAmount: 1, transferredOn: daysAgo(1), backdateReason: 'سُحب أمس ولم يُسجَّل' });
      const view = await scoped(() => transfers.get(result.id));
      expect(municipalToday(new Date(view.occurredAt))).toBe(daysAgo(1));
      expect(view.backdateReason).toBe('سُحب أمس ولم يُسجَّل');
      const fee = await scoped(() => expenses.get(view.fee!.voucherId));
      expect(municipalToday(new Date(fee.occurredAt))).toBe(daysAgo(1));
    });

    it('asks why, and refuses before go-live', async () => {
      await expect(move({ transferredOn: daysAgo(1) })).rejects.toMatchObject({ code: 'TRANSFER_BACKDATE_REASON_REQUIRED' });
      await expect(move({ transferredOn: daysAgo(9), backdateReason: 'x' })).rejects.toMatchObject({
        code: 'TRANSFER_DATE_BEFORE_GO_LIVE',
      });
    });

    it('refuses a transfer dated into a closed day, writing nothing', async () => {
      await ddl.query(`INSERT INTO "${SCHEMA}"."treasury_day_closures" ("businessDate", "closedById") VALUES ($1, $2)`, [
        daysAgo(3),
        MANAGER.id,
      ]);
      const before = await counts();
      await expect(
        move({ amount: 5, feeAmount: 1, transferredOn: daysAgo(3), backdateReason: 'نسيت تسجيله' }),
      ).rejects.toMatchObject({ code: 'CLOSED_DAY_MUTATION_BLOCKED' });
      expect(await counts()).toEqual(before);
    });
  });

  describe('locks', () => {
    /*
      Each transfer draws its «TR-» number by locking the month's row in
      `document_counters`, which already queues concurrent transfers before any
      wallet is touched. So this proves the outcome — every one books and the
      books balance — not the wallet lock order on its own; the next test pins
      the lock.
    */
    it('books transfers with fees crossing one pair of wallets both ways at once, every one of them', async () => {
      const lbpSafeBefore = await balance(safeLbp);
      const lbpWhishBefore = await balance(whishLbp);
      const before = await counts();
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          i % 2 === 0
            ? move({ fromAccountId: safeLbp, toAccountId: whishLbp, amount: 10_000, feeAmount: 500 })
            : move({ fromAccountId: whishLbp, toAccountId: safeLbp, amount: 10_000, feeAmount: 500 }),
        ),
      );
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(failures.map((failure) => String(failure.reason))).toEqual([]);
      expect(await counts()).toEqual({
        transfers: before.transfers + 8,
        vouchers: before.vouchers + 8,
        entries: before.entries + 24,
      });
      // Four each way, each paying a 500 fee from its own source.
      expect(await balance(safeLbp)).toBe(lbpSafeBefore - 4 * 500);
      expect(await balance(whishLbp)).toBe(lbpWhishBefore - 4 * 500);
    });

    it('judges amount + fee against the balance the other transfer left, when two race for one wallet', async () => {
      const petty = await scoped(() =>
        treasury.createAccount({ name: 'سلفة نثرية — دولار', type: 'PETTY_CASH', currency: 'USD' }, MANAGER),
      );
      await move({ fromAccountId: safeUsd, toAccountId: petty.id, amount: 100 });

      const results = await Promise.allSettled([
        move({ fromAccountId: petty.id, toAccountId: safeUsd, amount: 50, feeAmount: 2 }),
        move({ fromAccountId: petty.id, toAccountId: safeUsd, amount: 50, feeAmount: 2 }),
      ]);
      const refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(refused).toHaveLength(1);
      /*
        Locked before the balance is read, the loser waits for the winner and is
        told what it needs — 52 — against what is left — 48. Read without the
        lock it passes the check, and is refused later by the second of its two
        posts with figures that leave the fee out.
      */
      expect(refused[0].reason).toMatchObject({
        code: 'TREASURY_INSUFFICIENT_FUNDS',
        params: { available: 48, required: 52 },
      });
      expect(await balance(petty.id)).toBe(48);
    });
  });
});

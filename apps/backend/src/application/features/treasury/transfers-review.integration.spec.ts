import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TRANSFER_FEE_URGENT_REASON, type CreateTransferInput } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { FeesService } from '../fees/fees.service';
import { PaymentLedgerService } from '../fees/payment-ledger.service';
import { ExpensesService } from './expenses.service';
import { TransfersService } from './transfers.service';
import { TreasuryLedgerService } from './treasury-ledger.service';
import { TreasuryService } from './treasury.service';

/**
 * The PR #111 review (2026-10-10): what its transfers, exchanges, reviews and
 * new wallets did against the treasury controls, each pinned by a test that
 * fails without its fix.
 *
 *  - A review could never be written: the 0083 write-once trigger did not name
 *    0084's review stamp (fixed by 0088), and a cancelled exchange reached the
 *    reviewer as a server error.
 *  - A transfer's retry key was not bound to its act: any reuse — another
 *    amount, a cancelled transfer, a collector's handover — was answered as a
 *    replay of whatever the key had produced.
 *  - An accountant's transfer fee bypassed the payment order (D3).
 *  - A cancellation took the wallets before the settings row.
 *  - An exchange's other side was judged against the secondary currency's
 *    official rate whatever currency it was.
 *  - «إضافة حساب» could open the same wallet twice.
 *  - An accountant's save of the finance section wrote the exchange rule back
 *    and was recorded as changing it.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_transfers_review_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const RATE = 89_500;

describeIfDb('TransfersService — the PR #111 review', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let transfers: TransfersService;
  let treasury: TreasuryService;
  let fees: FeesService;
  const emit = jest.fn();

  let safeLbp: string;
  let safeUsd: string;
  let whishUsd: string;

  const MANAGER = { id: '', role: 'SUPER_ADMIN' };
  const ACCOUNTANT = { id: '', role: 'ACCOUNTANT' };
  const AUDITOR = { id: '', role: 'AUDITOR' };
  let collectorId = '';

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'review', schemaName: SCHEMA, prisma: db }, work);

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
          amount: 10,
          description: 'سحب من حساب Whish',
          clientRequestId: randomUUID(),
          ...over,
        } as CreateTransferInput,
        actor,
      ),
    );

  // Above the 1,000 threshold: booked and flagged for the auditor.
  const largeExchange = (over: Record<string, unknown> = {}) =>
    move({
      kind: 'EXCHANGE',
      fromAccountId: safeUsd,
      toAccountId: safeLbp,
      amount: 1_500,
      receivedAmount: 1_500 * RATE,
      description: 'مصارفة كبيرة',
      ...over,
    });

  const staff = async (role: string): Promise<string> => {
    const id = randomUUID();
    await db.user.create({
      data: { id, kind: 'STAFF', tenantSlug: 'review', email: `${role}-${id}@t.gov.lb`, firstName: role, lastName: 'spec', role: role as never },
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
    const expenses = new ExpensesService(context, ledger, audit);
    transfers = new TransfersService(context, ledger, audit, expenses);
    treasury = new TreasuryService(context, ledger, audit);
    fees = new FeesService(
      context,
      { emit } as unknown as EventEmitter2,
      {} as never,
      {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        invalidatePrefix: jest.fn().mockResolvedValue(undefined),
      } as never,
      new PaymentLedgerService(context, audit, ledger),
      audit,
    );

    MANAGER.id = await staff('SUPER_ADMIN');
    ACCOUNTANT.id = await staff('ACCOUNTANT');
    AUDITOR.id = await staff('AUDITOR');
    collectorId = await staff('COLLECTOR');

    const wallet = async (type: 'CASH_SAFE' | 'WHISH_ACCOUNT', currency: string) =>
      (await db.treasuryAccount.findFirstOrThrow({ where: { type, currency } })).id;
    safeLbp = await wallet('CASH_SAFE', 'LBP');
    safeUsd = await wallet('CASH_SAFE', 'USD');
    whishUsd = await wallet('WHISH_ACCOUNT', 'USD');
    const whishLbp = await wallet('WHISH_ACCOUNT', 'LBP');

    const opening: Record<string, number> = {
      [safeLbp]: 500_000_000,
      [safeUsd]: 50_000,
      [whishLbp]: 0,
      [whishUsd]: 5_000,
    };
    await scoped(() =>
      treasury.activate({ balances: Object.entries(opening).map(([accountId, amount]) => ({ accountId, amount })) }, MANAGER),
    );
    await db.systemSettings.updateMany({
      data: { baseCurrency: 'LBP', secondaryCurrency: 'USD', exchangeRate: RATE },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  // ───────────────────────────  the review stamp  ───────────────────────────

  describe('the review of a flagged exchange (0088)', () => {
    it('is written, once, and never rewritten afterwards', async () => {
      const flagged = await largeExchange();
      expect(flagged.requiresReview).toBe(true);

      const reviewed = await scoped(() => transfers.review(flagged.id, undefined, AUDITOR));
      expect(reviewed.review).toMatchObject({ reviewedByName: 'AUDITOR spec', note: null });
      expect(reviewed.review?.reviewedAt).not.toBeNull();

      // A note the review was made without is not added to it later…
      await expect(
        db.$executeRawUnsafe(`UPDATE "${SCHEMA}"."treasury_transfers" SET "reviewNote" = 'لاحقاً' WHERE "id" = $1::uuid`, flagged.id),
      ).rejects.toThrow(/a review is written once/);
      // …and the rest of the document stays as written.
      await expect(
        db.$executeRawUnsafe(`UPDATE "${SCHEMA}"."treasury_transfers" SET "amount" = 1 WHERE "id" = $1::uuid`, flagged.id),
      ).rejects.toThrow(/only its stamps may change/);
    });

    it('refuses a cancelled exchange with a code, not a server error', async () => {
      const flagged = await largeExchange();
      await scoped(() => transfers.void(flagged.id, 'سُجّلت خطأً', MANAGER));
      await expect(scoped(() => transfers.review(flagged.id, 'تمت', AUDITOR))).rejects.toMatchObject({
        code: 'TRANSFER_ALREADY_VOID',
      });
    });
  });

  // ───────────────────────────  the retry key  ───────────────────────────

  describe('a transfer’s retry key', () => {
    it('answers the same act with the first transfer, and moves nothing again', async () => {
      const key = randomUUID();
      const first = await move({ clientRequestId: key, feeAmount: 1 });
      const before = await counts();
      const again = await move({ clientRequestId: key, feeAmount: 1 });
      expect(again).toMatchObject({ id: first.id, feeVoucherNumber: first.feeVoucherNumber, replayed: true });
      expect(await counts()).toEqual(before);
    });

    it('refuses the key for another act, writing nothing', async () => {
      const key = randomUUID();
      await move({ clientRequestId: key, amount: 10 });
      const before = await counts();
      for (const other of [{ amount: 11 }, { feeAmount: 1 }, { description: 'بيان آخر' }, { toAccountId: safeLbp, kind: 'EXCHANGE', receivedAmount: 10 * RATE }]) {
        await expect(move({ clientRequestId: key, ...other })).rejects.toMatchObject({ code: 'TREASURY_REQUEST_KEY_REUSED' });
      }
      await expect(move({ clientRequestId: key }, MANAGER)).rejects.toMatchObject({ code: 'TREASURY_REQUEST_KEY_REUSED' });
      expect(await counts()).toEqual(before);
    });

    it('does not answer a cancelled transfer as recorded', async () => {
      const key = randomUUID();
      const first = await move({ clientRequestId: key });
      await scoped(() => transfers.void(first.id, 'خطأ في الحساب', MANAGER));
      await expect(move({ clientRequestId: key })).rejects.toMatchObject({
        code: 'TRANSFER_ALREADY_VOID',
        params: { transferNumber: first.transferNumber },
      });
    });

    it('never answers with a collector’s handover recorded under the same key', async () => {
      const custody = await db.treasuryAccount.create({
        data: { name: 'عهدة جابٍ — USD', type: 'COLLECTOR_CUSTODY', currency: 'USD', ownerId: collectorId },
      });
      await db.treasuryEntry.create({
        data: { accountId: custody.id, currency: 'USD', amount: 40, source: 'CITIZEN_PAYMENT', sourceId: randomUUID(), occurredAt: new Date() },
      });
      const key = randomUUID();
      await scoped(() => transfers.receiveCustody({ custodyAccountId: custody.id, amount: 40, clientRequestId: key }, ACCOUNTANT));
      const before = await counts();
      await expect(move({ clientRequestId: key })).rejects.toMatchObject({ code: 'TREASURY_REQUEST_KEY_REUSED' });
      expect(await counts()).toEqual(before);
    });
  });

  // ───────────────────────────  the fee and the payment order  ───────────────────────────

  describe('a transfer’s fee (D3)', () => {
    it('is the order on the manager’s transfer, and waits for it on the accountant’s, with the server’s reason', async () => {
      const mine = await move({ feeAmount: 1 }, MANAGER);
      const theirs = await move({ feeAmount: 1 }, ACCOUNTANT);
      const voucher = (number: string | null) =>
        db.expenseVoucher.findUniqueOrThrow({ where: { voucherNumber: number! }, select: { orderedAt: true, orderedById: true, urgentReason: true } });

      expect(await voucher(mine.feeVoucherNumber)).toMatchObject({ orderedById: MANAGER.id, urgentReason: null });
      const waiting = await voucher(theirs.feeVoucherNumber);
      expect(waiting).toMatchObject({ orderedAt: null, orderedById: null, urgentReason: TRANSFER_FEE_URGENT_REASON });
    });

    it('holds the accountant’s fee to the urgent ceiling, writing nothing above it', async () => {
      await db.systemSettings.updateMany({ data: { urgentExpenseCeilingUsd: 1 } });
      try {
        const before = await counts();
        await expect(move({ feeAmount: 2 }, ACCOUNTANT)).rejects.toMatchObject({ code: 'EXPENSE_URGENT_OVER_CEILING' });
        expect(await counts()).toEqual(before);
        // The manager's transfer is the order: no ceiling holds it.
        await expect(move({ feeAmount: 2 }, MANAGER)).resolves.toMatchObject({ replayed: false });
      } finally {
        await db.systemSettings.updateMany({ data: { urgentExpenseCeilingUsd: null } });
      }
    });
  });

  // ───────────────────────────  lock order  ───────────────────────────

  describe('cancelling a transfer', () => {
    it('takes the settings row before the wallets, as every treasury writer does', async () => {
      const done = await move({ amount: 5 });
      const holder = new Client({ connectionString: TEST_DATABASE_URL });
      await holder.connect();
      try {
        // A writer that holds the settings row and will want a wallet next — activation's order.
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM "${SCHEMA}"."system_settings" FOR UPDATE`);
        const voiding = scoped(() => transfers.void(done.id, 'خطأ في المبلغ', MANAGER));
        await new Promise((resolve) => setTimeout(resolve, 750));
        /*
          The cancellation is waiting on the settings row. Had it locked the
          wallets first, it would hold them now, and this writer would deadlock
          against it; NOWAIT turns that into an immediate refusal.
        */
        await expect(
          holder.query(`SELECT 1 FROM "${SCHEMA}"."treasury_accounts" WHERE "id" = $1::uuid FOR UPDATE NOWAIT`, [whishUsd]),
        ).resolves.toMatchObject({ rowCount: 1 });
        await holder.query('ROLLBACK');
        await expect(voiding).resolves.toMatchObject({ status: 'VOID' });
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
    });
  });

  // ───────────────────────────  the rate an exchange is judged by  ───────────────────────────

  describe('an exchange’s official rate', () => {
    it('is refused when its other side is not the currency the official rate is for', async () => {
      await db.systemSettings.updateMany({ data: { secondaryCurrency: 'EUR' } });
      try {
        const before = await counts();
        await expect(
          move({ kind: 'EXCHANGE', fromAccountId: safeUsd, toAccountId: safeLbp, amount: 10, receivedAmount: 10 * RATE }),
        ).rejects.toMatchObject({ code: 'EXCHANGE_PAIR_UNSUPPORTED' });
        expect(await counts()).toEqual(before);
      } finally {
        await db.systemSettings.updateMany({ data: { secondaryCurrency: 'USD' } });
      }
    });
  });

  // ───────────────────────────  opening a wallet  ───────────────────────────

  describe('«إضافة حساب»', () => {
    it('opens one wallet per name, kind and currency, even for two presses at once', async () => {
      const open = (name: string, currency = 'USD') =>
        scoped(() => treasury.createAccount({ name, type: 'BANK_ACCOUNT', currency }, MANAGER));
      const results = await Promise.allSettled([open('بنك بيبلوس — دولار'), open('بنك بيبلوس — دولار')]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'TREASURY_ACCOUNT_NAME_TAKEN' },
      });
      await expect(open('  بنك بيبلوس — دولار ')).rejects.toMatchObject({ code: 'TREASURY_ACCOUNT_NAME_TAKEN' });
      expect(await db.treasuryAccount.count({ where: { name: 'بنك بيبلوس — دولار' } })).toBe(1);
      // The same bank in the other currency is another wallet.
      await expect(open('بنك بيبلوس — دولار', 'LBP')).resolves.toMatchObject({ currency: 'LBP' });
    });
  });

  // ───────────────────────────  the exchange rule in الإعدادات  ───────────────────────────

  describe('the exchange rule', () => {
    const changedKeys = (): string[] => {
      const call = emit.mock.calls.filter(([event]) => event === 'settings.changed').at(-1);
      return (call?.[1] as { changed: string[] }).changed;
    };

    it('is moved by the manager alone, and an accountant’s save of the section does not write it', async () => {
      await expect(
        scoped(() => fees.updateSettings({ exchangeRateTolerancePercent: 5 }, ACCOUNTANT)),
      ).rejects.toMatchObject({ code: 'EXCHANGE_RULE_MANAGER_ONLY' });

      await scoped(() => fees.updateSettings({ defaultDueDays: 30, exchangeRateTolerancePercent: 3, largeExchangeThreshold: 1000 }, ACCOUNTANT));
      // The audit trail must not say the accountant edited the rule he sent back unchanged.
      expect(changedKeys()).not.toEqual(expect.arrayContaining(['exchangeRateTolerancePercent']));
      expect(changedKeys()).not.toEqual(expect.arrayContaining(['largeExchangeThreshold']));

      await scoped(() => fees.updateSettings({ exchangeRateTolerancePercent: 4 }, MANAGER));
      expect(changedKeys()).toContain('exchangeRateTolerancePercent');
      expect((await db.systemSettings.findFirstOrThrow()).exchangeRateTolerancePercent.toNumber()).toBe(4);
      await scoped(() => fees.updateSettings({ exchangeRateTolerancePercent: 3 }, MANAGER));
    });
  });
});

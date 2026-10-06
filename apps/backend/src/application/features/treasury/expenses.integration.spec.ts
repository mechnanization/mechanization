import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient, Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { ExpensesService } from './expenses.service';
import { TreasuryLedgerService } from './treasury-ledger.service';
import { TreasuryService } from './treasury.service';

/**
 * Expenses against a real Postgres.
 *
 * What only a database can prove: that the voucher and the money move in one
 * transaction (a refused outflow must leave no voucher behind), that the wallet
 * cannot be taken below zero under concurrency, that the retry key stops a
 * double-click paying twice, and that a void puts the money back as an opposing
 * entry rather than by deleting anything.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_expenses_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('ExpensesService', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let ledger: TreasuryLedgerService;
  let expenses: ExpensesService;
  let treasury: TreasuryService;

  let managerId: string;
  let safeLbpId: string;
  let safeUsdId: string;
  let fuelId: string;
  let miscId: string;

  const MANAGER = { id: '', role: 'SUPER_ADMIN' };

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'expenses', schemaName: SCHEMA, prisma: db }, work);

  const balance = async (accountId: string): Promise<number> =>
    Number(
      (await db.treasuryEntry.aggregate({ where: { accountId }, _sum: { amount: true } }))._sum.amount ?? 0,
    );

  const spend = (over: Partial<Parameters<ExpensesService['record']>[0]> = {}) =>
    scoped(() =>
      expenses.record(
        {
          categoryId: fuelId,
          accountId: safeLbpId,
          amount: 100_000,
          payee: 'محطة الوفاء للمحروقات',
          description: 'مازوت للمولّد',
          ...over,
        },
        MANAGER,
      ),
    );

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const auditService = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    ledger = new TreasuryLedgerService(context);
    expenses = new ExpensesService(context, ledger, auditService);
    treasury = new TreasuryService(context, ledger, auditService);

    managerId = randomUUID();
    MANAGER.id = managerId;
    await db.user.create({
      data: {
        id: managerId,
        kind: 'STAFF',
        tenantSlug: 'expenses',
        email: `m-${managerId}@t.gov.lb`,
        firstName: 'المدير',
        lastName: 'العام',
        role: 'SUPER_ADMIN',
      },
    });

    safeLbpId = (await db.treasuryAccount.findFirstOrThrow({ where: { type: 'CASH_SAFE', currency: 'LBP' } })).id;
    safeUsdId = (await db.treasuryAccount.findFirstOrThrow({ where: { type: 'CASH_SAFE', currency: 'USD' } })).id;
    fuelId = (await db.expenseCategory.findFirstOrThrow({ where: { key: 'FUEL' } })).id;
    miscId = (await db.expenseCategory.findFirstOrThrow({ where: { key: 'MISC' } })).id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  // ───────────────────────────────  the schema  ───────────────────────────────

  describe('the schema (migration 0074)', () => {
    it('seeds the ten agreed categories, in their agreed order', async () => {
      const rows = await db.expenseCategory.findMany({ orderBy: { sortOrder: 'asc' }, select: { key: true } });
      expect(rows.map((row) => row.key)).toEqual([
        'FUEL',
        'SALARIES',
        'MAINTENANCE',
        'WASTE',
        'OFFICE_SUPPLIES',
        'ELECTRICITY',
        'FIELD_COMMISSIONS',
        'SOCIAL_AID',
        'TRANSFER_FEES',
        'MISC',
      ]);
    });

    it('refuses a voucher whose currency is not its wallet’s', async () => {
      await expect(
        db.expenseVoucher.create({
          data: {
            voucherNumber: `X-${randomUUID().slice(0, 8)}`,
            categoryId: fuelId,
            accountId: safeLbpId,
            currency: 'USD',
            amount: 1,
            payee: 'x',
            description: 'x',
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a zero or negative voucher, and an empty payee', async () => {
      const base = {
        categoryId: fuelId,
        accountId: safeLbpId,
        currency: 'LBP',
        payee: 'x',
        description: 'x',
      };
      await expect(
        db.expenseVoucher.create({
          data: { ...base, voucherNumber: `X-${randomUUID().slice(0, 8)}`, amount: 0 },
        }),
      ).rejects.toThrow();
      await expect(
        db.expenseVoucher.create({
          data: { ...base, voucherNumber: `X-${randomUUID().slice(0, 8)}`, amount: 5, payee: '   ' },
        }),
      ).rejects.toThrow();
    });

    it('refuses a void stamp with no reason', async () => {
      await expect(
        db.expenseVoucher.create({
          data: {
            voucherNumber: `X-${randomUUID().slice(0, 8)}`,
            categoryId: fuelId,
            accountId: safeLbpId,
            currency: 'LBP',
            amount: 5,
            payee: 'x',
            description: 'x',
            voidedAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    });
  });

  // ──────────────────────────  managing categories  ──────────────────────────

  describe('the municipality’s own categories', () => {
    it('adds one, with no key and at the end of the list', async () => {
      const created = await scoped(() => expenses.createCategory({ name: 'إيجار آليات' }, MANAGER));

      expect(created.key).toBeNull();
      expect(created.active).toBe(true);
      expect(created.chapterCode).toBeNull();

      const listed = await scoped(() => expenses.categories());
      expect(listed.at(-1)?.id).toBe(created.id);
    });

    it('keeps the budget codes it is given', async () => {
      const created = await scoped(() =>
        expenses.createCategory({ name: 'أشغال طرق', chapterCode: '12', itemCode: '320' }, MANAGER),
      );
      expect(created).toMatchObject({ chapterCode: '12', itemCode: '320' });
    });

    it('refuses a second category on the same budget article', async () => {
      await expect(
        scoped(() => expenses.createCategory({ name: 'أشغال أخرى', chapterCode: '12', itemCode: '320' }, MANAGER)),
      ).rejects.toMatchObject({ code: 'EXPENSE_CATEGORY_CODE_TAKEN' });
    });

    it('lets two categories share a name: nothing claims otherwise', async () => {
      const first = await scoped(() => expenses.createCategory({ name: 'بند مكرر' }, MANAGER));
      const second = await scoped(() => expenses.createCategory({ name: 'بند مكرر' }, MANAGER));
      expect(second.id).not.toBe(first.id);
    });

    it('renames one, and takes it out of use without deleting it', async () => {
      const created = await scoped(() => expenses.createCategory({ name: 'بند مؤقت' }, MANAGER));
      const updated = await scoped(() =>
        expenses.updateCategory(created.id, { name: 'بند مؤقت — مُعدّل', active: false }, MANAGER),
      );

      expect(updated.name).toBe('بند مؤقت — مُعدّل');
      expect(updated.active).toBe(false);
      // Gone from the working list, still there for the vouchers that point at it.
      expect((await scoped(() => expenses.categories())).some((c) => c.id === created.id)).toBe(false);
      expect((await scoped(() => expenses.categories(true))).some((c) => c.id === created.id)).toBe(true);
    });

    it('refuses to edit one that does not exist', async () => {
      await expect(
        scoped(() => expenses.updateCategory(randomUUID(), { name: 'لا شيء' }, MANAGER)),
      ).rejects.toMatchObject({ code: 'EXPENSE_CATEGORY_NOT_FOUND' });
    });

    it('audits both acts', async () => {
      const created = await scoped(() => expenses.createCategory({ name: 'بند للتدقيق' }, MANAGER));
      await scoped(() => expenses.updateCategory(created.id, { name: 'بند للتدقيق 2' }, MANAGER));

      expect(
        await db.auditLogEntry.count({ where: { action: 'EXPENSE_CATEGORY_CREATED', entityId: created.id } }),
      ).toBe(1);
      expect(
        await db.auditLogEntry.count({ where: { action: 'EXPENSE_CATEGORY_UPDATED', entityId: created.id } }),
      ).toBe(1);
    });
  });

  // ─────────────────────  before the treasury is live  ─────────────────────

  describe('before the treasury is live', () => {
    it('records nothing: there is no counted wallet to pay from', async () => {
      await expect(spend()).rejects.toMatchObject({ code: 'TREASURY_NOT_ACTIVE' });
      expect(await db.expenseVoucher.count()).toBe(0);
    });
  });

  // ────────────────────────────  recording  ────────────────────────────────

  describe('recording an expense', () => {
    beforeAll(async () => {
      const accounts = await db.treasuryAccount.findMany({ where: { type: { not: 'COLLECTOR_CUSTODY' } } });
      await scoped(() =>
        treasury.activate(
          {
            balances: accounts.map((account) => ({
              accountId: account.id,
              amount: account.currency === 'LBP' ? 10_000_000 : 500,
            })),
          },
          MANAGER,
        ),
      );
    }, SETUP_TIMEOUT_MS);

    it('writes the voucher and takes the money out, together', async () => {
      const before = await balance(safeLbpId);
      const result = await spend({ amount: 250_000 });

      expect(result.voucherNumber).toMatch(/^PV-\d{6}$/);
      expect(result.replayed).toBe(false);
      expect(await balance(safeLbpId)).toBe(before - 250_000);
      expect(result.balanceAfter).toBe(before - 250_000);

      const entries = await db.treasuryEntry.findMany({ where: { source: 'EXPENSE_VOUCHER', sourceId: result.id } });
      expect(entries).toHaveLength(1);
      expect(Number(entries[0].amount)).toBe(-250_000);
      expect(entries[0].accountId).toBe(safeLbpId);
    });

    it('takes the currency from the wallet, not from the request', async () => {
      const result = await spend({ accountId: safeUsdId, amount: 25 });
      const voucher = await scoped(() => expenses.get(result.id));
      expect(voucher.currency).toBe('USD');
      expect(voucher.account.id).toBe(safeUsdId);
    });

    it('writes a Tier 1 audit row that does not carry the payee', async () => {
      const result = await spend({ amount: 1_000, payee: 'سعاد خليل' });
      const rows = await db.auditLogEntry.findMany({ where: { action: 'EXPENSE_RECORDED', entityId: result.id } });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0].after)).not.toContain('سعاد');
      expect(rows[0].after).toMatchObject({ voucherNumber: result.voucherNumber });
    });

    it('answers a retry from the first voucher, and pays once', async () => {
      const before = await balance(safeLbpId);
      const clientRequestId = randomUUID();
      const first = await spend({ amount: 7_000, clientRequestId });
      const again = await spend({ amount: 7_000, clientRequestId });

      expect(again.voucherNumber).toBe(first.voucherNumber);
      expect(again.replayed).toBe(true);
      expect(await balance(safeLbpId)).toBe(before - 7_000);
    });

    it('refuses more than the wallet holds, and leaves no voucher behind', async () => {
      const before = await db.expenseVoucher.count();
      await expect(spend({ amount: (await balance(safeLbpId)) + 1 })).rejects.toMatchObject({
        code: 'TREASURY_INSUFFICIENT_FUNDS',
      });
      expect(await db.expenseVoucher.count()).toBe(before);
    });

    it('lets only one of two simultaneous vouchers through when the wallet covers one', async () => {
      const held = await balance(safeUsdId);
      const results = await Promise.allSettled([
        spend({ accountId: safeUsdId, amount: held - 10 }),
        spend({ accountId: safeUsdId, amount: held - 10 }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
        code: 'TREASURY_INSUFFICIENT_FUNDS',
      });
      expect(await balance(safeUsdId)).toBe(10);
    });

    it('refuses an inactive category', async () => {
      await db.expenseCategory.update({ where: { id: miscId }, data: { active: false } });
      await expect(spend({ categoryId: miscId })).rejects.toMatchObject({ code: 'EXPENSE_CATEGORY_INACTIVE' });
      await db.expenseCategory.update({ where: { id: miscId }, data: { active: true } });
    });

    it('refuses a category that does not exist', async () => {
      await expect(spend({ categoryId: randomUUID() })).rejects.toMatchObject({
        code: 'EXPENSE_CATEGORY_NOT_FOUND',
      });
    });

    it('refuses a wallet that does not exist', async () => {
      await expect(spend({ accountId: randomUUID() })).rejects.toMatchObject({
        code: 'TREASURY_ACCOUNT_NOT_FOUND',
      });
    });

    it('refuses a voucher dated before the treasury went live', async () => {
      await expect(spend({ paidOn: '2020-01-01', adjustmentReason: 'فاتورة قديمة' })).rejects.toMatchObject({
        code: 'EXPENSE_DATE_BEFORE_GO_LIVE',
      });
    });
  });

  // ──────────────────────────────  the register  ──────────────────────────────

  describe('the register', () => {
    it('totals the whole filtered set per currency, not just the page', async () => {
      const all = await scoped(() => expenses.list({ pageSize: 1 }));
      expect(all.vouchers).toHaveLength(1);
      expect(all.total).toBeGreaterThan(1);

      const lbp = all.totals.find((row) => row.currency === 'LBP');
      const recorded = await db.expenseVoucher.aggregate({
        where: { currency: 'LBP', voidedAt: null },
        _sum: { amount: true },
      });
      expect(lbp?.amount).toBe(Number(recorded._sum.amount ?? 0));
    });

    it('filters by category and hides cancelled vouchers unless asked', async () => {
      const byCategory = await scoped(() => expenses.list({ categoryId: fuelId, pageSize: 200 }));
      expect(byCategory.vouchers.every((voucher) => voucher.category.id === fuelId)).toBe(true);
      expect(byCategory.vouchers.every((voucher) => voucher.status === 'RECORDED')).toBe(true);
    });
  });

  // ────────────────────────────────  voiding  ────────────────────────────────

  describe('cancelling a voucher', () => {
    it('puts the money back as an opposing entry, keeping both on the record', async () => {
      const before = await balance(safeLbpId);
      const recorded = await spend({ amount: 40_000 });
      expect(await balance(safeLbpId)).toBe(before - 40_000);

      const voided = await scoped(() => expenses.void(recorded.id, 'سُجّلت على البند الخطأ', MANAGER));

      expect(voided.status).toBe('VOID');
      expect(voided.voidReason).toBe('سُجّلت على البند الخطأ');
      expect(voided.voidedByName).toBe('المدير العام');
      expect(await balance(safeLbpId)).toBe(before);

      const entries = await db.treasuryEntry.findMany({
        where: { source: 'EXPENSE_VOUCHER', sourceId: recorded.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries).toHaveLength(2);
      expect(Number(entries[0].amount)).toBe(-40_000);
      expect(Number(entries[1].amount)).toBe(40_000);
      expect(entries[1].reversalOfId).toBe(entries[0].id);
    });

    it('refuses a second cancellation', async () => {
      const recorded = await spend({ amount: 5_000 });
      await scoped(() => expenses.void(recorded.id, 'خطأ في المبلغ', MANAGER));
      await expect(scoped(() => expenses.void(recorded.id, 'مرة ثانية', MANAGER))).rejects.toMatchObject({
        code: 'EXPENSE_ALREADY_VOID',
      });
    });

    it('lets only one of two simultaneous cancellations through', async () => {
      const recorded = await spend({ amount: 3_000 });
      const results = await Promise.allSettled([
        scoped(() => expenses.void(recorded.id, 'إلغاء أول', MANAGER)),
        scoped(() => expenses.void(recorded.id, 'إلغاء ثانٍ', MANAGER)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
        code: 'EXPENSE_ALREADY_VOID',
      });
    });

    it('still returns the money when the wallet has been emptied since', async () => {
      const recorded = await spend({ accountId: safeUsdId, amount: 10 });
      // Empty the wallet the cancellation will credit, so the balance it starts
      // from is zero. Skipped when it is already empty: a zero entry is not an
      // entry, and the ledger refuses one.
      const held = await balance(safeUsdId);
      if (held > 0) {
        await scoped(() =>
          db.$transaction((tx) =>
            ledger.post(
              tx,
              [{ accountId: safeUsdId, currency: 'USD', amount: new Prisma.Decimal(-held) }],
              { source: 'ADJUSTMENT', sourceId: null, actorId: managerId, occurredAt: new Date() },
            ),
          ),
        );
      }
      expect(await balance(safeUsdId)).toBe(0);

      /*
        A cancellation *credits* the wallet, so unlike an expense it can never be
        refused for want of funds. This pins that asymmetry: the money comes back
        even into an empty wallet, and nothing about the voucher is lost.
      */
      const voided = await scoped(() => expenses.void(recorded.id, 'إلغاء بعد تفريغ الصندوق', MANAGER));
      expect(voided.status).toBe('VOID');
      expect(await balance(safeUsdId)).toBe(10);
    });

    it('refuses a voucher that does not exist', async () => {
      await expect(scoped(() => expenses.void(randomUUID(), 'لا شيء', MANAGER))).rejects.toMatchObject({
        code: 'EXPENSE_NOT_FOUND',
      });
    });

    it('audits the cancellation', async () => {
      const recorded = await spend({ amount: 2_500 });
      await scoped(() => expenses.void(recorded.id, 'مكرّرة', MANAGER));
      const rows = await db.auditLogEntry.findMany({ where: { action: 'EXPENSE_VOIDED', entityId: recorded.id } });
      expect(rows).toHaveLength(1);
    });
  });
});

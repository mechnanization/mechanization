import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient, Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { IncomeService } from './income.service';
import { TreasuryLedgerService } from './treasury-ledger.service';
import { TreasuryService } from './treasury.service';
import { listIncomeVouchersQuerySchema, municipalPeriod, municipalToday } from '@mechanization/shared-schemas';

/**
 * Income vouchers against a real Postgres.
 *
 * What only a database can prove: that the voucher and the money arrive in one
 * transaction, that the retry key holds when two identical requests really do
 * race, that a collector's custody wallet cannot be paid into, and that a void
 * refuses once the wallet has spent the money — leaving the voucher standing.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_income_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('IncomeService', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let ledger: TreasuryLedgerService;
  let income: IncomeService;
  let treasury: TreasuryService;

  let managerId: string;
  let safeLbpId: string;
  let safeUsdId: string;
  let whishUsdId: string;
  let custodyId: string;
  let fundId: string;
  let finesId: string;
  let miscId: string;

  const MANAGER = { id: '', role: 'SUPER_ADMIN' };

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'income', schemaName: SCHEMA, prisma: db }, work);

  const balance = async (accountId: string): Promise<number> =>
    Number(
      (await db.treasuryEntry.aggregate({ where: { accountId }, _sum: { amount: true } }))._sum.amount ?? 0,
    );

  const receive = (over: Partial<Parameters<IncomeService['record']>[0]> = {}) =>
    scoped(() =>
      income.record(
        {
          categoryId: fundId,
          accountId: safeLbpId,
          amount: 1_000_000,
          payerName: 'مصرف لبنان',
          description: 'حصة البلدية من الصندوق البلدي المستقل',
          clientRequestId: randomUUID(),
          ...over,
        },
        MANAGER,
      ),
    );

  const list = (query: Record<string, string> = {}) =>
    scoped(() => income.list(listIncomeVouchersQuerySchema.parse(query)));

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const auditService = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    ledger = new TreasuryLedgerService(context);
    income = new IncomeService(context, ledger, auditService);
    treasury = new TreasuryService(context, ledger, auditService);

    managerId = randomUUID();
    MANAGER.id = managerId;
    await db.user.create({
      data: {
        id: managerId,
        kind: 'STAFF',
        tenantSlug: 'income',
        email: `m-${managerId}@t.gov.lb`,
        firstName: 'المدير',
        lastName: 'العام',
        role: 'SUPER_ADMIN',
      },
    });

    const collectorId = randomUUID();
    await db.user.create({
      data: {
        id: collectorId,
        kind: 'STAFF',
        tenantSlug: 'income',
        email: `c-${collectorId}@t.gov.lb`,
        firstName: 'علي',
        lastName: 'الجابي',
        role: 'COLLECTOR',
      },
    });
    custodyId = (
      await db.treasuryAccount.create({
        data: { name: 'عهدة علي — LBP', type: 'COLLECTOR_CUSTODY', currency: 'LBP', ownerId: collectorId },
      })
    ).id;

    safeLbpId = (await db.treasuryAccount.findFirstOrThrow({ where: { type: 'CASH_SAFE', currency: 'LBP' } })).id;
    safeUsdId = (await db.treasuryAccount.findFirstOrThrow({ where: { type: 'CASH_SAFE', currency: 'USD' } })).id;
    whishUsdId = (await db.treasuryAccount.findFirstOrThrow({ where: { type: 'WHISH_ACCOUNT', currency: 'USD' } })).id;
    fundId = (await db.incomeCategory.findFirstOrThrow({ where: { key: 'INDEPENDENT_MUNICIPAL_FUND' } })).id;
    finesId = (await db.incomeCategory.findFirstOrThrow({ where: { key: 'FINES_AND_PENALTIES' } })).id;
    miscId = (await db.incomeCategory.findFirstOrThrow({ where: { key: 'MISCELLANEOUS_INCOME' } })).id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  // ───────────────────────────────  the schema  ───────────────────────────────

  describe('the schema (migration 0080)', () => {
    it('seeds the seven agreed categories, in their agreed order, each with both names', async () => {
      const rows = await db.incomeCategory.findMany({
        orderBy: { sortOrder: 'asc' },
        select: { key: true, labelAr: true, labelEn: true, chapterCode: true },
      });
      expect(rows.map((row) => row.key)).toEqual([
        'INDEPENDENT_MUNICIPAL_FUND',
        'STATE_UTILITIES_FEES',
        'BUILDING_PERMITS_PLANNING',
        'PROPERTY_RENTAL_INVESTMENT',
        'UNCONDITIONAL_GRANTS_DONATIONS',
        'FINES_AND_PENALTIES',
        'MISCELLANEOUS_INCOME',
      ]);
      expect(rows.every((row) => row.labelAr.length > 0 && Boolean(row.labelEn))).toBe(true);
      // The budget codes are the municipality's: nothing seeds an invented one.
      expect(rows.every((row) => row.chapterCode === null)).toBe(true);
    });

    const raw = (over: Partial<Prisma.IncomeVoucherUncheckedCreateInput> = {}) =>
      db.incomeVoucher.create({
        data: {
          voucherNumber: `X-${randomUUID().slice(0, 8)}`,
          categoryId: fundId,
          accountId: safeLbpId,
          currency: 'LBP',
          amount: 5,
          description: 'x',
          clientRequestId: randomUUID(),
          ...over,
        },
      });

    it('refuses a voucher whose currency is not its wallet’s', async () => {
      await expect(raw({ currency: 'USD' })).rejects.toThrow();
    });

    it('refuses a zero amount, a blank description and a blank payer', async () => {
      await expect(raw({ amount: 0 })).rejects.toThrow();
      await expect(raw({ description: '   ' })).rejects.toThrow();
      await expect(raw({ payerName: '  ' })).rejects.toThrow();
    });

    it('refuses a void stamp with no reason', async () => {
      await expect(raw({ voidedAt: new Date() })).rejects.toThrow();
    });

    it('refuses a voucher with no retry key', async () => {
      await expect(
        ddl.query(
          `INSERT INTO "${SCHEMA}".income_vouchers ("voucherNumber", "categoryId", "accountId", "currency", "amount", "description")
           VALUES ('X-nokey', $1, $2, 'LBP', 5, 'x')`,
          [fundId, safeLbpId],
        ),
      ).rejects.toThrow(/clientRequestId/);
    });
  });

  // ──────────────────────────  managing categories  ──────────────────────────

  describe('the municipality’s own categories', () => {
    it('adds one, with no key and at the end of the list', async () => {
      const created = await scoped(() => income.createCategory({ labelAr: 'رسوم استعمال الملعب البلدي' }, MANAGER));

      expect(created).toMatchObject({ key: null, active: true, labelEn: null, chapterCode: null });
      const listed = await scoped(() => income.categories());
      expect(listed.at(-1)?.id).toBe(created.id);
    });

    it('keeps an English name and budget codes it is given', async () => {
      const created = await scoped(() =>
        income.createCategory(
          { labelAr: 'رسوم المسلخ', labelEn: 'Slaughterhouse fees', chapterCode: '7', itemCode: '120' },
          MANAGER,
        ),
      );
      expect(created).toMatchObject({ labelEn: 'Slaughterhouse fees', chapterCode: '7', itemCode: '120' });
    });

    it('refuses a second category on the same budget article', async () => {
      await expect(
        scoped(() => income.createCategory({ labelAr: 'بند آخر', chapterCode: '7', itemCode: '120' }, MANAGER)),
      ).rejects.toMatchObject({ code: 'INCOME_CATEGORY_CODE_TAKEN' });
    });

    it('renames one, and stops it without deleting it', async () => {
      const created = await scoped(() => income.createCategory({ labelAr: 'بند مؤقت' }, MANAGER));
      const updated = await scoped(() =>
        income.updateCategory(created.id, { labelAr: 'بند مؤقت — مُعدّل', active: false }, MANAGER),
      );

      expect(updated).toMatchObject({ labelAr: 'بند مؤقت — مُعدّل', active: false });
      // Gone from the working list, still there for the vouchers that point at it.
      expect((await scoped(() => income.categories())).some((c) => c.id === created.id)).toBe(false);
      expect((await scoped(() => income.categories(true))).some((c) => c.id === created.id)).toBe(true);
    });

    /*
      The expense twin's edit defaults `active` to true, so renaming a stopped
      category there restarts it. This one keeps what the category had.
    */
    it('does not restart a stopped category when it is only renamed', async () => {
      const created = await scoped(() => income.createCategory({ labelAr: 'بند متوقف' }, MANAGER));
      await scoped(() => income.updateCategory(created.id, { labelAr: 'بند متوقف', active: false }, MANAGER));
      const renamed = await scoped(() => income.updateCategory(created.id, { labelAr: 'بند متوقّف' }, MANAGER));
      expect(renamed.active).toBe(false);
    });

    it('restarts a stopped category when asked to', async () => {
      const created = await scoped(() => income.createCategory({ labelAr: 'بند يعود' }, MANAGER));
      await scoped(() => income.updateCategory(created.id, { labelAr: 'بند يعود', active: false }, MANAGER));
      const restarted = await scoped(() =>
        income.updateCategory(created.id, { labelAr: 'بند يعود', active: true }, MANAGER),
      );
      expect(restarted.active).toBe(true);
    });

    /*
      An edit carries the category's whole content, as the form holds it: a
      field sent empty or left out is cleared. Only `active`, a state rather
      than content, is kept when it is not sent.
    */
    it('replaces the names and codes as a whole: an empty or absent one is cleared', async () => {
      const created = await scoped(() =>
        income.createCategory({ labelAr: 'بند للمسح', labelEn: 'To clear', chapterCode: '9', itemCode: '1' }, MANAGER),
      );
      const cleared = await scoped(() => income.updateCategory(created.id, { labelAr: 'بند للمسح', labelEn: '' }, MANAGER));
      expect(cleared).toMatchObject({ labelEn: null, chapterCode: null, itemCode: null });
    });

    it('refuses to edit one that does not exist', async () => {
      await expect(
        scoped(() => income.updateCategory(randomUUID(), { labelAr: 'لا شيء' }, MANAGER)),
      ).rejects.toMatchObject({ code: 'INCOME_CATEGORY_NOT_FOUND' });
    });

    it('audits both acts, with the state before and after an edit', async () => {
      const created = await scoped(() => income.createCategory({ labelAr: 'بند للتدقيق' }, MANAGER));
      await scoped(() => income.updateCategory(created.id, { labelAr: 'بند للتدقيق 2', active: false }, MANAGER));

      expect(
        await db.auditLogEntry.count({ where: { action: 'INCOME_CATEGORY_CREATED', entityId: created.id } }),
      ).toBe(1);
      const edits = await db.auditLogEntry.findMany({
        where: { action: 'INCOME_CATEGORY_UPDATED', entityId: created.id },
      });
      expect(edits).toHaveLength(1);
      expect(edits[0].before).toMatchObject({ labelAr: 'بند للتدقيق', active: true });
      expect(edits[0].after).toMatchObject({ labelAr: 'بند للتدقيق 2', active: false });
    });
  });

  // ─────────────────────  before the treasury is live  ─────────────────────

  describe('before the treasury is live', () => {
    it('records nothing: there is no counted wallet to receive into', async () => {
      await expect(receive()).rejects.toMatchObject({ code: 'TREASURY_NOT_ACTIVE' });
      expect(await db.incomeVoucher.count()).toBe(0);
    });
  });

  // ────────────────────────────  recording  ────────────────────────────────

  describe('recording income', () => {
    beforeAll(async () => {
      const accounts = await db.treasuryAccount.findMany({ where: { type: { not: 'COLLECTOR_CUSTODY' } } });
      await scoped(() =>
        treasury.activate(
          {
            balances: accounts.map((account) => ({
              accountId: account.id,
              amount: account.currency === 'LBP' ? 2_000_000 : 100,
            })),
          },
          MANAGER,
        ),
      );
    }, SETUP_TIMEOUT_MS);

    it('writes the voucher and credits the wallet, together', async () => {
      const before = await balance(safeLbpId);
      const result = await receive({ amount: 750_000 });

      expect(result.voucherNumber).toMatch(new RegExp(`^RV-${municipalPeriod()}-\\d{4}$`));
      expect(result.replayed).toBe(false);
      expect(await balance(safeLbpId)).toBe(before + 750_000);
      expect(result.balanceAfter).toBe(before + 750_000);

      const entries = await db.treasuryEntry.findMany({ where: { source: 'INCOME_VOUCHER', sourceId: result.id } });
      expect(entries).toHaveLength(1);
      expect(Number(entries[0].amount)).toBe(750_000);
      expect(entries[0].accountId).toBe(safeLbpId);
    });

    it('numbers the month’s vouchers one after another', async () => {
      const first = await receive({ amount: 1 });
      const second = await receive({ amount: 1 });
      const counter = (n: string) => Number(n.split('-')[2]);
      expect(counter(second.voucherNumber)).toBe(counter(first.voucherNumber) + 1);
    });

    it('takes the currency from the wallet, not from the request', async () => {
      const result = await receive({ accountId: whishUsdId, amount: 250 });
      const voucher = await scoped(() => income.get(result.id));
      expect(voucher.currency).toBe('USD');
      expect(voucher.account.id).toBe(whishUsdId);
    });

    it('writes a Tier 1 audit row that does not carry the payer', async () => {
      const result = await receive({ amount: 1_000, payerName: 'سعاد خليل' });
      const rows = await db.auditLogEntry.findMany({ where: { action: 'INCOME_RECORDED', entityId: result.id } });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0].after)).not.toContain('سعاد');
      expect(rows[0].after).toMatchObject({ voucherNumber: result.voucherNumber });
    });

    it('answers a retry from the first voucher, and credits once', async () => {
      const before = await balance(safeLbpId);
      const clientRequestId = randomUUID();
      const first = await receive({ amount: 7_000, clientRequestId });
      const again = await receive({ amount: 7_000, clientRequestId });

      expect(again.voucherNumber).toBe(first.voucherNumber);
      expect(again.replayed).toBe(true);
      expect(await balance(safeLbpId)).toBe(before + 7_000);
    });

    /*
      The race the advisory lock exists for: two identical requests in flight at
      once. Without it both read "no voucher yet", and the second insert dies on
      the unique index as an unmapped 500. With it, the second waits, then finds
      the first.
    */
    it('credits once when two identical requests race', async () => {
      const before = await balance(safeLbpId);
      const clientRequestId = randomUUID();
      const results = await Promise.all([
        receive({ amount: 3_000, clientRequestId }),
        receive({ amount: 3_000, clientRequestId }),
      ]);

      expect(new Set(results.map((r) => r.voucherNumber)).size).toBe(1);
      expect(results.filter((r) => r.replayed)).toHaveLength(1);
      expect(await balance(safeLbpId)).toBe(before + 3_000);
      expect(await db.incomeVoucher.count({ where: { clientRequestId } })).toBe(1);
    });

    it('refuses a collector’s custody wallet, and leaves nothing behind', async () => {
      const before = await db.incomeVoucher.count();
      await expect(receive({ accountId: custodyId })).rejects.toMatchObject({
        code: 'INCOME_ACCOUNT_NOT_RECEIVING',
      });
      expect(await db.incomeVoucher.count()).toBe(before);
      expect(await balance(custodyId)).toBe(0);
    });

    it('refuses an inactive category', async () => {
      await db.incomeCategory.update({ where: { id: miscId }, data: { active: false } });
      await expect(receive({ categoryId: miscId })).rejects.toMatchObject({ code: 'INCOME_CATEGORY_INACTIVE' });
      await db.incomeCategory.update({ where: { id: miscId }, data: { active: true } });
    });

    it('refuses a category that does not exist', async () => {
      await expect(receive({ categoryId: randomUUID() })).rejects.toMatchObject({
        code: 'INCOME_CATEGORY_NOT_FOUND',
      });
    });

    it('records under a category the municipality added itself', async () => {
      const own = await scoped(() => income.createCategory({ labelAr: 'إيجار قاعة البلدية' }, MANAGER));
      const result = await receive({ categoryId: own.id, amount: 300_000 });
      const voucher = await scoped(() => income.get(result.id));
      expect(voucher.category).toMatchObject({ id: own.id, labelAr: 'إيجار قاعة البلدية', labelEn: null });
    });

    it('refuses a wallet that does not exist', async () => {
      await expect(receive({ accountId: randomUUID() })).rejects.toMatchObject({
        code: 'TREASURY_ACCOUNT_NOT_FOUND',
      });
    });

    it('refuses a voucher dated before the treasury went live', async () => {
      await expect(receive({ receivedOn: '2020-01-01', adjustmentReason: 'تحويل قديم' })).rejects.toMatchObject({
        code: 'INCOME_DATE_BEFORE_GO_LIVE',
      });
    });

    it('refuses a voucher dated after today', async () => {
      await expect(receive({ receivedOn: '2999-01-01' })).rejects.toMatchObject({ code: 'INCOME_DATE_IN_FUTURE' });
    });
  });

  // ──────────────────────────────  the register  ──────────────────────────────

  describe('the register', () => {
    it('totals the whole filtered set per currency, not just the page', async () => {
      const all = await list({ pageSize: '1' });
      expect(all.vouchers).toHaveLength(1);
      expect(all.total).toBeGreaterThan(1);

      const lbp = all.totals.find((row) => row.currency === 'LBP');
      const recorded = await db.incomeVoucher.aggregate({
        where: { currency: 'LBP', voidedAt: null },
        _sum: { amount: true },
      });
      expect(lbp?.amount).toBe(Number(recorded._sum.amount ?? 0));
    });

    it('filters by category, currency and a search over the payer', async () => {
      await receive({ categoryId: finesId, amount: 50_000, payerName: 'مخالفة بناء — حي الزهراء' });

      const fines = await list({ categoryId: finesId });
      expect(fines.vouchers.length).toBeGreaterThan(0);
      expect(fines.vouchers.every((voucher) => voucher.category.id === finesId)).toBe(true);

      const dollars = await list({ currency: 'USD' });
      expect(dollars.vouchers.every((voucher) => voucher.currency === 'USD')).toBe(true);

      const found = await list({ search: 'الزهراء' });
      expect(found.vouchers.map((voucher) => voucher.payerName)).toContain('مخالفة بناء — حي الزهراء');
    });

    it('covers today in a period ending today, and nothing in one that ended before', async () => {
      const today = municipalToday();
      const inPeriod = await list({ from: today, to: today });
      expect(inPeriod.total).toBeGreaterThan(0);

      const long = await list({ from: '2020-01-01', to: '2020-12-31' });
      expect(long.total).toBe(0);
    });
  });

  // ────────────────────────────────  voiding  ────────────────────────────────

  describe('cancelling a voucher', () => {
    it('takes the money back out as an opposing entry, keeping both on the record', async () => {
      const before = await balance(safeLbpId);
      const recorded = await receive({ amount: 40_000 });
      expect(await balance(safeLbpId)).toBe(before + 40_000);

      const voided = await scoped(() => income.void(recorded.id, 'سُجّل على البند الخطأ', MANAGER));

      expect(voided.status).toBe('VOID');
      expect(voided.voidReason).toBe('سُجّل على البند الخطأ');
      expect(voided.voidedByName).toBe('المدير العام');
      expect(await balance(safeLbpId)).toBe(before);

      const entries = await db.treasuryEntry.findMany({
        where: { source: 'INCOME_VOUCHER', sourceId: recorded.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries).toHaveLength(2);
      expect(Number(entries[0].amount)).toBe(40_000);
      expect(Number(entries[1].amount)).toBe(-40_000);
      expect(entries[1].reversalOfId).toBe(entries[0].id);
    });

    it('drops a cancelled voucher from the totals, and lists it only when asked', async () => {
      const recorded = await receive({ accountId: safeUsdId, amount: 11 });
      await scoped(() => income.void(recorded.id, 'تكرار في التسجيل', MANAGER));

      const visible = await list({ currency: 'USD' });
      expect(visible.vouchers.some((voucher) => voucher.id === recorded.id)).toBe(false);

      const withVoid = await list({ currency: 'USD', includeVoid: 'true' });
      expect(withVoid.vouchers.find((voucher) => voucher.id === recorded.id)?.status).toBe('VOID');
      expect(withVoid.totals).toEqual(visible.totals);
    });

    it('refuses a second cancellation', async () => {
      const recorded = await receive({ amount: 5_000 });
      await scoped(() => income.void(recorded.id, 'خطأ في المبلغ', MANAGER));
      await expect(scoped(() => income.void(recorded.id, 'مرة ثانية', MANAGER))).rejects.toMatchObject({
        code: 'INCOME_VOUCHER_ALREADY_VOIDED',
      });
    });

    it('lets only one of two simultaneous cancellations through', async () => {
      const recorded = await receive({ amount: 3_000 });
      const results = await Promise.allSettled([
        scoped(() => income.void(recorded.id, 'إلغاء أول', MANAGER)),
        scoped(() => income.void(recorded.id, 'إلغاء ثانٍ', MANAGER)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
        code: 'INCOME_VOUCHER_ALREADY_VOIDED',
      });
    });

    /*
      The asymmetry with expenses: cancelling income takes money *out*, and the
      wallet may have spent it since. docs/finance.md §4.4 — blocked, with the
      figures named, and the voucher left exactly as it was.
    */
    it('refuses when the wallet has spent the money since, and leaves the voucher standing', async () => {
      const recorded = await receive({ accountId: safeUsdId, amount: 30 });
      const held = await balance(safeUsdId);
      await scoped(() =>
        db.$transaction((tx) =>
          ledger.post(
            tx,
            [{ accountId: safeUsdId, currency: 'USD', amount: new Prisma.Decimal(-(held - 10)) }],
            { source: 'ADJUSTMENT', sourceId: null, actorId: managerId, occurredAt: new Date() },
          ),
        ),
      );
      expect(await balance(safeUsdId)).toBe(10);

      await expect(scoped(() => income.void(recorded.id, 'إلغاء بعد الصرف', MANAGER))).rejects.toMatchObject({
        code: 'TREASURY_INSUFFICIENT_FUNDS_FOR_VOID',
        params: { voucher: recorded.voucherNumber, available: 10, required: 30 },
      });

      const voucher = await scoped(() => income.get(recorded.id));
      expect(voucher.status).toBe('RECORDED');
      expect(await balance(safeUsdId)).toBe(10);
    });

    it('refuses a voucher that does not exist', async () => {
      await expect(scoped(() => income.void(randomUUID(), 'لا شيء هنا', MANAGER))).rejects.toMatchObject({
        code: 'INCOME_VOUCHER_NOT_FOUND',
      });
    });

    it('audits the cancellation', async () => {
      const recorded = await receive({ amount: 2_500 });
      await scoped(() => income.void(recorded.id, 'مكرّرة', MANAGER));
      const rows = await db.auditLogEntry.findMany({ where: { action: 'INCOME_VOIDED', entityId: recorded.id } });
      expect(rows).toHaveLength(1);
    });
  });
});

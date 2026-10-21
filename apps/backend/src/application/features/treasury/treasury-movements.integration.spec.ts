import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  listTreasuryMovementsQuerySchema,
  type ExpenseVoucherView,
  type IncomeVoucherView,
  type TreasuryMovementsResult,
} from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { ExpensesService } from './expenses.service';
import { IncomeService } from './income.service';
import { TreasuryLedgerService } from './treasury-ledger.service';
import { TreasuryMovementsService } from './treasury-movements.service';

/**
 * «الإيرادات والنفقات» against a real Postgres.
 *
 * What only a database can prove: that the two tables interleave in one order
 * with a tie-break that holds across them, that a day is Beirut's and not
 * UTC's, that `%` and `_` in a search are literals, and that the figures are
 * the filtered set's — cancelled vouchers listed on request and never counted,
 * a day whole on every page it reaches.
 *
 * The vouchers are written straight into the tables: this is a reader, and
 * what it reads is the rows, not how they were recorded.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_treasury_movements_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

// Four municipal days in June, when Beirut is UTC+3.
const D0 = '2026-06-07';
const D1 = '2026-06-08';
const D2 = '2026-06-09';
const D3 = '2026-06-10';

/** Two ids that order the same-instant, same-`createdAt` pair on D2: the expense's is the greater. */
const HIGH_ID = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
const LOW_ID = '00000000-0000-4000-8000-000000000001';

describeIfDb('TreasuryMovementsService', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let income: IncomeService;
  let expenses: ExpensesService;
  let movements: TreasuryMovementsService;

  let managerId: string;
  let safeLbpId: string;
  let safeUsdId: string;
  let whishUsdId: string;
  let fundId: string;
  let finesId: string;
  let incomeMiscId: string;
  let fuelId: string;
  let expenseMiscId: string;

  /** Fixture name → voucher id, and back. */
  const ids = new Map<string, string>();
  const names = new Map<string, string>();

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'movements', schemaName: SCHEMA, prisma: db }, work);

  const list = (query: Record<string, string> = {}): Promise<TreasuryMovementsResult> =>
    scoped(() => movements.list(listTreasuryMovementsQuerySchema.parse({ pageSize: '50', ...query })));

  /** The page as fixture names, in order. */
  const keys = (result: TreasuryMovementsResult): string[] =>
    result.movements.map((movement) => names.get(movement.voucher.id) ?? `?${movement.voucher.id}`);

  async function incomeVoucher(
    name: string,
    over: {
      occurredAt: string;
      accountId: string;
      currency: string;
      categoryId: string;
      amount: number;
      description: string;
      payerName?: string;
      externalReference?: string;
      createdAt?: string;
      id?: string;
      voided?: boolean;
    },
  ): Promise<void> {
    const row = await db.incomeVoucher.create({
      data: {
        ...(over.id ? { id: over.id } : {}),
        voucherNumber: `RV-2606-${String(ids.size + 1).padStart(4, '0')}`,
        categoryId: over.categoryId,
        accountId: over.accountId,
        currency: over.currency,
        amount: over.amount,
        payerName: over.payerName ?? null,
        description: over.description,
        externalReference: over.externalReference ?? null,
        occurredAt: new Date(over.occurredAt),
        ...(over.createdAt ? { createdAt: new Date(over.createdAt) } : {}),
        recordedById: managerId,
        clientRequestId: randomUUID(),
        ...(over.voided
          ? { voidedAt: new Date('2026-06-11T08:00:00Z'), voidedById: managerId, voidReason: 'سُجّل خطأً' }
          : {}),
      },
      select: { id: true },
    });
    ids.set(name, row.id);
    names.set(row.id, name);
  }

  async function expenseVoucher(
    name: string,
    over: {
      occurredAt: string;
      accountId: string;
      currency: string;
      categoryId: string;
      amount: number;
      payee: string;
      description: string;
      invoiceNumber?: string;
      createdAt?: string;
      id?: string;
      voided?: boolean;
    },
  ): Promise<void> {
    const row = await db.expenseVoucher.create({
      data: {
        ...(over.id ? { id: over.id } : {}),
        voucherNumber: `PV-2606-${String(ids.size + 1).padStart(4, '0')}`,
        categoryId: over.categoryId,
        accountId: over.accountId,
        currency: over.currency,
        amount: over.amount,
        payee: over.payee,
        description: over.description,
        invoiceNumber: over.invoiceNumber ?? null,
        occurredAt: new Date(over.occurredAt),
        ...(over.createdAt ? { createdAt: new Date(over.createdAt) } : {}),
        recordedById: managerId,
        orderedAt: new Date(over.occurredAt),
        orderedById: managerId,
        ...(over.voided
          ? { voidedAt: new Date('2026-06-11T08:00:00Z'), voidedById: managerId, voidReason: 'سُجّل خطأً' }
          : {}),
      },
      select: { id: true },
    });
    ids.set(name, row.id);
    names.set(row.id, name);
  }

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const auditService = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    const ledger = new TreasuryLedgerService(context);
    income = new IncomeService(context, ledger, auditService);
    expenses = new ExpensesService(context, ledger, auditService);
    movements = new TreasuryMovementsService(context, income, expenses);

    managerId = randomUUID();
    await db.user.create({
      data: {
        id: managerId,
        kind: 'STAFF',
        tenantSlug: 'movements',
        email: `m-${managerId}@t.gov.lb`,
        firstName: 'المدير',
        lastName: 'العام',
        role: 'SUPER_ADMIN',
      },
    });

    safeLbpId = (await db.treasuryAccount.findFirstOrThrow({ where: { type: 'CASH_SAFE', currency: 'LBP' } })).id;
    safeUsdId = (await db.treasuryAccount.findFirstOrThrow({ where: { type: 'CASH_SAFE', currency: 'USD' } })).id;
    whishUsdId = (await db.treasuryAccount.findFirstOrThrow({ where: { type: 'WHISH_ACCOUNT', currency: 'USD' } })).id;
    fundId = (await db.incomeCategory.findFirstOrThrow({ where: { key: 'INDEPENDENT_MUNICIPAL_FUND' } })).id;
    finesId = (await db.incomeCategory.findFirstOrThrow({ where: { key: 'FINES_AND_PENALTIES' } })).id;
    incomeMiscId = (await db.incomeCategory.findFirstOrThrow({ where: { key: 'MISCELLANEOUS_INCOME' } })).id;
    fuelId = (await db.expenseCategory.findFirstOrThrow({ where: { key: 'FUEL' } })).id;
    expenseMiscId = (await db.expenseCategory.findFirstOrThrow({ where: { key: 'MISC' } })).id;

    const lbp = { accountId: safeLbpId, currency: 'LBP' };
    const usd = { accountId: safeUsdId, currency: 'USD' };

    // D3, 2026-06-10. One minute before Beirut's midnight: still D3, though UTC is past 20:59.
    await incomeVoucher('I8', {
      ...lbp,
      occurredAt: '2026-06-10T20:59:00Z',
      categoryId: fundId,
      amount: 5_000,
      payerName: 'اتحاد البلديات',
      description: 'رسوم متأخرة',
    });
    // The same instant on both tables, as two back-dated vouchers at a nominal midday: `createdAt` orders them.
    await incomeVoucher('I2', {
      ...usd,
      occurredAt: '2026-06-10T12:00:00Z',
      createdAt: '2026-06-11T09:00:02Z',
      categoryId: finesId,
      amount: 50,
      payerName: 'Ali Haidar',
      externalReference: 'CHQ_77',
      description: 'غرامة مخالفة بناء',
    });
    await expenseVoucher('E2', {
      ...usd,
      occurredAt: '2026-06-10T12:00:00Z',
      createdAt: '2026-06-11T09:00:01Z',
      categoryId: expenseMiscId,
      amount: 20,
      payee: 'Hardware Co',
      description: 'مسامير',
    });
    // `CHQX77` is what an unescaped `_` would also match.
    await expenseVoucher('E1', {
      ...lbp,
      occurredAt: '2026-06-10T08:00:00Z',
      categoryId: fuelId,
      amount: 400_000,
      payee: 'محطة الأمل',
      description: 'مازوت',
      invoiceNumber: 'CHQX77',
    });
    await incomeVoucher('I1', {
      ...lbp,
      occurredAt: '2026-06-10T07:00:00Z',
      categoryId: fundId,
      amount: 1_000_000,
      payerName: 'مصرف لبنان',
      description: 'حصة الصندوق',
    });

    // D2, 2026-06-09. Same instant and same `createdAt`: only the id orders them.
    await expenseVoucher('E3', {
      ...usd,
      id: HIGH_ID,
      occurredAt: '2026-06-09T12:00:00Z',
      createdAt: '2026-06-11T09:00:00Z',
      categoryId: fuelId,
      amount: 30,
      payee: 'Total',
      // `1000` is what an unescaped `%` after `100` would also match.
      description: 'بنزين 1000 ليتر',
    });
    await incomeVoucher('I3', {
      accountId: whishUsdId,
      currency: 'USD',
      id: LOW_ID,
      occurredAt: '2026-06-09T12:00:00Z',
      createdAt: '2026-06-11T09:00:00Z',
      categoryId: fundId,
      amount: 200,
      description: 'تحويل 100% من الصندوق',
    });
    await incomeVoucher('I4', {
      ...lbp,
      occurredAt: '2026-06-09T06:00:00Z',
      categoryId: finesId,
      amount: 300_000,
      description: 'غرامة ملغاة',
      voided: true,
    });

    // D1, 2026-06-08. I5 is on the 7th in UTC and on the 8th in Beirut.
    await expenseVoucher('E6', {
      ...lbp,
      occurredAt: '2026-06-08T10:00:00Z',
      categoryId: expenseMiscId,
      amount: 10_000,
      payee: 'مكتبة البلدية',
      description: 'قرطاسية',
    });
    await expenseVoucher('E4', {
      ...lbp,
      occurredAt: '2026-06-08T09:00:00Z',
      categoryId: expenseMiscId,
      amount: 99_000,
      payee: 'x',
      description: 'نفقة ملغاة',
      voided: true,
    });
    await incomeVoucher('I5', {
      ...lbp,
      occurredAt: '2026-06-07T22:30:00Z',
      categoryId: incomeMiscId,
      amount: 70_000,
      description: 'بيع خردة',
    });

    // D0, 2026-06-07: one minute before D1 begins in Beirut.
    await incomeVoucher('I9', {
      ...lbp,
      occurredAt: '2026-06-07T20:59:00Z',
      categoryId: incomeMiscId,
      amount: 1,
      description: 'تسوية',
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  const EVERY_LIVE = ['I8', 'I2', 'E2', 'E1', 'I1', 'E3', 'I3', 'E6', 'I5', 'I9'];

  describe('the order', () => {
    it('interleaves both tables newest first, breaking a tie by createdAt and then by id', async () => {
      const result = await list();
      expect(keys(result)).toEqual(EVERY_LIVE);
      expect(result.movements.map((movement) => movement.direction)).toEqual([
        'IN',
        'IN',
        'OUT',
        'OUT',
        'IN',
        'OUT',
        'IN',
        'OUT',
        'IN',
        'IN',
      ]);
    });

    it('puts each voucher on its Beirut day, not its UTC date', async () => {
      const result = await list();
      expect(result.movements.map((movement) => [names.get(movement.voucher.id), movement.day])).toEqual([
        ['I8', D3],
        ['I2', D3],
        ['E2', D3],
        ['E1', D3],
        ['I1', D3],
        ['E3', D2],
        ['I3', D2],
        ['E6', D1],
        ['I5', D1],
        ['I9', D0],
      ]);
    });

    it('carries each voucher exactly as its own register shows it', async () => {
      const result = await list({ includeVoid: 'true' });
      for (const movement of result.movements) {
        const own = await scoped<IncomeVoucherView | ExpenseVoucherView>(() =>
          movement.direction === 'IN' ? income.get(movement.voucher.id) : expenses.get(movement.voucher.id),
        );
        expect(movement.voucher).toEqual(own);
      }
    });
  });

  describe('the figures', () => {
    it('counts every match and sums each currency in and out, cancelled vouchers excluded', async () => {
      const result = await list();
      expect(result.total).toBe(10);
      expect(result.totals).toEqual([
        { currency: 'LBP', amountIn: 1_075_001, amountOut: 410_000 },
        { currency: 'USD', amountIn: 250, amountOut: 50 },
      ]);
    });

    it('gives each listed day its whole totals, newest first', async () => {
      const result = await list();
      expect(result.days).toEqual([
        {
          day: D3,
          totals: [
            { currency: 'LBP', amountIn: 1_005_000, amountOut: 400_000 },
            { currency: 'USD', amountIn: 50, amountOut: 20 },
          ],
        },
        // I4 was cancelled: no LBP line on D2.
        { day: D2, totals: [{ currency: 'USD', amountIn: 200, amountOut: 30 }] },
        { day: D1, totals: [{ currency: 'LBP', amountIn: 70_000, amountOut: 10_000 }] },
        { day: D0, totals: [{ currency: 'LBP', amountIn: 1, amountOut: 0 }] },
      ]);
    });

    it('lists cancelled vouchers on request and still never counts them', async () => {
      const result = await list({ includeVoid: 'true' });
      expect(keys(result)).toEqual(['I8', 'I2', 'E2', 'E1', 'I1', 'E3', 'I3', 'I4', 'E6', 'E4', 'I5', 'I9']);
      expect(result.total).toBe(12);
      const voided = result.movements.filter((movement) => movement.voucher.status === 'VOID');
      expect(voided.map((movement) => names.get(movement.voucher.id))).toEqual(['I4', 'E4']);
      expect(result.totals).toEqual((await list()).totals);
      expect(result.days).toEqual((await list()).days);
    });

    it('counts a currency whose only matches are cancelled, with no line in the totals', async () => {
      const result = await list({ includeVoid: 'true', direction: 'IN', categoryId: finesId, currency: 'LBP' });
      expect(keys(result)).toEqual(['I4']);
      expect(result.total).toBe(1);
      expect(result.totals).toEqual([]);
      expect(result.days).toEqual([{ day: D2, totals: [] }]);
    });
  });

  describe('the pages', () => {
    it('splits the register across pages and keeps a split day whole on both', async () => {
      const first = await list({ pageSize: '3', page: '1' });
      const second = await list({ pageSize: '3', page: '2' });
      const third = await list({ pageSize: '3', page: '3' });
      const fourth = await list({ pageSize: '3', page: '4' });
      const past = await list({ pageSize: '3', page: '5' });

      expect([...keys(first), ...keys(second), ...keys(third), ...keys(fourth)]).toEqual(EVERY_LIVE);
      expect(keys(past)).toEqual([]);
      for (const page of [first, second, third, fourth, past]) expect(page.total).toBe(10);

      const d3 = {
        day: D3,
        totals: [
          { currency: 'LBP', amountIn: 1_005_000, amountOut: 400_000 },
          { currency: 'USD', amountIn: 50, amountOut: 20 },
        ],
      };
      // D3 runs over pages one and two; D2 over two and three. Each reads whole wherever it appears.
      expect(first.days).toEqual([d3]);
      expect(second.days).toEqual([d3, { day: D2, totals: [{ currency: 'USD', amountIn: 200, amountOut: 30 }] }]);
      expect(third.days).toEqual([
        { day: D2, totals: [{ currency: 'USD', amountIn: 200, amountOut: 30 }] },
        { day: D1, totals: [{ currency: 'LBP', amountIn: 70_000, amountOut: 10_000 }] },
      ]);
      expect(past.days).toEqual([]);
      // The totals are the filtered set's on every page.
      expect(third.totals).toEqual(first.totals);
    });

    it('serves the last page the schema allows, and refuses one past it before any SQL', async () => {
      // The largest offset the server can be asked to bind: still a number Postgres reads, not a 500.
      const last = await list({ page: '1000000', pageSize: '200' });
      expect(last.movements).toEqual([]);
      expect(last.total).toBe(10);
      expect(last.days).toEqual([]);
      for (const page of ['1000001', '1e20', '99999999999999999999']) {
        expect(listTreasuryMovementsQuerySchema.safeParse({ page }).success).toBe(false);
      }
    });
  });

  describe('the filters', () => {
    it('reads one table alone by direction', async () => {
      const incoming = await list({ direction: 'IN' });
      expect(keys(incoming)).toEqual(['I8', 'I2', 'I1', 'I3', 'I5', 'I9']);
      expect(incoming.total).toBe(6);
      expect(incoming.totals).toEqual([
        { currency: 'LBP', amountIn: 1_075_001, amountOut: 0 },
        { currency: 'USD', amountIn: 250, amountOut: 0 },
      ]);

      const outgoing = await list({ direction: 'OUT' });
      expect(keys(outgoing)).toEqual(['E2', 'E1', 'E3', 'E6']);
      expect(outgoing.totals).toEqual([
        { currency: 'LBP', amountIn: 0, amountOut: 410_000 },
        { currency: 'USD', amountIn: 0, amountOut: 50 },
      ]);
      expect(outgoing.days.find((day) => day.day === D3)?.totals).toEqual([
        { currency: 'LBP', amountIn: 0, amountOut: 400_000 },
        { currency: 'USD', amountIn: 0, amountOut: 20 },
      ]);
    });

    it('narrows both tables to one wallet', async () => {
      expect(keys(await list({ accountId: safeUsdId }))).toEqual(['I2', 'E2', 'E3']);
      expect(keys(await list({ accountId: whishUsdId }))).toEqual(['I3']);
    });

    it('narrows to a category of the direction asked for, and refuses one without a direction', async () => {
      expect(keys(await list({ direction: 'OUT', categoryId: fuelId }))).toEqual(['E1', 'E3']);
      expect(keys(await list({ direction: 'IN', categoryId: finesId }))).toEqual(['I2']);
      expect(keys(await list({ direction: 'IN', categoryId: finesId, includeVoid: 'true' }))).toEqual(['I2', 'I4']);
      expect(listTreasuryMovementsQuerySchema.safeParse({ categoryId: fuelId }).success).toBe(false);
    });

    it('narrows both tables to one currency', async () => {
      const result = await list({ currency: 'USD' });
      expect(keys(result)).toEqual(['I2', 'E2', 'E3', 'I3']);
      expect(result.totals).toEqual([{ currency: 'USD', amountIn: 250, amountOut: 50 }]);
    });

    it('reads from and to as Beirut days, both inclusive', async () => {
      // I5 is on the 7th in UTC and in; I9 is on the 7th in Beirut and out.
      expect(keys(await list({ from: D1, to: D2 }))).toEqual(['E3', 'I3', 'E6', 'I5']);
      // I8, at 23:59 in Beirut, is the last minute of D3 and in.
      expect(keys(await list({ from: D3, to: D3 }))).toEqual(['I8', 'I2', 'E2', 'E1', 'I1']);
      expect(keys(await list({ to: D0 }))).toEqual(['I9']);
    });

    it('searches each table through its own columns, without regard to case', async () => {
      // The payer and the payee.
      expect(keys(await list({ search: 'ali haidar' }))).toEqual(['I2']);
      expect(keys(await list({ search: 'HARDWARE' }))).toEqual(['E2']);
      // One term found on both tables: a payer on one, a payee on the other.
      expect(keys(await list({ search: 'البلدي' }))).toEqual(['I8', 'E6']);
      // The voucher number, cancelled ones left out unless asked for.
      expect(keys(await list({ search: 'pv-2606' }))).toEqual(['E2', 'E1', 'E3', 'E6']);
      // The description.
      expect(keys(await list({ search: 'مازوت' }))).toEqual(['E1']);
      // The invoice number and the external reference.
      expect(keys(await list({ search: 'chqx' }))).toEqual(['E1']);
      expect(keys(await list({ search: 'chq_' }))).toEqual(['I2']);
    });

    it('reads % and _ in a search as themselves', async () => {
      // Unescaped, `_` would also match E1's `CHQX77`, and `100%` E3's `1000 ليتر`.
      expect(keys(await list({ search: 'CHQ_77' }))).toEqual(['I2']);
      expect(keys(await list({ search: '100%' }))).toEqual(['I3']);
      expect(keys(await list({ search: '%' }))).toEqual(['I3']);
      expect(keys(await list({ search: '_' }))).toEqual(['I2']);
    });

    it('applies every filter at once, to the figures as to the page', async () => {
      const result = await list({ currency: 'LBP', from: D1, to: D3, search: 'ة' });
      /*
        LBP, D1 to D3, live, with «ة» in a searched column: I8 (متأخرة), E1 (محطة),
        I1 (حصة), E6 (مكتبة), I5 (خردة). I4 and E4 match too, and are cancelled;
        I9 is on D0; the USD vouchers are another currency.
      */
      expect(keys(result)).toEqual(['I8', 'E1', 'I1', 'E6', 'I5']);
      expect(result.total).toBe(5);
      expect(result.totals).toEqual([{ currency: 'LBP', amountIn: 1_075_000, amountOut: 410_000 }]);
      expect(result.days).toEqual([
        { day: D3, totals: [{ currency: 'LBP', amountIn: 1_005_000, amountOut: 400_000 }] },
        { day: D1, totals: [{ currency: 'LBP', amountIn: 70_000, amountOut: 10_000 }] },
      ]);
    });
  });

  /*
    Beirut's two clock changes, which the June set (UTC+3 throughout) never meets.
    Lebanon moves at local midnight: on 2025-10-26 00:00 (UTC+3) back to 23:00 on
    the 25th (UTC+2), so the 25th runs 25 hours and its last hour twice; on
    2026-03-29 00:00 (UTC+2) on to 01:00 (UTC+3), so the 29th runs 23 hours. A
    day computed at a fixed offset, either one, puts at least one of these
    vouchers on the wrong day.

    Last in the file, and written in this block's own `beforeAll`: jest runs it
    after every test above, so the June figures they assert never see these
    rows (a voucher cannot be deleted, 0083). Every read here is bounded by
    `from`/`to`, so the June rows never reach these assertions either.
  */
  describe('across the clock changes', () => {
    const OCT_24 = '2025-10-24';
    const OCT_25 = '2025-10-25';
    const OCT_26 = '2025-10-26';
    const MAR_28 = '2026-03-28';
    const MAR_29 = '2026-03-29';
    const MAR_30 = '2026-03-30';

    beforeAll(async () => {
      const lbp = { accountId: safeLbpId, currency: 'LBP' };
      const inc = { ...lbp, categoryId: incomeMiscId };
      const exp = { ...lbp, categoryId: expenseMiscId, payee: 'مورّد' };

      // Autumn: 23:59 on the 24th (UTC+3).
      await incomeVoucher('A1', { ...inc, occurredAt: '2025-10-24T20:59:00Z', amount: 1, description: 'خريف ١' });
      // 00:00 on the 25th (UTC+3).
      await expenseVoucher('A2', { ...exp, occurredAt: '2025-10-24T21:00:00Z', amount: 20, description: 'خريف ٢' });
      // 23:30 on the 25th, the first time (UTC+3).
      await incomeVoucher('A3', { ...inc, occurredAt: '2025-10-25T20:30:00Z', amount: 300, description: 'خريف ٣' });
      // 23:30 on the 25th, the second time (UTC+2); at a fixed UTC+3 it would be 00:30 on the 26th.
      await expenseVoucher('A4', { ...exp, occurredAt: '2025-10-25T21:30:00Z', amount: 4_000, description: 'خريف ٤' });
      // 00:00 on the 26th (UTC+2).
      await incomeVoucher('A5', { ...inc, occurredAt: '2025-10-25T22:00:00Z', amount: 50_000, description: 'خريف ٥' });

      // Spring: 23:59 on the 28th (UTC+2); at a fixed UTC+3 it would be 00:59 on the 29th.
      await expenseVoucher('B1', { ...exp, occurredAt: '2026-03-28T21:59:00Z', amount: 6, description: 'ربيع ١' });
      // 01:00 on the 29th (UTC+3), the first instant of the day's 23 hours.
      await incomeVoucher('B2', { ...inc, occurredAt: '2026-03-28T22:00:00Z', amount: 70, description: 'ربيع ٢' });
      // 23:59 on the 29th (UTC+3).
      await expenseVoucher('B3', { ...exp, occurredAt: '2026-03-29T20:59:00Z', amount: 800, description: 'ربيع ٣' });
      // 00:00 on the 30th (UTC+3); at a fixed UTC+2 it would be 23:00 on the 29th.
      await incomeVoucher('B4', { ...inc, occurredAt: '2026-03-29T21:00:00Z', amount: 9_000, description: 'ربيع ٤' });
    }, SETUP_TIMEOUT_MS);

    const dayOf = (result: TreasuryMovementsResult): Array<[string | undefined, string]> =>
      result.movements.map((movement) => [names.get(movement.voucher.id), movement.day]);

    it('puts each voucher on its Beirut day on both sides of each change', async () => {
      const autumn = await list({ from: OCT_24, to: OCT_26 });
      expect(dayOf(autumn)).toEqual([
        ['A5', OCT_26],
        ['A4', OCT_25],
        ['A3', OCT_25],
        ['A2', OCT_25],
        ['A1', OCT_24],
      ]);
      expect(autumn.days).toEqual([
        { day: OCT_26, totals: [{ currency: 'LBP', amountIn: 50_000, amountOut: 0 }] },
        { day: OCT_25, totals: [{ currency: 'LBP', amountIn: 300, amountOut: 4_020 }] },
        { day: OCT_24, totals: [{ currency: 'LBP', amountIn: 1, amountOut: 0 }] },
      ]);

      const spring = await list({ from: MAR_28, to: MAR_30 });
      expect(dayOf(spring)).toEqual([
        ['B4', MAR_30],
        ['B3', MAR_29],
        ['B2', MAR_29],
        ['B1', MAR_28],
      ]);
      expect(spring.days).toEqual([
        { day: MAR_30, totals: [{ currency: 'LBP', amountIn: 9_000, amountOut: 0 }] },
        { day: MAR_29, totals: [{ currency: 'LBP', amountIn: 70, amountOut: 800 }] },
        { day: MAR_28, totals: [{ currency: 'LBP', amountIn: 0, amountOut: 6 }] },
      ]);
    });

    it('reads a one-day range as that day’s 25 or 23 hours', async () => {
      const long = await list({ from: OCT_25, to: OCT_25 });
      expect(keys(long)).toEqual(['A4', 'A3', 'A2']);
      expect(long.totals).toEqual([{ currency: 'LBP', amountIn: 300, amountOut: 4_020 }]);

      const short = await list({ from: MAR_29, to: MAR_29 });
      expect(keys(short)).toEqual(['B3', 'B2']);
      expect(short.totals).toEqual([{ currency: 'LBP', amountIn: 70, amountOut: 800 }]);
    });

    it('keeps the 25-hour day whole on a page that holds only part of it', async () => {
      // Pages of two: A5, A4 | A3, A2 | A1. The second holds two of the 25th's three vouchers.
      const second = await list({ from: OCT_24, to: OCT_26, pageSize: '2', page: '2' });
      expect(keys(second)).toEqual(['A3', 'A2']);
      expect(second.total).toBe(5);
      expect(second.days).toEqual([{ day: OCT_25, totals: [{ currency: 'LBP', amountIn: 300, amountOut: 4_020 }] }]);
    });
  });
});

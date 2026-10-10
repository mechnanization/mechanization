import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { PrismaUserRepository } from '../../../infrastructure/repositories/user.repository';
import { AuditService } from '../audit/audit.service';
import { ExpensesService } from '../treasury/expenses.service';
import { TreasuryLedgerService } from '../treasury/treasury-ledger.service';
import { TreasuryService } from '../treasury/treasury.service';
import { StaffService } from './staff.service';
import {
  COMMISSION_URGENT_REASON,
  municipalPeriod,
  type RecordInspectorPayoutInput,
} from '@mechanization/shared-schemas';

/**
 * «صرف عمولة» against a real Postgres (docs/finance.md §5.6, migration 0086).
 *
 * What only a database can prove: that once the treasury is live a payout, its
 * voucher and the money leaving the wallet commit together or not at all; that
 * two payouts to one inspector cannot both spend the same balance owed; that a
 * retried press returns the first payout instead of paying twice; and that a
 * cancelled voucher stops counting as paid on the inspector's page and on the
 * roster alike.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_inspector_payout_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

/** Units the inspector filed, so dollars he earned (`COMMISSION_RATE` is 1). */
const EARNED = 20;

describeIfDb('StaffService.recordInspectorPayout', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let users: PrismaUserRepository;
  let staff: StaffService;
  let expenses: ExpensesService;
  let treasury: TreasuryService;

  let inspectorId: string;
  let safeLbpId: string;
  let safeUsdId: string;
  let commissionsId: string;
  let miscId: string;

  const MANAGER = { id: '', role: 'SUPER_ADMIN' };
  const ACCOUNTANT = { id: '', role: 'ACCOUNTANT' };

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'payouts', schemaName: SCHEMA, prisma: db }, work);

  const balance = async (accountId: string): Promise<number> =>
    Number(
      (await db.treasuryEntry.aggregate({ where: { accountId }, _sum: { amount: true } }))._sum.amount ?? 0,
    );

  const pay = (
    payload: Partial<RecordInspectorPayoutInput> & { amount: number },
    actor: { id: string; role: string } = MANAGER,
    to?: string,
  ) =>
    scoped(() =>
      staff.recordInspectorPayout({
        tenantSlug: 'payouts',
        inspectorId: to ?? inspectorId,
        payload: { currency: 'USD', ...payload },
        actor,
      }),
    );

  const profile = () => scoped(() => staff.getInspectorProfile('payouts', inspectorId));

  const counts = async () => ({
    payouts: await db.inspectorPayout.count(),
    vouchers: await db.expenseVoucher.count(),
    entries: await db.treasuryEntry.count({ where: { source: 'EXPENSE_VOUCHER' } }),
  });

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    const ledger = new TreasuryLedgerService(context);
    users = new PrismaUserRepository(context);
    expenses = new ExpensesService(context, ledger, audit);
    treasury = new TreasuryService(context, ledger, audit);
    staff = new StaffService(
      users,
      {} as never,
      {} as never,
      context,
      {} as never,
      {} as never,
      { emit: () => true } as never,
      expenses,
      ledger,
      audit,
    );

    MANAGER.id = randomUUID();
    ACCOUNTANT.id = randomUUID();
    inspectorId = randomUUID();
    await db.user.createMany({
      data: [
        {
          id: ACCOUNTANT.id,
          kind: 'STAFF',
          tenantSlug: 'payouts',
          email: `a-${ACCOUNTANT.id}@t.gov.lb`,
          firstName: 'رئيس',
          lastName: 'المحاسبة',
          role: 'ACCOUNTANT',
        },
        {
          id: MANAGER.id,
          kind: 'STAFF',
          tenantSlug: 'payouts',
          email: `m-${MANAGER.id}@t.gov.lb`,
          firstName: 'المدير',
          lastName: 'العام',
          role: 'SUPER_ADMIN',
        },
        {
          id: inspectorId,
          kind: 'STAFF',
          tenantSlug: 'payouts',
          email: `i-${inspectorId}@t.gov.lb`,
          firstName: 'حسن',
          lastName: 'الميداني',
          role: 'FIELD_INSPECTOR',
        },
      ],
    });

    // One building card with EARNED flats the census never linked: each is its own unit.
    const citizenId = randomUUID();
    await db.user.create({
      data: { id: citizenId, kind: 'CITIZEN', tenantSlug: 'payouts', firstName: 'سامر', lastName: 'خليل' },
    });
    const registration = await db.registration.create({
      data: { citizenId, referenceNumber: `R-${randomUUID().slice(0, 10)}`, createdById: inspectorId },
      select: { id: true },
    });
    await db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: 'OWNER',
        propertyType: 'BUILDING',
        neighborhood: 'الحي',
        propertyNumber: '101',
        units: {
          create: Array.from({ length: EARNED }, (_, i) => ({
            unitType: 'APARTMENT' as const,
            floor: String(i),
            unitArea: 100,
            unitStatus: 'OWNER_OCCUPIED' as const,
          })),
        },
      },
    });

    safeLbpId = (await db.treasuryAccount.findFirstOrThrow({ where: { type: 'CASH_SAFE', currency: 'LBP' } })).id;
    safeUsdId = (await db.treasuryAccount.findFirstOrThrow({ where: { type: 'CASH_SAFE', currency: 'USD' } })).id;
    commissionsId = (await db.expenseCategory.findFirstOrThrow({ where: { key: 'FIELD_COMMISSIONS' } })).id;
    miscId = (await db.expenseCategory.findFirstOrThrow({ where: { key: 'MISC' } })).id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('starts from what the fixture filed', async () => {
    const before = await profile();
    expect(before.totalEarnings).toBe(EARNED);
    expect(before.pendingBalance).toBe(EARNED);
  });

  // ──────────────────────────  before go-live  ──────────────────────────

  describe('before the treasury is live', () => {
    it('records the payout as it always did: a figure, dated as asked, with no wallet and no voucher', async () => {
      const paidAt = new Date('2026-09-15T12:00:00Z').toISOString();
      const payout = await pay({ amount: 2, paidAt, reference: 'وصل 7' });

      expect(payout.voucher).toBeNull();
      expect(payout.paidAt).toBe(paidAt);
      expect(payout.reference).toBe('وصل 7');
      expect(payout.replayed).toBe(false);
      expect(await counts()).toEqual({ payouts: 1, vouchers: 0, entries: 0 });
      expect((await profile()).pendingBalance).toBe(EARNED - 2);

      // Tier 1 with the figure: the amount this payout lowered the balance by is in the audit row.
      const rows = await db.auditLogEntry.findMany({
        where: { action: 'INSPECTOR_PAYOUT_RECORDED', entityId: inspectorId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].after).toMatchObject({ payoutId: payout.id, amount: 2, currency: 'USD', paidAt });
    });

    it("refuses the accountant: the figure-only payout, with no wallet, voucher or order, is the manager's", async () => {
      await expect(pay({ amount: 1 }, ACCOUNTANT)).rejects.toMatchObject({
        code: 'INSPECTOR_PAYOUT_BEFORE_LIVE_MANAGER_ONLY',
      });
      expect(await counts()).toEqual({ payouts: 1, vouchers: 0, entries: 0 });
      expect((await profile()).pendingBalance).toBe(EARNED - 2);
    });

    it('refuses a payout dated after today: the cash it records has not been handed over', async () => {
      const tomorrow = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
      await expect(pay({ amount: 1, paidAt: tomorrow })).rejects.toMatchObject({
        code: 'INSPECTOR_PAYOUT_DATE_IN_FUTURE',
      });
      expect(await counts()).toEqual({ payouts: 1, vouchers: 0, entries: 0 });
      expect((await profile()).pendingBalance).toBe(EARNED - 2);
    });

    it('refuses a wallet: there is no ledger yet for the money to leave', async () => {
      await expect(pay({ amount: 1, accountId: safeUsdId })).rejects.toMatchObject({ code: 'TREASURY_NOT_ACTIVE' });
      expect(await counts()).toEqual({ payouts: 1, vouchers: 0, entries: 0 });
    });
  });

  // ───────────────────────────  once live  ───────────────────────────

  describe('once the treasury is live', () => {
    let firstVoucherId: string;

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

    it('pays from the dollar safe: voucher, ledger entry and payout together, linked', async () => {
      const before = await balance(safeUsdId);
      const payout = await pay({ amount: 3, accountId: safeUsdId, note: 'عمولة أيلول', reference: 'وصل 8' });

      expect(payout.voucher).toMatchObject({ voided: false });
      expect(payout.voucher!.voucherNumber).toMatch(new RegExp(`^PV-${municipalPeriod()}-\\d{4}$`));
      expect(payout.currency).toBe('USD');
      firstVoucherId = payout.voucher!.id;

      const voucher = await scoped(() => expenses.get(firstVoucherId));
      expect(voucher.category.id).toBe(commissionsId);
      expect(voucher.payee).toBe('حسن الميداني');
      expect(voucher.payeeStaffId).toBe(inspectorId);
      expect(voucher.description).toBe('عمولة أيلول');
      expect(voucher.invoiceNumber).toBe('وصل 8');
      expect(voucher.amount).toBe(3);

      const entries = await db.treasuryEntry.findMany({ where: { source: 'EXPENSE_VOUCHER', sourceId: firstVoucherId } });
      expect(entries.map((entry) => Number(entry.amount))).toEqual([-3]);
      expect(await balance(safeUsdId)).toBe(before - 3);

      const row = await db.inspectorPayout.findUniqueOrThrow({ where: { id: payout.id } });
      expect(row.expenseVoucherId).toBe(firstVoucherId);
      expect(row.paidAt.getTime()).toBe(entries[0].occurredAt.getTime());

      expect((await profile()).pendingBalance).toBe(EARNED - 5);
    });

    it('files the voucher under the category’s own name when no statement is given', async () => {
      const payout = await pay({ amount: 1, accountId: safeUsdId });
      const voucher = await scoped(() => expenses.get(payout.voucher!.id));
      expect(voucher.description).toBe('تعويضات المسح والجباية');
      expect(payout.note).toBeNull();
    });

    it('writes a Tier 1 audit row naming the inspector by id and the voucher by number, never a name', async () => {
      const payout = await pay({ amount: 1, accountId: safeUsdId });
      const rows = await db.auditLogEntry.findMany({
        where: { action: 'INSPECTOR_PAYOUT_RECORDED', entityId: inspectorId },
      });
      const row = rows.find((candidate) => (candidate.after as { payoutId?: string }).payoutId === payout.id);
      expect(row).toBeDefined();
      expect(row!.after).toMatchObject({
        amount: 1,
        currency: 'USD',
        voucherId: payout.voucher!.id,
        voucherNumber: payout.voucher!.voucherNumber,
        accountId: safeUsdId,
      });
      expect(JSON.stringify(row!.after)).not.toContain('حسن');

      const expenseRow = await db.auditLogEntry.count({
        where: { action: 'EXPENSE_RECORDED', entityId: payout.voucher!.id },
      });
      expect(expenseRow).toBe(1);
    });

    it('answers a retried press with the first payout, paying once', async () => {
      const key = randomUUID();
      const before = await counts();
      const first = await pay({ amount: 1, accountId: safeUsdId, clientRequestId: key });
      const again = await pay({ amount: 1, accountId: safeUsdId, clientRequestId: key });

      expect(again.id).toBe(first.id);
      expect(again.voucher!.id).toBe(first.voucher!.id);
      // Said, so the dialog answers «صُرفت من قبل» rather than a second «صُرفت».
      expect(first.replayed).toBe(false);
      expect(again.replayed).toBe(true);
      expect(await counts()).toEqual({
        payouts: before.payouts + 1,
        vouchers: before.vouchers + 1,
        entries: before.entries + 1,
      });
    });

    it('binds a retry key to its act: another amount, wallet or statement under it is refused, not answered', async () => {
      const whishUsdId = (
        await db.treasuryAccount.findFirstOrThrow({
          where: { currency: 'USD', type: { notIn: ['CASH_SAFE', 'COLLECTOR_CUSTODY'] } },
        })
      ).id;
      const key = randomUUID();
      const first = await pay({ amount: 1, accountId: safeUsdId, note: 'عمولة تشرين', clientRequestId: key });
      const before = await counts();

      for (const edited of [
        { amount: 5, accountId: safeUsdId, note: 'عمولة تشرين' },
        { amount: 1, accountId: whishUsdId, note: 'عمولة تشرين' },
        { amount: 1, accountId: safeUsdId, note: 'عمولة أخرى' },
      ]) {
        await expect(pay({ ...edited, clientRequestId: key })).rejects.toMatchObject({
          code: 'TREASURY_REQUEST_KEY_REUSED',
        });
      }
      expect(await counts()).toEqual(before);

      // Unchanged, it is still the same payout.
      const again = await pay({ amount: 1, accountId: safeUsdId, note: ' عمولة تشرين ', clientRequestId: key });
      expect(again).toMatchObject({ id: first.id, replayed: true });
      expect(await counts()).toEqual(before);
    });

    it('does not answer a cancelled payout as made: its key is refused with the voucher it was', async () => {
      const key = randomUUID();
      const payout = await pay({ amount: 1, accountId: safeUsdId, clientRequestId: key });
      await scoped(() => expenses.void(payout.voucher!.id, 'سُلّمت العمولة نقداً من قبل', MANAGER));
      const owed = (await profile()).pendingBalance;
      const before = await counts();

      await expect(pay({ amount: 1, accountId: safeUsdId, clientRequestId: key })).rejects.toMatchObject({
        code: 'EXPENSE_ALREADY_VOID',
        params: { voucherNumber: payout.voucher!.voucherNumber },
      });
      expect(await counts()).toEqual(before);
      expect((await profile()).pendingBalance).toBe(owed);
    });

    // ── decision D9: a commission is paid like a salary (art. 35) ──

    it("pays the accountant's payout at once on the urgent path, with the server's art. 35 reason, waiting for the order", async () => {
      const owed = (await profile()).pendingBalance;
      const before = await balance(safeUsdId);
      const payout = await pay({ amount: 1, accountId: safeUsdId, clientRequestId: randomUUID() }, ACCOUNTANT);

      // Paid: the money left the safe and the inspector is owed that much less, now.
      expect(await balance(safeUsdId)).toBe(before - 1);
      expect((await profile()).pendingBalance).toBe(owed - 1);

      const voucher = await scoped(() => expenses.get(payout.voucher!.id));
      expect(voucher).toMatchObject({
        orderStatus: 'AWAITING_ORDER',
        urgentReason: COMMISSION_URGENT_REASON,
        payeeStaffId: inspectorId,
      });
      expect(voucher.urgentReason).toBe('عمولة مسح ميداني — تُدفع قبل الحوالة (المادة 35)');
      const row = (
        await db.auditLogEntry.findMany({ where: { action: 'INSPECTOR_PAYOUT_RECORDED', entityId: inspectorId } })
      ).find((candidate) => (candidate.after as { payoutId?: string }).payoutId === payout.id);
      expect(row?.after).toMatchObject({ ordered: false });

      // In the manager's queue, and his regularisation is the order.
      const waiting = await scoped(() => expenses.list({ awaitingOrder: true }));
      expect(waiting.vouchers.map((candidate) => candidate.id)).toContain(voucher.id);
      await expect(scoped(() => expenses.regularize(voucher.id, MANAGER))).resolves.toMatchObject({
        orderStatus: 'ORDERED',
      });

      // The manager's own payout is the order, and carries no reason.
      const own = await pay({ amount: 1, accountId: safeUsdId, clientRequestId: randomUUID() });
      expect(await scoped(() => expenses.get(own.voucher!.id))).toMatchObject({
        orderStatus: 'ORDERED',
        urgentReason: null,
      });
    });

    it("does not hold the accountant's commission to the urgent ceiling, as art. 35 does not hold a salary (D6, D9)", async () => {
      await db.systemSettings.updateMany({ data: { urgentExpenseCeilingUsd: 1 } });
      try {
        await expect(
          pay({ amount: 2, accountId: safeUsdId, clientRequestId: randomUUID() }, ACCOUNTANT),
        ).resolves.toMatchObject({ replayed: false });
      } finally {
        await db.systemSettings.updateMany({ data: { urgentExpenseCeilingUsd: null } });
      }
    });

    it('refuses an accountant his own commission, before any figure is read (the D8 rule)', async () => {
      // The accountant filed a card once, so he has earned something a payout could take.
      const citizenId = randomUUID();
      await db.user.create({
        data: { id: citizenId, kind: 'CITIZEN', tenantSlug: 'payouts', firstName: 'ليلى', lastName: 'عون' },
      });
      const registration = await db.registration.create({
        data: { citizenId, referenceNumber: `R-${randomUUID().slice(0, 10)}`, createdById: ACCOUNTANT.id },
        select: { id: true },
      });
      await db.propertyEntry.create({
        data: {
          registrationId: registration.id,
          occupancyType: 'OWNER',
          propertyType: 'BUILDING',
          neighborhood: 'الحي',
          propertyNumber: '202',
          units: {
            create: [{ unitType: 'APARTMENT', floor: '1', unitArea: 100, unitStatus: 'OWNER_OCCUPIED' }],
          },
        },
      });
      const own = await scoped(() => staff.getInspectorProfile('payouts', ACCOUNTANT.id));
      expect(own.pendingBalance).toBeGreaterThan(0);
      const before = await counts();

      await expect(
        pay({ amount: 1, accountId: safeUsdId, clientRequestId: randomUUID() }, ACCOUNTANT, ACCOUNTANT.id),
      ).rejects.toMatchObject({ code: 'COMMISSION_SELF_PAYOUT' });
      expect(await counts()).toEqual(before);
    });

    it('names no owed figure to the accountant, and judges the balance last, so no other refusal tells him it', async () => {
      const owed = (await profile()).pendingBalance;
      const before = await counts();

      // Above what is owed: refused in words that carry no figure, and nothing is written.
      const over = pay({ amount: owed + 1, accountId: safeUsdId, clientRequestId: randomUUID() }, ACCOUNTANT);
      await expect(over).rejects.toThrow('المبلغ أكبر من الرصيد المستحق.');
      await expect(over).rejects.not.toThrow(owed.toFixed(2));

      // A wallet that does not exist answers alike whether the amount is within what is owed or not.
      for (const amount of [1, owed + 1]) {
        await expect(
          pay({ amount, accountId: randomUUID(), clientRequestId: randomUUID() }, ACCOUNTANT),
        ).rejects.toMatchObject({ code: 'TREASURY_ACCOUNT_NOT_FOUND' });
      }
      expect(await counts()).toEqual(before);

      // The manager, who reads the profile, is told the figure.
      await expect(pay({ amount: owed + 1, accountId: safeUsdId })).rejects.toThrow(`(${owed.toFixed(2)}$)`);
    });

    it('keeps «تعويضات المسح والجباية» to «صرف عمولة»: the form, a request and an order refuse it', async () => {
      /*
        A commission paid any other way leaves the wallet with no payout row, so
        the inspector would still read as owed it and «صرف عمولة» would pay it
        again (reproduced before this guard: $4 paid through the form, $19 still
        owed, then paid in full).
      */
      const owed = (await profile()).pendingBalance;
      const before = await counts();
      const commission = {
        categoryId: commissionsId,
        accountId: safeUsdId,
        amount: 4,
        payee: 'حسن الميداني',
        description: 'عمولة مسح حي الزهور',
      };

      await expect(scoped(() => expenses.record(commission, MANAGER))).rejects.toMatchObject({
        code: 'EXPENSE_CATEGORY_RESERVED',
        params: { category: 'تعويضات المسح والجباية' },
      });
      await expect(scoped(() => expenses.requestPayment(commission, ACCOUNTANT))).rejects.toMatchObject({
        code: 'EXPENSE_CATEGORY_RESERVED',
      });

      // A request filed before the category was reserved is not ordered either: it waits, to be rejected.
      const filed = await db.expenseRequest.create({
        data: { ...commission, currency: 'USD', requestedById: ACCOUNTANT.id },
        select: { id: true },
      });
      await expect(scoped(() => expenses.orderRequest(filed.id, MANAGER))).rejects.toMatchObject({
        code: 'EXPENSE_CATEGORY_RESERVED',
      });
      expect((await db.expenseRequest.findUniqueOrThrow({ where: { id: filed.id } })).decision).toBeNull();

      expect(await counts()).toEqual(before);
      expect((await profile()).pendingBalance).toBe(owed);
    });

    it('refuses, writing nothing: no wallet, a ليرة wallet, a date, or more than is owed', async () => {
      const before = await counts();
      const owed = (await profile()).pendingBalance;

      await expect(pay({ amount: 1 })).rejects.toMatchObject({ code: 'INSPECTOR_PAYOUT_WALLET_REQUIRED' });
      await expect(pay({ amount: 1, accountId: safeLbpId })).rejects.toMatchObject({
        code: 'INSPECTOR_PAYOUT_WALLET_NOT_USD',
      });
      await expect(
        pay({ amount: 1, accountId: safeUsdId, paidAt: new Date().toISOString() }),
      ).rejects.toMatchObject({ code: 'INSPECTOR_PAYOUT_DATE_NOT_ALLOWED' });
      await expect(pay({ amount: owed + 1, accountId: safeUsdId })).rejects.toThrow('أكبر من الرصيد المستحق');
      await expect(pay({ amount: 1, accountId: randomUUID() })).rejects.toMatchObject({
        code: 'TREASURY_ACCOUNT_NOT_FOUND',
      });

      expect(await counts()).toEqual(before);
    });

    it('lets only one of two simultaneous payouts spend the same balance owed', async () => {
      const owed = (await profile()).pendingBalance;
      const half = Math.floor(owed / 2) + 1; // two of these exceed what is owed; one does not
      const before = await counts();

      const results = await Promise.allSettled([
        pay({ amount: half, accountId: safeUsdId, clientRequestId: randomUUID() }),
        pay({ amount: half, accountId: safeUsdId, clientRequestId: randomUUID() }),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await counts()).toEqual({
        payouts: before.payouts + 1,
        vouchers: before.vouchers + 1,
        entries: before.entries + 1,
      });
      expect((await profile()).pendingBalance).toBe(owed - half);
    });

    it('stops counting a payout as paid once its voucher is cancelled, on the profile and the roster alike', async () => {
      const before = await profile();
      await scoped(() => expenses.void(firstVoucherId, 'دُفعت العمولة مرتين بالخطأ', MANAGER));

      const after = await profile();
      expect(after.paidBalance).toBe(before.paidBalance - 3);
      expect(after.pendingBalance).toBe(before.pendingBalance + 3);

      const cancelled = after.payouts.find((payout) => payout.voucher?.id === firstVoucherId);
      expect(cancelled?.voucher?.voided).toBe(true);
      // Kept in the history: the payout happened, and so did its cancellation.
      expect(after.payouts).toHaveLength(before.payouts.length);

      const roster = await scoped(() => users.listStaff());
      const row = roster.find((summary) => summary.id === inspectorId);
      expect(row?.paidBalance).toBe(after.paidBalance);
      expect(row?.pendingBalance).toBe(after.pendingBalance);
    });

    it('refuses a payout the wallet cannot cover, and leaves no payout or voucher behind', async () => {
      // Spend the safe down to one dollar through an ordinary expense.
      const held = await balance(safeUsdId);
      await scoped(() =>
        expenses.record(
          { categoryId: miscId, accountId: safeUsdId, amount: held - 1, payee: 'مورّد', description: 'تفريغ الصندوق' },
          MANAGER,
        ),
      );
      const before = await counts();

      await expect(pay({ amount: 2, accountId: safeUsdId })).rejects.toMatchObject({
        code: 'TREASURY_INSUFFICIENT_FUNDS',
      });
      expect(await counts()).toEqual(before);
      expect(await balance(safeUsdId)).toBe(1);
    });
  });
});

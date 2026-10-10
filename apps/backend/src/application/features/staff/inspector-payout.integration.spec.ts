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
import { municipalPeriod, type RecordInspectorPayoutInput } from '@mechanization/shared-schemas';

/**
 * «صرف عمولة» against a real Postgres (docs/finance.md §5.6, migration 0083).
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

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'payouts', schemaName: SCHEMA, prisma: db }, work);

  const balance = async (accountId: string): Promise<number> =>
    Number(
      (await db.treasuryEntry.aggregate({ where: { accountId }, _sum: { amount: true } }))._sum.amount ?? 0,
    );

  const pay = (payload: Partial<RecordInspectorPayoutInput> & { amount: number }) =>
    scoped(() =>
      staff.recordInspectorPayout({
        tenantSlug: 'payouts',
        inspectorId,
        payload: { currency: 'USD', ...payload },
        actor: MANAGER,
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
    inspectorId = randomUUID();
    await db.user.createMany({
      data: [
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
      expect(await counts()).toEqual({
        payouts: before.payouts + 1,
        vouchers: before.vouchers + 1,
        entries: before.entries + 1,
      });
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

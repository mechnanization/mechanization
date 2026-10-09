import { Injectable } from '@nestjs/common';
import {
  municipalToday,
  type ExpenseCategoryKey,
  type ExpenseCategoryView,
  type ExpenseListResult,
  type ExpenseVoucherView,
  type CreateExpenseCategoryInput,
  type RecordExpenseInput,
  type RecordExpenseResult,
  type RecordStaffSalaryInput,
  type UpdateExpenseCategoryInput,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { allocateDocumentNumber } from '../../common/document-number';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { AuditService } from '../audit/audit.service';
import { expenseOccurredAt, planExpenseDate } from './expenses.plan';
import { TreasuryLedgerService } from './treasury-ledger.service';

/** One page of the register. A municipality's year of spending is thousands of rows, not all of them. */
const PAGE_MAX = 200;
const PAGE_DEFAULT = 50;

/** The voucher row a list or a read returns, with everything the screen names. */
const VOUCHER_SELECT = {
  id: true,
  voucherNumber: true,
  amount: true,
  currency: true,
  payee: true,
  payeeStaffId: true,
  description: true,
  occurredAt: true,
  invoiceNumber: true,
  hasPhysicalReceipt: true,
  adjustmentReason: true,
  voidedAt: true,
  voidReason: true,
  category: { select: { id: true, name: true } },
  account: { select: { id: true, name: true, currency: true } },
  recordedBy: { select: { firstName: true, lastName: true } },
  voidedBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.ExpenseVoucherSelect;

type VoucherRow = Prisma.ExpenseVoucherGetPayload<{ select: typeof VOUCHER_SELECT }>;

/**
 * النفقات — recording money out of a wallet, and cancelling a voucher.
 *
 * ## Recording is paying
 *
 * There is no draft and no approval step (docs/finance.md §5.1, a product
 * decision): one call writes the voucher and the ledger entry that takes the
 * money out, inside one transaction. So a voucher cannot exist without its
 * movement, and a movement cannot exist without the voucher explaining it.
 *
 * The outflow goes through `TreasuryLedgerService.post`, which holds the
 * wallet's row lock and refuses to take it below zero. That is the whole
 * safety story for "we cannot pay what we do not hold": it is one check, in one
 * place, behind a lock, shared with every other way money leaves.
 *
 * ## What the client is not trusted with
 *
 * The currency is taken from the wallet, never from the request, so a voucher
 * can never claim a currency its wallet does not hold. The voucher number comes
 * from a Postgres sequence. The balance it reports is read back after the
 * write, not computed on the client.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly ledger: TreasuryLedgerService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  /** The bands money may be spent under. Inactive ones are kept for the vouchers that point at them. */
  async categories(includeInactive = false): Promise<ExpenseCategoryView[]> {
    const rows = await this.db.expenseCategory.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        chapterCode: true,
        itemCode: true,
        active: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      key: (row.key as ExpenseCategoryKey | null) ?? null,
      name: row.name,
      description: row.description,
      chapterCode: row.chapterCode,
      itemCode: row.itemCode,
      active: row.active,
    }));
  }

  /**
   * Adds a band of spending the municipality names itself.
   *
   * `key` stays NULL: it is the handle for the categories *code* has to find,
   * and nothing in the code looks for one a municipality invented. The budget
   * codes are optional and theirs — this never fills them in.
   */
  async createCategory(
    input: CreateExpenseCategoryInput,
    actor: { id: string; role: string },
  ): Promise<ExpenseCategoryView> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const created = await this.writeCategory(tx, null, {
        name: input.name.trim(),
        description: input.description?.trim() || null,
        chapterCode: input.chapterCode?.trim() || null,
        itemCode: input.itemCode?.trim() || null,
      });

      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'EXPENSE_CATEGORY_CREATED',
        entityType: 'ExpenseCategory',
        entityId: created.id,
        after: { name: created.name, chapterCode: created.chapterCode, itemCode: created.itemCode },
      });
      return created;
    });
  }

  /**
   * Renames a category, re-codes it, or takes it out of use.
   *
   * `active: false` is the only way one leaves the list. Deleting is not
   * offered and the foreign key refuses it anyway: every voucher ever filed
   * under this band still points here, and a deleted row would take the
   * meaning of all of them.
   */
  async updateCategory(
    id: string,
    input: UpdateExpenseCategoryInput,
    actor: { id: string; role: string },
  ): Promise<ExpenseCategoryView> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const before = await tx.expenseCategory.findUnique({
        where: { id },
        select: { id: true, name: true, active: true },
      });
      if (!before) {
        throw new NotFoundError({
          code: 'EXPENSE_CATEGORY_NOT_FOUND',
          message: `Expense category ${id} was not found`,
        });
      }

      const updated = await this.writeCategory(tx, id, {
        name: input.name.trim(),
        description: input.description?.trim() || null,
        chapterCode: input.chapterCode?.trim() || null,
        itemCode: input.itemCode?.trim() || null,
        active: input.active ?? true,
      });

      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'EXPENSE_CATEGORY_UPDATED',
        entityType: 'ExpenseCategory',
        entityId: id,
        before: { name: before.name, active: before.active },
        after: { name: updated.name, active: updated.active },
      });
      return updated;
    });
  }

  /** The register: newest first, filtered, with what the filtered set adds up to. */
  async list(filters: {
    from?: Date;
    to?: Date;
    categoryId?: string;
    accountId?: string;
    includeVoid?: boolean;
    page?: number;
    pageSize?: number;
  }): Promise<ExpenseListResult> {
    const pageSize = Math.min(Math.max(filters.pageSize ?? PAGE_DEFAULT, 1), PAGE_MAX);
    const page = Math.max(filters.page ?? 1, 1);

    const where: Prisma.ExpenseVoucherWhereInput = {
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.accountId ? { accountId: filters.accountId } : {}),
      ...(filters.includeVoid ? {} : { voidedAt: null }),
      ...(filters.from || filters.to
        ? {
            occurredAt: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    };

    const [rows, total, sums] = await Promise.all([
      this.db.expenseVoucher.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: VOUCHER_SELECT,
      }),
      this.db.expenseVoucher.count({ where }),
      /*
        Totals over the whole filtered set, not the page — «كم صرفنا على
        المحروقات هذه السنة» is the question the register is opened with, and a
        figure that only added up the fifty rows on screen would answer a
        different one. Cancelled vouchers are always excluded: they moved no
        money in the end.
      */
      this.db.expenseVoucher.groupBy({
        by: ['currency'],
        where: { ...where, voidedAt: null },
        _sum: { amount: true },
      }),
    ]);

    return {
      vouchers: rows.map((row) => this.view(row)),
      total,
      totals: sums
        .map((sum) => ({ currency: sum.currency, amount: sum._sum.amount?.toNumber() ?? 0 }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    };
  }

  async get(id: string): Promise<ExpenseVoucherView> {
    const row = await this.db.expenseVoucher.findUnique({ where: { id }, select: VOUCHER_SELECT });
    if (!row) {
      throw new NotFoundError({ code: 'EXPENSE_NOT_FOUND', message: `Expense voucher ${id} was not found` });
    }
    return this.view(row);
  }

  /**
   * «سجّل النفقة» — writes the voucher and takes the money out, together.
   *
   * Refuses, writing nothing, when the treasury is not live, the category is
   * gone or switched off, the date breaks one of the three rules in
   * `planExpenseDate`, or the wallet does not hold the amount.
   */
  async record(input: RecordExpenseInput, actor: { id: string; role: string }): Promise<RecordExpenseResult> {
    return this.recordVoucher(input, actor, null);
  }

  /**
   * «صرف راتب / أجر» — a salary or wage paid to a staff member (docs/finance.md §5.8).
   *
   * `record`, with two things taken out of the client's hands: the payee is the
   * account's own name, read here, and the category is the seeded «رواتب وأجور».
   * The lock, the never-negative post, the number and the audit row are
   * `record`'s, unchanged. The voucher also carries `payeeStaffId`, so what a
   * person was paid is found by their id rather than by a name two people share.
   *
   * `kind = 'STAFF'` is in the WHERE because `users` holds citizens too. A
   * deleted account is refused: it has left the books. A disabled one is not —
   * someone who has stopped working may still be owed their last month.
   */
  async recordSalary(
    staffId: string,
    input: RecordStaffSalaryInput,
    actor: { id: string; role: string },
  ): Promise<RecordExpenseResult> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;

      const staff = await tx.user.findFirst({
        where: { id: staffId, kind: 'STAFF', deletedAt: null },
        select: { id: true, firstName: true, lastName: true },
      });
      if (!staff) {
        throw new NotFoundError({
          code: 'SALARY_PAYEE_NOT_FOUND',
          message: `Staff member ${staffId} was not found`,
        });
      }

      const salaries: ExpenseCategoryKey = 'SALARIES';
      const category = await tx.expenseCategory.findFirst({ where: { key: salaries }, select: { id: true } });
      if (!category) {
        throw new NotFoundError({
          code: 'EXPENSE_CATEGORY_NOT_FOUND',
          message: 'The seeded salaries category is missing',
        });
      }

      return this.recordVoucher(
        {
          categoryId: category.id,
          accountId: input.accountId,
          amount: input.amount,
          payee: `${staff.firstName} ${staff.lastName}`.trim(),
          description: input.description,
          invoiceNumber: input.invoiceNumber,
          clientRequestId: input.clientRequestId,
        },
        actor,
        staff.id,
      );
    });
  }

  /** The one write behind `record` and `recordSalary`. `payeeStaffId` is null except for a salary. */
  private async recordVoucher(
    input: RecordExpenseInput,
    actor: { id: string; role: string },
    payeeStaffId: string | null,
  ): Promise<RecordExpenseResult> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;

      /*
        Checked before anything is written, so a double-clicked button answers
        with the first voucher instead of paying the supplier twice. The unique
        index on `clientRequestId` is what makes this safe under a real race:
        the loser's insert fails rather than becoming a second payment.
      */
      if (input.clientRequestId) {
        const earlier = await tx.expenseVoucher.findUnique({
          where: { clientRequestId: input.clientRequestId },
          select: { id: true, voucherNumber: true, accountId: true, currency: true },
        });
        if (earlier) {
          return {
            id: earlier.id,
            voucherNumber: earlier.voucherNumber,
            balanceAfter: (await this.ledger.balanceOf(tx, earlier.accountId)).toNumber(),
            currency: earlier.currency,
            replayed: true,
          };
        }
      }

      const config = await this.ledger.config(tx);
      if (!config.goLiveAt) {
        throw new ConflictError({
          code: 'TREASURY_NOT_ACTIVE',
          message: 'The treasury is not active, so no money can leave it yet.',
        });
      }

      const today = municipalToday();
      const verdict = planExpenseDate({
        paidOn: input.paidOn,
        reason: input.adjustmentReason,
        goLiveOn: municipalToday(config.goLiveAt),
        today,
      });
      if (!verdict.ok) {
        if (verdict.code === 'EXPENSE_DATE_BEFORE_GO_LIVE') {
          throw new ValidationError({
            code: verdict.code,
            message: `An expense cannot be dated before the treasury went live (${verdict.goLiveOn}).`,
            params: { date: verdict.goLiveOn },
          });
        }
        throw new ValidationError({
          code: verdict.code,
          message:
            verdict.code === 'EXPENSE_DATE_IN_FUTURE'
              ? 'An expense cannot be dated after today.'
              : 'A back-dated expense must say why.',
          details: { paidOn: input.paidOn ?? today },
        });
      }

      const category = await tx.expenseCategory.findUnique({
        where: { id: input.categoryId },
        select: { id: true, name: true, active: true },
      });
      if (!category) {
        throw new NotFoundError({
          code: 'EXPENSE_CATEGORY_NOT_FOUND',
          message: `Expense category ${input.categoryId} was not found`,
        });
      }
      if (!category.active) {
        throw new ConflictError({
          code: 'EXPENSE_CATEGORY_INACTIVE',
          message: 'That expense category is no longer in use.',
          params: { category: category.name },
        });
      }

      // The currency comes from the wallet, never from the request.
      const account = await tx.treasuryAccount.findFirst({
        where: { id: input.accountId, active: true },
        select: { id: true, name: true, currency: true },
      });
      if (!account) {
        throw new NotFoundError({
          code: 'TREASURY_ACCOUNT_NOT_FOUND',
          message: `Treasury account ${input.accountId} was not found`,
        });
      }

      const occurredAt = expenseOccurredAt(verdict.paidOn, today);

      // «PV-2610-0001». See `allocateDocumentNumbers` and migration 0079.
      const voucherNumber = await allocateDocumentNumber(tx, this.S, 'VOUCHER');

      const voucher = await tx.expenseVoucher.create({
        data: {
          voucherNumber,
          categoryId: category.id,
          accountId: account.id,
          currency: account.currency,
          amount: new Prisma.Decimal(input.amount),
          payee: input.payee.trim(),
          payeeStaffId,
          description: input.description.trim(),
          occurredAt,
          adjustmentReason: verdict.backdatedDays > 0 ? (input.adjustmentReason?.trim() ?? null) : null,
          invoiceNumber: input.invoiceNumber?.trim() || null,
          hasPhysicalReceipt: input.hasPhysicalReceipt ?? false,
          recordedById: actor.id,
          clientRequestId: input.clientRequestId ?? null,
        },
        select: { id: true },
      });

      // The money leaves here. Refused below zero, which rolls the voucher back with it.
      await this.ledger.post(
        tx,
        [
          {
            accountId: account.id,
            currency: account.currency,
            amount: new Prisma.Decimal(input.amount).negated(),
          },
        ],
        {
          source: 'EXPENSE_VOUCHER',
          sourceId: voucher.id,
          actorId: actor.id,
          occurredAt,
          exchangeRate: config.exchangeRate,
        },
      );

      /*
        Tier 1: the audit row commits with the money or not at all. The payee is
        deliberately absent — it is free text that may name a citizen, and an
        audit row is not a second copy of personal data (docs/security.md). The
        voucher number is the handle that leads to it. A salary's payee is a
        staff account, so it is named here by its id, never by its name.
      */
      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'EXPENSE_RECORDED',
        entityType: 'ExpenseVoucher',
        entityId: voucher.id,
        after: {
          voucherNumber,
          amount: input.amount,
          currency: account.currency,
          categoryId: category.id,
          accountId: account.id,
          occurredAt: occurredAt.toISOString(),
          ...(payeeStaffId ? { payeeStaffId } : {}),
        },
      });

      return {
        id: voucher.id,
        voucherNumber,
        balanceAfter: (await this.ledger.balanceOf(tx, account.id)).toNumber(),
        currency: account.currency,
        replayed: false,
      };
    });
  }

  /**
   * «إلغاء سند الصرف» — cancels a voucher and puts the money back.
   *
   * The voucher is stamped rather than deleted, and the ledger gets an opposing
   * entry rather than losing the first one: an auditor asking "what happened to
   * voucher PV-000012" is owed «صُرف في الثالث وأُلغي في الخامس»، not a register
   * that has quietly forgotten the third.
   */
  async void(id: string, reason: string, actor: { id: string; role: string }): Promise<ExpenseVoucherView> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;

      /*
        Locked before it is read, so two managers pressing cancel together meet
        here one after the other and the second finds the first's stamp.
      */
      const locked = await tx.$queryRaw<Array<{ id: string; voucherNumber: string; voidedAt: Date | null }>>`
        SELECT "id", "voucherNumber", "voidedAt"
          FROM ${this.S}expense_vouchers
         WHERE "id" = ${id}::uuid
         FOR UPDATE
      `;
      const voucher = locked[0];
      if (!voucher) {
        throw new NotFoundError({ code: 'EXPENSE_NOT_FOUND', message: `Expense voucher ${id} was not found` });
      }
      if (voucher.voidedAt) {
        throw new ConflictError({
          code: 'EXPENSE_ALREADY_VOID',
          message: 'This expense voucher has already been cancelled.',
        });
      }

      const voidedAt = new Date();
      await this.ledger.reverseEntriesOf(tx, {
        source: 'EXPENSE_VOUCHER',
        sourceId: id,
        actorId: actor.id,
        occurredAt: voidedAt,
        note: `إلغاء سند الصرف ${voucher.voucherNumber}`,
      });

      await tx.expenseVoucher.update({
        where: { id },
        data: { voidedAt, voidedById: actor.id, voidReason: reason.trim() },
      });

      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'EXPENSE_VOIDED',
        entityType: 'ExpenseVoucher',
        entityId: id,
        after: { voucherNumber: voucher.voucherNumber, reason: reason.trim() },
      });

      const updated = await tx.expenseVoucher.findUniqueOrThrow({ where: { id }, select: VOUCHER_SELECT });
      return this.view(updated);
    });
  }

  /**
   * The one place a category row is written, so create and edit map the same
   * database refusals to the same codes.
   *
   * The duplicate budget code is caught as a `P2002` from the partial unique
   * index rather than by reading first: a read-then-write cannot see a row a
   * concurrent request has not committed yet, and the index can
   * ([docs/database.md](../../../../../docs/database.md)). Matched structurally
   * on `error.code`, never `instanceof`: the two generated clients have separate
   * error classes.
   */
  private async writeCategory(
    tx: Prisma.TransactionClient,
    id: string | null,
    data: {
      name: string;
      description: string | null;
      chapterCode: string | null;
      itemCode: string | null;
      active?: boolean;
    },
  ): Promise<ExpenseCategoryView> {
    const select = {
      id: true,
      key: true,
      name: true,
      description: true,
      chapterCode: true,
      itemCode: true,
      active: true,
    } as const;

    try {
      const row = id
        ? await tx.expenseCategory.update({ where: { id }, data, select })
        : await tx.expenseCategory.create({
            data: { ...data, sortOrder: 1_000 },
            select,
          });
      return { ...row, key: (row.key as ExpenseCategoryKey | null) ?? null };
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'P2002'
      ) {
        throw new ConflictError({
          code: 'EXPENSE_CATEGORY_CODE_TAKEN',
          message: 'Another category already carries that budget chapter and article.',
        });
      }
      throw error;
    }
  }

  /** The row as a screen reads it. `status` is derived, never a second stored copy of `voidedAt`. */
  private view(row: VoucherRow): ExpenseVoucherView {
    const name = (person: { firstName: string; lastName: string } | null): string | null =>
      person ? `${person.firstName} ${person.lastName}` : null;

    return {
      id: row.id,
      voucherNumber: row.voucherNumber,
      status: row.voidedAt ? 'VOID' : 'RECORDED',
      category: row.category,
      account: row.account,
      amount: row.amount.toNumber(),
      currency: row.currency,
      payee: row.payee,
      payeeStaffId: row.payeeStaffId,
      description: row.description,
      occurredAt: row.occurredAt.toISOString(),
      invoiceNumber: row.invoiceNumber,
      hasPhysicalReceipt: row.hasPhysicalReceipt,
      adjustmentReason: row.adjustmentReason,
      recordedByName: name(row.recordedBy),
      voidedAt: row.voidedAt?.toISOString() ?? null,
      voidedByName: name(row.voidedBy),
      voidReason: row.voidReason,
    };
  }
}

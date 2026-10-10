import { Injectable } from '@nestjs/common';
import {
  municipalToday,
  SALARY_URGENT_REASON,
  TREASURY_ADMIN_ROLES,
  type ExpenseCategoryKey,
  type ExpenseCategoryView,
  type ExpenseListResult,
  type ExpenseRequestListResult,
  type ExpenseRequestStatus,
  type ExpenseRequestView,
  type ExpenseVoucherView,
  type CreateExpenseCategoryInput,
  type RecordExpenseInput,
  type RecordExpenseResult,
  type RecordStaffSalaryInput,
  type RequestExpenseInput,
  type RequestExpenseResult,
  type UpdateExpenseCategoryInput,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { allocateDocumentNumber } from '../../common/document-number';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/exceptions';
import { AuditService } from '../audit/audit.service';
import { planExpenseDate, urgentCeilingBreached } from './expenses.plan';
import { isUniqueViolationOn } from './retry-key';
import { TreasuryLedgerService } from './treasury-ledger.service';
import { documentOccurredAt } from './treasury.plan';

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
  orderedAt: true,
  urgentReason: true,
  category: { select: { id: true, name: true } },
  account: { select: { id: true, name: true, currency: true } },
  recordedBy: { select: { firstName: true, lastName: true } },
  voidedBy: { select: { firstName: true, lastName: true } },
  orderedBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.ExpenseVoucherSelect;

type VoucherRow = Prisma.ExpenseVoucherGetPayload<{ select: typeof VOUCHER_SELECT }>;

/** The request row a list or a decision returns. */
const REQUEST_SELECT = {
  id: true,
  amount: true,
  currency: true,
  payee: true,
  description: true,
  invoiceNumber: true,
  hasPhysicalReceipt: true,
  requestedById: true,
  createdAt: true,
  decision: true,
  decidedAt: true,
  decisionReason: true,
  voucherId: true,
  category: { select: { id: true, name: true } },
  account: { select: { id: true, name: true, currency: true } },
  requestedBy: { select: { firstName: true, lastName: true } },
  decidedBy: { select: { firstName: true, lastName: true } },
  voucher: { select: { voucherNumber: true } },
} satisfies Prisma.ExpenseRequestSelect;

type RequestRow = Prisma.ExpenseRequestGetPayload<{ select: typeof REQUEST_SELECT }>;

/** Whether a role signs payment orders — the manager, acting for the head of the municipality. */
const ordersPayments = (role: string): boolean => (TREASURY_ADMIN_ROLES as readonly string[]).includes(role);

/**
 * النفقات — recording money out of a wallet, and cancelling a voucher.
 *
 * ## The payment order, and recording is paying
 *
 * Money leaves on the order of the head of the municipality (decree 5595/1982
 * art. 28 and 33; docs/finance.md §5.1, decided 2026-10-09). The manager's own
 * voucher is the order. An accountant either files a request (`requestPayment`)
 * that the manager orders — the order writes and pays the voucher — or, for
 * what art. 35 lets be paid first, pays at once with a reason and the voucher
 * waits for the manager to regularise it. Wherever a voucher is written, one
 * call writes it and the ledger entry that takes the money out, inside one
 * transaction: a voucher cannot exist without its movement, and a movement
 * cannot exist without the voucher explaining it.
 *
 * The outflow goes through `TreasuryLedgerService.post`, which holds the
 * wallet's row lock and refuses to take it below zero. That is the whole
 * safety story for "we cannot pay what we do not hold": it is one check, in one
 * place, behind a lock, shared with every other way money leaves.
 *
 * ## What the client is not trusted with
 *
 * The currency is taken from the wallet, never from the request, so a voucher
 * can never claim a currency its wallet does not hold. The voucher number is
 * drawn from `document_counters` in the same transaction
 * (`allocateDocumentNumber`, migration 0079). The balance it reports is read
 * back after the write, not computed on the client.
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

      /*
        A PATCH: what the request leaves out stays as it is. Read as a full
        replacement it cleared the budget codes of any edit that only renamed a
        band, and switched a retired band back on whenever `active` was omitted.
      */
      const updated = await this.writeCategory(tx, id, {
        name: input.name.trim(),
        ...(input.description !== undefined ? { description: input.description.trim() || null } : {}),
        ...(input.chapterCode !== undefined ? { chapterCode: input.chapterCode.trim() || null } : {}),
        ...(input.itemCode !== undefined ? { itemCode: input.itemCode.trim() || null } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
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
    /** Only urgent payments still waiting for the manager's order (art. 35). */
    awaitingOrder?: boolean;
    page?: number;
    pageSize?: number;
  }): Promise<ExpenseListResult> {
    const pageSize = Math.min(Math.max(filters.pageSize ?? PAGE_DEFAULT, 1), PAGE_MAX);
    const page = Math.max(filters.page ?? 1, 1);

    const where: Prisma.ExpenseVoucherWhereInput = {
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.accountId ? { accountId: filters.accountId } : {}),
      ...(filters.includeVoid && !filters.awaitingOrder ? {} : { voidedAt: null }),
      ...(filters.awaitingOrder ? { orderedAt: null } : {}),
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
   * Refuses, writing nothing, when the treasury is not live, an accountant
   * gives no urgent reason or pays above the urgent ceiling, the category is
   * gone or switched off, the date breaks one of the three rules in
   * `planExpenseDate`, or the wallet does not hold the amount.
   */
  async record(input: RecordExpenseInput, actor: { id: string; role: string }): Promise<RecordExpenseResult> {
    try {
      return await runInTenantTransaction(this.tenantContext, () => this.recordInTransaction(input, actor, null));
    } catch (error) {
      /*
        Two presses carrying one key, past both reads at the same moment: the
        loser's insert hits the unique index on `clientRequestId` and its
        transaction is gone. Answer it from the winner's voucher, read afresh,
        rather than as a server error — the supplier is paid once either way.
      */
      if (input.clientRequestId && isUniqueViolationOn(error, 'clientRequestId')) {
        const replay = await this.replayVoucher(this.db as Prisma.TransactionClient, input, actor, null);
        if (replay) return replay;
      }
      throw error;
    }
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
   * The payment order (decided 2026-10-10): decree 5595/1982 art. 35 names
   * salaries among what may be paid before the order. So the manager's payout
   * is ordered, as any voucher of his, and an accountant's is paid at once on
   * the urgent path with `SALARY_URGENT_REASON`, written here rather than asked
   * for, and waits for the manager's regularisation like any urgent voucher.
   * The urgent-payment ceiling does not apply to it (`recordInTransaction`).
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
    // The voucher's own input, built in the transaction; a lost key race is replayed against it, as in `record`.
    const built: { voucher?: RecordExpenseInput } = {};
    try {
      return await runInTenantTransaction(this.tenantContext, async () => {
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

        /*
          Nobody pays himself on the urgent path. An accountant's salary leaves the
          safe before any order, so an accountant naming himself would be paying
          himself with only his own word behind it — the control behind
          CUSTODY_SELF_RECEIPT, for the same reason. The manager records it, or it
          goes as a request for his order.
        */
        if (!ordersPayments(actor.role) && staff.id === actor.id) {
          throw new ForbiddenError({
            code: 'SALARY_SELF_PAYOUT',
            message: 'Staff cannot pay their own salary; the manager records it, or send it as a request.',
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

        built.voucher = {
          categoryId: category.id,
          accountId: input.accountId,
          amount: input.amount,
          payee: `${staff.firstName} ${staff.lastName}`.trim(),
          description: input.description,
          invoiceNumber: input.invoiceNumber,
          // Art. 35: an accountant's salary is paid before the order; the manager's payout is the order.
          urgentReason: ordersPayments(actor.role) ? undefined : SALARY_URGENT_REASON,
          clientRequestId: input.clientRequestId,
        };
        return this.recordInTransaction(built.voucher, actor, staff.id);
      });
    } catch (error) {
      if (built.voucher && isUniqueViolationOn(error, 'clientRequestId')) {
        const replay = await this.replayVoucher(this.db as Prisma.TransactionClient, built.voucher, actor, staffId);
        if (replay) return replay;
      }
      throw error;
    }
  }

  /** The one write behind `record` and `recordSalary`. `payeeStaffId` is null except for a salary. */
  private async recordInTransaction(
    input: RecordExpenseInput,
    actor: { id: string; role: string },
    payeeStaffId: string | null,
  ): Promise<RecordExpenseResult> {
    {
      const tx = this.db as Prisma.TransactionClient;

      /*
        Checked before anything is written, so a double-clicked button answers
        with the first voucher instead of paying the supplier twice — and again
        once the wallet is locked, below, for the press that arrived while the
        first was still running.

        The retry key is serialised first, as `IncomeService.record` does in
        its own namespace: a second press with the same key waits here until the
        first commits, then finds its voucher. It complements, and does not
        replace, the answer `record` gives a unique violation on
        `clientRequestId` (a press that got past this point by another road
        is still answered from the winner's voucher). The key names the schema,
        so two municipalities never wait on each other. Taken before any row
        lock, so it adds no lock-order edge (`TreasuryLedgerService.lockAccounts`).
      */
      if (input.clientRequestId) {
        const lockKey = `${this.tenantContext.schemaName}:expense-request:${input.clientRequestId}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      }

      const replay = await this.replayVoucher(tx, input, actor, payeeStaffId);
      if (replay) return replay;

      const config = await this.ledger.config(tx);
      if (!config.goLiveAt) {
        throw new ConflictError({
          code: 'TREASURY_NOT_ACTIVE',
          message: 'The treasury is not active, so no money can leave it yet.',
        });
      }

      /*
        «أمر الصرف» (decree 5595/1982 art. 28 and 33): money leaves on the order
        of the head of the municipality. The manager's own voucher is that order.
        An accountant pays without one only for what art. 35 allows — salaries,
        routine petty and urgent expenses — and says why (a salary's reason is
        written by `recordSalary`), up to the manager's ceiling below, and the
        voucher then waits for the manager to regularise it; everything else
        goes to the manager as a request (`requestPayment`) and moves no money
        until ordered.
      */
      const ordered = ordersPayments(actor.role);
      const urgentReason = ordered ? null : input.urgentReason?.trim() || null;
      if (!ordered && !urgentReason) {
        throw new ConflictError({
          code: 'EXPENSE_ORDER_REQUIRED',
          message:
            "An expense is paid only on the manager's payment order: send it as a request, or give the reason it is urgent.",
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

      const category = await this.activeCategory(tx, input.categoryId);

      // The currency comes from the wallet, never from the request.
      const account = await this.payingAccount(tx, input.accountId);

      /*
        «سقف الدفع العاجل» (decision D6): art. 35 covers salaries, routine petty
        and genuinely urgent spending, not a large purchase called urgent. Above
        the manager's ceiling for the wallet's currency, an accountant's urgent
        payment is refused and goes to him as a request. Read from the settings
        row `config` already holds FOR SHARE. Not for the manager's own voucher,
        which is the order, nor for a salary (`payeeStaffId`, written only by
        `recordSalary`): art. 35 names salaries, so no ceiling holds them back.
      */
      if (!ordered && payeeStaffId === null) {
        const breach = urgentCeilingBreached({
          amount: input.amount,
          currency: account.currency,
          ceilings: config.urgentExpenseCeiling,
        });
        if (breach) {
          throw new ConflictError({
            code: 'EXPENSE_URGENT_OVER_CEILING',
            message: `An urgent payment is capped at ${breach.ceiling} ${breach.currency}; above it, the manager orders it.`,
            params: breach,
          });
        }
      }

      const occurredAt = documentOccurredAt({
        day: verdict.paidOn,
        today,
        now: new Date(),
        goLiveAt: config.goLiveAt,
      });

      /*
        The wallet's strong lock before anything references it (see
        `TreasuryLedgerService.lockAccounts`): the voucher's foreign key would
        otherwise take a weak one first, and an expense and a handover on the
        same safe deadlocked. Then the retry key is asked once more, now that a
        press racing this one has either committed or not started.
      */
      await this.ledger.lockAccounts(tx, [account.id]);
      const lateReplay = await this.replayVoucher(tx, input, actor, payeeStaffId);
      if (lateReplay) return lateReplay;

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
          orderedAt: ordered ? new Date() : null,
          orderedById: ordered ? actor.id : null,
          urgentReason,
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
          // Whether the order came with it, or the payment was urgent and waits for one (art. 35).
          ordered,
          ...(payeeStaffId ? { payeeStaffId } : {}),
        },
      });

      return {
        id: voucher.id,
        voucherNumber,
        balanceAfter: (await this.ledger.balanceOf(tx, account.id)).toNumber(),
        currency: account.currency,
        replayed: false,
        orderStatus: ordered ? 'ORDERED' : 'AWAITING_ORDER',
      };
    }
  }

  /**
   * The wallet an expense may be paid from: an active municipal wallet, never a
   * collector's custody.
   *
   * A custody wallet is the cash a collector is still carrying. Paying an
   * expense out of it would let an accountant write his liability down with
   * nobody counting the notes — the shortage write-off docs/finance.md §6.3
   * keeps for the manager — and a collector may pay nothing out himself
   * (decree 5595/1982 art. 93).
   */
  private async payingAccount(
    tx: Prisma.TransactionClient,
    accountId: string,
  ): Promise<{ id: string; name: string; currency: string }> {
    const account = await tx.treasuryAccount.findFirst({
      where: { id: accountId, active: true },
      select: { id: true, name: true, currency: true, type: true },
    });
    if (!account) {
      throw new NotFoundError({
        code: 'TREASURY_ACCOUNT_NOT_FOUND',
        message: `Treasury account ${accountId} was not found`,
      });
    }
    if (account.type === 'COLLECTOR_CUSTODY') {
      throw new ConflictError({
        code: 'EXPENSE_ACCOUNT_NOT_PAYABLE',
        message: 'An expense cannot be paid out of a collector custody wallet.',
      });
    }
    return { id: account.id, name: account.name, currency: account.currency };
  }

  /**
   * The voucher a retry key already produced, if any.
   *
   * A key names one act: this clerk paying this amount out of this wallet, to
   * this payee, for this, under this band — the fields the form renews its key
   * on — and, for a salary, to this staff account (`payeeStaffId`, so two staff
   * members who share a name are two acts; null on any other voucher). Replayed
   * with all of them it answers with the first voucher; anything
   * else is a new act under an old key, and is refused rather than silently
   * answered with a voucher the clerk did not ask for. What the form does not
   * renew the key on (the invoice number, the receipt flag, the reasons) is not
   * compared: a retry is the same payment, and the voucher keeps what it was
   * first recorded with.
   *
   * A voucher cancelled since is not answered as recorded: the clerk would read
   * «سُجّل» for money the register no longer shows as paid.
   */
  private async replayVoucher(
    tx: Prisma.TransactionClient,
    input: RecordExpenseInput,
    actor: { id: string },
    payeeStaffId: string | null,
  ): Promise<RecordExpenseResult | null> {
    if (!input.clientRequestId) return null;
    const earlier = await tx.expenseVoucher.findUnique({
      where: { clientRequestId: input.clientRequestId },
      select: {
        id: true,
        voucherNumber: true,
        accountId: true,
        currency: true,
        amount: true,
        recordedById: true,
        categoryId: true,
        payee: true,
        payeeStaffId: true,
        description: true,
        orderedAt: true,
        voidedAt: true,
      },
    });
    if (!earlier) return null;
    if (
      earlier.accountId !== input.accountId ||
      !earlier.amount.equals(new Prisma.Decimal(input.amount)) ||
      earlier.recordedById !== actor.id ||
      earlier.categoryId !== input.categoryId ||
      earlier.payee !== input.payee.trim() ||
      earlier.payeeStaffId !== payeeStaffId ||
      earlier.description !== input.description.trim()
    ) {
      throw new ConflictError({
        code: 'TREASURY_REQUEST_KEY_REUSED',
        message: 'This request id was already used for a different voucher.',
      });
    }
    if (earlier.voidedAt) {
      throw new ConflictError({
        code: 'EXPENSE_ALREADY_VOID',
        message: `This request was recorded as ${earlier.voucherNumber}, and that voucher has since been cancelled.`,
        params: { voucherNumber: earlier.voucherNumber },
      });
    }
    return {
      id: earlier.id,
      voucherNumber: earlier.voucherNumber,
      balanceAfter: (await this.ledger.balanceOf(tx, earlier.accountId)).toNumber(),
      currency: earlier.currency,
      replayed: true,
      orderStatus: earlier.orderedAt ? 'ORDERED' : 'AWAITING_ORDER',
    };
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

  // ───────────────────────  «أمر الصرف» — the payment order  ───────────────────────

  /**
   * «طلب أمر صرف» — an accountant prepares an expense for the manager's order.
   *
   * Nothing leaves a wallet here: the cashier pays an order that bears the
   * signature of the head of the municipality (decree 5595/1982 art. 28, 33).
   * What does not depend on the day — the treasury is live, the band is in use,
   * the wallet is a municipal one — is checked now, so the manager is not handed
   * a request that cannot be ordered. The balance is checked when the money
   * actually leaves, at the order.
   */
  async requestPayment(
    input: RequestExpenseInput,
    actor: { id: string; role: string },
  ): Promise<RequestExpenseResult> {
    try {
      return await runInTenantTransaction(this.tenantContext, async () => {
        const tx = this.db as Prisma.TransactionClient;

        const replay = await this.replayRequest(tx, input, actor);
        if (replay) return replay;

        const config = await this.ledger.config(tx);
        if (!config.goLiveAt) {
          throw new ConflictError({
            code: 'TREASURY_NOT_ACTIVE',
            message: 'The treasury is not active, so no payment can be requested from it yet.',
          });
        }
        const category = await this.activeCategory(tx, input.categoryId);
        const account = await this.payingAccount(tx, input.accountId);

        const request = await tx.expenseRequest.create({
          data: {
            categoryId: category.id,
            accountId: account.id,
            currency: account.currency,
            amount: new Prisma.Decimal(input.amount),
            payee: input.payee.trim(),
            description: input.description.trim(),
            invoiceNumber: input.invoiceNumber?.trim() || null,
            hasPhysicalReceipt: input.hasPhysicalReceipt ?? false,
            requestedById: actor.id,
            clientRequestId: input.clientRequestId ?? null,
          },
          select: { id: true },
        });

        // Tier 1, and like the voucher's: no payee — free text that may name a citizen.
        await this.audit.recordInTransaction({
          actorId: actor.id,
          actorType: 'STAFF',
          actorRole: actor.role as never,
          action: 'EXPENSE_REQUESTED',
          entityType: 'ExpenseRequest',
          entityId: request.id,
          after: { amount: input.amount, currency: account.currency, categoryId: category.id, accountId: account.id },
        });

        return { id: request.id, status: 'PENDING', replayed: false };
      });
    } catch (error) {
      // The same race as a voucher's double press: answer the loser from the winner's request.
      if (input.clientRequestId && isUniqueViolationOn(error, 'clientRequestId')) {
        const replay = await this.replayRequest(this.db as Prisma.TransactionClient, input, actor);
        if (replay) return replay;
      }
      throw error;
    }
  }

  /** The requests, newest first — by default the manager's queue, those still waiting. */
  async listRequests(filters: {
    status?: ExpenseRequestStatus;
    page?: number;
    pageSize?: number;
  }): Promise<ExpenseRequestListResult> {
    const pageSize = Math.min(Math.max(filters.pageSize ?? PAGE_DEFAULT, 1), PAGE_MAX);
    const page = Math.max(filters.page ?? 1, 1);
    const status = filters.status ?? 'PENDING';
    const where: Prisma.ExpenseRequestWhereInput = status === 'PENDING' ? { decision: null } : { decision: status };

    const [rows, total] = await Promise.all([
      this.db.expenseRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: REQUEST_SELECT,
      }),
      this.db.expenseRequest.count({ where }),
    ]);
    return { requests: rows.map((row) => this.requestView(row)), total };
  }

  /**
   * «إصدار أمر الصرف» — the manager orders a request, and the money leaves.
   *
   * One transaction: the request is locked and found still waiting, the voucher
   * is written with its PV number and its order, the wallet is debited behind
   * its lock (refused below zero, which leaves the request waiting), and the
   * request records the decision and the voucher it produced. The voucher names
   * the accountant who prepared it as its recorder and the manager as its
   * orderer — the two signatures the decree asks for.
   */
  async orderRequest(id: string, actor: { id: string; role: string }): Promise<RecordExpenseResult> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;

      /*
        The request's own id is the retry key of an order. A manager whose
        answer was lost, and who presses again, is answered with the voucher his
        order paid rather than «بُتّ في هذا الطلب» — he would otherwise not know
        it was paid, or by which voucher. Read under the row lock, so a second
        press racing the first waits for it and is answered the same way. Another
        manager's order is not his to be answered with.
      */
      const locked = await this.lockRequest(tx, id);
      if (locked.decision === 'ORDERED' && locked.decidedById === actor.id && locked.voucherId) {
        return this.answerOrder(tx, locked.voucherId);
      }
      const request = await this.lockPendingRequest(tx, id);

      const config = await this.ledger.config(tx);
      if (!config.goLiveAt) {
        throw new ConflictError({
          code: 'TREASURY_NOT_ACTIVE',
          message: 'The treasury is not active, so no money can leave it yet.',
        });
      }
      const category = await this.activeCategory(tx, request.categoryId);
      const account = await this.payingAccount(tx, request.accountId);

      // Strong lock before anything references the wallet (see `lockAccounts`).
      await this.ledger.lockAccounts(tx, [account.id]);
      const now = new Date();
      const voucherNumber = await allocateDocumentNumber(tx, this.S, 'VOUCHER');

      const voucher = await tx.expenseVoucher.create({
        data: {
          voucherNumber,
          categoryId: category.id,
          accountId: account.id,
          currency: account.currency,
          amount: request.amount,
          payee: request.payee,
          description: request.description,
          occurredAt: now,
          invoiceNumber: request.invoiceNumber,
          hasPhysicalReceipt: request.hasPhysicalReceipt,
          recordedById: request.requestedById,
          orderedAt: now,
          orderedById: actor.id,
        },
        select: { id: true },
      });

      await this.ledger.post(
        tx,
        [{ accountId: account.id, currency: account.currency, amount: request.amount.negated() }],
        {
          source: 'EXPENSE_VOUCHER',
          sourceId: voucher.id,
          actorId: actor.id,
          occurredAt: now,
          exchangeRate: config.exchangeRate,
        },
      );

      await tx.expenseRequest.update({
        where: { id },
        data: { decision: 'ORDERED', decidedAt: now, decidedById: actor.id, voucherId: voucher.id },
      });

      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'EXPENSE_ORDERED',
        entityType: 'ExpenseVoucher',
        entityId: voucher.id,
        after: {
          voucherNumber,
          requestId: id,
          amount: request.amount.toNumber(),
          currency: account.currency,
          categoryId: category.id,
          accountId: account.id,
        },
      });

      return {
        id: voucher.id,
        voucherNumber,
        balanceAfter: (await this.ledger.balanceOf(tx, account.id)).toNumber(),
        currency: account.currency,
        replayed: false,
        orderStatus: 'ORDERED',
      };
    });
  }

  /** «رفض الطلب» — the manager declines a request, with a reason. No money ever moved. */
  async rejectRequest(id: string, reason: string, actor: { id: string; role: string }): Promise<ExpenseRequestView> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      await this.lockPendingRequest(tx, id);

      await tx.expenseRequest.update({
        where: { id },
        data: { decision: 'REJECTED', decidedAt: new Date(), decidedById: actor.id, decisionReason: reason.trim() },
      });
      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'EXPENSE_REQUEST_REJECTED',
        entityType: 'ExpenseRequest',
        entityId: id,
        after: { reason: reason.trim() },
      });

      return this.requestView(await tx.expenseRequest.findUniqueOrThrow({ where: { id }, select: REQUEST_SELECT }));
    });
  }

  /**
   * «سحب الطلب» — its author takes back a request still waiting (the manager
   * may too). Anyone else is refused: a request is one accountant's word, and
   * another may not unsay it.
   */
  async withdrawRequest(id: string, actor: { id: string; role: string }): Promise<ExpenseRequestView> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const request = await this.lockPendingRequest(tx, id);
      if (request.requestedById !== actor.id && !ordersPayments(actor.role)) {
        throw new ForbiddenError({
          code: 'EXPENSE_REQUEST_NOT_YOURS',
          message: 'Only the person who prepared a request, or the manager, can withdraw it.',
        });
      }

      await tx.expenseRequest.update({
        where: { id },
        data: { decision: 'WITHDRAWN', decidedAt: new Date(), decidedById: actor.id },
      });
      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'EXPENSE_REQUEST_WITHDRAWN',
        entityType: 'ExpenseRequest',
        entityId: id,
        after: {},
      });

      return this.requestView(await tx.expenseRequest.findUniqueOrThrow({ where: { id }, select: REQUEST_SELECT }));
    });
  }

  /**
   * «تسوية بأمر صرف» — the manager's order for an urgent payment an accountant
   * already made (decree 5595/1982 art. 35: the order follows). The money has
   * moved; this stamps the order on the voucher, once. A payment the manager
   * will not order is cancelled instead (`void`), which returns the money.
   */
  async regularize(voucherId: string, actor: { id: string; role: string }): Promise<ExpenseVoucherView> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const locked = await tx.$queryRaw<
        Array<{ id: string; voucherNumber: string; voidedAt: Date | null; orderedAt: Date | null }>
      >`
        SELECT "id", "voucherNumber", "voidedAt", "orderedAt"
          FROM ${this.S}expense_vouchers
         WHERE "id" = ${voucherId}::uuid
         FOR UPDATE
      `;
      const voucher = locked[0];
      if (!voucher) {
        throw new NotFoundError({ code: 'EXPENSE_NOT_FOUND', message: `Expense voucher ${voucherId} was not found` });
      }
      if (voucher.voidedAt) {
        throw new ConflictError({ code: 'EXPENSE_ALREADY_VOID', message: 'This expense voucher has been cancelled.' });
      }
      if (voucher.orderedAt) {
        throw new ConflictError({
          code: 'EXPENSE_ALREADY_ORDERED',
          message: 'This voucher already carries its payment order.',
        });
      }

      await tx.expenseVoucher.update({
        where: { id: voucherId },
        data: { orderedAt: new Date(), orderedById: actor.id },
      });
      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'EXPENSE_ORDERED',
        entityType: 'ExpenseVoucher',
        entityId: voucherId,
        after: { voucherNumber: voucher.voucherNumber, afterPayment: true },
      });

      return this.view(await tx.expenseVoucher.findUniqueOrThrow({ where: { id: voucherId }, select: VOUCHER_SELECT }));
    });
  }

  /** A band money may still be spent under. */
  private async activeCategory(
    tx: Prisma.TransactionClient,
    categoryId: string,
  ): Promise<{ id: string; name: string }> {
    const category = await tx.expenseCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, name: true, active: true },
    });
    if (!category) {
      throw new NotFoundError({
        code: 'EXPENSE_CATEGORY_NOT_FOUND',
        message: `Expense category ${categoryId} was not found`,
      });
    }
    if (!category.active) {
      throw new ConflictError({
        code: 'EXPENSE_CATEGORY_INACTIVE',
        message: 'That expense category is no longer in use.',
        params: { category: category.name },
      });
    }
    return { id: category.id, name: category.name };
  }

  /**
   * A request still waiting for its decision, locked so two managers deciding
   * it together meet here one after the other and the second finds the first's.
   */
  /** Locks a request's row, so two decisions on it are taken one after the other. */
  private async lockRequest(tx: Prisma.TransactionClient, id: string) {
    const locked = await tx.$queryRaw<
      Array<{ id: string; decision: string | null; decidedById: string | null; voucherId: string | null }>
    >`
      SELECT "id", "decision", "decidedById", "voucherId"
        FROM ${this.S}expense_requests
       WHERE "id" = ${id}::uuid
       FOR UPDATE
    `;
    if (!locked[0]) {
      throw new NotFoundError({ code: 'EXPENSE_REQUEST_NOT_FOUND', message: `Expense request ${id} was not found` });
    }
    return locked[0];
  }

  /** What an order already given answers its own repeat with: the voucher it paid. */
  private async answerOrder(tx: Prisma.TransactionClient, voucherId: string): Promise<RecordExpenseResult> {
    const voucher = await tx.expenseVoucher.findUniqueOrThrow({
      where: { id: voucherId },
      select: { id: true, voucherNumber: true, accountId: true, currency: true, voidedAt: true },
    });
    if (voucher.voidedAt) {
      throw new ConflictError({
        code: 'EXPENSE_ALREADY_VOID',
        message: `This order paid ${voucher.voucherNumber}, and that voucher has since been cancelled.`,
        params: { voucherNumber: voucher.voucherNumber },
      });
    }
    return {
      id: voucher.id,
      voucherNumber: voucher.voucherNumber,
      balanceAfter: (await this.ledger.balanceOf(tx, voucher.accountId)).toNumber(),
      currency: voucher.currency,
      replayed: true,
      orderStatus: 'ORDERED',
    };
  }

  private async lockPendingRequest(tx: Prisma.TransactionClient, id: string) {
    const locked = await this.lockRequest(tx, id);
    if (locked.decision) {
      throw new ConflictError({
        code: 'EXPENSE_REQUEST_ALREADY_DECIDED',
        message: 'This request has already been decided.',
      });
    }
    return tx.expenseRequest.findUniqueOrThrow({
      where: { id },
      select: {
        categoryId: true,
        accountId: true,
        amount: true,
        payee: true,
        description: true,
        invoiceNumber: true,
        hasPhysicalReceipt: true,
        requestedById: true,
      },
    });
  }

  /** The request a retry key already filed, bound to its act as a voucher's key is (`replayVoucher`). */
  private async replayRequest(
    tx: Prisma.TransactionClient,
    input: RequestExpenseInput,
    actor: { id: string },
  ): Promise<RequestExpenseResult | null> {
    if (!input.clientRequestId) return null;
    const earlier = await tx.expenseRequest.findUnique({
      where: { clientRequestId: input.clientRequestId },
      select: {
        id: true,
        accountId: true,
        amount: true,
        requestedById: true,
        categoryId: true,
        payee: true,
        description: true,
        decision: true,
      },
    });
    if (!earlier) return null;
    if (
      earlier.accountId !== input.accountId ||
      !earlier.amount.equals(new Prisma.Decimal(input.amount)) ||
      earlier.requestedById !== actor.id ||
      earlier.categoryId !== input.categoryId ||
      earlier.payee !== input.payee.trim() ||
      earlier.description !== input.description.trim()
    ) {
      throw new ConflictError({
        code: 'TREASURY_REQUEST_KEY_REUSED',
        message: 'This request id was already used for a different request.',
      });
    }
    return { id: earlier.id, status: (earlier.decision as ExpenseRequestStatus | null) ?? 'PENDING', replayed: true };
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
      description?: string | null;
      chapterCode?: string | null;
      itemCode?: string | null;
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
      orderStatus: row.orderedAt ? 'ORDERED' : 'AWAITING_ORDER',
      orderedAt: row.orderedAt?.toISOString() ?? null,
      orderedByName: name(row.orderedBy),
      urgentReason: row.urgentReason,
    };
  }

  /** A request as a screen reads it. Its status is derived from the decision, written once. */
  private requestView(row: RequestRow): ExpenseRequestView {
    const name = (person: { firstName: string; lastName: string } | null): string | null =>
      person ? `${person.firstName} ${person.lastName}` : null;

    return {
      id: row.id,
      status: (row.decision as ExpenseRequestStatus | null) ?? 'PENDING',
      category: row.category,
      account: row.account,
      amount: row.amount.toNumber(),
      currency: row.currency,
      payee: row.payee,
      description: row.description,
      invoiceNumber: row.invoiceNumber,
      hasPhysicalReceipt: row.hasPhysicalReceipt,
      requestedById: row.requestedById,
      requestedByName: name(row.requestedBy),
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decidedByName: name(row.decidedBy),
      decisionReason: row.decisionReason,
      voucherId: row.voucherId,
      voucherNumber: row.voucher?.voucherNumber ?? null,
    };
  }
}

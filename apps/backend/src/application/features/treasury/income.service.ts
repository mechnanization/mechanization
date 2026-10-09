import { Injectable } from '@nestjs/common';
import {
  canReceiveIncome,
  municipalToday,
  type CreateIncomeCategoryInput,
  type IncomeCategoryKey,
  type IncomeCategoryView,
  type IncomeListResult,
  type IncomeVoucherView,
  type ListIncomeVouchersQuery,
  type RecordIncomeVoucherInput,
  type RecordIncomeVoucherResult,
  type TreasuryAccountType,
  type UpdateIncomeCategoryInput,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { allocateDocumentNumber } from '../../common/document-number';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { AuditService } from '../audit/audit.service';
import { incomeOccurredAt, incomePeriod, planIncomeDate } from './income.plan';
import { TreasuryLedgerService } from './treasury-ledger.service';

/** The voucher row a list or a read returns, with everything the screen names. */
const VOUCHER_SELECT = {
  id: true,
  voucherNumber: true,
  amount: true,
  currency: true,
  payerName: true,
  description: true,
  externalReference: true,
  occurredAt: true,
  adjustmentReason: true,
  voidedAt: true,
  voidReason: true,
  category: { select: { id: true, labelAr: true, labelEn: true } },
  account: { select: { id: true, name: true, currency: true } },
  recordedBy: { select: { firstName: true, lastName: true } },
  voidedBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.IncomeVoucherSelect;

type VoucherRow = Prisma.IncomeVoucherGetPayload<{ select: typeof VOUCHER_SELECT }>;

const CATEGORY_SELECT = {
  id: true,
  key: true,
  labelAr: true,
  labelEn: true,
  chapterCode: true,
  itemCode: true,
  active: true,
} satisfies Prisma.IncomeCategorySelect;

/**
 * الإيرادات العامة — recording money into a wallet that no citizen's bill
 * brought, and cancelling a voucher. Design: docs/finance.md §4.
 *
 * ## Recording is receiving
 *
 * One call writes the «سند قبض» and the ledger entry that raises the wallet's
 * balance, inside one transaction. So a voucher cannot exist without its
 * movement, and a movement cannot exist without the voucher explaining it. The
 * twin of `ExpensesService`, run the other way.
 *
 * ## What the client is not trusted with
 *
 * The currency is taken from the wallet, never from the request. Which wallets
 * may receive is checked here (`canReceiveIncome`): a collector's custody is his
 * pocket on a round, and the Fund's transfer does not go into it. The number is
 * drawn from the month's counter. The balance it reports is read back after
 * the write.
 *
 * ## Cancelling takes money out
 *
 * Unlike an expense, whose cancellation puts money back, cancelling income
 * removes it — and the wallet may have spent it since. That is refused
 * (docs/finance.md §4.4), behind the wallet's row lock, with
 * `TREASURY_INSUFFICIENT_FUNDS_FOR_VOID` naming what is there and what is
 * needed, so the manager knows to move money in first rather than reading a
 * generic shortfall.
 */
@Injectable()
export class IncomeService {
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

  /** Where income may be filed. Inactive ones are kept for the vouchers that point at them. */
  async categories(includeInactive = false): Promise<IncomeCategoryView[]> {
    const rows = await this.db.incomeCategory.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: [{ sortOrder: 'asc' }, { labelAr: 'asc' }],
      select: CATEGORY_SELECT,
    });
    return rows.map((row) => ({ ...row, key: (row.key as IncomeCategoryKey | null) ?? null }));
  }

  /**
   * «بند إيراد جديد» — a source of income the municipality names itself.
   *
   * `key` stays NULL: it is the handle for the seeded categories, and nothing in
   * the code looks for one a municipality invented. It goes to the end of the
   * list (`sortOrder` 1000), after the seven seeded ones.
   */
  async createCategory(
    input: CreateIncomeCategoryInput,
    actor: { id: string; role: string },
  ): Promise<IncomeCategoryView> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const created = await this.writeCategory(tx, null, {
        labelAr: input.labelAr.trim(),
        labelEn: input.labelEn?.trim() || null,
        chapterCode: input.chapterCode?.trim() || null,
        itemCode: input.itemCode?.trim() || null,
      });

      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'INCOME_CATEGORY_CREATED',
        entityType: 'IncomeCategory',
        entityId: created.id,
        after: {
          labelAr: created.labelAr,
          labelEn: created.labelEn,
          chapterCode: created.chapterCode,
          itemCode: created.itemCode,
        },
      });
      return created;
    });
  }

  /**
   * Renames a category, re-codes it, or stops or restarts it.
   *
   * Never deletes: every voucher ever filed under it still points here, and
   * the foreign key is RESTRICT. `active` absent keeps what the category had, so
   * correcting the spelling of a stopped one does not put it back in use.
   */
  async updateCategory(
    id: string,
    input: UpdateIncomeCategoryInput,
    actor: { id: string; role: string },
  ): Promise<IncomeCategoryView> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const before = await tx.incomeCategory.findUnique({ where: { id }, select: CATEGORY_SELECT });
      if (!before) {
        throw new NotFoundError({
          code: 'INCOME_CATEGORY_NOT_FOUND',
          message: `Income category ${id} was not found`,
        });
      }

      const updated = await this.writeCategory(tx, id, {
        labelAr: input.labelAr.trim(),
        labelEn: input.labelEn?.trim() || null,
        chapterCode: input.chapterCode?.trim() || null,
        itemCode: input.itemCode?.trim() || null,
        active: input.active ?? before.active,
      });

      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'INCOME_CATEGORY_UPDATED',
        entityType: 'IncomeCategory',
        entityId: id,
        before: {
          labelAr: before.labelAr,
          labelEn: before.labelEn,
          chapterCode: before.chapterCode,
          itemCode: before.itemCode,
          active: before.active,
        },
        after: {
          labelAr: updated.labelAr,
          labelEn: updated.labelEn,
          chapterCode: updated.chapterCode,
          itemCode: updated.itemCode,
          active: updated.active,
        },
      });
      return updated;
    });
  }

  /** The register: newest first, filtered, with what the filtered set adds up to. */
  async list(query: ListIncomeVouchersQuery): Promise<IncomeListResult> {
    const period = incomePeriod(query.from, query.to);
    const search = query.search?.trim();

    const where: Prisma.IncomeVoucherWhereInput = {
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.currency ? { currency: query.currency } : {}),
      ...(query.includeVoid ? {} : { voidedAt: null }),
      ...(period.gte || period.lt ? { occurredAt: period } : {}),
      ...(search
        ? {
            OR: [
              { voucherNumber: { contains: search, mode: 'insensitive' } },
              { payerName: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } },
              { externalReference: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total, sums] = await Promise.all([
      this.db.incomeVoucher.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: VOUCHER_SELECT,
      }),
      this.db.incomeVoucher.count({ where }),
      /*
        Totals over the whole filtered set, not the page — «كم وصلنا من الصندوق
        البلدي المستقل هذه السنة» is the question the register is opened with.
        Cancelled vouchers are always excluded: they brought in nothing in the end.
      */
      this.db.incomeVoucher.groupBy({
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

  async get(id: string): Promise<IncomeVoucherView> {
    const row = await this.db.incomeVoucher.findUnique({ where: { id }, select: VOUCHER_SELECT });
    if (!row) {
      throw new NotFoundError({ code: 'INCOME_VOUCHER_NOT_FOUND', message: `Income voucher ${id} was not found` });
    }
    return this.view(row);
  }

  /**
   * «سجّل الإيراد» — writes the voucher and credits the wallet, together.
   *
   * Refuses, writing nothing, when the treasury is not live, the date breaks one
   * of the three rules in `planIncomeDate`, the category is gone or switched
   * off, or the wallet does not exist or may not receive income.
   */
  async record(
    input: RecordIncomeVoucherInput,
    actor: { id: string; role: string },
  ): Promise<RecordIncomeVoucherResult> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;

      /*
        A double-click, or a retry after a lost response, must answer with the
        first voucher and credit nothing. Reading first is not enough on its own:
        two identical requests arriving together would both read nothing, and the
        second insert would die on the unique index as an unmapped 500. So the
        retry key is serialised first — the second request waits here until the
        first commits, then finds its voucher. The key names the schema, so two
        municipalities never wait on each other (docs/database.md).
      */
      const lockKey = `${this.tenantContext.schemaName}:income-request:${input.clientRequestId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

      const earlier = await tx.incomeVoucher.findUnique({
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

      const config = await this.ledger.config(tx);
      if (!config.goLiveAt) {
        throw new ConflictError({
          code: 'TREASURY_NOT_ACTIVE',
          message: 'The treasury is not active, so no wallet can receive money yet.',
        });
      }

      const today = municipalToday();
      const verdict = planIncomeDate({
        receivedOn: input.receivedOn,
        reason: input.adjustmentReason,
        goLiveOn: municipalToday(config.goLiveAt),
        today,
      });
      if (!verdict.ok) {
        if (verdict.code === 'INCOME_DATE_BEFORE_GO_LIVE') {
          throw new ValidationError({
            code: verdict.code,
            message: `Income cannot be dated before the treasury went live (${verdict.goLiveOn}).`,
            params: { date: verdict.goLiveOn },
          });
        }
        throw new ValidationError({
          code: verdict.code,
          message:
            verdict.code === 'INCOME_DATE_IN_FUTURE'
              ? 'Income cannot be dated after today.'
              : 'A back-dated income voucher must say why.',
          details: { receivedOn: input.receivedOn ?? today },
        });
      }

      const category = await tx.incomeCategory.findUnique({
        where: { id: input.categoryId },
        select: { id: true, labelAr: true, active: true },
      });
      if (!category) {
        throw new NotFoundError({
          code: 'INCOME_CATEGORY_NOT_FOUND',
          message: `Income category ${input.categoryId} was not found`,
        });
      }
      if (!category.active) {
        throw new ConflictError({
          code: 'INCOME_CATEGORY_INACTIVE',
          message: 'That income category is no longer in use.',
          params: { category: category.labelAr },
        });
      }

      // The currency comes from the wallet, never from the request.
      const account = await tx.treasuryAccount.findFirst({
        where: { id: input.accountId, active: true },
        select: { id: true, name: true, currency: true, type: true },
      });
      if (!account) {
        throw new NotFoundError({
          code: 'TREASURY_ACCOUNT_NOT_FOUND',
          message: `Treasury account ${input.accountId} was not found`,
        });
      }
      if (!canReceiveIncome(account.type as TreasuryAccountType)) {
        throw new ValidationError({
          code: 'INCOME_ACCOUNT_NOT_RECEIVING',
          message: `A ${account.type} account cannot receive income.`,
          params: { account: account.name },
        });
      }

      const occurredAt = incomeOccurredAt(verdict.receivedOn, today);
      const amount = new Prisma.Decimal(input.amount);

      // «RV-2610-0001». See `allocateDocumentNumbers` and migration 0079.
      const voucherNumber = await allocateDocumentNumber(tx, this.S, 'REVENUE_VOUCHER');

      const voucher = await tx.incomeVoucher.create({
        data: {
          voucherNumber,
          categoryId: category.id,
          accountId: account.id,
          currency: account.currency,
          amount,
          payerName: input.payerName?.trim() || null,
          description: input.description.trim(),
          externalReference: input.externalReference?.trim() || null,
          occurredAt,
          adjustmentReason: verdict.backdatedDays > 0 ? (input.adjustmentReason?.trim() ?? null) : null,
          recordedById: actor.id,
          clientRequestId: input.clientRequestId,
        },
        select: { id: true },
      });

      // The money arrives here, in the same transaction as the voucher that explains it.
      await this.ledger.post(
        tx,
        [{ accountId: account.id, currency: account.currency, amount }],
        {
          source: 'INCOME_VOUCHER',
          sourceId: voucher.id,
          actorId: actor.id,
          occurredAt,
          exchangeRate: config.exchangeRate,
        },
      );

      /*
        Tier 1: the audit row commits with the money or not at all. The payer is
        deliberately absent — free text that may name a citizen (a fine, a rent),
        and an audit row is not a second copy of personal data (docs/finance.md
        §4.4). The voucher number is the handle that leads to it.
      */
      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'INCOME_RECORDED',
        entityType: 'IncomeVoucher',
        entityId: voucher.id,
        after: {
          voucherNumber,
          amount: input.amount,
          currency: account.currency,
          categoryId: category.id,
          accountId: account.id,
          occurredAt: occurredAt.toISOString(),
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
   * «إلغاء سند القبض» — cancels a voucher and takes its money back out.
   *
   * The voucher is stamped rather than deleted, and the ledger gets an opposing
   * entry rather than losing the first one: «قُبض في الثالث وأُلغي في الخامس».
   */
  async void(id: string, reason: string, actor: { id: string; role: string }): Promise<IncomeVoucherView> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;

      /*
        Locked before it is read, so two managers pressing cancel together meet
        here one after the other and the second finds the first's stamp.
      */
      const locked = await tx.$queryRaw<
        Array<{ id: string; voucherNumber: string; voidedAt: Date | null; accountId: string; amount: Prisma.Decimal }>
      >`
        SELECT "id", "voucherNumber", "voidedAt", "accountId", "amount"
          FROM ${this.S}income_vouchers
         WHERE "id" = ${id}::uuid
         FOR UPDATE
      `;
      const voucher = locked[0];
      if (!voucher) {
        throw new NotFoundError({ code: 'INCOME_VOUCHER_NOT_FOUND', message: `Income voucher ${id} was not found` });
      }
      if (voucher.voidedAt) {
        throw new ConflictError({
          code: 'INCOME_VOUCHER_ALREADY_VOIDED',
          message: 'This income voucher has already been cancelled.',
        });
      }

      /*
        The wallet is locked and its balance read here, before the reversal, so
        a wallet that has spent the money refuses with the code that says so.
        The ledger's own post checks again behind the same lock, which this
        transaction already holds, so the two can never disagree.
      */
      const wallet = await tx.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT "id", "name"
          FROM ${this.S}treasury_accounts
         WHERE "id" = ${voucher.accountId}::uuid
         FOR UPDATE
      `;
      const available = await this.ledger.balanceOf(tx, voucher.accountId);
      const required = new Prisma.Decimal(voucher.amount);
      if (available.lessThan(required)) {
        throw new ConflictError({
          code: 'TREASURY_INSUFFICIENT_FUNDS_FOR_VOID',
          message: `Voiding ${voucher.voucherNumber} needs ${required.toString()}; the wallet holds ${available.toString()}.`,
          params: {
            voucher: voucher.voucherNumber,
            account: wallet[0]?.name ?? '',
            available: available.toNumber(),
            required: required.toNumber(),
          },
        });
      }

      const voidedAt = new Date();
      await this.ledger.reverseEntriesOf(tx, {
        source: 'INCOME_VOUCHER',
        sourceId: id,
        actorId: actor.id,
        occurredAt: voidedAt,
        note: `إلغاء سند القبض ${voucher.voucherNumber}`,
      });

      await tx.incomeVoucher.update({
        where: { id },
        data: { voidedAt, voidedById: actor.id, voidReason: reason.trim() },
      });

      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'INCOME_VOIDED',
        entityType: 'IncomeVoucher',
        entityId: id,
        after: { voucherNumber: voucher.voucherNumber, reason: reason.trim() },
      });

      const updated = await tx.incomeVoucher.findUniqueOrThrow({ where: { id }, select: VOUCHER_SELECT });
      return this.view(updated);
    });
  }

  /**
   * The one place a category row is written, so create and edit map the same
   * database refusal to the same code.
   *
   * A budget article already taken is caught as the `P2002` of the partial
   * unique index in 0080 rather than by reading first: a read cannot see a row
   * a concurrent request has not committed, and the index can. Matched
   * structurally on `error.code`, never `instanceof` — the two generated
   * clients have separate error classes (docs/database.md).
   */
  private async writeCategory(
    tx: Prisma.TransactionClient,
    id: string | null,
    data: {
      labelAr: string;
      labelEn: string | null;
      chapterCode: string | null;
      itemCode: string | null;
      active?: boolean;
    },
  ): Promise<IncomeCategoryView> {
    try {
      const row = id
        ? await tx.incomeCategory.update({ where: { id }, data, select: CATEGORY_SELECT })
        : await tx.incomeCategory.create({ data: { ...data, sortOrder: 1_000 }, select: CATEGORY_SELECT });
      return { ...row, key: (row.key as IncomeCategoryKey | null) ?? null };
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
        throw new ConflictError({
          code: 'INCOME_CATEGORY_CODE_TAKEN',
          message: 'Another income category already carries that budget chapter and article.',
        });
      }
      throw error;
    }
  }

  /** The row as a screen reads it. `status` is derived, never a second stored copy of `voidedAt`. */
  private view(row: VoucherRow): IncomeVoucherView {
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
      payerName: row.payerName,
      description: row.description,
      externalReference: row.externalReference,
      occurredAt: row.occurredAt.toISOString(),
      adjustmentReason: row.adjustmentReason,
      recordedByName: name(row.recordedBy),
      voidedAt: row.voidedAt?.toISOString() ?? null,
      voidedByName: name(row.voidedBy),
      voidReason: row.voidReason,
    };
  }
}

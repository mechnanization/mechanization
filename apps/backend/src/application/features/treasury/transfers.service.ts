import { Injectable } from '@nestjs/common';
import {
  formatUnitCode,
  MUNICIPAL_TIME_ZONE,
  municipalToday,
} from '@mechanization/shared-schemas';
import {
  DEFAULT_EXCHANGE_TOLERANCE_PERCENT,
  DEFAULT_LARGE_EXCHANGE_THRESHOLD,
  exchangeRateOf,
  judgeExchange,
} from '@mechanization/shared-schemas';
import type {
  CollectorCollectionsResult,
  CollectorCustodyView,
  CollectorRoundView,
  CreateTransferInput,
  CreateTransferResult,
  ListTransfersQuery,
  ReceiveCustodyInput,
  ReceiveCustodyResult,
  TransferListResult,
  TransferView,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { allocateDocumentNumber } from '../../common/document-number';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { AuditService } from '../audit/audit.service';
import { ExpensesService } from './expenses.service';
import { expenseOccurredAt } from './expenses.plan';
import { incomePeriod } from './income.plan';
import { TreasuryLedgerService } from './treasury-ledger.service';
import { planTransferDate, transferKindOf } from './transfers.plan';
import { roundMoney } from './treasury.plan';

/** The row a screen reads a transfer as. */
const TRANSFER_SELECT = {
  id: true,
  transferNumber: true,
  amount: true,
  receivedAmount: true,
  feeAmount: true,
  exchangeRate: true,
  officialExchangeRate: true,
  adjustmentReason: true,
  moneyChangerName: true,
  backdateReason: true,
  requiresReview: true,
  reviewedAt: true,
  reviewNote: true,
  description: true,
  occurredAt: true,
  voidedAt: true,
  voidReason: true,
  from: { select: { id: true, name: true, currency: true, type: true } },
  to: { select: { id: true, name: true, currency: true, type: true } },
  feeVoucher: { select: { id: true, voucherNumber: true } },
  recordedBy: { select: { firstName: true, lastName: true } },
  reviewedBy: { select: { firstName: true, lastName: true } },
  voidedBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.TreasuryTransferSelect;

type TransferRow = Prisma.TreasuryTransferGetPayload<{ select: typeof TRANSFER_SELECT }>;

/**
 * المناقلات — money between the municipality's own wallets.
 *
 * ## «تسليم صندوق الجابي», and why it is a transfer and not a payment
 *
 * A citizen who pays at his door has his invoice settled there and then, and the
 * cash is credited to that collector's custody wallet — his pocket, which is the
 * whole reason custody exists (0073). The money has not reached the
 * municipality yet. This is the step where it does: the accountant counts what
 * the collector hands over and records it, and the same figure leaves custody
 * and arrives in the safe, in one transaction.
 *
 * Nothing here touches an invoice. The citizen's debt was settled at the door;
 * if this step never happened, the register would still be right and the
 * collector would simply still owe the municipality the cash. That is exactly
 * what his custody balance says, and it is why a handover cannot be folded into
 * the payment itself.
 *
 * ## Partial is normal
 *
 * A collector may hand in part of what he holds — he was passing the office, or
 * the rest is in another currency. The remainder stays on his name until he
 * brings it, so «كم بعهدة علي؟» always has an answer. What is refused is more
 * than he holds, which would make the municipality's books claim cash nobody
 * has.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly ledger: TreasuryLedgerService,
    private readonly audit: AuditService,
    private readonly expenses: ExpensesService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  /**
   * What every collector is still carrying, per currency.
   *
   * Empty wallets are kept in the list rather than dropped: «علي سلّم كل شيء»
   * is an answer the accountant needs at the end of a round, and a collector who
   * vanishes from the screen the moment he settles looks like one who was never
   * out.
   */
  async custody(): Promise<CollectorCustodyView[]> {
    const accounts = await this.db.treasuryAccount.findMany({
      where: { type: 'COLLECTOR_CUSTODY' },
      select: {
        id: true,
        currency: true,
        ownerId: true,
        owner: { select: { firstName: true, lastName: true } },
      },
    });
    if (accounts.length === 0) return [];

    const sums = await this.db.treasuryEntry.groupBy({
      by: ['accountId'],
      where: { accountId: { in: accounts.map((account) => account.id) } },
      _sum: { amount: true },
      _count: { _all: true },
      _max: { occurredAt: true },
    });
    const byAccount = new Map(sums.map((row) => [row.accountId, row]));
    const today = await this.collectedToday();

    return accounts
      .map((account) => {
        const totals = byAccount.get(account.id);
        const day = account.ownerId ? today.get(`${account.ownerId}|${account.currency}`) : undefined;
        const held = totals?._sum.amount?.toNumber() ?? 0;
        return {
          accountId: account.id,
          collectorId: account.ownerId,
          collectorName: account.owner ? `${account.owner.firstName} ${account.owner.lastName}` : null,
          currency: account.currency,
          held: totals?._sum.amount?.toNumber() ?? 0,
          movements: totals?._count._all ?? 0,
          lastCollectedAt: totals?._max.occurredAt?.toISOString() ?? null,
          receiptsToday: day?.receipts ?? 0,
          collectedToday: day?.amount ?? 0,
          /*
            An inference, and labelled as one on the screen. «لم يخرج اليوم»
            with an empty pocket and «سلّم كل شيء» are different answers to
            «أين علي؟», and collapsing them would tell the accountant a man
            settled up when he simply never went out.
          */
          status:
            (day?.receipts ?? 0) > 0
              ? ('COLLECTING_TODAY' as const)
              : held === 0
                ? ('SETTLED' as const)
                : ('NOT_OUT_TODAY' as const),
        };
      })
      .sort((a, b) => b.held - a.held || (a.collectorName ?? '').localeCompare(b.collectorName ?? ''));
  }

  /**
   * «من حصّل الجابي» — the receipts behind one collector's custody balance.
   *
   * The screen the accountant reads while the notes are on the desk: these are
   * the people, and this is what each of them paid. It answers a question the
   * custody figure cannot, because custody is one number and a round is thirty
   * doors.
   *
   * It is a list of *receipts*, not of handovers, and the two do not line up:
   * a handover moves an amount, not a set of receipts, so once he has handed
   * anything in the collected total and the custody balance differ by exactly
   * what he brought. Marking individual receipts "handed over" would be an
   * invention — nothing in the data says which notes were in the envelope.
   *
   * A reversed payment stays on the list beside its opposing row. The citizen
   * was at the door and the clerk did write a receipt; hiding the pair would
   * make the collector's totals stop adding up for whoever is counting.
   */
  async collections(collectorId: string, limit = 200): Promise<CollectorCollectionsResult> {
    const collector = await this.db.user.findFirst({
      where: { id: collectorId, kind: 'STAFF' },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!collector) {
      throw new NotFoundError({
        code: 'COLLECTOR_NOT_FOUND',
        message: `Staff member ${collectorId} was not found`,
      });
    }

    const [rows, total, totals, custody] = await Promise.all([
      this.db.paymentTransaction.findMany({
        where: { collectedById: collectorId },
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        take: Math.min(Math.max(limit, 1), 500),
        select: {
          id: true,
          receiptNumber: true,
          occurredAt: true,
          amount: true,
          currency: true,
          note: true,
          reversalOfId: true,
          reversedBy: { select: { id: true } },
          payment: {
            select: {
              title: true,
              citizenId: true,
              citizen: {
                select: {
                  firstName: true,
                  middleName: true,
                  lastName: true,
                  phone: true,
                  contactPhone: true,
                  hasNoPhone: true,
                  /*
                    Where he is now, for the sector. The newest occupancy that
                    has not ended: a file carries its history, and last year's
                    address is not an answer to «من أي حي؟».
                  */
                  unitOccupancies: {
                    where: { toDate: null },
                    orderBy: { fromDate: 'desc' },
                    take: 1,
                    select: { unit: { select: { building: { select: { parcelNumber: true } } } } },
                  },
                },
              },
            },
          },
        },
      }),
      this.db.paymentTransaction.count({ where: { collectedById: collectorId } }),
      /*
        Over every receipt, not just the page. `amount` is signed and a reversal
        is a negative row, so the sum nets the cancellations out on its own.
      */
      this.db.paymentTransaction.groupBy({
        by: ['currency'],
        where: { collectedById: collectorId },
        _sum: { amount: true },
      }),
      this.custody(),
    ]);

    /*
      Parcel → sector, read once for the page.

      A sector owns a *list* of parcel numbers (`Zone.parcelNumbers`, D13) rather
      than buildings pointing at it, so "which sector is this parcel in" cannot
      be joined and a two-hundred-row list would otherwise be two hundred
      queries. A municipality has a handful of sectors, so reading them whole is
      cheaper than any alternative — the same trade `BuildingsService` makes.
    */
    const parcels = new Set(
      rows
        .map((row) => row.payment.citizen.unitOccupancies[0]?.unit.building.parcelNumber)
        .filter((parcel): parcel is string => Boolean(parcel)),
    );
    const zoneOfParcel = new Map<string, string>();
    if (parcels.size > 0) {
      const zones = await this.db.zone.findMany({ select: { name: true, parcelNumbers: true } });
      for (const zone of zones) {
        for (const parcel of zone.parcelNumbers) {
          // First sector wins, as everywhere else: a parcel in two is a data
          // error the sector editor already refuses, and answering it the same
          // way on every screen beats answering it differently on each.
          if (parcels.has(parcel) && !zoneOfParcel.has(parcel)) zoneOfParcel.set(parcel, zone.name);
        }
      }
    }

    return {
      collector: { id: collector.id, name: `${collector.firstName} ${collector.lastName}` },
      custody: custody
        .filter((wallet) => wallet.collectorId === collectorId)
        .map((wallet) => ({ currency: wallet.currency, held: wallet.held })),
      rows: rows.map((row) => ({
        id: row.id,
        receiptNumber: row.receiptNumber,
        occurredAt: row.occurredAt.toISOString(),
        citizenId: row.payment.citizenId,
        citizenName: [
          row.payment.citizen.firstName,
          row.payment.citizen.middleName,
          row.payment.citizen.lastName,
        ]
          .filter(Boolean)
          .join(' '),
        citizenPhone: row.payment.citizen.phone,
        citizenContactPhone: row.payment.citizen.contactPhone,
        citizenHasNoPhone: row.payment.citizen.hasNoPhone,
        zoneName:
          zoneOfParcel.get(
            row.payment.citizen.unitOccupancies[0]?.unit.building.parcelNumber ?? '',
          ) ?? null,
        paymentTitle: row.payment.title,
        amount: row.amount.toNumber(),
        currency: row.currency,
        isReversal: row.reversalOfId !== null,
        reversed: row.reversedBy !== null,
        note: row.note,
      })),
      total,
      totals: totals.map((row) => ({ currency: row.currency, amount: row._sum.amount?.toNumber() ?? 0 })),
    };
  }

  /**
   * «سجل المناقلات» — newest first, filtered, with the auditor's count.
   *
   * The kind is derived from the two ends (`transferKindOf`), so it is filtered
   * the same way: a handover leaves a custody wallet, an exchange changes
   * currency. The period is the municipality's calendar.
   */
  async list(query: Partial<ListTransfersQuery> = {}): Promise<TransferListResult> {
    const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 200);
    const page = Math.max(query.page ?? 1, 1);

    const sameCurrency = Prisma.sql`"fromCurrency" = "toCurrency"`;
    const kindFilter =
      query.kind === 'HANDOVER'
        ? { from: { type: 'COLLECTOR_CUSTODY' as const } }
        : query.kind === 'SAME_CURRENCY' || query.kind === 'EXCHANGE'
          ? { from: { type: { not: 'COLLECTOR_CUSTODY' as const } } }
          : {};
    /*
      «same currency» compares two columns of one row, which Prisma's filters
      cannot say, so the ids come from one schema-qualified query.
    */
    const currencyIds =
      query.kind === 'SAME_CURRENCY' || query.kind === 'EXCHANGE'
        ? (
            await this.db.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM ${this.S}treasury_transfers
               WHERE ${query.kind === 'SAME_CURRENCY' ? sameCurrency : Prisma.sql`NOT (${sameCurrency})`}
            `
          ).map((row) => row.id)
        : null;

    const where: Prisma.TreasuryTransferWhereInput = {
      ...kindFilter,
      ...(currencyIds ? { id: { in: currencyIds } } : {}),
      ...(query.review === 'PENDING' ? { requiresReview: true, reviewedAt: null } : {}),
      ...(query.review === 'REVIEWED' ? { requiresReview: true, reviewedAt: { not: null } } : {}),
      ...(query.includeVoid ? {} : { voidedAt: null }),
      // Beirut midnights, the same bounds as the income register's.
      ...(query.from || query.to ? { occurredAt: incomePeriod(query.from, query.to) } : {}),
    };

    const [rows, total, pendingReview] = await Promise.all([
      this.db.treasuryTransfer.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: TRANSFER_SELECT,
      }),
      this.db.treasuryTransfer.count({ where }),
      this.db.treasuryTransfer.count({ where: { requiresReview: true, reviewedAt: null, voidedAt: null } }),
    ]);

    return { transfers: rows.map((row) => this.view(row)), total, pendingReview };
  }

  async get(id: string): Promise<TransferView> {
    const row = await this.db.treasuryTransfer.findUnique({ where: { id }, select: TRANSFER_SELECT });
    if (!row) {
      throw new NotFoundError({ code: 'TRANSFER_NOT_FOUND', message: `Transfer ${id} was not found` });
    }
    return this.view(row);
  }

  /**
   * «تحويل داخلي» and «مصارفة» — money between two working wallets, with its
   * fee, in one transaction (docs/finance.md §6).
   *
   * ## What is written
   *
   * The transfer document; its two ledger legs, out of the source and into the
   * destination; when there is a fee, a «PV-» voucher under «رسوم تحويل
   * ومصرفية» whose own entry takes the fee from the source too; and the Tier 1
   * audit row. All or nothing.
   *
   * ## Locks
   *
   * Both wallets are locked in ascending id order before anything posts. The
   * fee and the move are two posts, and each locking its own wallets in order
   * is not enough: two transfers over one pair of wallets, opposite ways round,
   * would meet in the opposite order between them. Locked first, the balance
   * check is then honest for amount + fee together.
   *
   * ## An exchange
   *
   * The rate is derived from the two amounts (`exchangeRateOf`), stored with
   * the official rate beside it, and judged by `judgeExchange` — the function
   * the form warned with. Beyond the tolerance a written reason is required;
   * beyond it, above the threshold, or with no official rate to compare, the
   * transfer is flagged for an auditor. The money moves either way (§6.3).
   */
  async create(input: CreateTransferInput, actor: { id: string; role: string }): Promise<CreateTransferResult> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;

      /*
        Serialised before it is read, as the vouchers' keys are: two identical
        requests arriving together would both read nothing, and the second
        insert would die on the unique index as an unmapped 500. The key names
        the schema, so two municipalities never wait on each other.
      */
      const lockKey = `${this.tenantContext.schemaName}:transfer-request:${input.clientRequestId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const earlier = await tx.treasuryTransfer.findUnique({
        where: { clientRequestId: input.clientRequestId },
        select: {
          id: true,
          transferNumber: true,
          fromAccountId: true,
          toAccountId: true,
          requiresReview: true,
          feeVoucher: { select: { voucherNumber: true } },
        },
      });
      if (earlier) {
        return {
          id: earlier.id,
          transferNumber: earlier.transferNumber,
          feeVoucherNumber: earlier.feeVoucher?.voucherNumber ?? null,
          requiresReview: earlier.requiresReview,
          fromBalanceAfter: (await this.ledger.balanceOf(tx, earlier.fromAccountId)).toNumber(),
          toBalanceAfter: (await this.ledger.balanceOf(tx, earlier.toAccountId)).toNumber(),
          replayed: true,
        };
      }

      const config = await this.ledger.config(tx);
      if (!config.goLiveAt) {
        throw new ConflictError({
          code: 'TREASURY_NOT_ACTIVE',
          message: 'The treasury is not active, so no money can move yet.',
        });
      }

      const today = municipalToday();
      const verdict = planTransferDate({
        transferredOn: input.transferredOn,
        reason: input.backdateReason,
        goLiveOn: municipalToday(config.goLiveAt),
        today,
      });
      if (!verdict.ok) {
        if (verdict.code === 'TRANSFER_DATE_BEFORE_GO_LIVE') {
          throw new ValidationError({
            code: verdict.code,
            message: `A transfer cannot be dated before the treasury went live (${verdict.goLiveOn}).`,
            params: { date: verdict.goLiveOn },
          });
        }
        throw new ValidationError({
          code: verdict.code,
          message:
            verdict.code === 'TRANSFER_DATE_IN_FUTURE'
              ? 'A transfer cannot be dated after today.'
              : 'A back-dated transfer must say why.',
          details: { transferredOn: input.transferredOn ?? today },
        });
      }

      if (input.fromAccountId === input.toAccountId) {
        throw new ValidationError({
          code: 'TRANSFER_SAME_ACCOUNT_FORBIDDEN',
          message: 'Money cannot move to the wallet it is in.',
        });
      }

      const ends = await tx.treasuryAccount.findMany({
        where: { id: { in: [input.fromAccountId, input.toAccountId] } },
        select: { id: true, name: true, type: true, currency: true, active: true },
      });
      const from = ends.find((account) => account.id === input.fromAccountId);
      const to = ends.find((account) => account.id === input.toAccountId);
      if (!from || !to) {
        throw new NotFoundError({
          code: 'TREASURY_ACCOUNT_NOT_FOUND',
          message: 'A wallet named by this transfer does not exist.',
        });
      }
      /*
        A collector's custody has its own act, the handover, which knows whose
        pocket it is and refuses more than he holds; money is never sent into
        one. A stopped wallet does not move at all.
      */
      for (const end of [from, to]) {
        if (end.type === 'COLLECTOR_CUSTODY' || !end.active) {
          throw new ValidationError({
            code: 'TRANSFER_ACCOUNT_NOT_ALLOWED',
            message: `Wallet ${end.id} cannot be an end of this transfer.`,
            params: { account: end.name },
          });
        }
      }

      const amount = new Prisma.Decimal(input.amount);
      const fee = input.feeAmount ? new Prisma.Decimal(input.feeAmount) : null;
      let receivedAmount = amount;
      let exchange: {
        rate: number;
        officialRate: number | null;
        reason: string | null;
        changer: string | null;
        requiresReview: boolean;
      } | null = null;

      if (input.kind === 'SAME_CURRENCY') {
        if (from.currency !== to.currency) {
          throw new ValidationError({
            code: 'TRANSFER_CURRENCY_MISMATCH',
            message: `An internal transfer needs one currency, not ${from.currency} and ${to.currency}.`,
            params: { from: from.currency, to: to.currency },
          });
        }
      } else {
        if (from.currency === to.currency) {
          throw new ValidationError({
            code: 'EXCHANGE_SAME_CURRENCY_FORBIDDEN',
            message: `Both wallets hold ${from.currency}; an exchange needs two currencies.`,
            params: { currency: from.currency },
          });
        }
        const settings = await tx.systemSettings.findFirst({
          select: { baseCurrency: true, exchangeRateTolerancePercent: true, largeExchangeThreshold: true },
        });
        const baseCurrency = settings?.baseCurrency ?? 'LBP';
        const legs = exchangeRateOf({
          fromCurrency: from.currency,
          toCurrency: to.currency,
          amount: input.amount,
          receivedAmount: input.receivedAmount,
          baseCurrency,
        });
        if (!legs) {
          throw new ValidationError({
            code: 'EXCHANGE_PAIR_UNSUPPORTED',
            message: `No rate between ${from.currency} and ${to.currency} against base ${baseCurrency}.`,
            params: { from: from.currency, to: to.currency, base: baseCurrency },
          });
        }
        const officialRate = config.exchangeRate?.toNumber() ?? null;
        const tolerance = settings?.exchangeRateTolerancePercent.toNumber() ?? DEFAULT_EXCHANGE_TOLERANCE_PERCENT;
        const judgement = judgeExchange({
          rate: legs.rate,
          foreignAmount: legs.foreignAmount,
          officialRate,
          tolerancePercent: tolerance,
          largeThreshold: settings?.largeExchangeThreshold.toNumber() ?? DEFAULT_LARGE_EXCHANGE_THRESHOLD,
        });
        const reason = input.adjustmentReason?.trim() || null;
        if (judgement.beyondTolerance && !reason) {
          throw new ValidationError({
            code: 'EXCHANGE_RATE_TOLERANCE_EXCEEDED',
            message: `The rate is ${judgement.deviationPercent}% from the official one; ${tolerance}% is allowed without a reason.`,
            params: { deviation: judgement.deviationPercent ?? 0, tolerance },
            details: { rate: legs.rate, officialRate },
          });
        }
        receivedAmount = new Prisma.Decimal(input.receivedAmount);
        exchange = {
          rate: legs.rate,
          officialRate,
          reason,
          changer: input.moneyChangerName?.trim() || null,
          requiresReview: judgement.requiresReview,
        };
      }

      await this.ledger.lockAccounts(tx, [from.id, to.id]);

      /*
        Checked for amount + fee together, under the lock, so the refusal names
        what the source actually needs. The two posts below would each refuse
        on their own, but the second would report the balance the first had
        already reduced.
      */
      const needed = fee ? amount.plus(fee) : amount;
      const held = await this.ledger.balanceOf(tx, from.id);
      if (held.lessThan(needed)) {
        throw new ConflictError({
          code: 'TREASURY_INSUFFICIENT_FUNDS',
          message: `Account ${from.id} holds ${held.toString()}, less than the ${needed.toString()} this transfer needs.`,
          params: { account: from.name, available: held.toNumber(), required: needed.toNumber() },
        });
      }

      const occurredAt = expenseOccurredAt(verdict.transferredOn, today);
      // «TR-2610-0001». See `allocateDocumentNumbers` and migration 0079.
      const transferNumber = await allocateDocumentNumber(tx, this.S, 'TRANSFER');
      const description = input.description.trim();
      const backdateReason = verdict.backdatedDays > 0 ? (input.backdateReason?.trim() ?? null) : null;

      // The fee first: its voucher number goes on the transfer, which points at it.
      const feeVoucher = fee
        ? await this.expenses.recordTransferFee(
            {
              accountId: from.id,
              amount: fee.toNumber(),
              // Who was paid: the صرّاف, else the provider the wallet is with.
              payee: exchange?.changer ?? from.name,
              description: `رسوم المناقلة ${transferNumber}`,
              paidOn: verdict.transferredOn,
              adjustmentReason: backdateReason ?? undefined,
            },
            actor,
          )
        : null;

      const transfer = await tx.treasuryTransfer.create({
        data: {
          transferNumber,
          fromAccountId: from.id,
          fromCurrency: from.currency,
          toAccountId: to.id,
          toCurrency: to.currency,
          amount,
          receivedAmount,
          feeAmount: fee,
          feeVoucherId: feeVoucher?.id ?? null,
          exchangeRate: exchange ? new Prisma.Decimal(exchange.rate) : null,
          officialExchangeRate:
            exchange?.officialRate !== null && exchange?.officialRate !== undefined
              ? new Prisma.Decimal(exchange.officialRate)
              : null,
          adjustmentReason: exchange?.reason ?? null,
          moneyChangerName: exchange?.changer ?? null,
          backdateReason,
          requiresReview: exchange?.requiresReview ?? false,
          description,
          occurredAt,
          recordedById: actor.id,
          clientRequestId: input.clientRequestId,
        },
        select: { id: true },
      });

      await this.ledger.post(
        tx,
        [
          { accountId: from.id, currency: from.currency, amount: amount.negated() },
          { accountId: to.id, currency: to.currency, amount: receivedAmount },
        ],
        {
          source: 'TRANSFER',
          sourceId: transfer.id,
          actorId: actor.id,
          occurredAt,
          exchangeRate: config.exchangeRate,
          note: description,
        },
      );

      /*
        Tier 1: ids, figures and rates. The changer's name and the free-text
        reasons stay on the document; an audit row is not a second copy of
        whatever was typed.
      */
      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: exchange ? 'EXCHANGE_RECORDED' : 'TRANSFER_RECORDED',
        entityType: 'TreasuryTransfer',
        entityId: transfer.id,
        after: {
          transferNumber,
          amount: input.amount,
          fromAccountId: from.id,
          fromCurrency: from.currency,
          receivedAmount: receivedAmount.toNumber(),
          toAccountId: to.id,
          toCurrency: to.currency,
          occurredAt: occurredAt.toISOString(),
          ...(fee ? { feeAmount: fee.toNumber(), feeVoucherNumber: feeVoucher!.voucherNumber } : {}),
          ...(exchange
            ? { exchangeRate: exchange.rate, officialRate: exchange.officialRate, requiresReview: exchange.requiresReview }
            : {}),
        },
      });

      return {
        id: transfer.id,
        transferNumber,
        feeVoucherNumber: feeVoucher?.voucherNumber ?? null,
        requiresReview: exchange?.requiresReview ?? false,
        fromBalanceAfter: (await this.ledger.balanceOf(tx, from.id)).toNumber(),
        toBalanceAfter: (await this.ledger.balanceOf(tx, to.id)).toNumber(),
        replayed: false,
      };
    });
  }

  /**
   * «اعتماد المراجعة» — an auditor or the manager clears a flagged exchange.
   *
   * Locked before it is read, so two reviewers meet one after the other and the
   * second is told it is done. Nothing about the money changes: the exchange was
   * booked when it happened, and this records that somebody whose job is
   * checking has looked at it. Tier 1 audited, with the note.
   */
  async review(id: string, note: string | undefined, actor: { id: string; role: string }): Promise<TransferView> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const locked = await tx.$queryRaw<
        Array<{ id: string; transferNumber: string; requiresReview: boolean; reviewedAt: Date | null }>
      >`
        SELECT "id", "transferNumber", "requiresReview", "reviewedAt"
          FROM ${this.S}treasury_transfers
         WHERE "id" = ${id}::uuid
         FOR UPDATE
      `;
      const transfer = locked[0];
      if (!transfer) {
        throw new NotFoundError({ code: 'TRANSFER_NOT_FOUND', message: `Transfer ${id} was not found` });
      }
      if (!transfer.requiresReview) {
        throw new ConflictError({ code: 'TRANSFER_NOT_FLAGGED', message: 'This transfer is not flagged for review.' });
      }
      if (transfer.reviewedAt) {
        throw new ConflictError({
          code: 'TRANSFER_ALREADY_REVIEWED',
          message: 'This transfer has already been reviewed.',
        });
      }

      const reviewNote = note?.trim() || null;
      await tx.treasuryTransfer.update({
        where: { id },
        data: { reviewedAt: new Date(), reviewedById: actor.id, reviewNote },
      });

      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'TRANSFER_REVIEWED',
        entityType: 'TreasuryTransfer',
        entityId: id,
        after: { transferNumber: transfer.transferNumber, ...(reviewNote ? { note: reviewNote } : {}) },
      });

      return this.view(await tx.treasuryTransfer.findUniqueOrThrow({ where: { id }, select: TRANSFER_SELECT }));
    });
  }

  /**
   * «استلام صندوق الجابي» — the money leaves custody and reaches the safe.
   *
   * One transaction: the two ledger entries, the transfer document and the
   * Tier 1 audit row. `TreasuryLedgerService.post` locks both wallets in id
   * order and refuses to take custody below zero, which is the whole guard
   * against receiving more than the collector actually holds.
   */
  async receiveCustody(
    input: ReceiveCustodyInput,
    actor: { id: string; role: string },
  ): Promise<ReceiveCustodyResult> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;

      /*
        Answered before anything is written, so a double-pressed «استلم» returns
        the first handover instead of emptying the collector twice. The unique
        index on `clientRequestId` is what makes it safe under a real race.
      */
      if (input.clientRequestId) {
        const earlier = await tx.treasuryTransfer.findUnique({
          where: { clientRequestId: input.clientRequestId },
          select: { id: true, transferNumber: true, fromAccountId: true, toAccountId: true, toCurrency: true },
        });
        if (earlier) {
          return {
            id: earlier.id,
            transferNumber: earlier.transferNumber,
            remainingInCustody: (await this.ledger.balanceOf(tx, earlier.fromAccountId)).toNumber(),
            safeBalanceAfter: (await this.ledger.balanceOf(tx, earlier.toAccountId)).toNumber(),
            currency: earlier.toCurrency,
            replayed: true,
          };
        }
      }

      const custody = await tx.treasuryAccount.findFirst({
        where: { id: input.custodyAccountId, type: 'COLLECTOR_CUSTODY' },
        select: {
          id: true,
          name: true,
          currency: true,
          ownerId: true,
          owner: { select: { firstName: true, lastName: true } },
        },
      });
      if (!custody) {
        throw new NotFoundError({
          code: 'CUSTODY_ACCOUNT_NOT_FOUND',
          message: `Collector custody account ${input.custodyAccountId} was not found`,
        });
      }

      /*
        Refused here as well as by the ledger's own never-negative check, so the
        accountant is told what the collector actually holds rather than a bare
        "insufficient funds" about a wallet they did not name.
      */
      const held = await this.ledger.balanceOf(tx, custody.id);
      const amount = new Prisma.Decimal(input.amount);
      if (amount.greaterThan(held)) {
        throw new ConflictError({
          code: 'CUSTODY_EXCEEDS_HELD',
          message: `The collector holds ${held.toString()}, less than the ${amount.toString()} received.`,
          params: { held: held.toNumber(), amount: input.amount },
        });
      }

      // Cash goes to the safe of the same currency — never to Whish or a bank.
      const safe = await tx.treasuryAccount.findFirst({
        where: { type: 'CASH_SAFE', currency: custody.currency, isPrimary: true, active: true },
        select: { id: true, name: true, currency: true },
      });
      if (!safe) {
        throw new ConflictError({
          code: 'TREASURY_ACCOUNT_MISSING',
          message: `No active primary cash safe in ${custody.currency}.`,
          params: { currency: custody.currency },
        });
      }

      const occurredAt = new Date();
      // «TR-2610-0001». See `allocateDocumentNumbers` and migration 0079.
      const transferNumber = await allocateDocumentNumber(tx, this.S, 'TRANSFER');

      const collectorName = custody.owner
        ? `${custody.owner.firstName} ${custody.owner.lastName}`
        : custody.name;
      const description = input.note?.trim() || `تسليم صندوق الجابي ${collectorName}`;

      const transfer = await tx.treasuryTransfer.create({
        data: {
          transferNumber,
          fromAccountId: custody.id,
          fromCurrency: custody.currency,
          toAccountId: safe.id,
          toCurrency: safe.currency,
          amount,
          receivedAmount: amount,
          description,
          occurredAt,
          recordedById: actor.id,
          clientRequestId: input.clientRequestId ?? null,
        },
        select: { id: true },
      });

      // Both legs together: out of the pocket, into the safe.
      await this.ledger.post(
        tx,
        [
          { accountId: custody.id, currency: custody.currency, amount: amount.negated() },
          { accountId: safe.id, currency: safe.currency, amount },
        ],
        {
          source: 'TRANSFER',
          sourceId: transfer.id,
          actorId: actor.id,
          occurredAt,
          note: description,
        },
      );

      /*
        Tier 1. The collector is named by id, not by name: an audit row is not a
        second copy of who works here, and the transfer number leads to the rest.
      */
      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'CUSTODY_RECEIVED',
        entityType: 'TreasuryTransfer',
        entityId: transfer.id,
        after: {
          transferNumber,
          amount: input.amount,
          currency: custody.currency,
          collectorId: custody.ownerId,
          custodyAccountId: custody.id,
          safeAccountId: safe.id,
        },
      });

      return {
        id: transfer.id,
        transferNumber,
        remainingInCustody: (await this.ledger.balanceOf(tx, custody.id)).toNumber(),
        safeBalanceAfter: (await this.ledger.balanceOf(tx, safe.id)).toNumber(),
        currency: custody.currency,
        replayed: false,
      };
    });
  }

  /**
   * Cancels a transfer and puts both legs back — and its fee, when it had one.
   *
   * The money returns to the wallet it left, which for a handover means back
   * onto the collector's name — the honest answer when the count turns out to
   * have been wrong, since the cash is his responsibility again. Refused if the
   * destination no longer holds what arrived. A fee's voucher is cancelled in
   * the same act, so the source gets amount + fee back, as it gave them.
   */
  async void(id: string, reason: string, actor: { id: string; role: string }): Promise<TransferView> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;

      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          transferNumber: string;
          voidedAt: Date | null;
          fromAccountId: string;
          toAccountId: string;
          feeVoucherId: string | null;
        }>
      >`
        SELECT "id", "transferNumber", "voidedAt", "fromAccountId", "toAccountId", "feeVoucherId"
          FROM ${this.S}treasury_transfers
         WHERE "id" = ${id}::uuid
         FOR UPDATE
      `;
      const transfer = locked[0];
      if (!transfer) {
        throw new NotFoundError({ code: 'TRANSFER_NOT_FOUND', message: `Transfer ${id} was not found` });
      }
      if (transfer.voidedAt) {
        throw new ConflictError({
          code: 'TRANSFER_ALREADY_VOID',
          message: 'This transfer has already been cancelled.',
        });
      }

      // Two reversals when there is a fee: both wallets first, in id order, as `create` does.
      await this.ledger.lockAccounts(tx, [transfer.fromAccountId, transfer.toAccountId]);

      const voidedAt = new Date();
      await this.ledger.reverseEntriesOf(tx, {
        source: 'TRANSFER',
        sourceId: id,
        actorId: actor.id,
        occurredAt: voidedAt,
        note: `إلغاء سند المناقلة ${transfer.transferNumber}`,
      });
      if (transfer.feeVoucherId) {
        await this.expenses.voidTransferFee(transfer.feeVoucherId, reason, actor);
      }

      await tx.treasuryTransfer.update({
        where: { id },
        data: { voidedAt, voidedById: actor.id, voidReason: reason.trim() },
      });

      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'TRANSFER_VOIDED',
        entityType: 'TreasuryTransfer',
        entityId: id,
        after: { transferNumber: transfer.transferNumber, reason: reason.trim() },
      });

      return this.view(await tx.treasuryTransfer.findUniqueOrThrow({ where: { id }, select: TRANSFER_SELECT }));
    });
  }

  /**
   * What each collector took today, on the municipality's clock.
   *
   * Raw SQL because the day boundary is Beirut's and the column is a bare
   * timestamp holding UTC: the first `AT TIME ZONE` labels the stored value as
   * UTC, the second moves the instant onto the municipality's wall clock. One
   * alone would shift every boundary by the offset — the same two-step the
   * audit day-buckets use.
   *
   * The count excludes reversal entries so it stays a count of *receipts
   * written*; the sum includes them, so a cancelled payment nets itself out of
   * the money figure. A receipt written today and cancelled today is still a
   * door he knocked on.
   */
  private async collectedToday(): Promise<Map<string, { receipts: number; amount: number }>> {
    const today = municipalToday();
    const rows = await this.db.$queryRaw<
      Array<{ collectedById: string; currency: string; receipts: bigint; amount: Prisma.Decimal | null }>
    >`
      SELECT "collectedById", "currency",
             count(*) FILTER (WHERE "reversalOfId" IS NULL)::bigint AS receipts,
             sum("amount") AS amount
        FROM ${this.S}payment_transactions
       WHERE "collectedById" IS NOT NULL
         AND ("occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE ${MUNICIPAL_TIME_ZONE}::text)::date
             = ${today}::date
       GROUP BY "collectedById", "currency"
    `;

    return new Map(
      rows.map((row) => [
        `${row.collectedById}|${row.currency}`,
        { receipts: Number(row.receipts), amount: row.amount?.toNumber() ?? 0 },
      ]),
    );
  }

  /**
   * «جولتي» — one collector's own round, for his own phone.
   *
   * Always called with the id off the session's token and never with one from
   * the client, which is why there is no actor check inside it: there is no id
   * to tamper with (the same shape as `inspector/me/profile`).
   *
   * ## Which receipts are listed, and why the total can still disagree
   *
   * The list is every receipt since his last handover that still stands —
   * "this round", the natural unit for a man emptying his pockets on a desk.
   * It leaves out cancelled payments and their opposing rows, because this list
   * is the money he is carrying and a cancelled payment is not in it.
   *
   * After a **partial** handover the listed receipts will not add up to what he
   * holds, and that is not a bug to paper over: a handover moves an amount, not
   * a set of receipts, so nothing in the data says which of them he brought in.
   * The difference is reported as `carriedOver` and named on the screen rather
   * than hidden, because a collector whose list and pocket disagree silently
   * will assume one of the two is lying.
   */
  async myRound(collectorId: string): Promise<CollectorRoundView> {
    const person = await this.db.user.findFirst({
      where: { id: collectorId, kind: 'STAFF' },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!person) {
      throw new NotFoundError({
        code: 'COLLECTOR_NOT_FOUND',
        message: `Staff member ${collectorId} was not found`,
      });
    }
    const collector = { id: person.id, name: `${person.firstName} ${person.lastName}` };

    const wallets = await this.db.treasuryAccount.findMany({
      where: { type: 'COLLECTOR_CUSTODY', ownerId: collectorId },
      select: { id: true, currency: true },
    });
    // Nobody has ever handed him money at a door. An empty round, not an error.
    if (wallets.length === 0) return { collector, lastHandoverAt: null, currencies: [], rows: [] };

    const walletIds = wallets.map((wallet) => wallet.id);
    const [sums, lastHandover] = await Promise.all([
      this.db.treasuryEntry.groupBy({
        by: ['accountId'],
        where: { accountId: { in: walletIds } },
        _sum: { amount: true },
      }),
      this.db.treasuryTransfer.findFirst({
        where: { fromAccountId: { in: walletIds }, voidedAt: null },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      }),
    ]);
    const heldOf = new Map(sums.map((row) => [row.accountId, row._sum.amount?.toNumber() ?? 0]));
    const since = lastHandover?.occurredAt ?? null;

    const rows = await this.db.paymentTransaction.findMany({
      where: {
        collectedById: collectorId,
        // Not a reversal entry, and not a receipt that has since been cancelled.
        reversalOfId: null,
        reversedBy: { is: null },
        ...(since ? { occurredAt: { gt: since } } : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      take: 500,
      select: {
        id: true,
        receiptNumber: true,
        occurredAt: true,
        amount: true,
        currency: true,
        paymentId: true,
        payment: {
          select: {
            title: true,
            citizenId: true,
            citizen: {
              select: {
                firstName: true,
                middleName: true,
                lastName: true,
                unitOccupancies: {
                  where: { toDate: null },
                  orderBy: { fromDate: 'desc' },
                  take: 1,
                  select: {
                    unit: {
                      select: { floor: true, sequence: true, building: { select: { code: true } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const listedOf = new Map<string, number>();
    for (const row of rows) {
      listedOf.set(row.currency, (listedOf.get(row.currency) ?? 0) + row.amount.toNumber());
    }

    return {
      collector,
      lastHandoverAt: since?.toISOString() ?? null,
      currencies: wallets.map((wallet) => {
        const held = heldOf.get(wallet.id) ?? 0;
        const listed = roundMoney(listedOf.get(wallet.currency) ?? 0, wallet.currency);
        return {
          currency: wallet.currency,
          held,
          listed,
          carriedOver: roundMoney(held - listed, wallet.currency),
        };
      }),
      rows: rows.map((row) => {
        const unit = row.payment.citizen.unitOccupancies[0]?.unit;
        return {
          id: row.id,
          receiptNumber: row.receiptNumber,
          occurredAt: row.occurredAt.toISOString(),
          paymentId: row.paymentId,
          citizenId: row.payment.citizenId,
          citizenName: [
            row.payment.citizen.firstName,
            row.payment.citizen.middleName,
            row.payment.citizen.lastName,
          ]
            .filter(Boolean)
            .join(' '),
          // The same formatter the receipt prints, not the stored copy.
          unitCode: unit ? formatUnitCode(unit.floor, unit.sequence) : null,
          buildingCode: unit?.building.code ?? null,
          amount: row.amount.toNumber(),
          currency: row.currency,
          paymentTitle: row.payment.title,
        };
      }),
    };
  }

  private view(row: TransferRow): TransferView {
    const name = (person: { firstName: string; lastName: string } | null): string | null =>
      person ? `${person.firstName} ${person.lastName}` : null;

    return {
      id: row.id,
      transferNumber: row.transferNumber,
      status: row.voidedAt ? 'VOID' : 'RECORDED',
      kind: transferKindOf(row.from, row.to),
      from: row.from,
      to: row.to,
      amount: row.amount.toNumber(),
      receivedAmount: row.receivedAmount.toNumber(),
      fee:
        row.feeAmount && row.feeVoucher
          ? { amount: row.feeAmount.toNumber(), voucherId: row.feeVoucher.id, voucherNumber: row.feeVoucher.voucherNumber }
          : null,
      exchangeRate: row.exchangeRate?.toNumber() ?? null,
      officialExchangeRate: row.officialExchangeRate?.toNumber() ?? null,
      adjustmentReason: row.adjustmentReason,
      moneyChangerName: row.moneyChangerName,
      backdateReason: row.backdateReason,
      description: row.description,
      occurredAt: row.occurredAt.toISOString(),
      recordedByName: name(row.recordedBy),
      review: row.requiresReview
        ? { reviewedAt: row.reviewedAt?.toISOString() ?? null, reviewedByName: name(row.reviewedBy), note: row.reviewNote }
        : null,
      voidedAt: row.voidedAt?.toISOString() ?? null,
      voidedByName: name(row.voidedBy),
      voidReason: row.voidReason,
    };
  }
}

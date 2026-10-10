import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  citizenDisplayName,
  planBulkSettlement,
  roundRate,
  type BulkRefusal,
  type BulkSettlePayments,
  type FeeAssessment,
  type PaymentMethod,
  type SettlementReceipt,
  type SettlementReceiptItem,
} from '@mechanization/shared-schemas';
import type { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { allocateDocumentNumber } from '../../common/document-number';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { AuditService } from '../audit/audit.service';
import { isUniqueViolationOn } from '../treasury/retry-key';
import { officialRateFor } from './fees.service';
import { PaymentLedgerService, type Tender } from './payment-ledger.service';

/** What the transaction decided, before the receipt is read back. */
interface SettleOutcome {
  settlementId: string;
  citizenId: string;
  paymentIds: string[];
  replayed: boolean;
}

/**
 * «تسديد الفواتير المحددة» — several of one citizen's bills settled in one
 * press, all of them or none (docs/finance.md §3.7).
 *
 * Built on the payment ledger, not beside it: every bill is settled by
 * `PaymentLedgerService.recordIn`, the same code a single counter payment runs —
 * the row lock, the receipt number, the wallet entries, the closed-day rule
 * where it exists, the Tier 1 audit row — inside one transaction this service
 * owns. A refusal on the fortieth bill rolls back the thirty-nine before it.
 *
 * What is new is only what belongs to the set: `payment_settlements` (0085),
 * holding the «BRC-» master number, the notes handed over, the change handed
 * back and the press's retry key; and `planBulkSettlement`, the shared rule
 * that spreads the notes over the bills.
 *
 * Its own service rather than more of `FeesService`, which docs/code-quality.md
 * lists as a god file to be split.
 */
@Injectable()
export class PaymentSettlementService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
    private readonly ledger: PaymentLedgerService,
    private readonly auditTrail: AuditService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  /**
   * Settles the bills, or refuses and writes nothing.
   *
   * Refused when a bill is missing (`PAYMENT_NOT_FOUND`), belongs to someone
   * else (`BULK_SETTLE_CITIZEN_MISMATCH`), was settled since it was ticked
   * (`BULK_SETTLE_SOME_ALREADY_PAID`), when the notes do not cover the set or
   * cannot be spread over it (`planBulkSettlement`'s refusals), when the safe
   * cannot hand back the change (`TREASURY_INSUFFICIENT_FUNDS`, from the
   * ledger), and for anything a single counter payment is refused for.
   *
   * Lock order: the retry key's advisory lock, then every bill in id order,
   * then the settings row (FOR SHARE), then the document counters and the
   * wallets as each bill's `recordIn` reaches them — the order a single payment
   * already takes (bill, counter, settings, wallets), so the two never deadlock.
   */
  async settle(input: BulkSettlePayments, actor: { id: string; role: string }): Promise<SettlementReceipt> {
    let outcome: SettleOutcome;
    try {
      outcome = await runInTenantTransaction(this.tenantContext, () => this.settleInTransaction(input, actor));
    } catch (error) {
      /*
        Two presses carrying one key that both got past the read: the loser's
        insert hits the unique index on `clientRequestId` and its transaction is
        gone. Answered from the winner's settlement, read afresh. The advisory
        lock makes this rare; the index makes it impossible to get wrong.
      */
      if (!isUniqueViolationOn(error, 'clientRequestId')) throw error;
      const earlier = await this.replay(this.db as Prisma.TransactionClient, input);
      if (!earlier) throw error;
      outcome = earlier;
    }

    // For the caches that show these bills. A replayed retry changed nothing.
    if (!outcome.replayed) {
      for (const paymentId of outcome.paymentIds) {
        this.events.emit('payment.reviewed', {
          tenantSlug: this.tenantContext.tenantSlug,
          paymentId,
          citizenId: outcome.citizenId,
          confirmed: true,
          actorId: actor.id,
          actorRole: actor.role,
        });
      }
    }

    const receipt = await this.get(outcome.settlementId);
    return { ...receipt, replayed: outcome.replayed };
  }

  /** The consolidated receipt, for the screen right after the press and for every reprint. */
  async get(settlementId: string): Promise<SettlementReceipt> {
    const row = await this.db.paymentSettlement.findUnique({
      where: { id: settlementId },
      include: {
        citizen: {
          select: {
            id: true,
            firstName: true,
            middleName: true,
            lastName: true,
            residence: true,
            phone: true,
            whatsapp: true,
          },
        },
        collectedBy: { select: { firstName: true, lastName: true } },
        recordedBy: { select: { firstName: true, lastName: true } },
        transactions: {
          orderBy: [{ createdAt: 'asc' }, { receiptNumber: 'asc' }],
          select: {
            id: true,
            paymentId: true,
            receiptNumber: true,
            amount: true,
            currency: true,
            reversedBy: { select: { id: true } },
            payment: {
              select: { invoiceNumber: true, title: true, periodKey: true, dueDate: true, assessment: true },
            },
          },
        },
      },
    });
    if (!row) {
      throw new NotFoundError({
        code: 'PAYMENT_SETTLEMENT_NOT_FOUND',
        message: `Settlement ${settlementId} was not found`,
      });
    }

    const items: SettlementReceiptItem[] = row.transactions.map((tx) => ({
      paymentId: tx.paymentId,
      transactionId: tx.id,
      receiptNumber: tx.receiptNumber,
      invoiceNumber: tx.payment.invoiceNumber,
      title: tx.payment.title,
      periodKey: tx.payment.periodKey,
      dueDate: tx.payment.dueDate.toISOString(),
      properties: propertiesOf(tx.payment.assessment as FeeAssessment | null),
      amount: Number(tx.amount),
      currency: tx.currency,
      reversed: tx.reversedBy !== null,
    }));

    const totals: Record<string, number> = {};
    for (const item of items) {
      totals[item.currency] = roundIn((totals[item.currency] ?? 0) + item.amount, item.currency);
    }

    const baseCurrency = row.tenderedLocal === null ? null : await this.baseCurrency();

    return {
      id: row.id,
      number: row.number,
      occurredAt: row.occurredAt.toISOString(),
      method: row.method as PaymentMethod,
      citizen: {
        id: row.citizen.id,
        // «ورثة المرحوم …» for an estate (0076): the heirs pay, not the deceased.
        // The father's name is its own line on the receipt, so not repeated here.
        fullName: citizenDisplayName(row.citizen, { middleName: false }),
        fatherName: row.citizen.middleName,
        phone: row.citizen.phone,
        whatsapp: row.citizen.whatsapp,
      },
      collectorName: row.collectedBy ? `${row.collectedBy.firstName} ${row.collectedBy.lastName}`.trim() : null,
      externalRef: row.externalRef,
      recordedByName: row.recordedBy ? `${row.recordedBy.firstName} ${row.recordedBy.lastName}`.trim() : null,
      items,
      totals,
      tender:
        row.tenderedLocal === null
          ? null
          : {
              local: Number(row.tenderedLocal),
              localCurrency: baseCurrency ?? 'LBP',
              foreign: Number(row.tenderedForeign ?? 0),
              foreignCurrency: row.tenderedForeignCurrency,
              exchangeRate: row.exchangeRate === null ? null : Number(row.exchangeRate),
              changeGiven: Number(row.changeGiven ?? 0),
            },
    };
  }

  // ──────────────────────────────  internals  ──────────────────────────────

  private async settleInTransaction(
    input: BulkSettlePayments,
    actor: { id: string; role: string },
  ): Promise<SettleOutcome> {
    const tx = this.db as Prisma.TransactionClient;

    /*
      A double-click, or a retry after a lost response, must answer with the
      first settlement and move no money. Reading first is not enough: two
      identical requests arriving together would both read nothing. So the key
      is serialised first; the second waits here, then finds the first's row.
      The key names the schema, so two municipalities never wait on each other.
      Taken before any row lock, so it adds no lock-order edge.
    */
    const lockKey = `${this.tenantContext.schemaName}:bulk-settle:${input.clientRequestId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const earlier = await this.replay(tx, input);
    if (earlier) return earlier;

    const invoices = await this.ledger.lockInvoices(tx, input.paymentIds);
    const found = new Set(invoices.map((invoice) => invoice.id));
    const missing = input.paymentIds.find((id) => !found.has(id));
    if (missing) {
      throw new NotFoundError({ code: 'PAYMENT_NOT_FOUND', message: `Payment ${missing} was not found` });
    }
    if (invoices.some((invoice) => invoice.citizenId !== input.citizenId)) {
      throw new ValidationError({
        code: 'BULK_SETTLE_CITIZEN_MISMATCH',
        message: 'The selected bills do not all belong to the citizen named in the request.',
      });
    }

    // Read behind the locks, so what it says cannot change before the rows are written.
    const meta = new Map(
      (
        await tx.citizenPayment.findMany({
          where: { id: { in: input.paymentIds } },
          select: { id: true, invoiceNumber: true, title: true },
        })
      ).map((row) => [row.id, row]),
    );
    for (const invoice of invoices) {
      if (invoice.paymentStatus === 'PAID' || invoice.amount - invoice.paidAmount <= toleranceFor(invoice.currency)) {
        const bill = meta.get(invoice.id);
        throw new ConflictError({
          code: 'BULK_SETTLE_SOME_ALREADY_PAID',
          message: `Payment ${invoice.id} was settled before this settlement reached it.`,
          params: { invoice: bill?.invoiceNumber ?? bill?.title ?? invoice.id },
          details: { paymentId: invoice.id },
        });
      }
    }

    const settings = await this.settings(tx);
    const foreignCurrency = input.tendered?.foreignCurrency ?? null;
    const result = planBulkSettlement({
      bills: invoices.map((invoice) => ({
        id: invoice.id,
        currency: invoice.currency,
        outstanding: roundIn(invoice.amount - invoice.paidAmount, invoice.currency),
        dueDate: invoice.dueDate,
        createdAt: invoice.createdAt,
      })),
      method: input.method,
      tender: input.tendered ?? null,
      baseCurrency: settings.baseCurrency,
      exchangeRate: foreignCurrency
        ? officialRateFor(settings, settings.baseCurrency, foreignCurrency)
        : null,
    });
    if (!result.ok) throw refusalError(result.refusal);
    const { plan } = result;

    const number = await allocateDocumentNumber(tx, this.S, 'BULK_RECEIPT');
    const foreign = input.tendered?.foreign ?? 0;
    const settlement = await tx.paymentSettlement.create({
      data: {
        number,
        citizenId: input.citizenId,
        method: input.method as never,
        collectedById: input.method === 'COLLECTOR' ? (input.collectedById ?? null) : null,
        externalRef: input.method === 'WHISH_MONEY' ? (input.whishTransactionRef ?? null) : null,
        ...(input.method === 'CASH' && input.tendered
          ? {
              tenderedLocal: input.tendered.local,
              tenderedForeign: foreign,
              tenderedForeignCurrency: foreign > 0 ? input.tendered.foreignCurrency : null,
              exchangeRate: plan.exchangeRate,
              changeGiven: plan.change,
            }
          : {}),
        recordedById: actor.id,
        clientRequestId: input.clientRequestId,
      },
      select: { id: true },
    });

    /*
      Oldest bill first, so the receipt numbers run in the order the bills fell
      due. Each is settled by the ledger exactly as a single counter payment is,
      and the plan's every row covers its bill in full: a row that came back
      part-paid would mean the plan and the ledger disagree, and is refused
      rather than recorded.
    */
    const receipts: string[] = [];
    for (const row of plan.rows) {
      const tender: Tender | null = row.tender
        ? {
            local: row.tender.local,
            foreign: row.tender.foreign > 0 ? row.tender.foreign : null,
            foreignCurrency: row.tender.foreign > 0 ? row.tender.foreignCurrency : null,
            exchangeRate: row.tender.foreign > 0 ? plan.exchangeRate : null,
            officialExchangeRate: row.tender.foreign > 0 ? plan.exchangeRate : null,
          }
        : null;

      const settled = await this.ledger.recordIn(tx, {
        paymentId: row.paymentId,
        amount: row.amount,
        method: input.method,
        externalRef: input.method === 'WHISH_MONEY' ? (input.whishTransactionRef ?? null) : null,
        collectedById: input.method === 'COLLECTOR' ? (input.collectedById ?? null) : null,
        recordedById: actor.id,
        note: input.note,
        tendered: tender,
        settlementId: settlement.id,
        audit: (movement) => ({
          actorId: actor.id,
          actorType: 'STAFF',
          actorRole: actor.role as never,
          action: 'PAYMENT_CONFIRMED',
          entityType: 'Payment',
          entityId: row.paymentId,
          after: {
            citizenId: input.citizenId,
            confirmed: true,
            receiptNumber: movement.receiptNumber,
            settlementNumber: number,
            method: input.method,
            amount: movement.received,
            currency: row.currency,
            occurredAt: movement.occurredAt,
            ...(tender
              ? {
                  tenderedLocal: tender.local,
                  tenderedForeign: tender.foreign,
                  tenderedForeignCurrency: tender.foreignCurrency,
                  exchangeRate: tender.exchangeRate,
                  officialExchangeRate: tender.officialExchangeRate,
                  changeGiven: movement.changeGiven,
                }
              : {}),
          },
        }),
      });
      if (settled.paymentStatus !== 'PAID') {
        throw new ConflictError({
          code: 'PAYMENT_STATE_CHANGED',
          message: `Payment ${row.paymentId} would be left part-paid by this settlement.`,
        });
      }
      receipts.push(settled.receiptNumber);
    }

    /*
      Tier 1, in this transaction: the set as one act. Ids and figures only —
      the citizen and the collector by id, never by name, and no رقم مرجعي
      (docs/security.md). Each bill's own row was written by the ledger above.
    */
    await this.auditTrail.recordInTransaction({
      actorId: actor.id,
      actorType: 'STAFF',
      actorRole: actor.role as never,
      action: 'PAYMENT_BULK_SETTLED',
      entityType: 'PaymentSettlement',
      entityId: settlement.id,
      after: {
        citizenId: input.citizenId,
        settlementNumber: number,
        method: input.method,
        paymentIds: plan.rows.map((row) => row.paymentId),
        receiptNumbers: receipts,
        due: plan.due,
        ...(input.method === 'COLLECTOR' ? { collectedById: input.collectedById ?? null } : {}),
        ...(input.method === 'CASH' && input.tendered
          ? {
              tenderedLocal: input.tendered.local,
              tenderedForeign: foreign,
              tenderedForeignCurrency: foreign > 0 ? input.tendered.foreignCurrency : null,
              exchangeRate: plan.exchangeRate,
              changeGiven: plan.change,
            }
          : {}),
      },
    });

    return {
      settlementId: settlement.id,
      citizenId: input.citizenId,
      paymentIds: plan.rows.map((row) => row.paymentId),
      replayed: false,
    };
  }

  /**
   * The settlement already recorded under this retry key, or null.
   *
   * Bound to its act: the same citizen, method and bills. A key that settled
   * another set can only mean a page reused an id, and answering with another
   * settlement's receipt would tell the clerk the wrong bills were paid. A
   * settlement one of whose bills has been reversed since is not answered as
   * recorded either: the clerk would hand over a receipt the ledger has
   * partly cancelled.
   */
  private async replay(tx: Prisma.TransactionClient, input: BulkSettlePayments): Promise<SettleOutcome | null> {
    const row = await tx.paymentSettlement.findUnique({
      where: { clientRequestId: input.clientRequestId },
      select: {
        id: true,
        citizenId: true,
        method: true,
        transactions: {
          select: { paymentId: true, receiptNumber: true, reversedBy: { select: { id: true } } },
        },
      },
    });
    if (!row) return null;

    const settled = row.transactions.map((tx) => tx.paymentId).sort();
    const asked = [...input.paymentIds].sort();
    const same =
      row.citizenId === input.citizenId &&
      row.method === input.method &&
      settled.length === asked.length &&
      settled.every((id, index) => id === asked[index]);
    if (!same) {
      throw new ConflictError({
        code: 'BULK_SETTLE_REQUEST_REUSED',
        message: 'This retry key already settled a different set of bills.',
      });
    }
    const reversed = row.transactions.find((tx) => tx.reversedBy !== null);
    if (reversed) {
      throw new ConflictError({
        code: 'TRANSACTION_ALREADY_REVERSED',
        message: `This settlement's receipt ${reversed.receiptNumber} has since been reversed.`,
        params: { receiptNumber: reversed.receiptNumber },
      });
    }
    return { settlementId: row.id, citizenId: row.citizenId, paymentIds: settled, replayed: true };
  }

  /**
   * The municipality's currencies and official rate, read in the settlement's
   * transaction. FOR SHARE, as `TreasuryLedgerService.config` reads the same
   * row: a rate being changed at this moment is waited for, never read half way.
   */
  private async settings(tx: Prisma.TransactionClient): Promise<{
    baseCurrency: string;
    secondaryCurrency: string | null;
    exchangeRate: number | null;
  }> {
    const rows = await tx.$queryRaw<
      Array<{ baseCurrency: string; secondaryCurrency: string | null; exchangeRate: Prisma.Decimal | null }>
    >`
      SELECT "baseCurrency", "secondaryCurrency", "exchangeRate"
        FROM ${this.S}system_settings
       LIMIT 1
         FOR SHARE
    `;
    const row = rows[0];
    return {
      baseCurrency: row?.baseCurrency ?? 'LBP',
      secondaryCurrency: row?.secondaryCurrency ?? null,
      exchangeRate: row?.exchangeRate == null ? null : roundRate(Number(row.exchangeRate)),
    };
  }

  private async baseCurrency(): Promise<string> {
    const row = await this.db.systemSettings.findFirst({ select: { baseCurrency: true } });
    return row?.baseCurrency ?? 'LBP';
  }
}

/** A plan's refusal, as the coded error the client words. */
function refusalError(refusal: BulkRefusal): ValidationError {
  switch (refusal.code) {
    case 'BULK_SETTLE_TENDER_SHORT':
      return new ValidationError({
        code: refusal.code,
        message: `The notes are ${refusal.params.shortBy} ${refusal.params.currency} short of the selected bills.`,
        params: refusal.params,
      });
    case 'BULK_SETTLE_TENDER_EXCEEDS':
      return new ValidationError({
        code: refusal.code,
        message: `The notes in ${refusal.params.currency} (${refusal.params.amount}) are more than is owed in it (${refusal.params.due}).`,
        params: refusal.params,
      });
    case 'BULK_SETTLE_CURRENCY_UNSUPPORTED':
      return new ValidationError({
        code: refusal.code,
        message: `A bill is in ${refusal.params.currency}, which neither currency of the notes can pay.`,
        params: refusal.params,
      });
    case 'BULK_SETTLE_RATE_NOT_SET':
      return new ValidationError({
        code: refusal.code,
        message: 'No official exchange rate is set, so foreign notes cannot pay bills in the base currency.',
      });
  }
}

/** The parcels and units a bill was assessed on, each once, in the order the assessment lists them. */
export function propertiesOf(
  assessment: FeeAssessment | null,
): SettlementReceiptItem['properties'] {
  const seen = new Set<string>();
  const out: SettlementReceiptItem['properties'] = [];
  for (const line of assessment?.lines ?? []) {
    const entry = {
      propertyNumber: line.propertyNumber ?? null,
      unitType: line.unitType ?? null,
      unitCode: line.unitCode ?? null,
    };
    const key = `${entry.propertyNumber}|${entry.unitType}|${entry.unitCode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** Half a pound for ليرة, a tenth of a cent otherwise — the ledger's own tolerance. */
function toleranceFor(currency: string): number {
  return currency === 'LBP' ? 0.5 : 0.001;
}

function roundIn(value: number, currency: string): number {
  return currency === 'LBP' ? Math.round(value) : Math.round(value * 100) / 100;
}

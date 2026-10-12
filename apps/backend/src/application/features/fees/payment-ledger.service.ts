import { Injectable } from '@nestjs/common';
import { municipalToday, type PaymentMethod } from '@mechanization/shared-schemas';
import type { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { allocateDocumentNumber, allocateDocumentNumbers } from '../../common/document-number';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { AuditService, type AuditEntryInput } from '../audit/audit.service';
import { TreasuryLedgerService } from '../treasury/treasury-ledger.service';

/** One movement of money, as the caller describes it. */
export interface LedgerEntryInput {
  paymentId: string;
  /** Positive. A reversal is `reverse()`, not a negative amount here. */
  amount: number;
  method: PaymentMethod;
  externalRef?: string | null;
  collectedById?: string | null;
  recordedById?: string | null;
  note?: string | null;
  /** Defaults to now. Set when recording a collector's round after the fact. */
  occurredAt?: Date;
  /**
   * What was handed over, when cash came in more than the invoice's currency
   * (migration 0064). `amount` is already the credit worked out from it; this
   * is the record of the notes themselves.
   */
  tendered?: Tender | null;
  /** Why the rate or the date departs from the ordinary (migration 0066). */
  adjustmentReason?: string | null;
  /**
   * The page's id for this press of the button (migration 0066). A second
   * `record` carrying the same id returns the first movement's totals instead
   * of writing another — a retry after a lost response must not take the
   * money twice.
   */
  clientRequestId?: string | null;
  /**
   * Set only by the two writes that settle a citizen's claim (PENDING_REVIEW):
   * the staff confirmation and the Whish success callback. Any other `record`
   * on a bill under review is refused (`PAYMENT_CLAIM_UNDER_REVIEW`): `append`
   * writes PAID or UNPAID, and would erase the claim without deciding it.
   */
  resolvesClaim?: boolean;
  /**
   * The settlement this movement belongs to, when one press settles several
   * of a citizen's bills (migration 0085). The settlement row must already be
   * written in the same transaction: the ledger refuses UPDATE, so a row joins
   * its settlement at insert or never.
   */
  settlementId?: string | null;
  /**
   * The «RCP-» number for this movement, when the caller drew it beforehand
   * (`reserveReceiptNumbers`, in the same transaction). A settlement of several
   * bills draws all of its numbers before it locks its wallets, because a single
   * payment takes the counter before its wallets and the two must agree on that
   * order. Left out, the number is drawn here, as it always was.
   */
  receiptNumber?: string;
}

/** An invoice as its row lock returns it, as plain numbers. */
export interface LockedInvoice {
  id: string;
  amount: number;
  paidAmount: number;
  currency: string;
  paymentStatus: string;
  citizenId: string;
  createdAt: Date;
  dueDate: Date;
}

/**
 * The audit row for a movement — Tier 1 (docs/security.md).
 *
 * Called inside the ledger's own transaction once the movement is written,
 * with what only that write knows (the receipt number, the day, the change),
 * and written through the same transaction: the money and its record commit
 * together or not at all. Required, so no caller can move money without one.
 * A retry answered from an earlier movement (`replayed`) writes no second row.
 */
export type LedgerAudit = (settled: SettledTotals) => AuditEntryInput;

/** Cash as it was handed over: the invoice's own currency, and another at a rate. */
export interface Tender {
  local: number;
  foreign: number | null;
  foreignCurrency: string | null;
  exchangeRate: number | null;
  /** The municipality's own rate at the time, when it has one — kept beside the rate used. */
  officialExchangeRate: number | null;
}

/** What an invoice's balance looks like after a movement. */
export interface SettledTotals {
  receiptNumber: string;
  transactionId: string;
  received: number;
  paidAmount: number;
  remaining: number;
  paymentStatus: 'PAID' | 'UNPAID';
  /** Handed back to the citizen from a larger note, in the invoice's currency. */
  changeGiven: number;
  /** When the money moved — what the receipt prints. */
  occurredAt: string;
  /** True when this answers a retry with the movement already recorded. */
  replayed: boolean;
}

/**
 * Half a pound.
 *
 * `Decimal(14,2)` round-trips through `Number` on the way in and out, and LBP
 * is whole pounds in practice, so this absorbs float noise without ever letting
 * a real underpayment count as settled. The tolerance exists because money
 * crosses into IEEE-754 here at all — removing it means keeping `Decimal` end
 * to end, which is tracked as F-07 and is a wider change than this.
 */
const LBP_TOLERANCE = 0.5;
const USD_TOLERANCE = 0.001;

/**
 * Writes to the payment ledger, and keeps the invoice's cached balance in step.
 *
 * Every money-moving path goes through `record`, and `record` does all of it
 * inside one transaction that holds a row lock on the invoice. That lock is the
 * fix for a defect all three settlement paths shared: each read `paidAmount`,
 * computed a new total in JavaScript, and wrote it back, with no transaction
 * and no guard in the `WHERE`. Two clerks settling instalments on the same
 * invoice in the same second both read the same starting figure and the second
 * write silently discarded the first — money taken, receipt issued, register
 * short.
 *
 * `SELECT … FOR UPDATE` serialises them instead: the second waits for the
 * first to commit, then computes from the total the first actually wrote.
 */
@Injectable()
export class PaymentLedgerService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditTrail: AuditService,
    private readonly treasury: TreasuryLedgerService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /**
   * The schema prefix every raw query in this class writes into its SQL.
   *
   * Raw SQL is sent to Postgres untouched, so an unqualified table name resolves
   * through `search_path` — session state on a connection shared through a
   * transaction pooler, which is not required to carry it. See
   * `tenant-schema-ref.ts` for the 42P01 this prevents.
   */
  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  /**
   * Records money received against an invoice.
   *
   * Returns the receipt number, which is drawn from a Postgres sequence and is
   * the citizen's handle on this specific movement — the thing that makes a
   * reprint possible at all.
   */
  async record(input: LedgerEntryInput & { audit: LedgerAudit }): Promise<SettledTotals> {
    assertPositiveAmount(input.amount);
    return this.db.$transaction((tx) => this.recordIn(tx, input));
  }

  /**
   * `record`, inside a transaction the caller already holds.
   *
   * For an act that settles several bills and must commit all of them or none
   * (`PaymentSettlementService.settle`): the same lock, the same checks, the same
   * receipt number, wallet entries and Tier 1 audit row, written through the
   * caller's client. The caller owns the commit, and a refusal here rolls the
   * whole act back.
   */
  async recordIn(
    tx: Prisma.TransactionClient,
    input: LedgerEntryInput & { audit: LedgerAudit },
  ): Promise<SettledTotals> {
    assertPositiveAmount(input.amount);
    // Before the bill's row lock, as every caller takes it (`lockExternalRef`).
    const externalRef = normaliseExternalRef(input.externalRef);
    if (externalRef) await this.lockExternalRef(tx, externalRef);
    const invoice = await this.lock(tx, input.paymentId);

    /*
      Checked behind the lock, so two presses racing each other still meet
      here one after the other and the second finds the first's row.
    */
    if (input.clientRequestId) {
      const earlier = await this.replay(tx, invoice, input.clientRequestId, input);
      if (earlier) return earlier;
    }

    if (invoice.paymentStatus === 'CANCELLED') throw billCancelled();
    const outstanding = invoice.amount - invoice.paidAmount;
    if (invoice.paymentStatus === 'PAID' || outstanding <= 0) {
      throw new ConflictError({
        code: 'PAYMENT_ALREADY_PAID',
        message: 'This payment has already been settled.',
      });
    }
    if (invoice.paymentStatus === 'PENDING_REVIEW' && !input.resolvesClaim) throw claimUnderReview();

    /*
      One Whish transfer, or one bank transfer, is one receipt (finance audit
      B2). A reference already on a receipt still standing — not reversed — is
      refused, whichever path brings it: the counter, a citizen's claim being
      confirmed, the Whish callback, a settlement of several bills. Only the
      rows of one settlement share a reference, since one transfer paid them
      all. Asked after the retry key's replay, so a retry finds its own row
      first, and behind the reference's advisory lock, so two clerks typing one
      reference at the same moment meet here one after the other.
    */
    if (externalRef) await this.assertExternalRefFree(tx, externalRef, input.settlementId ?? null);

    /*
      A closed treasury day takes nothing (docs/finance.md §7.3): a collector's
      round or a counter payment back-dated into one is refused here, before a
      receipt number is drawn, rather than by the ledger's own check further
      down. Here in `recordIn`, not only in `record`, so every path that settles
      a bill — the counter, a round, a bulk settlement — meets it. Today is
      never closed by the application — only a day that has ended can be — so
      an undated payment passes unless a closure says otherwise.
    */
    await this.treasury.assertPaymentDayOpen(tx, input.occurredAt ?? new Date());

    // Money cannot have been taken against a bill before the bill existed.
    if (input.occurredAt && municipalToday(input.occurredAt) < municipalToday(invoice.createdAt)) {
      throw new ValidationError({
        code: 'PAYMENT_DATE_BEFORE_INVOICE',
        message: `The payment date is before the invoice was issued (${municipalToday(invoice.createdAt)}).`,
        params: { issuedOn: municipalToday(invoice.createdAt) },
        details: { paidOn: municipalToday(input.occurredAt) },
      });
    }

    const tolerance = toleranceFor(invoice.currency);
    let credit = input.amount;
    let changeGiven = 0;
    /*
      «الباقي»: a citizen pays a smaller bill with a larger dollar note and
      gets the difference back. The credit is what was owed; the rest is
      recorded as change, so tender − change = credit on the row. Only the
      foreign notes can produce change — ليرة handed over beyond the balance
      is a typing mistake, not a note too large to split.
    */
    if (input.tendered && input.amount > outstanding + tolerance) {
      if (!input.tendered.foreign || input.tendered.local > outstanding + tolerance) {
        throw new ConflictError({
          code: 'PAYMENT_TENDER_EXCEEDS_BALANCE',
          message: `The amount in the invoice currency (${input.tendered.local}) is more than the balance due (${outstanding}).`,
          params: { amount: input.tendered.local, outstanding },
        });
      }
      credit = outstanding;
      changeGiven = roundTo(input.amount - outstanding, invoice.currency);
    }

    if (credit > outstanding + tolerance) {
      throw new ConflictError({
        code: 'PAYMENT_EXCEEDS_BALANCE',
        message: `The amount received (${credit}) is more than the balance due (${outstanding}).`,
        params: { amount: credit, outstanding },
      });
    }

    const settled = await this.append(tx, invoice, credit, input, undefined, changeGiven);
    await this.auditTrail.recordInTransaction(input.audit(settled), tx);
    return settled;
  }

  /**
   * Draws `count` consecutive «RCP-» numbers in the caller's transaction, for
   * `recordIn` calls that pass them back as `receiptNumber`.
   *
   * The RECEIPT counter's row stays locked until the caller commits, as it does
   * for a single payment. Drawing the block up front is what lets a settlement
   * of several bills hold the counter before it locks its wallets
   * (`TreasuryLedgerService.lockPaymentWallets`) — the order a single payment
   * takes them in — and it keeps the set's receipts consecutive.
   */
  async reserveReceiptNumbers(tx: Prisma.TransactionClient, count: number): Promise<string[]> {
    return allocateDocumentNumbers(tx, this.S, 'RECEIPT', count);
  }

  /**
   * Serialises every write that carries one Whish or bank reference (finance
   * audit B2), so two clerks typing the same reference at once meet in
   * `assertExternalRefFree` one after the other. A transaction-scoped advisory
   * lock, named by the schema so two municipalities never wait on each other.
   *
   * Taken before any row lock, like the retry key's: `recordIn` takes it ahead of
   * the bill's, and a caller that locks bills itself first (`settleInPerson`, a
   * settlement of several bills) takes it before them. Re-taking it in the same
   * transaction is free (`pg_advisory_xact_lock` is re-entrant).
   */
  async lockExternalRef(tx: Prisma.TransactionClient, externalRef: string | null | undefined): Promise<void> {
    const ref = normaliseExternalRef(externalRef);
    if (!ref) return;
    const key = `${this.tenantContext.schemaName}:external-ref:${ref}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  /**
   * Refuses a reference already on a receipt still standing (`PAYMENT_EXTERNAL_REF_REUSED`,
   * naming that receipt). A reversed receipt frees its reference; the rows of
   * `settlementId` share one by design. Compared without case or edge spaces,
   * through `payment_transactions_externalRef_lower_idx` (0091).
   */
  private async assertExternalRefFree(
    tx: Prisma.TransactionClient,
    externalRef: string,
    settlementId: string | null,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ receiptNumber: string }>>`
      SELECT t."receiptNumber"
        FROM ${this.S}payment_transactions t
       WHERE lower(btrim(t."externalRef")) = ${externalRef}
         AND t."externalRef" IS NOT NULL
         AND t."amount" > 0
         AND NOT EXISTS (
               SELECT 1 FROM ${this.S}payment_transactions r WHERE r."reversalOfId" = t."id"
             )
         AND (${settlementId}::uuid IS NULL OR t."settlementId" IS NULL OR t."settlementId" <> ${settlementId}::uuid)
       LIMIT 1
    `;
    if (rows[0]) {
      throw new ConflictError({
        code: 'PAYMENT_EXTERNAL_REF_REUSED',
        message: `This reference is already on receipt ${rows[0].receiptNumber}.`,
        params: { receiptNumber: rows[0].receiptNumber },
      });
    }
  }

  /**
   * The settings a payment is judged by — the official rate, the two
   * currencies, the counter's rate tolerance and the go-live stamp — read FOR
   * SHARE in the caller's transaction (finance audit B8). Take it after the
   * bill's row lock: that is the order every payment path takes the two in.
   */
  async settings(tx: Prisma.TransactionClient) {
    return this.treasury.config(tx);
  }

  /**
   * Takes `record`'s row lock on several invoices at once, in id order.
   *
   * A settlement of several bills locks all of them before it writes any, so a
   * bill another clerk is settling at that moment is waited for and then seen
   * as paid, never half-way. Id order is the deadlock rule (as `lockAccounts`
   * on wallets): two settlements over overlapping sets take their locks in the
   * same order and the second simply waits. `recordIn` re-locking a row this
   * transaction already holds costs nothing.
   *
   * Returns the rows found, in id order; the caller decides what a missing id
   * means.
   */
  async lockInvoices(tx: Prisma.TransactionClient, paymentIds: string[]): Promise<LockedInvoice[]> {
    const ids = [...new Set(paymentIds)].sort();
    if (ids.length === 0) return [];
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        amount: string;
        paidAmount: string;
        currency: string;
        paymentStatus: string;
        citizenId: string;
        createdAt: Date;
        dueDate: Date;
      }>
    >`
      SELECT "id", "amount"::text, "paidAmount"::text, "currency",
             "paymentStatus"::text, "citizenId", "createdAt", "dueDate"
        FROM ${this.S}citizen_payments
       WHERE "id" = ANY(${ids}::uuid[])
       ORDER BY "id"
       FOR UPDATE
    `;
    return rows.map((row) => ({
      id: row.id,
      amount: Number(row.amount),
      paidAmount: Number(row.paidAmount),
      currency: row.currency,
      paymentStatus: row.paymentStatus,
      citizenId: row.citizenId,
      createdAt: row.createdAt,
      dueDate: row.dueDate,
    }));
  }

  /**
   * Reverses an earlier entry, as an opposing row.
   *
   * Never an edit or a delete — the trigger on this table refuses both, on
   * purpose. A municipality asked "what happened to that payment" is owed
   * "it was taken on the 3rd and reversed on the 5th by this clerk", not a
   * ledger that has quietly forgotten the 3rd.
   */
  async reverse(input: {
    transactionId: string;
    recordedById?: string | null;
    note?: string | null;
    audit: LedgerAudit;
  }): Promise<SettledTotals> {
    return this.db.$transaction(async (tx) => {
      const original = await tx.paymentTransaction.findUnique({
        where: { id: input.transactionId },
        select: {
          id: true,
          paymentId: true,
          amount: true,
          method: true,
          externalRef: true,
          collectedById: true,
        },
      });
      if (!original) throw new NotFoundError({
        code: 'TRANSACTION_NOT_FOUND',
        message: `Transaction ${input.transactionId} was not found`,
      });
      if (Number(original.amount) < 0) {
        throw new ConflictError({
          code: 'TRANSACTION_IS_REVERSAL',
          message: 'A reversal cannot itself be reversed.',
        });
      }

      const invoice = await this.lock(tx, original.paymentId);
      // `append` writes PAID or UNPAID, which would erase the citizen's pending claim.
      if (invoice.paymentStatus === 'PENDING_REVIEW') throw claimUnderReview();

      /*
        The unique index on `reversalOfId` enforces this too; checking here
        turns a constraint violation into a sentence a clerk can act on. Asked
        under the invoice's lock, not before it: two clerks reversing the same
        receipt together both passed a check made earlier, and the second
        reached the index as a raw 500. The lock serialises them, and a reversal
        committed while this one waited is visible now.
      */
      const reversedBy = await tx.paymentTransaction.findFirst({
        where: { reversalOfId: original.id },
        select: { id: true },
      });
      if (reversedBy) {
        throw new ConflictError({
          code: 'TRANSACTION_ALREADY_REVERSED',
          message: 'This transaction has already been reversed.',
        });
      }

      const reversed = await this.append(
        tx,
        invoice,
        -Number(original.amount),
        {
          paymentId: original.paymentId,
          amount: Number(original.amount),
          method: original.method as PaymentMethod,
          externalRef: original.externalRef,
          collectedById: original.collectedById,
          recordedById: input.recordedById,
          note: input.note,
        },
        original.id,
      );
      await this.auditTrail.recordInTransaction(input.audit(reversed), tx);
      return reversed;
    });
  }

  /** The ledger for one invoice, oldest first — the receipt history. */
  async listForPayment(paymentId: string) {
    const rows = await this.db.paymentTransaction.findMany({
      where: { paymentId },
      orderBy: { occurredAt: 'asc' },
      include: {
        collectedBy: { select: { firstName: true, lastName: true } },
        recordedBy: { select: { firstName: true, lastName: true } },
        reversedBy: { select: { id: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      receiptNumber: row.receiptNumber,
      amount: Number(row.amount),
      currency: row.currency,
      method: row.method,
      externalRef: row.externalRef,
      collectedBy: row.collectedBy
        ? `${row.collectedBy.firstName} ${row.collectedBy.lastName}`
        : null,
      recordedBy: row.recordedBy
        ? `${row.recordedBy.firstName} ${row.recordedBy.lastName}`
        : null,
      /** True for the opposing row itself; `reversed` for the one it undoes. */
      isReversal: row.reversalOfId !== null,
      reversed: row.reversedBy !== null,
      note: row.note,
      occurredAt: row.occurredAt.toISOString(),
      // The notes as handed over (0064/0066) — what a reprinted وصل and the
      // day's cash-up by currency read. All null on rows without a tender.
      tenderedLocal: row.tenderedLocal == null ? null : Number(row.tenderedLocal),
      tenderedForeign: row.tenderedForeign == null ? null : Number(row.tenderedForeign),
      tenderedForeignCurrency: row.tenderedForeignCurrency,
      exchangeRate: row.exchangeRate == null ? null : Number(row.exchangeRate),
      officialExchangeRate: row.officialExchangeRate == null ? null : Number(row.officialExchangeRate),
      changeGiven: row.changeGiven == null ? null : Number(row.changeGiven),
      adjustmentReason: row.adjustmentReason,
    }));
  }

  // ──────────────────────────────  internals  ──────────────────────────────

  /**
   * Takes the invoice's row lock and returns it as plain numbers.
   *
   * Raw SQL because Prisma has no `FOR UPDATE`, and this clause is the entire
   * point of the method: without it two concurrent settlements read the same
   * balance and one of them is lost.
   */
  private async lock(
    tx: Prisma.TransactionClient,
    paymentId: string,
  ): Promise<{
    id: string;
    amount: number;
    paidAmount: number;
    currency: string;
    paymentStatus: string;
    citizenId: string;
    createdAt: Date;
  }> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        amount: string;
        paidAmount: string;
        currency: string;
        paymentStatus: string;
        citizenId: string;
        createdAt: Date;
      }>
    >`
      SELECT "id", "amount"::text, "paidAmount"::text, "currency",
             "paymentStatus"::text, "citizenId", "createdAt"
        FROM ${this.S}citizen_payments
       WHERE "id" = ${paymentId}::uuid
       FOR UPDATE
    `;

    const row = rows[0];
    if (!row) throw new NotFoundError({
      code: 'PAYMENT_NOT_FOUND',
      message: `Payment ${paymentId} was not found`,
    });

    return {
      id: row.id,
      amount: Number(row.amount),
      paidAmount: Number(row.paidAmount),
      currency: row.currency,
      paymentStatus: row.paymentStatus,
      citizenId: row.citizenId,
      createdAt: row.createdAt,
    };
  }

  /**
   * The totals of a movement already recorded under this retry key, or null.
   *
   * A key names one act (finance audit B6): this bill, by this method, with this
   * collector and reference, for this sum — or these notes, when cash came in
   * two currencies. Replayed with all of them it answers with the first receipt.
   * Anything else under the key is refused (`PAYMENT_IDEMPOTENCY_KEY_REUSED`)
   * rather than answered: the screens keep a key across every edit, so a figure
   * corrected after a lost answer arrives here, and answering it with the first
   * receipt would tell the clerk the corrected sum was taken when it was not.
   * The rate is not compared: a retry carries the official rate as it stands,
   * which may have moved since, and the notes are what changed hands.
   */
  private async replay(
    tx: Prisma.TransactionClient,
    invoice: { id: string; amount: number; paidAmount: number; paymentStatus: string },
    clientRequestId: string,
    input: LedgerEntryInput,
  ): Promise<SettledTotals | null> {
    const row = await tx.paymentTransaction.findUnique({
      where: { clientRequestId },
      select: {
        id: true,
        paymentId: true,
        receiptNumber: true,
        amount: true,
        method: true,
        collectedById: true,
        externalRef: true,
        tenderedLocal: true,
        tenderedForeign: true,
        tenderedForeignCurrency: true,
        changeGiven: true,
        occurredAt: true,
        reversedBy: { select: { id: true } },
      },
    });
    if (!row) return null;
    if (row.paymentId !== invoice.id || !sameAct(row, input)) {
      throw new ConflictError({
        code: 'PAYMENT_IDEMPOTENCY_KEY_REUSED',
        message: `This operation’s identifier was already used for another payment (${row.receiptNumber}). Reload the page.`,
        params: { receiptNumber: row.receiptNumber },
      });
    }
    // Not answered as recorded once reversed: the clerk would hand over a receipt the ledger has cancelled.
    if (row.reversedBy) {
      throw new ConflictError({
        code: 'TRANSACTION_ALREADY_REVERSED',
        message: `This operation was recorded as ${row.receiptNumber}, and that receipt has since been reversed.`,
        params: { receiptNumber: row.receiptNumber },
      });
    }
    return {
      receiptNumber: row.receiptNumber,
      transactionId: row.id,
      received: Number(row.amount),
      paidAmount: invoice.paidAmount,
      remaining: Math.max(invoice.amount - invoice.paidAmount, 0),
      paymentStatus: invoice.paymentStatus === 'PAID' ? 'PAID' : 'UNPAID',
      changeGiven: row.changeGiven == null ? 0 : Number(row.changeGiven),
      occurredAt: row.occurredAt.toISOString(),
      replayed: true,
    };
  }

  /**
   * Writes the ledger row and the invoice's new cached balance, together.
   *
   * Both inside the caller's transaction and behind its row lock, so the cache
   * can never disagree with the sum of the rows it summarises.
   */
  private async append(
    tx: Prisma.TransactionClient,
    invoice: { id: string; amount: number; paidAmount: number; currency: string },
    delta: number,
    input: LedgerEntryInput,
    reversalOfId?: string,
    changeGiven = 0,
  ): Promise<SettledTotals> {
    /*
      «RCP-2610-0001» — the book, the month it was issued in, and a counter that
      restarts on the first (migration 0079). Drawn from `document_counters`
      rather than the old `payment_receipt_seq`, which a monthly reset is
      impossible with: `nextval` only climbs.

      `tx`, not `this.db`: the number and the receipt have to commit or roll
      back together. This runs inside the caller's transaction, behind the
      invoice's `FOR UPDATE`, and `this.S` names the schema for the reason it
      always has — a drifted pooled connection would otherwise draw from
      **another municipality's** counter, and receipt numbers are printed on
      paper handed to a resident.
    */
    const receiptNumber = input.receiptNumber ?? (await allocateDocumentNumber(tx, this.S, 'RECEIPT'));

    const created = await tx.paymentTransaction.create({
      data: {
        paymentId: invoice.id,
        amount: delta,
        currency: invoice.currency,
        method: input.method as never,
        receiptNumber,
        externalRef: input.externalRef ?? null,
        collectedById: input.collectedById ?? null,
        recordedById: input.recordedById ?? null,
        ...(reversalOfId ? { reversalOfId } : {}),
        note: input.note ?? null,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        ...(input.tendered
          ? {
              tenderedLocal: input.tendered.local,
              tenderedForeign: input.tendered.foreign,
              tenderedForeignCurrency: input.tendered.foreignCurrency,
              exchangeRate: input.tendered.exchangeRate,
              officialExchangeRate: input.tendered.officialExchangeRate,
              changeGiven,
            }
          : {}),
        adjustmentReason: input.adjustmentReason ?? null,
        clientRequestId: input.clientRequestId ?? null,
        settlementId: input.settlementId ?? null,
      },
      select: { id: true, occurredAt: true },
    });

    const paidAmount = invoice.paidAmount + delta;
    const tolerance = toleranceFor(invoice.currency);
    const fullySettled = paidAmount >= invoice.amount - tolerance;

    /*
      The day the bill was settled is the day the last of its money arrived —
      not this entry's date when it is back-dated before an earlier instalment.
      Reversed movements and the reversals themselves do not count.
    */
    const paidAt = fullySettled
      ? ((
          await tx.paymentTransaction.aggregate({
            where: { paymentId: invoice.id, amount: { gt: 0 }, reversedBy: { is: null } },
            _max: { occurredAt: true },
          })
        )._max.occurredAt ?? created.occurredAt)
      : null;

    await tx.citizenPayment.update({
      where: { id: invoice.id },
      data: {
        /**
         * The cache, recomputed from the balance this transaction locked —
         * not from a value read before the lock. That is the difference
         * between this and what it replaces.
         */
        paidAmount,
        /**
         * Only a fully covered invoice becomes PAID. A partial one stays
         * UNPAID on purpose: every "what is outstanding" query keys off that
         * status, and a half-paid row marked PAID drops out of the arrears the
         * municipality is chasing.
         */
        paymentStatus: fullySettled ? 'PAID' : 'UNPAID',
        paidAt,
        /**
         * Still written, because the ledger screens and the citizen portal
         * read them without joining. They now describe the *latest* movement
         * rather than being the only record of any — the history is the table
         * above, so overwriting these loses nothing.
         */
        paymentMethod: input.method as never,
        whishTransactionRef: input.externalRef ?? null,
        collectedById: input.collectedById ?? null,
      },
    });

    /*
      The wallets, in this same transaction: the payment and the money it moved
      commit together or not at all. Only once the treasury is live and only for
      a payment taken since (docs/finance.md §3). A reversal opposes the entries
      of the movement it undoes; a refused outflow (the drawer cannot cover a
      refund) rolls the reversal back with it.
    */
    if (reversalOfId) {
      await this.treasury.reversePayment(tx, {
        originalTransactionId: reversalOfId,
        reversalTransactionId: created.id,
        method: input.method,
        invoiceCurrency: invoice.currency,
        amount: Math.abs(delta),
        occurredAt: created.occurredAt,
        actorId: input.recordedById ?? null,
      });
    } else {
      await this.treasury.creditPayment(tx, {
        paymentTransactionId: created.id,
        occurredAt: created.occurredAt,
        actorId: input.recordedById ?? null,
        method: input.method,
        invoiceCurrency: invoice.currency,
        amount: delta,
        tendered: input.tendered
          ? {
              local: input.tendered.local,
              foreign: input.tendered.foreign,
              foreignCurrency: input.tendered.foreignCurrency,
            }
          : null,
        changeGiven,
        collectedById: input.collectedById ?? null,
      });
    }

    return {
      receiptNumber,
      transactionId: created.id,
      received: Math.abs(delta),
      paidAmount,
      remaining: Math.max(invoice.amount - paidAmount, 0),
      paymentStatus: fullySettled ? 'PAID' : 'UNPAID',
      changeGiven,
      occurredAt: created.occurredAt.toISOString(),
      replayed: false,
    };
  }
}

/** Money received is more than nothing — checked before any lock is taken. */
function assertPositiveAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError({
      code: 'PAYMENT_AMOUNT_NOT_POSITIVE',
      message: 'The amount received must be greater than zero.',
      details: {
        amount: String(amount ?? ''),
      },
    });
  }
}

/**
 * Whether a row recorded under a retry key is the act a retry now describes
 * (`replay`): the same method, collector and reference, and the same notes —
 * or, with no notes, the same sum. Ids and references compared as written
 * apart from case and edge spaces.
 */
function sameAct(
  row: {
    amount: Prisma.Decimal;
    method: string;
    collectedById: string | null;
    externalRef: string | null;
    tenderedLocal: Prisma.Decimal | null;
    tenderedForeign: Prisma.Decimal | null;
    tenderedForeignCurrency: string | null;
  },
  input: LedgerEntryInput,
): boolean {
  const id = (value: string | null | undefined) => value?.trim().toLowerCase() || null;
  if (row.method !== input.method) return false;
  if (id(row.collectedById) !== id(input.collectedById)) return false;
  if (normaliseExternalRef(row.externalRef) !== normaliseExternalRef(input.externalRef)) return false;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
  if (input.tendered) {
    if (row.tenderedLocal === null) return false;
    return (
      near(Number(row.tenderedLocal), input.tendered.local) &&
      near(Number(row.tenderedForeign ?? 0), input.tendered.foreign ?? 0) &&
      (row.tenderedForeignCurrency ?? null) === (input.tendered.foreignCurrency ?? null)
    );
  }
  return row.tenderedLocal === null && near(Number(row.amount), input.amount);
}

/** A Whish or bank reference as it is compared: trimmed and lower-cased; null when empty. */
function normaliseExternalRef(value: string | null | undefined): string | null {
  return value?.trim().toLowerCase() || null;
}

/** A bill the manager cancelled (0090): it owes nothing and takes nothing. */
function billCancelled(): ConflictError {
  return new ConflictError({
    code: 'PAYMENT_BILL_CANCELLED',
    message: 'This bill has been cancelled; it takes no payment.',
  });
}

/** A citizen's payment claim on this bill awaits a clerk's confirmation or refusal. */
function claimUnderReview(): ConflictError {
  return new ConflictError({
    code: 'PAYMENT_CLAIM_UNDER_REVIEW',
    message: 'A citizen payment claim on this bill is under review; confirm or reject it first.',
  });
}

/** Half a pound for ليرة; a tenth of a cent for dollars and euros alike. */
function toleranceFor(currency: string): number {
  return currency === 'LBP' ? LBP_TOLERANCE : USD_TOLERANCE;
}

/** Whole ليرة for a ليرة bill, cents for any other currency. */
function roundTo(value: number, currency: string): number {
  return currency === 'LBP' ? Math.round(value) : Math.round(value * 100) / 100;
}

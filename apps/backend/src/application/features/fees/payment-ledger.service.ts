import { Injectable } from '@nestjs/common';
import { municipalToday, type PaymentMethod } from '@mechanization/shared-schemas';
import type { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
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
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new ValidationError({
        code: 'PAYMENT_AMOUNT_NOT_POSITIVE',
        message: 'The amount received must be greater than zero.',
        details: {
          amount: String(input.amount ?? ''),
        },
      });
    }

    return this.db.$transaction(async (tx) => {
      const invoice = await this.lock(tx, input.paymentId);

      /*
        Checked behind the lock, so two presses racing each other still meet
        here one after the other and the second finds the first's row.
      */
      if (input.clientRequestId) {
        const earlier = await this.replay(tx, invoice, input.clientRequestId);
        if (earlier) return earlier;
      }

      const outstanding = invoice.amount - invoice.paidAmount;
      if (invoice.paymentStatus === 'PAID' || outstanding <= 0) {
        throw new ConflictError({
          code: 'PAYMENT_ALREADY_PAID',
          message: 'This payment has already been settled.',
        });
      }

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
    });
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
          reversedBy: { select: { id: true } },
        },
      });
      if (!original) throw new NotFoundError({
        code: 'TRANSACTION_NOT_FOUND',
        message: `Transaction ${input.transactionId} was not found`,
      });

      // The unique index on `reversalOfId` enforces this too; checking here
      // turns a constraint violation into a sentence a clerk can act on.
      if (original.reversedBy) {
        throw new ConflictError({
          code: 'TRANSACTION_ALREADY_REVERSED',
          message: 'This transaction has already been reversed.',
        });
      }
      if (Number(original.amount) < 0) {
        throw new ConflictError({
          code: 'TRANSACTION_IS_REVERSAL',
          message: 'A reversal cannot itself be reversed.',
        });
      }

      const invoice = await this.lock(tx, original.paymentId);

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
   * A key used for a different invoice is refused rather than answered: it can
   * only mean a page reused an id, and replaying another bill's receipt would
   * tell the clerk the wrong money was taken.
   */
  private async replay(
    tx: Prisma.TransactionClient,
    invoice: { id: string; amount: number; paidAmount: number; paymentStatus: string },
    clientRequestId: string,
  ): Promise<SettledTotals | null> {
    const row = await tx.paymentTransaction.findUnique({
      where: { clientRequestId },
      select: { id: true, paymentId: true, receiptNumber: true, amount: true, changeGiven: true, occurredAt: true },
    });
    if (!row) return null;
    if (row.paymentId !== invoice.id) {
      throw new ConflictError({
        code: 'PAYMENT_IDEMPOTENCY_KEY_REUSED',
        message: 'This operation’s identifier was already used for another invoice. Reload the page.',
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
      The sequence names its schema too — see `tenant-schema-ref.ts`.

      `payment_receipt_seq` is created once per tenant schema (migration 0017),
      so a bare `nextval('payment_receipt_seq')` resolves through the pooled
      connection's `search_path` exactly as an unqualified table would. The
      failure is worse than a missing table, though: this runs *inside* the
      caller's transaction, behind the invoice's `FOR UPDATE`, so a drifted
      connection either 42P01s a payment that is already half-written, or draws
      from **another municipality's** sequence — and receipt numbers are printed
      on paper handed to a resident.

      `nextval` takes text cast to `regclass`, which accepts a quoted qualified
      name, so the prefix goes inside the literal.
    */
    const [{ nextval }] = await tx.$queryRaw<Array<{ nextval: bigint }>>`
      SELECT nextval('${this.S}payment_receipt_seq') AS nextval
    `;
    const receiptNumber = `RCP-${String(nextval).padStart(6, '0')}`;

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

/** Half a pound for ليرة; a tenth of a cent for dollars and euros alike. */
function toleranceFor(currency: string): number {
  return currency === 'LBP' ? LBP_TOLERANCE : USD_TOLERANCE;
}

/** Whole ليرة for a ليرة bill, cents for any other currency. */
function roundTo(value: number, currency: string): number {
  return currency === 'LBP' ? Math.round(value) : Math.round(value * 100) / 100;
}

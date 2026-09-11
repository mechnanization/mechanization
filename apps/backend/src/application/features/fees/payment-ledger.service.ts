import { Injectable } from '@nestjs/common';
import type { PaymentMethod } from '@mechanization/shared-schemas';
import type { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';

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
}

/** What an invoice's balance looks like after a movement. */
export interface SettledTotals {
  receiptNumber: string;
  transactionId: string;
  received: number;
  paidAmount: number;
  remaining: number;
  paymentStatus: 'PAID' | 'UNPAID';
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
  constructor(private readonly tenantContext: TenantContextService) {}

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
  async record(input: LedgerEntryInput): Promise<SettledTotals> {
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new ValidationError('المبلغ المستلم يجب أن يكون أكبر من صفر', {
        amount: String(input.amount ?? ''),
      });
    }

    return this.db.$transaction(async (tx) => {
      const invoice = await this.lock(tx, input.paymentId);

      const outstanding = invoice.amount - invoice.paidAmount;
      if (invoice.paymentStatus === 'PAID' || outstanding <= 0) {
        throw new ConflictError('هذه الدفعة مسدّدة بالفعل');
      }

      const tolerance = invoice.currency === 'USD' ? USD_TOLERANCE : LBP_TOLERANCE;
      if (input.amount > outstanding + tolerance) {
        throw new ConflictError(
          `المبلغ المستلم (${input.amount.toLocaleString('en-US')}) أكبر من الرصيد المستحق (${outstanding.toLocaleString('en-US')})`,
        );
      }

      return this.append(tx, invoice, input.amount, input);
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
      if (!original) throw new NotFoundError('Transaction', input.transactionId);

      // The unique index on `reversalOfId` enforces this too; checking here
      // turns a constraint violation into a sentence a clerk can act on.
      if (original.reversedBy) {
        throw new ConflictError('هذه الحركة معكوسة بالفعل');
      }
      if (Number(original.amount) < 0) {
        throw new ConflictError('لا يمكن عكس حركة عكسية');
      }

      const invoice = await this.lock(tx, original.paymentId);

      return this.append(
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
  }> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        amount: string;
        paidAmount: string;
        currency: string;
        paymentStatus: string;
        citizenId: string;
      }>
    >`
      SELECT "id", "amount"::text, "paidAmount"::text, "currency",
             "paymentStatus"::text, "citizenId"
        FROM ${this.S}citizen_payments
       WHERE "id" = ${paymentId}::uuid
       FOR UPDATE
    `;

    const row = rows[0];
    if (!row) throw new NotFoundError('Payment', paymentId);

    return {
      id: row.id,
      amount: Number(row.amount),
      paidAmount: Number(row.paidAmount),
      currency: row.currency,
      paymentStatus: row.paymentStatus,
      citizenId: row.citizenId,
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
      },
      select: { id: true },
    });

    const paidAmount = invoice.paidAmount + delta;
    const tolerance = invoice.currency === 'USD' ? USD_TOLERANCE : LBP_TOLERANCE;
    const fullySettled = paidAmount >= invoice.amount - tolerance;

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
        paidAt: fullySettled ? new Date() : null,
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

    return {
      receiptNumber,
      transactionId: created.id,
      received: Math.abs(delta),
      paidAmount,
      remaining: Math.max(invoice.amount - paidAmount, 0),
      paymentStatus: fullySettled ? 'PAID' : 'UNPAID',
    };
  }
}

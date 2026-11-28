
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/tenant-client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { WriteOffBillInput } from '@mechanization/shared-schemas';
import { municipalToday } from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { cancelRequestOfCancelledBill } from '../citizen-requests/cancelled-bill';
import { settleRequestOfWrittenOffBill } from '../citizen-requests/written-off-bill';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { PaymentLedgerService } from './payment-ledger.service';
import { AuditService } from '../audit/audit.service';
import { billWriteOffRefusal, writeOffDecisionInFuture } from './bill-write-off';
import { FeesService } from './fees.service';
import { StaffActor } from '../../common/actor';

/**
 * Why a bill cannot be cancelled now, or null when it can — «إلغاء الفاتورة»'s
 * rule, applied by `cancelBill` to one bill and by `cancelNoticeBatch` to each
 * bill of a notice, so a batch never cancels what one press would refuse: one
 * already cancelled or written off («شطب»); one with a citizen's claim under review (the claim is
 * decided first); one with money on it, paid or part-paid (its receipts are
 * reversed first, so the money's own record is corrected before the debt is).
 */
export function billCancelRefusal(bill: {
  paymentStatus: string;
  paidAmount: number;
}):
  | 'BILL_ALREADY_CANCELLED'
  | 'BILL_ALREADY_WRITTEN_OFF'
  | 'PAYMENT_CLAIM_UNDER_REVIEW'
  | 'BILL_CANCEL_HAS_PAYMENTS'
  | null {
  if (bill.paymentStatus === 'CANCELLED') return 'BILL_ALREADY_CANCELLED';
  // Forgiven by the council (0107): the debt was real, so it is never withdrawn as a mistake after.
  if (bill.paymentStatus === 'WRITTEN_OFF') return 'BILL_ALREADY_WRITTEN_OFF';
  if (bill.paymentStatus === 'PENDING_REVIEW') return 'PAYMENT_CLAIM_UNDER_REVIEW';
  if (bill.paymentStatus === 'PAID' || bill.paidAmount > 0) return 'BILL_CANCEL_HAS_PAYMENTS';
  return null;
}

/**
 * A bill after it is raised, apart from paying it: its ledger and a reversal
 * (`listTransactions`, `reverseTransaction`), «إلغاء الفاتورة» (`cancelBill`)
 * and «شطب» (`writeOffBill`). Each writes its Tier 1 row in the transaction
 * that changes the bill. Out of `FeesService` (audit GOD-04).
 */
@Injectable()
export class BillLifecycleService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
    private readonly ledger: PaymentLedgerService,
    private readonly auditTrail: AuditService,
    private readonly fees: FeesService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  /** Every movement of money against one invoice, oldest first. */
  async listTransactions(paymentId: string) {
    return this.ledger.listForPayment(paymentId);
  }

  /**
   * Reverses one recorded movement, as an opposing ledger row.
   *
   * The correction path a mutable `paidAmount` could not offer: a
   * mis-keyed figure used to be fixed by overwriting the total, which left no
   * trace that the first entry had ever existed.
   */
  async reverseTransaction(input: {
    transactionId: string;
    note?: string;
    actor: StaffActor;
  }) {
    const reversed = await this.ledger.reverse({
      transactionId: input.transactionId,
      recordedById: input.actor.id,
      note: input.note,
      /*
        Tier 1, and new: `payment.reversed` had no listener, so a reversal —
        money taken back out of the register's totals — left no audit row at all.
      */
      audit: (movement) => ({
        actorId: input.actor.id,
        actorType: 'STAFF',
        actorRole: input.actor.role,
        action: 'PAYMENT_REVERSED',
        entityType: 'PaymentTransaction',
        entityId: input.transactionId,
        after: {
          reversalTransactionId: movement.transactionId,
          receiptNumber: movement.receiptNumber,
          amount: movement.received,
          ...(input.note ? { note: input.note } : {}),
        },
      }),
    });

    this.events.emit('payment.reversed', {
      tenantSlug: this.tenantContext.tenantSlug,
      transactionId: input.transactionId,
      receiptNumber: reversed.receiptNumber,
      amount: reversed.received,
      actorId: input.actor.id,
      actorRole: input.actor.role,
    });

    return reversed;
  }

  /**
   * «إلغاء الفاتورة» — the manager withdraws a bill nothing has been paid on
   * (finance audit B3): a notice issued twice, a charge raised in error. Until
   * this a wrong bill could not be withdrawn at all and stayed owed, in every
   * arrears list, for ever.
   *
   * Refused when money is on it (`BILL_CANCEL_HAS_PAYMENTS`): its receipts are
   * reversed first, so the money's own record is corrected before the debt is.
   * Refused while a citizen's claim waits on it (`PAYMENT_CLAIM_UNDER_REVIEW`):
   * the claim is decided first, as for a counter payment. The row is never
   * deleted: it stays on the citizen's record, CANCELLED, with who, when and why
   * (0091), and a Tier 1 row in the same transaction.
   */
  async cancelBill(paymentId: string, reason: string, actor: StaffActor) {
    const { citizenId, cancelledRequest } = await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const [bill] = await this.ledger.lockInvoices(tx, [paymentId]);
      if (!bill) {
        throw new NotFoundError({ code: 'PAYMENT_NOT_FOUND', message: `Payment ${paymentId} was not found` });
      }
      const refusal = billCancelRefusal(bill);
      if (refusal === 'BILL_ALREADY_CANCELLED') {
        throw new ConflictError({ code: 'BILL_ALREADY_CANCELLED', message: 'This bill has already been cancelled.' });
      }
      if (refusal === 'BILL_ALREADY_WRITTEN_OFF') {
        throw new ConflictError({
          code: 'BILL_ALREADY_WRITTEN_OFF',
          message: 'What was left on this bill has been written off; a debt forgiven is not withdrawn after.',
        });
      }
      if (refusal === 'PAYMENT_CLAIM_UNDER_REVIEW') {
        throw new ConflictError({
          code: 'PAYMENT_CLAIM_UNDER_REVIEW',
          message: 'A citizen payment claim on this bill is under review; confirm or reject it first.',
        });
      }
      if (refusal === 'BILL_CANCEL_HAS_PAYMENTS') {
        throw new ConflictError({
          code: 'BILL_CANCEL_HAS_PAYMENTS',
          message: 'Money has been taken on this bill; reverse its receipts before cancelling it.',
          params: { paidAmount: bill.paidAmount, currency: bill.currency },
        });
      }

      const row = await tx.citizenPayment.update({
        where: { id: paymentId },
        data: {
          paymentStatus: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledById: actor.id,
          cancellationReason: reason.trim(),
        },
        select: { invoiceNumber: true, title: true, periodKey: true },
      });
      await this.auditTrail.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role,
        action: 'FEE_BILL_CANCELLED',
        entityType: 'Payment',
        entityId: paymentId,
        before: { paymentStatus: bill.paymentStatus },
        after: {
          citizenId: bill.citizenId,
          invoiceNumber: row.invoiceNumber,
          title: row.title,
          periodKey: row.periodKey,
          amount: bill.amount,
          currency: bill.currency,
          reason: reason.trim(),
        },
      });
      // A municipal request waiting on this bill is cancelled with it (decision of 2026-10-13, 0094).
      const request = await cancelRequestOfCancelledBill(tx, this.auditTrail, { billId: paymentId, actor });
      return { citizenId: bill.citizenId, cancelledRequest: request };
    });

    // For the caches that count what is owed; the audit row is already written.
    this.events.emit('payment.cancelled', {
      tenantSlug: this.tenantContext.tenantSlug,
      paymentId,
      citizenId,
      actorId: actor.id,
      actorRole: actor.role,
    });

    /*
      The request cancelled with the bill, so the page can say so: the manager
      pressed «إلغاء الفاتورة», and a citizen's request ended with it (review of
      PR #122). Null when the bill was no open request's fee.
    */
    return { ...(await this.fees.getPaymentById(paymentId)), cancelledRequest };
  }

  /**
   * «شطب» — what is left on a bill is written off on a council decision
   * (0107, docs/old-debts-plan.md decision 10, docs/finance.md §3.8): an
   * amnesty, a debt too old to collect, one that cannot be collected. The
   * manager's alone (`BILL_WRITE_OFF_ROLES`).
   *
   * Not «إلغاء الفاتورة»: the debt was real. A part-paid bill keeps its
   * receipts and its rest is written off; the amount is never sent, it is what
   * is left when the row is locked, written by the database itself
   * (`"amount" - "paidAmount"`), which holds it there
   * (`paidAmount + writeOffAmount = amount`). No money moves: no ledger row, no
   * wallet. Refused, behind the bill's lock, by `billWriteOffRefusal`. A municipal
   * request's fee may be written off (the owner's decision of 2026-11-21): the
   * forgiven fee leaves nothing to pay, so the request waiting on it goes on to
   * review in the same transaction (`settleRequestOfWrittenOffBill`). A Tier 1 row
   * in the same transaction.
   */
  async writeOffBill(paymentId: string, input: WriteOffBillInput, actor: StaffActor) {
    const today = municipalToday();
    if (writeOffDecisionInFuture(input.decisionDate, today)) {
      throw new ValidationError({
        code: 'BILL_WRITE_OFF_DECISION_IN_FUTURE',
        message: 'The council decision is dated after today.',
        params: { today },
      });
    }
    const reason = input.reason.trim();
    const decisionRef = input.decisionRef.trim();

    const { citizenId, settledRequest } = await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const [bill] = await this.ledger.lockInvoices(tx, [paymentId]);
      if (!bill) {
        throw new NotFoundError({ code: 'PAYMENT_NOT_FOUND', message: `Payment ${paymentId} was not found` });
      }
      const refusal = billWriteOffRefusal(bill);
      if (refusal === 'BILL_ALREADY_WRITTEN_OFF') {
        throw new ConflictError({ code: refusal, message: 'What was left on this bill has already been written off.' });
      }
      if (refusal === 'BILL_ALREADY_CANCELLED') {
        throw new ConflictError({ code: refusal, message: 'This bill has been cancelled; it owes nothing to write off.' });
      }
      if (refusal === 'PAYMENT_CLAIM_UNDER_REVIEW') {
        throw new ConflictError({
          code: refusal,
          message: 'A citizen payment claim on this bill is under review; confirm or reject it first.',
        });
      }
      if (refusal === 'BILL_WRITE_OFF_NOTHING_LEFT') {
        throw new ConflictError({ code: refusal, message: 'Nothing is left on this bill to write off.' });
      }
      const [row] = await tx.$queryRaw<
        Array<{ writeOffAmount: string; invoiceNumber: string | null; title: string; periodKey: string | null }>
      >`
        UPDATE ${this.S}citizen_payments
           SET "paymentStatus" = 'WRITTEN_OFF',
               "writtenOffAt" = now(),
               "writtenOffById" = ${actor.id}::uuid,
               "writeOffAmount" = "amount" - "paidAmount",
               "writeOffReason" = ${reason},
               "writeOffDecisionRef" = ${decisionRef},
               "writeOffDecisionDate" = ${input.decisionDate}::date,
               "updatedAt" = now()
         WHERE "id" = ${paymentId}::uuid
           AND "paymentStatus" IN ('UNPAID', 'OVERDUE')
        RETURNING "writeOffAmount"::text AS "writeOffAmount", "invoiceNumber", "title", "periodKey"
      `;
      if (!row) throw new Error(`writeOffBill: bill ${paymentId} passed the checks under its lock and was not written off`);

      await this.auditTrail.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role,
        action: 'FEE_BILL_WRITTEN_OFF',
        entityType: 'Payment',
        entityId: paymentId,
        before: { paymentStatus: bill.paymentStatus, paidAmount: bill.paidAmount },
        after: {
          citizenId: bill.citizenId,
          invoiceNumber: row.invoiceNumber,
          title: row.title,
          periodKey: row.periodKey,
          amount: bill.amount,
          writeOffAmount: Number(row.writeOffAmount),
          currency: bill.currency,
          reason,
          decisionRef,
          decisionDate: input.decisionDate,
        },
      });
      // A municipal request waiting on this fee goes on to review: nothing is left to pay.
      const request = await settleRequestOfWrittenOffBill(tx, this.auditTrail, { billId: paymentId, actor });
      return { citizenId: bill.citizenId, settledRequest: request };
    });

    // For the caches that count what is owed, as a cancellation; the audit row is already written.
    this.events.emit('payment.cancelled', {
      tenantSlug: this.tenantContext.tenantSlug,
      paymentId,
      citizenId,
      actorId: actor.id,
      actorRole: actor.role,
    });

    // The request moved on with the bill, so the page can say so: null when it was no request's fee.
    return { ...(await this.fees.getPaymentById(paymentId)), settledRequest };
  }
}

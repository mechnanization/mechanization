
import { billOwesNothing, citizenDisplayName } from '@mechanization/shared-schemas';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../../generated/tenant-client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WHISH_GATEWAY } from '../../../domain/interfaces/whish-gateway.interface';
import type { WhishCallback, WhishGateway } from '../../../domain/interfaces/whish-gateway.interface';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { ConflictError, DomainError, NotFoundError } from '../../common/exceptions';
import { PaymentLedgerService } from './payment-ledger.service';
import { AuditService } from '../audit/audit.service';
import { assertNotSharedOnline } from './fees.service';

/**
 * The ledger's refusals that mean a Whish success cannot be banked as it stands
 * (finance audit B5): the bill was settled, part-paid or cancelled another way
 * while the citizen paid online, or the provider's reference is already on a
 * receipt. The money moved at the provider, so the checkout is set aside,
 * MISMATCHED, for a clerk — never retried by the provider for ever.
 */
const WHISH_UNBANKABLE = new Set<string>([
  'PAYMENT_ALREADY_PAID',
  'PAYMENT_EXCEEDS_BALANCE',
  'PAYMENT_BILL_CANCELLED',
  'PAYMENT_EXTERNAL_REF_REUSED',
  'PAYMENT_IDEMPOTENCY_KEY_REUSED',
  // The checkout's own claim was refused and the citizen has declared another transfer since.
  'PAYMENT_CLAIM_UNDER_REVIEW',
]);

/**
 * Online payment through Whish: the checkout a citizen starts, the signed
 * callback, and the checkout set aside when it cannot be banked. Dormant while
 * the gateway is not live (`ONLINE_PAYMENT_UNAVAILABLE`). Out of `FeesService`
 * (audit GOD-01).
 */
@Injectable()
export class WhishCheckoutService {
  private readonly logger = new Logger(WhishCheckoutService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
    @Inject(WHISH_GATEWAY) private readonly whish: WhishGateway,
    private readonly ledger: PaymentLedgerService,
    private readonly auditTrail: AuditService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /**
   * Starts an online Whish payment for one of the signed-in citizen's bills.
   *
   * Ownership is checked here rather than trusted from the route: the payment
   * id comes from the browser, and without this a citizen could open a checkout
   * against somebody else's invoice — which would let them *pay* it, but also
   * disclose its amount and title in the process.
   *
   * Refused with `ONLINE_PAYMENT_UNAVAILABLE` until the gateway is live (below).
   * Once it is, the invoice moves to PENDING_REVIEW while the citizen is at the
   * provider, and reaches PAID only through `settleFromWhishCallback`, behind a
   * verified signature. The sandbox's own path to PENDING_REVIEW — no money, a
   * reference no statement shows — is no longer reachable from here.
   */
  async startWhishCheckout(input: {
    paymentId: string;
    citizenId: string;
    callbackUrl: string;
    returnUrl: string;
  }): Promise<{ redirectUrl: string; pending: boolean }> {
    /*
      Paused until Whish gives the municipality its API (the product owner's
      decision of 2026-10-13, open-decisions §21): citizens pay at the
      municipality. Refused before anything is read or written, because the
      sandbox below is not a payment — it moved the bill to PENDING_REVIEW under
      a WSH- reference of our own that no Whish statement can show, and a bill in
      review cannot be settled at the counter until a clerk rejects the claim.
      Lifts when the gateway is live — `isLive` is `WHISH_API_URL` and
      `WHISH_API_KEY` set, nothing more — which must not happen before
      `postCheckout` is written (the reopening order in open-decisions §21).
    */
    if (!this.whish.isLive) {
      throw new ConflictError({
        code: 'ONLINE_PAYMENT_UNAVAILABLE',
        message: 'Online payment is paused; pay at the municipality.',
      });
    }

    const payment = await this.db.citizenPayment.findUnique({
      where: { id: input.paymentId },
      select: {
        id: true,
        citizenId: true,
        amount: true,
        paidAmount: true,
        currency: true,
        paymentStatus: true,
        unitId: true,
        citizen: { select: { firstName: true, lastName: true, residence: true } },
        // Whether this citizen owes it as one of a shared unit bill's debtors (0099).
        debtors: { where: { citizenId: input.citizenId }, select: { citizenId: true } },
      },
    });

    // A debtor's shared unit bill is theirs to see, and paid at the office (`assertNotSharedOnline`).
    if (payment && payment.unitId && payment.debtors.length > 0) assertNotSharedOnline(payment);
    if (!payment || !payment.citizen || payment.citizenId !== input.citizenId) {
      // Same error for "no such invoice" and "not yours", so the endpoint
      // cannot be used to discover which payment ids exist.
      throw new NotFoundError({
        code: 'PAYMENT_NOT_FOUND',
        message: `Payment ${input.paymentId} was not found`,
      });
    }
    // A bill the manager cancelled (0090) owes nothing and takes no claim.
    if (payment.paymentStatus === 'CANCELLED') {
      throw new ConflictError({
        code: 'PAYMENT_BILL_CANCELLED',
        message: 'This bill has been cancelled; it takes no payment.',
      });
    }
    // Nor does one the council wrote off («شطب», 0107).
    if (payment.paymentStatus === 'WRITTEN_OFF') {
      throw new ConflictError({
        code: 'PAYMENT_BILL_WRITTEN_OFF',
        message: 'What was left on this bill has been written off; it takes no payment.',
      });
    }
    if (payment.paymentStatus === 'PAID') {
      throw new ConflictError({
        code: 'CHARGE_ALREADY_PAID',
        message: 'This charge has already been paid.',
      });
    }
    if (payment.paymentStatus === 'PENDING_REVIEW') {
      throw new ConflictError({
        code: 'CHARGE_PAYMENT_PENDING',
        message: 'A payment on this charge is awaiting confirmation.',
      });
    }

    const outstanding = Number(payment.amount) - Number(payment.paidAmount);
    if (outstanding <= 0) {
      throw new ConflictError({
        code: 'PAYMENT_NOTHING_OUTSTANDING',
        message: 'Nothing is outstanding on this charge.',
      });
    }

    const checkout = await this.whish.createCheckout({
      paymentId: payment.id,
      amount: outstanding,
      currency: payment.currency,
      citizenName: citizenDisplayName(payment.citizen, { middleName: false }),
      callbackUrl: input.callbackUrl,
      returnUrl: input.returnUrl,
    });

    /**
     * The widest race in this service: the guard above was read before an
     * outbound HTTP call to the provider, so hundreds of milliseconds — or
     * seconds — separate the decision from this write. A counter settlement
     * landing in that window would otherwise be pulled back to PENDING_REVIEW.
     *
     * Refusing here leaves a checkout live at the provider that no row
     * references. That is a smaller problem than silently unsettling a paid
     * invoice, but it is not nothing: see docs/open-decisions.md §15 — whether
     * to reserve the row before calling the provider, or cancel the checkout on
     * refusal, is a decision this code does not get to make.
     *
     * All three writes are one transaction. The `whish_checkouts` row is what a
     * callback will be matched against, so an invoice that says PENDING_REVIEW
     * with no checkout row — or a checkout row against an invoice that was never
     * claimed — is a state no callback could be resolved from.
     */
    await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      /*
        Any earlier attempt on this invoice stops being live. A citizen who
        abandons a checkout and starts again leaves the first one open at the
        provider, and `whish_checkouts_one_open_per_payment_key` allows exactly
        one — which is the point: two open checkouts on one bill are two ways to
        pay it and a race to bank the second. The old row is marked, not
        deleted, because the provider may still call back about it and "we know,
        and we stopped waiting" is worth being able to say.
      */
      await tx.whishCheckout.updateMany({
        where: { paymentId: payment.id, state: 'OPEN' },
        data: { state: 'ABANDONED', settledAt: new Date() },
      });

      const { count } = await tx.citizenPayment.updateMany({
        where: {
          id: payment.id,
          citizenId: input.citizenId,
          paymentStatus: { in: ['UNPAID', 'OVERDUE'] },
        },
        data: {
          paymentStatus: 'PENDING_REVIEW',
          paymentMethod: 'WHISH_MONEY',
          // Kept in step for now. `whish_checkouts.externalRef` is what the
          // callback resolves by; this column is the pre-0057 path and is due
          // to be dropped in its own later release.
          whishTransactionRef: checkout.externalRef,
        },
      });

      if (count === 0) {
        throw new ConflictError({
          code: 'CHARGE_CHANGED_DURING_CHECKOUT',
          message: 'This charge changed while the payment was being prepared. Refresh the page.',
        });
      }

      await tx.whishCheckout.create({
        data: {
          externalRef: checkout.externalRef,
          paymentId: payment.id,
          citizenId: input.citizenId,
          // What was quoted to the provider, captured now. Not re-read off the
          // invoice when the callback lands: by then the outstanding balance
          // may have moved, and the callback answers what was asked for.
          amount: outstanding,
          currency: payment.currency,
        },
      });
    });

    return { redirectUrl: checkout.redirectUrl, pending: !this.whish.isLive };
  }

  /**
   * Verifies a raw callback body. Returns `null` unless the signature checks
   * out — the controller has no other way to obtain a payload, so an unsigned
   * body cannot reach `settleFromWhishCallback` by mistake.
   */
  parseWhishCallback(input: { rawBody: string; signature?: string }): WhishCallback | null {
    return this.whish.parseCallback(input);
  }

  /**
   * Applies a verified Whish callback.
   *
   * Idempotent by construction: a callback resolves to one checkout, a closed
   * checkout takes nothing more, and the ledger write is keyed by the checkout's
   * id and closes it in the same transaction — a provider that does not get a
   * 200 retries, and a retry must not take the money twice. A success is banked
   * only for the amount the checkout quoted and only while the bill can take it;
   * otherwise the checkout is set aside, MISMATCHED, for a clerk
   * (`markWhishCheckoutMismatched`). A failed callback returns the invoice to
   * UNPAID and clears the reference, so the citizen can start again rather than
   * being stuck behind a PENDING_REVIEW that will never resolve.
   */
  async settleFromWhishCallback(callback: WhishCallback): Promise<{ applied: boolean }> {
    /*
      Resolved against `whish_checkouts`, not against
      `citizen_payments.whishTransactionRef` (migration 0057).

      That column was the wrong key in two compounding ways: it is not unique,
      and it is mutable — the ledger overwrites it on settlement and the failure
      path nulls it. So the handle the provider holds could stop existing on the
      row it belonged to while the provider still believed it was live.

      The shape that lost money: a citizen abandons checkout #1 and opens #2, so
      the column now names #2. A late *failure* callback for #1 found the
      invoice by that column, cleared it, and #2's own success callback then
      arrived to a reference no row carried — logged as unknown, money never
      banked.

      A checkout row is immutable and uniquely keyed, so a callback resolves to
      exactly one attempt or to none, for ever.
    */
    const checkout = await this.db.whishCheckout.findUnique({
      where: { externalRef: callback.externalRef },
      select: {
        id: true,
        state: true,
        paymentId: true,
        amount: true,
        payment: {
          select: { id: true, amount: true, paidAmount: true, paymentStatus: true, citizenId: true },
        },
      },
    });

    if (!checkout) {
      this.logger.warn(`Whish callback for unknown reference ${callback.externalRef}`);
      return { applied: false };
    }

    // A checkout the citizen walked away from. Recorded rather than deleted
    // precisely so this answer exists: we know about it, and we stopped waiting.
    if (checkout.state !== 'OPEN') {
      this.logger.warn(
        `Whish callback for reference ${callback.externalRef}, which is already ${checkout.state}`,
      );
      return { applied: false };
    }

    const payment = checkout.payment;

    if (!callback.succeeded) {
      // Nothing moved, and a bill settled, cancelled or written off another way has nothing to undo; the
      // attempt is still over, so the checkout is closed rather than left OPEN for ever.
      if (payment.paymentStatus === 'PAID' || billOwesNothing(payment.paymentStatus)) {
        await this.db.whishCheckout.updateMany({
          where: { id: checkout.id, state: 'OPEN' },
          data: { state: 'FAILED', settledAt: new Date(), providerTxnRef: callback.transactionRef ?? null },
        });
        return { applied: false };
      }
      /*
        No money moved, so nothing is written to the ledger. The invoice goes
        back to UNPAID so the citizen can start again rather than being stuck
        behind a PENDING_REVIEW that will never resolve.

        Two predicates on the invoice, not one. `paymentStatus` stops a counter
        settlement that landed since the read above from being overwritten with
        UNPAID — an invoice marked unpaid with the cash already in the drawer.
        `whishTransactionRef` keeps this attempt from clearing a reference a
        newer attempt has since claimed.

        The checkout and the invoice move together: a FAILED checkout beside an
        invoice still sitting at PENDING_REVIEW would leave the citizen unable
        to retry and nothing to explain why.

        This deliberately does not throw. The controller answers 200 to every
        callback so the provider stops retrying, and a 409 here would be an
        infinite retry loop. `{ applied: false }` is already this method's word
        for "nothing to do".
      */
      const count = await runInTenantTransaction(this.tenantContext, async () => {
        const tx = this.db as Prisma.TransactionClient;
        const invoice = await tx.citizenPayment.updateMany({
          where: {
            id: payment.id,
            paymentStatus: 'PENDING_REVIEW',
            whishTransactionRef: callback.externalRef,
          },
          data: { paymentStatus: 'UNPAID', paymentMethod: null, whishTransactionRef: null },
        });

        await tx.whishCheckout.updateMany({
          where: { id: checkout.id, state: 'OPEN' },
          data: {
            state: 'FAILED',
            settledAt: new Date(),
            providerTxnRef: callback.transactionRef ?? null,
          },
        });

        return invoice.count;
      });

      if (count === 0) {
        this.logger.warn(
          `Whish failure callback for ${callback.externalRef} changed nothing: the invoice ` +
            'moved on, or the reference is no longer live.',
        );
      }
      return { applied: count > 0 };
    }

    /*
      The provider is the authority on what it took, and what it took must be
      what was quoted (finance audit B5). `startWhishCheckout` quoted the bill's
      outstanding balance and wrote it on the checkout; a success for any other
      amount — a part payment, a tampered payload, or a bill paid another way
      since — is not banked by arithmetic here but set aside, MISMATCHED, for a
      clerk. Before this the smaller of the two was credited, so an online
      overpayment vanished with nothing owed back to the citizen on record.
    */
    const quoted = Number(checkout.amount);
    if (Math.abs(callback.amount - quoted) >= 0.005) {
      await this.markWhishCheckoutMismatched(checkout, callback, 'AMOUNT_DIFFERS');
      return { applied: false };
    }

    /*
      The money and the checkout's close in one transaction, keyed by the
      checkout: `clientRequestId` is its id, so a provider retry — or two
      deliveries of one callback at the same moment — meets the first receipt in
      the ledger's own replay and never banks it twice. Before this the checkout
      was closed after the ledger committed, in a step whose failure was only
      logged, and a retry in that window credited the bill again.
    */
    let settled: Awaited<ReturnType<PaymentLedgerService['recordIn']>>;
    try {
      settled = await runInTenantTransaction(this.tenantContext, async () => {
        const tx = this.db as Prisma.TransactionClient;
        const movement = await this.ledger.recordIn(tx, {
          paymentId: payment.id,
          amount: quoted,
          method: 'WHISH_MONEY',
          externalRef: callback.transactionRef,
          note: 'دفع إلكتروني عبر Whish',
          // The provider's verified word settles the claim `startWhishCheckout` put the bill under —
          // that claim only: one the citizen declared since is not this money's to decide.
          resolvesClaim: true,
          claimRef: callback.externalRef,
          clientRequestId: checkout.id,
          /*
            A system row: no staff member acted. `actorId` is a uuid column and
            `actorRole` the staff-role enum, so the provider is named in `after`.
          */
          audit: (row) => ({
            actorId: null,
            actorType: 'SYSTEM',
            action: 'PAYMENT_CONFIRMED',
            entityType: 'Payment',
            entityId: payment.id,
            after: {
              citizenId: payment.citizenId,
              confirmed: true,
              provider: 'WHISH',
              receiptNumber: row.receiptNumber,
              amount: row.received,
              externalRef: callback.transactionRef ?? null,
            },
          }),
        });
        await tx.whishCheckout.updateMany({
          where: { id: checkout.id, state: 'OPEN' },
          data: { state: 'SUCCEEDED', settledAt: new Date(), providerTxnRef: callback.transactionRef ?? null },
        });
        return movement;
      });
    } catch (error) {
      // The bill cannot take this money as it stands: a person decides, from the provider's record.
      if (error instanceof DomainError && WHISH_UNBANKABLE.has(error.code)) {
        await this.markWhishCheckoutMismatched(checkout, callback, error.code);
        return { applied: false };
      }
      throw error;
    }
    if (settled.replayed) return { applied: false };

    this.events.emit('payment.reviewed', {
      tenantSlug: this.tenantContext.tenantSlug,
      paymentId: payment.id,
      citizenId: payment.citizenId,
      confirmed: true,
      actorId: null,
      actorRole: 'WHISH',
      receiptNumber: settled.receiptNumber,
    });

    return { applied: true };
  }

  /**
   * A success callback this system cannot bank as it stands (finance audit B5):
   * an amount other than the one quoted, or a bill that was settled, cancelled
   * or part-paid another way while the citizen paid online, or a provider
   * reference already on a receipt. The money moved at the provider, so the
   * checkout is neither FAILED nor SUCCEEDED: it becomes MISMATCHED (0090),
   * nothing is credited, and a Tier 1 row says what came in and why it was not
   * banked. The bill is left as it is — under review when the checkout put it
   * there — and a clerk decides from the provider's record: refuse the claim and
   * record what the provider shows at the counter, under the provider's
   * reference, or refund the citizen. Confirming the claim as it stands is
   * refused (`PAYMENT_CHECKOUT_MISMATCHED`, `review`): it would bank the whole
   * balance for money nobody has matched to it (decision of 2026-10-13).
   *
   * Raises no refusal of its own, so the controller answers 200 and the provider
   * stops retrying; only a database failure escapes, and the provider's retry
   * then reaches this again.
   */
  private async markWhishCheckoutMismatched(
    checkout: { id: string; amount: Prisma.Decimal; paymentId: string },
    callback: WhishCallback,
    reason: string,
  ): Promise<void> {
    await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const { count } = await tx.whishCheckout.updateMany({
        where: { id: checkout.id, state: 'OPEN' },
        data: { state: 'MISMATCHED', settledAt: new Date(), providerTxnRef: callback.transactionRef ?? null },
      });
      if (count === 0) return;
      await this.auditTrail.recordInTransaction({
        actorId: null,
        actorType: 'SYSTEM',
        action: 'WHISH_CHECKOUT_MISMATCHED',
        entityType: 'Payment',
        entityId: checkout.paymentId,
        after: {
          provider: 'WHISH',
          checkoutId: checkout.id,
          externalRef: callback.transactionRef ?? null,
          quoted: Number(checkout.amount),
          reported: callback.amount,
          reason,
        },
      });
    });
    this.logger.warn(`Whish callback for ${callback.externalRef} not banked: ${reason}`);
  }
}

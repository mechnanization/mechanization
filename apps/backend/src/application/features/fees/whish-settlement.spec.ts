import { EventEmitter2 } from '@nestjs/event-emitter';
import { WhishGateway } from '../../../domain/interfaces/whish-gateway.interface';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { ConflictError } from '../../common/exceptions';
import { AuditService } from '../audit/audit.service';
import { FeesService } from './fees.service';
import { PaymentLedgerService } from './payment-ledger.service';

/**
 * Applying a verified Whish callback to an invoice.
 *
 * This wrote `paidAmount: received` — an assignment, correct only for an
 * invoice nothing had been paid against. `startWhishCheckout` quotes the
 * *outstanding* balance to the provider, so on a part-settled invoice the
 * callback carries the balance and the assignment overwrote the counter cash
 * with a figure that excluded it.
 *
 * The arithmetic lives in `PaymentLedgerService`, under a row lock, and is
 * covered against a real database in `payment-ledger.integration.spec.ts` and
 * `finance-audit.integration.spec.ts`. What this file pins is the decision
 * *this* method still owns: which callbacks reach the ledger at all, with what
 * amount and key, and what becomes of one the bill cannot take (finance audit
 * B5): the quoted amount is banked, keyed by the checkout, and the checkout is
 * closed in the same transaction; anything else is set aside, MISMATCHED.
 */

interface Row {
  id: string;
  amount: number;
  paidAmount: number;
  paymentStatus: string;
  citizenId: string;
}

function build(
  row: Row | null,
  {
    updatedCount = 1,
    checkoutState = 'OPEN',
    quoted = row ? row.amount - row.paidAmount : 0,
    recordIn = jest.fn().mockResolvedValue({
      receiptNumber: 'RCP-000001',
      transactionId: 'txn-1',
      received: 0,
      paidAmount: 0,
      remaining: 0,
      paymentStatus: 'PAID',
      replayed: false,
    }),
  }: { updatedCount?: number; checkoutState?: string; quoted?: number; recordIn?: jest.Mock } = {},
) {
  const update = jest.fn().mockResolvedValue({});
  const updateMany = jest.fn().mockResolvedValue({ count: updatedCount });

  /**
   * A callback resolves through `whish_checkouts` (migration 0057) rather than
   * through the mutable `citizenPayment.whishTransactionRef` column, so the
   * fixture hands back a checkout carrying its invoice and the amount it quoted.
   */
  const checkoutUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const whishCheckout = {
    findUnique: jest.fn().mockResolvedValue(
      row
        ? { id: 'checkout-1', state: checkoutState, paymentId: row.id, amount: quoted, payment: row }
        : null,
    ),
    updateMany: checkoutUpdateMany,
  };

  const prisma: Record<string, unknown> = {
    citizenPayment: { findFirst: jest.fn().mockResolvedValue(row), update, updateMany },
    whishCheckout,
  };
  // Every write runs in a transaction; the fixture's is the same client.
  prisma.$transaction = (fn: (tx: unknown) => unknown) => fn(prisma);

  const context = new TenantContextService();
  const recordInTransaction = jest.fn().mockResolvedValue(undefined);
  const service = new FeesService(
    context,
    { emit: jest.fn() } as unknown as EventEmitter2,
    {} as WhishGateway,
    {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      invalidatePrefix: jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisCacheService,
    { recordIn } as unknown as PaymentLedgerService,
    // The settlement's own row is written by the (mocked) ledger; a set-aside writes its own.
    { recordInTransaction } as unknown as AuditService,
  );
  const settle = (input: ReturnType<typeof callback>) =>
    context.run(
      { tenantId: 'tenant-1', tenantSlug: 'albazourieh', schemaName: 'tenant_albazourieh', prisma: prisma as never },
      () => service.settleFromWhishCallback(input),
    );

  return { settle, update, updateMany, recordIn, whishCheckout, recordInTransaction };
}

const UNTOUCHED: Row = {
  id: 'payment-1',
  amount: 100_000,
  paidAmount: 0,
  paymentStatus: 'PENDING_REVIEW',
  citizenId: 'citizen-1',
};

/** The provider confirming it took `amount`. */
function callback(amount: number, succeeded = true) {
  return { externalRef: 'WSH-ABC', transactionRef: 'TX-1', amount, succeeded };
}

describe('settleFromWhishCallback — a payment adds to what was already banked', () => {
  it('banks the balance the checkout quoted on a part-settled invoice, not the face value', async () => {
    // 50,000 already in the drawer; the citizen settles the balance online.
    const { settle, recordIn } = build({ ...UNTOUCHED, paidAmount: 50_000 });

    await settle(callback(50_000));

    expect(recordIn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        paymentId: 'payment-1',
        amount: 50_000,
        method: 'WHISH_MONEY',
        externalRef: 'TX-1',
      }),
    );
  });

  it('records the full amount on an untouched invoice', async () => {
    const { settle, recordIn } = build(UNTOUCHED);
    await settle(callback(100_000));
    expect(recordIn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: 100_000 }));
  });

  it('settles the claim the checkout put the bill under, as the ledger requires', async () => {
    // Without the flag the ledger refuses a write on a PENDING_REVIEW bill (PAYMENT_CLAIM_UNDER_REVIEW).
    const { settle, recordIn } = build(UNTOUCHED);
    await settle(callback(100_000));
    expect(recordIn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resolvesClaim: true }));
  });

  it('keys the ledger write by the checkout, so a retry meets the first receipt', async () => {
    const { settle, recordIn } = build(UNTOUCHED);
    await settle(callback(100_000));
    expect(recordIn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ clientRequestId: 'checkout-1' }));
  });

  it('sets aside an amount other than the one quoted, banking nothing', async () => {
    // The old code banked the smaller of the two; the rest of an overpayment vanished.
    const { settle, recordIn, whishCheckout, recordInTransaction } = build(
      { ...UNTOUCHED, paidAmount: 70_000 },
      { quoted: 30_000 },
    );
    await expect(settle(callback(999_999))).resolves.toEqual({ applied: false });
    expect(recordIn).not.toHaveBeenCalled();
    expect(whishCheckout.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'checkout-1', state: 'OPEN' }, data: expect.objectContaining({ state: 'MISMATCHED' }) }),
    );
    expect(recordInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WHISH_CHECKOUT_MISMATCHED',
        after: expect.objectContaining({ quoted: 30_000, reported: 999_999, reason: 'AMOUNT_DIFFERS' }),
      }),
    );
  });

  it('sets aside a success for a bill settled another way while the checkout was open', async () => {
    const recordIn = jest
      .fn()
      .mockRejectedValue(new ConflictError({ code: 'PAYMENT_ALREADY_PAID', message: 'settled' }));
    const { settle, whishCheckout } = build({ ...UNTOUCHED, paymentStatus: 'PAID' }, { quoted: 100_000, recordIn });
    await expect(settle(callback(100_000))).resolves.toEqual({ applied: false });
    expect(whishCheckout.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'MISMATCHED' }) }),
    );
  });

  it('writes nothing to the ledger for a failed payment', async () => {
    const { settle, recordIn, updateMany } = build(UNTOUCHED);

    const result = await settle(callback(100_000, /* succeeded */ false));

    // No money moved, so there is no movement to record — but the invoice is
    // released so the citizen can try again.
    expect(recordIn).not.toHaveBeenCalled();
    expect(result).toEqual({ applied: true });
    expect(updateMany.mock.calls[0][0].data).toMatchObject({
      paymentStatus: 'UNPAID',
      paymentMethod: null,
      whishTransactionRef: null,
    });
  });

  it('releases the invoice only while it is still this attempt that holds it', async () => {
    /*
      The row is found by `whishTransactionRef` but updated by `id`, so both
      have to be in the predicate. Without the status, a counter settlement
      landing between the read and the write is dragged back to UNPAID with
      the cash already in the drawer. Without the reference, a late failure
      for an abandoned attempt #1 clears the live reference attempt #2 just
      claimed — and attempt #2's own callback then arrives to an unknown
      reference with its money never banked.
    */
    const { settle, updateMany } = build(UNTOUCHED);

    await settle(callback(100_000, false));

    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: 'payment-1',
      paymentStatus: 'PENDING_REVIEW',
      whishTransactionRef: 'WSH-ABC',
    });
  });

  it('does not throw when a failure callback matches nothing', async () => {
    /*
      The controller answers 200 to every callback so the provider stops
      retrying. A refusal thrown from here would be a 409, and a 409 is an
      infinite retry loop — so "changed nothing" has to come back as data.
    */
    const { settle, recordIn } = build(UNTOUCHED, { updatedCount: 0 });

    await expect(settle(callback(100_000, false))).resolves.toEqual({ applied: false });
    expect(recordIn).not.toHaveBeenCalled();
  });

  it('declines a callback for a checkout the citizen walked away from', async () => {
    /*
      The reason `whish_checkouts` keeps ABANDONED rows instead of deleting
      them. A citizen who abandons attempt #1 and opens attempt #2 leaves #1
      live at the provider; when its late callback arrives, the answer has to be
      "we know about this one, and we stopped waiting" — not "unknown
      reference", which is indistinguishable from a real lost payment.
    */
    const { settle, recordIn } = build(UNTOUCHED, { checkoutState: 'ABANDONED' });

    await expect(settle(callback(100_000))).resolves.toEqual({ applied: false });
    expect(recordIn).not.toHaveBeenCalled();
  });

  it('closes the checkout row with the money, in the same transaction', async () => {
    const { settle, whishCheckout } = build(UNTOUCHED);

    await settle(callback(100_000));

    expect(whishCheckout.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'checkout-1', state: 'OPEN' },
        data: expect.objectContaining({ state: 'SUCCEEDED', providerTxnRef: 'TX-1' }),
      }),
    );
  });

  it('ignores a retry of a callback already applied: its checkout is closed', async () => {
    // A provider that does not get a 200 retries; a retry must not bank twice.
    const { settle, recordIn } = build({ ...UNTOUCHED, paymentStatus: 'PAID' }, { checkoutState: 'SUCCEEDED' });

    await expect(settle(callback(100_000))).resolves.toEqual({ applied: false });
    expect(recordIn).not.toHaveBeenCalled();
  });

  it('reports nothing applied when the ledger answers from the checkout’s key', async () => {
    // Two deliveries at once: the second meets the first receipt in the ledger's replay.
    const recordIn = jest.fn().mockResolvedValue({ receiptNumber: 'RCP-000001', replayed: true });
    const { settle } = build(UNTOUCHED, { recordIn });
    await expect(settle(callback(100_000))).resolves.toEqual({ applied: false });
  });

  it('ignores a callback for a reference this municipality does not hold', async () => {
    const { settle, recordIn } = build(null);

    await expect(settle(callback(100_000))).resolves.toEqual({ applied: false });
    expect(recordIn).not.toHaveBeenCalled();
  });
});

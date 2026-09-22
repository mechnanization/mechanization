import { EventEmitter2 } from '@nestjs/event-emitter';
import { WhishGateway } from '../../../domain/interfaces/whish-gateway.interface';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { FeesService } from './fees.service';
import { PaymentLedgerService } from './payment-ledger.service';

/**
 * Applying a verified Whish callback to an invoice.
 *
 * This wrote `paidAmount: received` — an assignment, correct only for an
 * invoice nothing had been paid against. `startWhishCheckout` quotes the
 * *outstanding* balance to the provider, so on a part-settled invoice the
 * callback carries the balance and the assignment overwrote the counter cash
 * with a figure that excluded it: 50,000 taken in notes plus 50,000 taken
 * online left a register showing 50,000 still owed, and a citizen who had paid
 * in full still being chased for it.
 *
 * The arithmetic now lives in `PaymentLedgerService`, under a row lock, and is
 * covered against a real database in `payment-ledger.integration.spec.ts`.
 * What this file pins is the decision *this* method still owns: which
 * callbacks reach the ledger at all, and with what amount.
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
  }: { updatedCount?: number; checkoutState?: string } = {},
) {
  const update = jest.fn().mockResolvedValue({});
  const updateMany = jest.fn().mockResolvedValue({ count: updatedCount });
  const record = jest.fn().mockResolvedValue({
    receiptNumber: 'RCP-000001',
    transactionId: 'txn-1',
    received: 0,
    paidAmount: 0,
    remaining: 0,
    paymentStatus: 'PAID',
  });

  /**
   * A callback now resolves through `whish_checkouts` (migration 0057) rather
   * than through the mutable `citizenPayment.whishTransactionRef` column, so
   * the fixture hands back a checkout carrying its invoice.
   */
  const checkoutUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const whishCheckout = {
    findUnique: jest.fn().mockResolvedValue(
      row ? { id: 'checkout-1', state: checkoutState, paymentId: row.id, payment: row } : null,
    ),
    updateMany: checkoutUpdateMany,
  };

  const prisma: Record<string, unknown> = {
    citizenPayment: { findFirst: jest.fn().mockResolvedValue(row), update, updateMany },
    whishCheckout,
  };
  // The failure path writes the invoice and the checkout together.
  prisma.$transaction = (fn: (tx: unknown) => unknown) => fn(prisma);

  const service = new FeesService(
    {
      prisma,
      tenantSlug: 'albazourieh',
      tenantId: 'tenant-1',
    } as unknown as TenantContextService,
    { emit: jest.fn() } as unknown as EventEmitter2,
    {} as WhishGateway,
    {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      invalidatePrefix: jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisCacheService,
    { record } as unknown as PaymentLedgerService,
  );

  return { service, update, updateMany, record, whishCheckout };
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
  it('records only the balance still owed, not the invoice face value', async () => {
    // 50,000 already in the drawer; the citizen settles the balance online.
    // The old code assigned the callback amount over the top of the cash.
    const { service, record } = build({ ...UNTOUCHED, paidAmount: 50_000 });

    await service.settleFromWhishCallback(callback(50_000));

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: 'payment-1',
        amount: 50_000,
        method: 'WHISH_MONEY',
        externalRef: 'TX-1',
      }),
    );
  });

  it('records the full amount on an untouched invoice', async () => {
    const { service, record } = build(UNTOUCHED);
    await service.settleFromWhishCallback(callback(100_000));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ amount: 100_000 }));
  });

  it('caps against the outstanding balance, not the face value', async () => {
    // The old ceiling was the invoice total, which on a part-settled row is
    // larger than what is actually owed.
    const { service, record } = build({ ...UNTOUCHED, paidAmount: 70_000 });
    await service.settleFromWhishCallback(callback(999_999));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ amount: 30_000 }));
  });

  it('writes nothing to the ledger for a failed payment', async () => {
    const { service, record, updateMany } = build(UNTOUCHED);

    const result = await service.settleFromWhishCallback(callback(100_000, /* succeeded */ false));

    // No money moved, so there is no movement to record — but the invoice is
    // released so the citizen can try again.
    expect(record).not.toHaveBeenCalled();
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
    const { service, updateMany } = build(UNTOUCHED);

    await service.settleFromWhishCallback(callback(100_000, false));

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
    const { service, record } = build(UNTOUCHED, { updatedCount: 0 });

    await expect(
      service.settleFromWhishCallback(callback(100_000, false)),
    ).resolves.toEqual({ applied: false });
    expect(record).not.toHaveBeenCalled();
  });

  it('declines a callback for a checkout the citizen walked away from', async () => {
    /*
      The reason `whish_checkouts` keeps ABANDONED rows instead of deleting
      them. A citizen who abandons attempt #1 and opens attempt #2 leaves #1
      live at the provider; when its late callback arrives, the answer has to be
      "we know about this one, and we stopped waiting" — not "unknown
      reference", which is indistinguishable from a real lost payment.
    */
    const { service, record } = build(UNTOUCHED, { checkoutState: 'ABANDONED' });

    await expect(service.settleFromWhishCallback(callback(100_000))).resolves.toEqual({
      applied: false,
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('closes the checkout row when the money is banked', async () => {
    const { service, whishCheckout } = build(UNTOUCHED);

    await service.settleFromWhishCallback(callback(100_000));

    expect(whishCheckout.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'checkout-1', state: 'OPEN' },
        data: expect.objectContaining({ state: 'SUCCEEDED', providerTxnRef: 'TX-1' }),
      }),
    );
  });

  it('ignores a retry of a callback already applied', async () => {
    // A provider that does not get a 200 retries; a retry must not bank twice.
    const { service, record } = build({ ...UNTOUCHED, paymentStatus: 'PAID' });

    await expect(service.settleFromWhishCallback(callback(100_000))).resolves.toEqual({
      applied: false,
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('ignores a callback for a reference this municipality does not hold', async () => {
    const { service, record } = build(null);

    await expect(service.settleFromWhishCallback(callback(100_000))).resolves.toEqual({
      applied: false,
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('ignores a callback against an invoice with nothing left to pay', async () => {
    const { service, record } = build({ ...UNTOUCHED, paidAmount: 100_000 });

    await expect(service.settleFromWhishCallback(callback(50_000))).resolves.toEqual({
      applied: false,
    });
    expect(record).not.toHaveBeenCalled();
  });
});

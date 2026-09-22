import { EventEmitter2 } from '@nestjs/event-emitter';
import { WhishGateway } from '../../../domain/interfaces/whish-gateway.interface';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { ConflictError } from '../../common/exceptions';
import { FeesService } from './fees.service';
import { PaymentLedgerService } from './payment-ledger.service';

/**
 * Status transitions that happen *outside* the payment ledger.
 *
 * `PaymentLedgerService` holds the invoice with `SELECT … FOR UPDATE` and
 * re-reads every value it decides on under that lock, so its writes need no
 * predicate. These four paths move no money and take no lock: they read the
 * row, decide, and write. Between those two steps a clerk can take cash at the
 * counter and the ledger can settle the invoice in full.
 *
 * What that cost, before the predicates existed, was never money — the ledger
 * stops the money being taken twice. It was the *status*, and the loss does not
 * self-correct: an invoice with `paidAmount == amount`, a real
 * `payment_transactions` row and a printed receipt, sitting in the register as
 * UNPAID. The clerk cannot clear it forward either, because confirming it
 * computes an outstanding balance of zero and refuses.
 *
 * So each test here forces the interleaving explicitly — `updateMany` matching
 * zero rows *is* "somebody settled it while you were deciding". Nothing here
 * races real threads, so nothing here can flake.
 */

interface Row {
  id: string;
  citizenId: string;
  amount: number;
  paidAmount: number;
  currency?: string;
  paymentStatus: string;
}

const INVOICE: Row = {
  id: 'payment-1',
  citizenId: 'citizen-1',
  amount: 100_000,
  paidAmount: 0,
  currency: 'LBP',
  paymentStatus: 'UNPAID',
};

function build(row: Row | null, { updatedCount = 1 }: { updatedCount?: number } = {}) {
  const update = jest.fn().mockResolvedValue({});
  const updateMany = jest.fn().mockResolvedValue({ count: updatedCount });
  const record = jest.fn().mockResolvedValue({
    receiptNumber: 'RCP-000001',
    transactionId: 'txn-1',
    received: 100_000,
    paidAmount: 100_000,
    remaining: 0,
    paymentStatus: 'PAID',
  });

  const withCitizen = row && { ...row, citizen: { firstName: 'سارة', lastName: 'خليل' } };

  // `startWhishCheckout` claims the invoice and opens a `whish_checkouts` row
  // in one transaction (migration 0057), so the fixture carries both.
  const checkoutCreate = jest.fn().mockResolvedValue({ id: 'checkout-1' });
  const checkoutUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

  const prisma: Record<string, unknown> = {
    citizenPayment: {
      findFirst: jest.fn().mockResolvedValue(row),
      findUnique: jest.fn().mockResolvedValue(withCitizen),
      update,
      updateMany,
    },
    whishCheckout: { create: checkoutCreate, updateMany: checkoutUpdateMany },
  };
  prisma.$transaction = (fn: (tx: unknown) => unknown) => fn(prisma);

  const createCheckout = jest.fn().mockResolvedValue({
    redirectUrl: 'https://whish.example/pay/abc',
    externalRef: 'WSH-NEW',
  });

  const service = new FeesService(
    {
      prisma,
      tenantSlug: 'albazourieh',
      tenantId: 'tenant-1',
    } as unknown as TenantContextService,
    { emit: jest.fn() } as unknown as EventEmitter2,
    { createCheckout, isLive: true } as unknown as WhishGateway,
    {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      invalidatePrefix: jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisCacheService,
    { record } as unknown as PaymentLedgerService,
  );

  return { service, update, updateMany, record, createCheckout, checkoutCreate, checkoutUpdateMany };
}

describe('declare', () => {
  const input = { paymentId: 'payment-1', citizenId: 'citizen-1', method: 'WHISH_MONEY' as const };

  it('carries the status and the owner into the predicate', async () => {
    const { service, updateMany } = build(INVOICE);

    await service.declare(input);

    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: 'payment-1',
      citizenId: 'citizen-1',
      paymentStatus: { in: ['UNPAID', 'OVERDUE'] },
    });
    expect(updateMany.mock.calls[0][0].data).toMatchObject({
      paymentStatus: 'PENDING_REVIEW',
    });
  });

  it('refuses when a clerk settled the invoice while the citizen was typing', async () => {
    // The pre-read still saw UNPAID; the row moved before the write landed.
    const { service } = build(INVOICE, { updatedCount: 0 });

    await expect(service.declare(input)).rejects.toBeInstanceOf(ConflictError);
  });

  it('still answers the ordinary cases from the pre-read, not from the predicate', async () => {
    /*
      The read before the write is what separates "not yours" and the two
      states a citizen can act on from the genuine race. Losing it would turn
      three actionable messages into one generic conflict.
    */
    const { service, updateMany } = build({ ...INVOICE, paymentStatus: 'PAID' });

    await expect(service.declare(input)).rejects.toThrow('مسدّدة بالفعل');
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('review — refusing a claim', () => {
  const refuse = {
    paymentId: 'payment-1',
    confirmed: false,
    actor: { id: 'staff-1', role: 'ACCOUNTANT' },
  };

  it('only releases a claim that is still pending review', async () => {
    const { service, updateMany } = build({ ...INVOICE, paymentStatus: 'PENDING_REVIEW' });

    await service.review(refuse);

    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: 'payment-1',
      paymentStatus: 'PENDING_REVIEW',
    });
    expect(updateMany.mock.calls[0][0].data).toMatchObject({
      paymentStatus: 'UNPAID',
      paymentMethod: null,
      whishTransactionRef: null,
      reviewedById: 'staff-1',
    });
  });

  it('refuses rather than marking a settled invoice unpaid', async () => {
    /*
      The worst of the four. Clerk A decides the transfer never arrived while
      clerk B takes the cash; without the predicate, A's refusal lands on a
      PAID row and the receipt in the citizen's hand becomes the only record
      that the money was ever received.
    */
    const { service } = build({ ...INVOICE, paymentStatus: 'PENDING_REVIEW' }, { updatedCount: 0 });

    await expect(service.review(refuse)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('review — confirming a claim', () => {
  it('leaves the status to the ledger and writes only its own metadata', async () => {
    /*
      A regression guard, not a fix. The confirm branch is already safe: the
      status transition happens inside `ledger.record`, under the row lock.
      Adding a status predicate to the metadata write here would refuse to
      record who reviewed a claim whenever the row had legitimately just moved
      — so this pins that the write stays unconditional and status-free.
    */
    const { service, update, record } = build({
      ...INVOICE,
      paymentStatus: 'PENDING_REVIEW',
    });

    await service.review({
      paymentId: 'payment-1',
      confirmed: true,
      note: 'حوالة مؤكدة',
      actor: { id: 'staff-1', role: 'ACCOUNTANT' },
    });

    expect(record).toHaveBeenCalled();
    const write = update.mock.calls[0][0];
    expect(write.where).toEqual({ id: 'payment-1' });
    expect(write.data).not.toHaveProperty('paymentStatus');
    expect(write.data).toMatchObject({ reviewedById: 'staff-1', reviewNote: 'حوالة مؤكدة' });
  });
});

describe('startWhishCheckout', () => {
  const input = {
    paymentId: 'payment-1',
    citizenId: 'citizen-1',
    callbackUrl: 'https://api.example/callback',
    returnUrl: 'https://portal.example/done',
  };

  it('claims the invoice under the status it was quoted against', async () => {
    const { service, updateMany } = build(INVOICE);

    await service.startWhishCheckout(input);

    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: 'payment-1',
      citizenId: 'citizen-1',
      paymentStatus: { in: ['UNPAID', 'OVERDUE'] },
    });
    expect(updateMany.mock.calls[0][0].data).toMatchObject({
      paymentStatus: 'PENDING_REVIEW',
      paymentMethod: 'WHISH_MONEY',
      whishTransactionRef: 'WSH-NEW',
    });
  });

  it('opens a checkout row, and retires any earlier one first', async () => {
    /*
      The row a callback will be matched against (migration 0057), written in
      the same transaction that claims the invoice. Earlier attempts are marked
      ABANDONED rather than deleted: the provider may still call back about one,
      and `whish_checkouts_one_open_per_payment_key` allows only one live.
    */
    const { service, checkoutCreate, checkoutUpdateMany } = build(INVOICE);

    await service.startWhishCheckout(input);

    expect(checkoutUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { paymentId: 'payment-1', state: 'OPEN' },
        data: expect.objectContaining({ state: 'ABANDONED' }),
      }),
    );
    expect(checkoutCreate.mock.calls[0][0].data).toMatchObject({
      externalRef: 'WSH-NEW',
      paymentId: 'payment-1',
      citizenId: 'citizen-1',
      // The outstanding balance quoted to the provider, not the face value.
      amount: 100_000,
      currency: 'LBP',
    });
  });

  it('does not open a checkout row when the claim is refused', async () => {
    const { service, checkoutCreate } = build(INVOICE, { updatedCount: 0 });

    await expect(service.startWhishCheckout(input)).rejects.toBeInstanceOf(ConflictError);
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it('refuses after the provider call, which cannot be un-made', async () => {
    /*
      The widest window of the four: the guard is read before an outbound HTTP
      call, so the decision and the write are separated by a network
      round-trip. Refusing here is right — better an orphaned checkout at the
      provider than a settled invoice quietly pulled back to PENDING_REVIEW —
      but the checkout really does exist by then, and this test says so out
      loud. What to do about that orphan is recorded in docs/open-decisions.md.
    */
    const { service, createCheckout } = build(INVOICE, { updatedCount: 0 });

    await expect(service.startWhishCheckout(input)).rejects.toBeInstanceOf(ConflictError);
    expect(createCheckout).toHaveBeenCalledTimes(1);
  });
});

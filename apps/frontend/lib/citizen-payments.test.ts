import { describe, expect, it } from 'vitest';
import { billFigure, citizenPaymentTotals, isPartlyPaid, isPayable } from './citizen-payments';

const bill = (paymentStatus: string, amount: number, paidAmount: number) => ({
  paymentStatus,
  amount,
  paidAmount,
  remaining: Math.max(amount - paidAmount, 0),
});

describe('citizenPaymentTotals', () => {
  it('owes what is left on a part-paid bill, not its face value', () => {
    const totals = citizenPaymentTotals([bill('UNPAID', 300_000, 100_000), bill('OVERDUE', 50_000, 0)]);
    expect(totals.outstanding).toBe(250_000);
  });

  it('counts part-payments on open bills as paid, beside the settled ones', () => {
    const totals = citizenPaymentTotals([bill('UNPAID', 300_000, 100_000), bill('PAID', 80_000, 80_000)]);
    expect(totals.paid).toBe(180_000);
  });

  it('leaves a claimed bill out of what is owed — it waits on a clerk', () => {
    const totals = citizenPaymentTotals([bill('PENDING_REVIEW', 200_000, 50_000)]);
    expect(totals.outstanding).toBe(0);
    // What was taken at the counter before the claim is still paid.
    expect(totals.paid).toBe(50_000);
  });

  it('is zero for no bills', () => {
    expect(citizenPaymentTotals([])).toEqual({ outstanding: 0, paid: 0 });
  });
});

describe('billFigure', () => {
  it('shows what is left on an open bill', () => {
    expect(billFigure(bill('UNPAID', 300_000, 100_000))).toBe(200_000);
    expect(billFigure(bill('PENDING_REVIEW', 300_000, 100_000))).toBe(200_000);
  });

  it('shows the face value once settled', () => {
    expect(billFigure(bill('PAID', 300_000, 300_000))).toBe(300_000);
  });
});

describe('isPartlyPaid and isPayable', () => {
  it('marks an open bill with money on it, never a settled one', () => {
    expect(isPartlyPaid(bill('OVERDUE', 300_000, 1))).toBe(true);
    expect(isPartlyPaid(bill('UNPAID', 300_000, 0))).toBe(false);
    expect(isPartlyPaid(bill('PAID', 300_000, 300_000))).toBe(false);
  });

  it('lets the citizen pay an unpaid or overdue bill only', () => {
    expect(['UNPAID', 'OVERDUE', 'PENDING_REVIEW', 'PAID'].map((status) => isPayable({ paymentStatus: status }))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

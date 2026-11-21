import { billOwesNothing, billRemaining } from '@mechanization/shared-schemas';
import { billWriteOffRefusal, writeOffDecisionInFuture, writeOffView } from './bill-write-off';

describe('billWriteOffRefusal («شطب»)', () => {
  const open = { paymentStatus: 'UNPAID', amount: 100, paidAmount: 0 };

  it('writes off an unpaid bill, and the rest of a part-paid one', () => {
    expect(billWriteOffRefusal(open)).toBeNull();
    expect(billWriteOffRefusal({ ...open, paidAmount: 40 })).toBeNull();
  });

  it('refuses one already written off', () => {
    expect(billWriteOffRefusal({ ...open, paymentStatus: 'WRITTEN_OFF', paidAmount: 40 })).toBe('BILL_ALREADY_WRITTEN_OFF');
  });

  it('refuses a cancelled bill: it owes nothing to forgive', () => {
    expect(billWriteOffRefusal({ ...open, paymentStatus: 'CANCELLED' })).toBe('BILL_ALREADY_CANCELLED');
  });

  it('refuses while a citizen’s claim waits, as a cancellation does', () => {
    expect(billWriteOffRefusal({ ...open, paymentStatus: 'PENDING_REVIEW' })).toBe('PAYMENT_CLAIM_UNDER_REVIEW');
  });

  it('refuses a paid bill, and one with nothing left whatever its status says', () => {
    expect(billWriteOffRefusal({ ...open, paymentStatus: 'PAID', paidAmount: 100 })).toBe('BILL_WRITE_OFF_NOTHING_LEFT');
    expect(billWriteOffRefusal({ ...open, paidAmount: 100 })).toBe('BILL_WRITE_OFF_NOTHING_LEFT');
  });
});

describe('writeOffDecisionInFuture', () => {
  it('takes today and earlier, and refuses a later day', () => {
    expect(writeOffDecisionInFuture('2026-11-21', '2026-11-21')).toBe(false);
    expect(writeOffDecisionInFuture('2026-01-05', '2026-11-21')).toBe(false);
    expect(writeOffDecisionInFuture('2026-11-22', '2026-11-21')).toBe(true);
  });
});

describe('writeOffView', () => {
  it('is null on a bill not written off', () => {
    expect(
      writeOffView({ writtenOffAt: null, writeOffAmount: null, writeOffReason: null, writeOffDecisionRef: null, writeOffDecisionDate: null }),
    ).toBeNull();
  });

  it('reads the decision day as the day it was stored', () => {
    expect(
      writeOffView({
        writtenOffAt: new Date('2026-11-21T09:00:00.000Z'),
        writeOffAmount: { toString: () => '70000.00' },
        writeOffReason: 'عفو',
        writeOffDecisionRef: '45/2026',
        writeOffDecisionDate: new Date('2026-11-01T00:00:00.000Z'),
      }),
    ).toEqual({ at: '2026-11-21T09:00:00.000Z', amount: 70_000, reason: 'عفو', decisionRef: '45/2026', decisionDate: '2026-11-01' });
  });
});

describe('billRemaining (shared)', () => {
  it('is nothing on a cancelled or written-off bill, whatever its amounts say', () => {
    expect(billOwesNothing('WRITTEN_OFF')).toBe(true);
    expect(billOwesNothing('CANCELLED')).toBe(true);
    expect(billOwesNothing('UNPAID')).toBe(false);
    // On a written-off bill amount − paid is the sum forgiven, never a sum owed.
    expect(billRemaining({ paymentStatus: 'WRITTEN_OFF', amount: 100, paidAmount: 30 })).toBe(0);
    expect(billRemaining({ paymentStatus: 'UNPAID', amount: 100, paidAmount: 30 })).toBe(70);
    expect(billRemaining({ paymentStatus: 'UNPAID', amount: 100, paidAmount: 120 })).toBe(0);
  });
});

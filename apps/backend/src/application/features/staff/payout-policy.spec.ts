import { payoutAllowance, payoutRefusal } from '@mechanization/shared-schemas';

/*
  The payout rule, as the server enforces it: never more than is owed.

  Two rules were removed by decision: the $100 lifetime threshold on
  2026-09-27, which had stopped four of six officers from being paid anything,
  and the $50 weekly cap on 2026-10-04. The first two tests below are the ones
  that used to assert them, inverted: a small balance is payable in full, and so
  is a large one, in a single payout.
*/
describe('payoutAllowance', () => {
  it('pays a small balance in full — there is no lifetime threshold', () => {
    const allowance = payoutAllowance({ pendingBalance: 8 });
    expect(allowance).toEqual({ allowed: true, reason: 'OK', owed: 8 });
    expect(payoutRefusal(allowance, 8)).toBeNull();
    // Still never more than is owed.
    expect(payoutRefusal(allowance, 8.01)).not.toBeNull();
  });

  it('pays more than $50 in one payout — there is no weekly cap', () => {
    const allowance = payoutAllowance({ pendingBalance: 120 });
    expect(allowance).toEqual({ allowed: true, reason: 'OK', owed: 120 });
    expect(payoutRefusal(allowance, 120)).toBeNull();
    expect(payoutRefusal(allowance, 120.01)).not.toBeNull();
  });

  it('never allows more than is owed', () => {
    const allowance = payoutAllowance({ pendingBalance: 12.5 });
    expect(payoutRefusal(allowance, 12.5)).toBeNull();
    expect(payoutRefusal(allowance, 13)).toContain('الرصيد المستحق');
  });

  it('refuses when nothing is owed, whatever the amount', () => {
    const allowance = payoutAllowance({ pendingBalance: 0 });
    expect(allowance).toEqual({ allowed: false, reason: 'NOTHING_OWED', owed: 0 });
    expect(payoutRefusal(allowance, 0.01)).toBe('لا يوجد رصيد مستحق لهذا المفتش.');
  });

  it('reads a negative balance as nothing owed', () => {
    expect(payoutAllowance({ pendingBalance: -1 })).toMatchObject({
      allowed: false,
      reason: 'NOTHING_OWED',
      owed: 0,
    });
  });

  it('compares money in cents, so float drift cannot refuse an exact payout', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in floating point.
    expect(payoutRefusal(payoutAllowance({ pendingBalance: 0.1 + 0.2 }), 0.3)).toBeNull();
    expect(payoutRefusal(payoutAllowance({ pendingBalance: 0.3 }), 0.1 + 0.2)).toBeNull();
  });
});

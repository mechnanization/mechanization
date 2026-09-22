import { payoutAllowance, payoutRefusal } from '@mechanization/shared-schemas';

/*
  The payout rule, as the server enforces it: nothing before $100 of lifetime
  earnings, then at most $50 per week — weeks counted in sevens of days from the
  first payout — and never more than is owed.
*/
const noon = (day: string) => `${day}T12:00:00.000Z`;

describe('payoutAllowance', () => {
  it('refuses anything before lifetime earnings reach $100', () => {
    const allowance = payoutAllowance({
      totalEarnings: 99,
      pendingBalance: 99,
      payouts: [],
      paidAt: noon('2026-09-01'),
    });
    expect(allowance).toEqual({ allowed: false, reason: 'BELOW_THRESHOLD', shortBy: 1 });
    expect(payoutRefusal(allowance, 10)).toContain('100$');
  });

  it('allows up to $50 on the first payout once $100 is reached', () => {
    const allowance = payoutAllowance({
      totalEarnings: 100,
      pendingBalance: 100,
      payouts: [],
      paidAt: noon('2026-09-01'),
    });
    expect(allowance).toMatchObject({
      allowed: true,
      reason: 'OK',
      weekStart: '2026-09-01',
      weekEnd: '2026-09-07',
      nextWeekStart: '2026-09-08',
      maxAmount: 50,
    });
    expect(payoutRefusal(allowance, 50)).toBeNull();
    expect(payoutRefusal(allowance, 50.01)).not.toBeNull();
  });

  it('keeps the threshold met after payouts bring the balance down', () => {
    // Earned $120, paid $50: still over $100 lifetime, so the rule is the weekly cap.
    const allowance = payoutAllowance({
      totalEarnings: 120,
      pendingBalance: 70,
      payouts: [{ amount: 50, paidAt: noon('2026-09-01') }],
      paidAt: noon('2026-09-08'),
    });
    expect(allowance).toMatchObject({ allowed: true, maxAmount: 50 });
  });

  it('counts every payout inside the same seven days against the $50', () => {
    const allowance = payoutAllowance({
      totalEarnings: 300,
      pendingBalance: 270,
      payouts: [
        { amount: 20, paidAt: noon('2026-09-01') },
        { amount: 10, paidAt: noon('2026-09-04') },
      ],
      paidAt: noon('2026-09-07'),
    });
    expect(allowance).toMatchObject({ allowed: true, paidThisWeek: 30, maxAmount: 20 });
    expect(payoutRefusal(allowance, 20)).toBeNull();
    expect(payoutRefusal(allowance, 25)).toContain('20.00$');
  });

  it('refuses the rest of a week whose $50 is spent, and says when it comes back', () => {
    const allowance = payoutAllowance({
      totalEarnings: 300,
      pendingBalance: 250,
      payouts: [{ amount: 50, paidAt: noon('2026-09-01') }],
      paidAt: noon('2026-09-07'),
    });
    expect(allowance).toMatchObject({ allowed: false, reason: 'WEEK_USED', maxAmount: 0 });
    expect(payoutRefusal(allowance, 1)).toContain('2026-09-08');
  });

  it('starts a fresh $50 on day 8, counted from the first payout', () => {
    const allowance = payoutAllowance({
      totalEarnings: 300,
      pendingBalance: 250,
      payouts: [{ amount: 50, paidAt: noon('2026-09-01') }],
      paidAt: noon('2026-09-08'),
    });
    expect(allowance).toMatchObject({ allowed: true, weekStart: '2026-09-08', maxAmount: 50 });
  });

  it('anchors the weeks at the first payout, not the latest one', () => {
    // First paid on the 1st, then on the 10th: the 10th is in the week of the
    // 8th–14th, so a payout on the 15th starts the next week.
    const allowance = payoutAllowance({
      totalEarnings: 300,
      pendingBalance: 220,
      payouts: [
        { amount: 30, paidAt: noon('2026-09-01') },
        { amount: 50, paidAt: noon('2026-09-10') },
      ],
      paidAt: noon('2026-09-15'),
    });
    expect(allowance).toMatchObject({ weekStart: '2026-09-15', paidThisWeek: 0, maxAmount: 50 });
  });

  it('counts in calendar days, not instants', () => {
    // Recorded at 3pm on the 1st, the next at noon on the 8th: a new week,
    // though fewer than 7 × 24 hours have passed.
    const allowance = payoutAllowance({
      totalEarnings: 300,
      pendingBalance: 250,
      payouts: [{ amount: 50, paidAt: '2026-09-01T15:00:00.000Z' }],
      paidAt: noon('2026-09-08'),
    });
    expect(allowance).toMatchObject({ allowed: true, maxAmount: 50 });
  });

  it('never allows more than is owed', () => {
    const allowance = payoutAllowance({
      totalEarnings: 100,
      pendingBalance: 12.5,
      payouts: [{ amount: 87.5, paidAt: noon('2026-08-01') }],
      paidAt: noon('2026-09-01'),
    });
    expect(allowance).toMatchObject({ allowed: true, maxAmount: 12.5 });
    expect(payoutRefusal(allowance, 13)).toContain('الرصيد المستحق');
  });

  it('refuses when nothing is owed', () => {
    const allowance = payoutAllowance({
      totalEarnings: 100,
      pendingBalance: 0,
      payouts: [
        { amount: 50, paidAt: noon('2026-08-01') },
        { amount: 50, paidAt: noon('2026-08-08') },
      ],
      paidAt: noon('2026-09-01'),
    });
    expect(allowance).toMatchObject({ allowed: false, reason: 'NOTHING_OWED' });
  });

  it('adds money in cents, so float drift cannot tip a payout over the cap', () => {
    const allowance = payoutAllowance({
      totalEarnings: 300,
      pendingBalance: 250,
      payouts: [
        { amount: 0.1, paidAt: noon('2026-09-01') },
        { amount: 0.2, paidAt: noon('2026-09-02') },
      ],
      paidAt: noon('2026-09-03'),
    });
    expect(payoutRefusal(allowance, 49.7)).toBeNull();
  });
});

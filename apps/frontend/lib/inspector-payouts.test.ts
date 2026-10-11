import { describe, expect, it } from 'vitest';
import { payoutHistory } from './inspector-payouts';

const registration = (submittedAt: string, commissionEarned: number) => ({ submittedAt, commissionEarned });
const payout = (id: string, paidAt: string, amount: number) => ({ id, paidAt, amount });

describe('payoutHistory', () => {
  const registrations = [
    registration('2026-03-01T09:00:00.000Z', 10),
    registration('2026-03-20T09:00:00.000Z', 15),
    // Filed after the first payout: it was not owed when that payout was made.
    registration('2026-05-02T09:00:00.000Z', 40),
  ];

  it('owes after each payout what had been earned by then, not today’s total', () => {
    const rows = payoutHistory([payout('a', '2026-04-01T12:00:00.000Z', 20)], registrations);
    // Earned 25 by 1 April; today's total (65) would have read as 45 still owed.
    expect(rows[0]).toMatchObject({ earnedToDate: 25, paidToDate: 20, owedAfter: 5, overpaidAfter: 0 });
  });

  it('carries the paid sum down the column, and answers newest first', () => {
    const rows = payoutHistory(
      [payout('late', '2026-06-01T12:00:00.000Z', 30), payout('early', '2026-04-01T12:00:00.000Z', 20)],
      registrations,
    );
    expect(rows.map((row) => row.payout.id)).toEqual(['late', 'early']);
    expect(rows[0]).toMatchObject({ earnedToDate: 65, paidToDate: 50, owedAfter: 15, overpaidAfter: 0 });
  });

  it('says a payout went beyond what had been earned, rather than reading as settled', () => {
    const rows = payoutHistory([payout('a', '2026-03-10T12:00:00.000Z', 25)], registrations);
    expect(rows[0]).toMatchObject({ earnedToDate: 10, owedAfter: 0, overpaidAfter: 15 });
  });

  it('counts a registration submitted at the very moment of the payout', () => {
    const rows = payoutHistory([payout('a', '2026-03-01T09:00:00.000Z', 10)], registrations);
    expect(rows[0]).toMatchObject({ earnedToDate: 10, owedAfter: 0, overpaidAfter: 0 });
  });

  it('leaves no float dust on the balance', () => {
    const rows = payoutHistory(
      [payout('a', '2026-04-01T12:00:00.000Z', 0.1), payout('b', '2026-04-02T12:00:00.000Z', 0.2)],
      [registration('2026-03-01T09:00:00.000Z', 0.3)],
    );
    expect(rows[0]).toMatchObject({ paidToDate: 0.3, owedAfter: 0, overpaidAfter: 0 });
  });

  it('is empty with no payouts', () => {
    expect(payoutHistory([], registrations)).toEqual([]);
  });
});

import { bulkSettlementOrder, planBulkSettlement, type BulkBill } from '@mechanization/shared-schemas';

/**
 * Old debts and the order a settlement pays in (old-debts task 6): the oldest due
 * date is paid first, so an «ARR-» bill, due on 31 December of its year, is settled
 * before a current one — even though it was raised later, at the batch's approval.
 */
const bill = (over: Partial<BulkBill> & Pick<BulkBill, 'id'>): BulkBill => ({
  currency: 'LBP',
  outstanding: 100_000,
  dueDate: '2026-12-31T00:00:00.000Z',
  createdAt: '2026-01-05T08:00:00.000Z',
  ...over,
});

// A current bill raised in January, and an old debt raised today by an approval: due years earlier.
const current = bill({ id: 'current', dueDate: '2026-12-31T00:00:00.000Z', createdAt: '2026-01-05T08:00:00.000Z' });
const oldDebt = bill({ id: 'arr', dueDate: '2023-12-31T00:00:00.000Z', createdAt: '2026-11-21T09:00:00.000Z' });

describe('settling an old debt with a current bill', () => {
  it('puts the old debt first, whatever order the bills were ticked in or raised in', () => {
    expect(bulkSettlementOrder([current, oldDebt]).map((entry) => entry.id)).toEqual(['arr', 'current']);
    expect(bulkSettlementOrder([oldDebt, current]).map((entry) => entry.id)).toEqual(['arr', 'current']);
  });

  it('plans the old debt’s row first, and every row for what it owes', () => {
    const result = planBulkSettlement({ bills: [current, oldDebt], method: 'WHISH_MONEY', baseCurrency: 'LBP', exchangeRate: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.rows.map((row) => [row.paymentId, row.amount])).toEqual([
      ['arr', 100_000],
      ['current', 100_000],
    ]);
  });

  it('two old debts are paid oldest year first, and one raised earlier goes first on a tie', () => {
    const older = bill({ id: 'arr-2021', dueDate: '2021-12-31T00:00:00.000Z', createdAt: '2026-11-21T09:00:00.000Z' });
    const sameDay = bill({ id: 'arr-2023-b', dueDate: '2023-12-31T00:00:00.000Z', createdAt: '2026-11-21T09:00:01.000Z' });
    expect(bulkSettlementOrder([sameDay, current, oldDebt, older]).map((entry) => entry.id)).toEqual([
      'arr-2021',
      'arr',
      'arr-2023-b',
      'current',
    ]);
  });
});

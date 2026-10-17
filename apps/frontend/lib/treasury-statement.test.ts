import { describe, expect, it } from 'vitest';
import { closingBalance, mayVoidTransfer, monthSoFar } from './treasury-statement';

describe('mayVoidTransfer', () => {
  const handover = {
    source: 'TRANSFER' as const,
    sourceId: 't0000001-0000-4000-8000-000000000001',
    isReversal: false,
    reversed: false,
  };

  it('offers the manager the cancellation of a handover still standing', () => {
    expect(mayVoidTransfer(handover, 'SUPER_ADMIN')).toBe(true);
  });

  it('is the manager’s alone, as the route is', () => {
    for (const role of ['ACCOUNTANT', 'AUDITOR', 'VIEWER', 'COLLECTOR', '', undefined]) {
      expect({ role, offered: mayVoidTransfer(handover, role) }).toEqual({ role, offered: false });
    }
  });

  it('is not offered on a handover already cancelled, nor on the cancelling movement itself', () => {
    expect(mayVoidTransfer({ ...handover, reversed: true }, 'SUPER_ADMIN')).toBe(false);
    expect(mayVoidTransfer({ ...handover, isReversal: true }, 'SUPER_ADMIN')).toBe(false);
  });

  it('is only for a transfer’s movement, and only one that names its transfer', () => {
    for (const source of ['CITIZEN_PAYMENT', 'EXPENSE_VOUCHER', 'OPENING_BALANCE', 'INCOME_VOUCHER', 'ADJUSTMENT'] as const) {
      expect({ source, offered: mayVoidTransfer({ ...handover, source }, 'SUPER_ADMIN') }).toEqual({
        source,
        offered: false,
      });
    }
    expect(mayVoidTransfer({ ...handover, sourceId: null }, 'SUPER_ADMIN')).toBe(false);
  });
});

describe('monthSoFar', () => {
  it('runs from the first of the month to today', () => {
    expect(monthSoFar('2026-10-09')).toEqual({ from: '2026-10-01', to: '2026-10-09' });
    expect(monthSoFar('2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('is a single day on the first of the month', () => {
    expect(monthSoFar('2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-01' });
  });
});

describe('closingBalance', () => {
  it('is the opening balance when nothing moved in the range', () => {
    expect(closingBalance({ openingBalance: 1_250_000, entries: [] })).toBe(1_250_000);
  });

  it('adds what the shown movements moved, in and out', () => {
    const entries = [{ amount: 500_000 }, { amount: -200_000 }, { amount: 75_000 }];
    expect(closingBalance({ openingBalance: 1_000_000, entries })).toBe(1_375_000);
  });

  it('does not depend on the order the rows arrive in', () => {
    const entries = [{ amount: 500_000 }, { amount: -200_000 }, { amount: 75_000 }];
    expect(closingBalance({ openingBalance: 1_000_000, entries: [...entries].reverse() })).toBe(1_375_000);
  });

  it('keeps the cents of a dollar wallet exact', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in floating point; a register shows 0.30.
    expect(closingBalance({ openingBalance: 0.1, entries: [{ amount: 0.2 }] })).toBe(0.3);
    expect(closingBalance({ openingBalance: 100, entries: [{ amount: -0.07 }, { amount: -0.01 }] })).toBe(99.92);
  });

  it('can close below zero, which is a fact about the ledger and not for the screen to hide', () => {
    expect(closingBalance({ openingBalance: 10, entries: [{ amount: -25 }] })).toBe(-15);
  });
});

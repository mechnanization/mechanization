import { randomUUID } from 'node:crypto';
import {
  businessDay,
  createTransferSchema,
  isCalendarDay,
  listIncomeVouchersQuerySchema,
  listTransfersQuerySchema,
  recordExpenseSchema,
  recordIncomeVoucherSchema,
  treasuryDayQuerySchema,
} from '@mechanization/shared-schemas';

/**
 * A treasury date is a day that exists (`businessDay` in the shared package).
 *
 * The transfer contract checked the pattern alone (review of 2026-10-11):
 * «2026-10-00» reached the server as an Invalid Date and Prisma answered with a
 * 500; «2026-13-45» made the register's period throw a RangeError, another 500;
 * «2026-09-31» was booked on 1 October; «2026-02-30» filtered from 2 March. The
 * expense, income and day-closing contracts refused them, each with its own copy
 * of the rule. One schema now, used by all four.
 */
const IMPOSSIBLE = ['2026-09-31', '2026-10-00', '2026-13-45', '2026-02-30', '2026-00-10'];
const REAL = ['2026-10-09', '2024-02-29', '2026-12-31'];

describe('businessDay', () => {
  it('is a real calendar day, not a string shaped like one', () => {
    for (const day of REAL) expect({ day, ok: isCalendarDay(day) }).toEqual({ day, ok: true });
    for (const day of [...IMPOSSIBLE, '2025-02-29']) expect({ day, ok: isCalendarDay(day) }).toEqual({ day, ok: false });
    expect(businessDay.safeParse('9/10/2026').success).toBe(false);
  });
});

describe('the transfer contract', () => {
  const base = {
    kind: 'SAME_CURRENCY' as const,
    fromAccountId: randomUUID(),
    toAccountId: randomUUID(),
    amount: 1_000,
    description: 'مناقلة إلى المصرف',
    backdateReason: 'سُجّلت متأخرة',
    clientRequestId: randomUUID(),
  };

  it('refuses a transfer dated on a day that does not exist', () => {
    for (const transferredOn of IMPOSSIBLE) {
      expect({ transferredOn, ok: createTransferSchema.safeParse({ ...base, transferredOn }).success }).toEqual({
        transferredOn,
        ok: false,
      });
    }
    for (const transferredOn of REAL) {
      expect(createTransferSchema.safeParse({ ...base, transferredOn }).success).toBe(true);
    }
  });

  it('refuses a register period bounded by a day that does not exist', () => {
    for (const day of IMPOSSIBLE) {
      expect({ day, from: listTransfersQuerySchema.safeParse({ from: day }).success }).toEqual({ day, from: false });
      expect({ day, to: listTransfersQuerySchema.safeParse({ to: day }).success }).toEqual({ day, to: false });
    }
    expect(listTransfersQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31' }).success).toBe(true);
  });
});

describe('every treasury contract takes the same days', () => {
  it('refuses the same impossible days on an expense, an income voucher, their registers and a count', () => {
    const expense = {
      categoryId: randomUUID(),
      accountId: randomUUID(),
      amount: 10,
      payee: 'مورّد',
      description: 'قرطاسية',
    };
    const income = { categoryId: randomUUID(), accountId: randomUUID(), amount: 10, description: 'هبة', clientRequestId: randomUUID() };
    for (const day of IMPOSSIBLE) {
      expect(recordExpenseSchema.safeParse({ ...expense, paidOn: day }).success).toBe(false);
      expect(recordIncomeVoucherSchema.safeParse({ ...income, receivedOn: day }).success).toBe(false);
      expect(listIncomeVouchersQuerySchema.safeParse({ from: day }).success).toBe(false);
      expect(treasuryDayQuerySchema.safeParse({ date: day }).success).toBe(false);
    }
    expect(recordExpenseSchema.safeParse({ ...expense, paidOn: '2026-10-09' }).success).toBe(true);
    expect(recordIncomeVoucherSchema.safeParse({ ...income, receivedOn: '2026-10-09' }).success).toBe(true);
  });
});

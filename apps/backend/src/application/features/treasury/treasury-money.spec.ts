import { randomUUID } from 'node:crypto';
import { dailyCountLineSchema, recordExpenseSchema, recordIncomeVoucherSchema } from '@mechanization/shared-schemas';

/*
  The income voucher's amount and the count's figures judge two decimals by the
  shared money rule (`hasAtMostTwoDecimals`, `positiveMoneyAmount`), as the
  expense, transfer and payout amounts do (DRY-06, 2026-11-24). Each used to
  carry its own `value * 100` float check, which refused valid figures from
  2^27 on and let `1e-9` through to a DECIMAL(14,2) column (docs/gotchas.md).
*/
const income = (amount: number) => ({
  categoryId: randomUUID(),
  accountId: randomUUID(),
  amount,
  description: 'هبة',
  clientRequestId: randomUUID(),
});

const countLine = (countedAmount: number, expectedAmount: number) => ({
  accountId: randomUUID(),
  countedAmount,
  expectedAmount,
  varianceReason: 'فرق في العدّ',
});

/** A two-decimal figure the float check refused: `value * 100` is off by more than its tolerance. */
const PAST_FLOAT_PRECISION = 134_217_728.14;
/** Float noise, or a figure the column would round to 0.00, that the float check let through. */
const NOT_TWO_DECIMALS = [1e-9, 0.1 + 0.2, 12.345];

describe('the income voucher amount', () => {
  it('takes a two-decimal figure, however large, up to what the ledger holds', () => {
    for (const amount of [0.01, 12.5, PAST_FLOAT_PRECISION, 999_999_999_999]) {
      expect(recordIncomeVoucherSchema.safeParse(income(amount)).success).toBe(true);
    }
  });

  it('refuses a third decimal and float noise, as an expense does', () => {
    for (const amount of NOT_TWO_DECIMALS) {
      expect(recordIncomeVoucherSchema.safeParse(income(amount)).success).toBe(false);
      expect(
        recordExpenseSchema.safeParse({
          categoryId: randomUUID(),
          accountId: randomUUID(),
          amount,
          payee: 'مورّد',
          description: 'قرطاسية',
        }).success,
      ).toBe(false);
    }
  });

  it('refuses zero, a negative amount and one past the column', () => {
    for (const amount of [0, -5, 1_000_000_000_000]) {
      expect(recordIncomeVoucherSchema.safeParse(income(amount)).success).toBe(false);
    }
  });
});

describe('a count line', () => {
  it('takes a zero count, and a signed expected figure', () => {
    expect(dailyCountLineSchema.safeParse(countLine(0, 0)).success).toBe(true);
    expect(dailyCountLineSchema.safeParse(countLine(0, -12.5)).success).toBe(true);
    expect(dailyCountLineSchema.safeParse(countLine(PAST_FLOAT_PRECISION, PAST_FLOAT_PRECISION)).success).toBe(true);
  });

  it('refuses a negative count', () => {
    expect(dailyCountLineSchema.safeParse(countLine(-1, 0)).success).toBe(false);
  });

  it('refuses a third decimal or float noise in either figure', () => {
    for (const value of NOT_TWO_DECIMALS) {
      expect(dailyCountLineSchema.safeParse(countLine(value, 0)).success).toBe(false);
      expect(dailyCountLineSchema.safeParse(countLine(0, -value)).success).toBe(false);
    }
  });
});

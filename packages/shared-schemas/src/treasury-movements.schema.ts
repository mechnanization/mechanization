import { z } from 'zod';
import { businessDay } from './primitives';
import type { ExpenseVoucherView } from './expense.schema';
import type { IncomeVoucherView } from './income.schema';

/**
 * «الإيرادات والنفقات» — the income vouchers and the expense vouchers in one
 * register, newest first, so the accountant reads what came in and what went
 * out on a day as one page of the books rather than two. Design:
 * docs/finance.md §4.6.
 *
 * Vouchers only: a citizen's payment credits a wallet without a voucher and is
 * read on the fees pages and the wallet's statement, not here (decided
 * 2026-10-12). The expense requests still waiting for an order are not vouchers
 * either: they stay on their own queue (`GET treasury/expenses/requests`).
 *
 * Read only. Recording, cancelling and ordering keep their own routes.
 */

/** «قبض» (an income voucher) or «صرف» (an expense voucher). */
export const TREASURY_MOVEMENT_DIRECTIONS = ['IN', 'OUT'] as const;
export type TreasuryMovementDirection = (typeof TREASURY_MOVEMENT_DIRECTIONS)[number];

/** The last page the register serves: a million pages of 200 is far past any municipality's books. */
const TREASURY_MOVEMENTS_MAX_PAGE = 1_000_000;

/**
 * The merged register's filters, as they arrive in the query string.
 *
 * The same filters as the two registers it replaces, now applied to both:
 *
 * - `from` and `to` are days on the municipality's calendar, both inclusive
 *   (Beirut midnights, as the income register reads them).
 * - `categoryId` names a category of one table — an income category or an
 *   expense band are different rows — so it needs `direction`; without it the
 *   filter would silently drop the other half of the books.
 * - `search` matches the voucher number, the payer or payee, the description,
 *   and the cheque, transfer or invoice number.
 * - `includeVoid` lists the cancelled vouchers among the others; the totals
 *   never count them.
 */
export const listTreasuryMovementsQuerySchema = z
  .object({
    direction: z.enum(TREASURY_MOVEMENT_DIRECTIONS).optional(),
    from: businessDay.optional(),
    to: businessDay.optional(),
    accountId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(),
    /** ISO 4217, as the wallets store it. */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    search: z.string().trim().max(120).optional(),
    includeVoid: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    /**
     * Bounded so the offset the server binds (`(page - 1) * pageSize`) stays a
     * whole number Postgres can read: unbounded, `page=1e20` passed and the
     * query failed as a 500 (bigint out of range), its URL logged.
     */
    page: z.coerce.number().int().min(1).max(TREASURY_MOVEMENTS_MAX_PAGE).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'بداية الفترة بعد نهايتها',
    path: ['to'],
  })
  .refine((value) => !value.categoryId || value.direction !== undefined, {
    message: 'اختر قبضاً أو صرفاً قبل البند',
    path: ['categoryId'],
  });

export type ListTreasuryMovementsQuery = z.infer<typeof listTreasuryMovementsQuerySchema>;

// ───────────────────────────────  response shapes  ───────────────────────────────

/**
 * One line of the register: the voucher as its own register shows it, and the
 * municipal day it belongs to (`YYYY-MM-DD`, Beirut), so a screen groups by day
 * without converting an instant through a zone of its own.
 */
export type TreasuryMovement =
  | { direction: 'IN'; day: string; voucher: IncomeVoucherView }
  | { direction: 'OUT'; day: string; voucher: ExpenseVoucherView };

/** What came in and what went out in one currency; cancelled vouchers never count. */
export interface TreasuryMovementTotal {
  currency: string;
  amountIn: number;
  amountOut: number;
}

/** A day's whole totals under the same filters, whichever page its vouchers fall on. */
export interface TreasuryMovementDay {
  day: string;
  totals: TreasuryMovementTotal[];
}

export interface TreasuryMovementsResult {
  movements: TreasuryMovement[];
  /** Every voucher the filters match, cancelled ones included when asked for. */
  total: number;
  /** Over the whole filtered set, per currency, sorted by currency. */
  totals: TreasuryMovementTotal[];
  /**
   * One entry for each day that has a line on this page, newest first. A day
   * that runs over two pages still reads whole on both: these are summed over
   * the filtered set, not over the page.
   */
  days: TreasuryMovementDay[];
}

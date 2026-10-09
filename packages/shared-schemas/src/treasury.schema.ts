import { z } from 'zod';

/**
 * الخزينة — the municipality's wallets and the ledger behind them.
 * Design: docs/finance.md.
 *
 * A wallet (account) holds one currency. Its balance is the sum of its entries;
 * nothing stores a balance. Money is sent over the wire as a plain number: LBP
 * is whole pounds in practice and USD has cents, and both fit a double exactly
 * at municipal scale. The database keeps `DECIMAL(14,2)`.
 */

/** Kept in step with the Prisma enum `TreasuryAccountType` and migration 0073. */
export const TREASURY_ACCOUNT_TYPES = [
  'CASH_SAFE',
  'WHISH_ACCOUNT',
  'BANK_ACCOUNT',
  'COLLECTOR_CUSTODY',
  'PETTY_CASH',
] as const;
export type TreasuryAccountType = (typeof TREASURY_ACCOUNT_TYPES)[number];

/** Kept in step with the Prisma enum `TreasuryEntrySource` and migration 0073. */
export const TREASURY_ENTRY_SOURCES = [
  'OPENING_BALANCE',
  'CITIZEN_PAYMENT',
  'INCOME_VOUCHER',
  'EXPENSE_VOUCHER',
  'TRANSFER',
  'ADJUSTMENT',
] as const;
export type TreasuryEntrySource = (typeof TREASURY_ENTRY_SOURCES)[number];

/**
 * Who may do what with the treasury (docs/finance.md §9).
 *
 * - read: every balance, statement and report.
 * - work: the accountant's daily work.
 * - admin: the manager only — activating the treasury, corrections, settings.
 */
export const TREASURY_READ_ROLES = ['SUPER_ADMIN', 'ACCOUNTANT', 'AUDITOR', 'VIEWER'] as const;
export const TREASURY_WORK_ROLES = ['SUPER_ADMIN', 'ACCOUNTANT'] as const;
export const TREASURY_ADMIN_ROLES = ['SUPER_ADMIN'] as const;

/**
 * باب وبند الموازنة: the chapter or the article as the municipality's own budget
 * numbers it. Digits and dots, because that is every shape a Lebanese municipal
 * budget line takes, and free text here would make the codes unsortable.
 *
 * Shared by the expense and the income categories (0074, 0080), whose tables
 * carry the same two columns under the same CHECK.
 */
export const budgetCodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9][0-9.]{0,15}$/, 'الرمز أرقام، وقد تفصلها نقاط')
  .optional();

/**
 * Both codes or neither: a chapter without its article is a half-entered code
 * no report can use, and the database refuses it.
 */
export const budgetCodesComplete = (value: { chapterCode?: string; itemCode?: string }): boolean =>
  Boolean(value.chapterCode) === Boolean(value.itemCode);

export const BUDGET_CODES_INCOMPLETE = {
  message: 'اكتب الباب والبند معاً، أو اتركهما فارغين',
  path: ['itemCode'],
};

/** An amount in a wallet's currency: not negative, at most two decimals. */
const openingAmount = z
  .number({ required_error: 'اكتب الرصيد الافتتاحي', invalid_type_error: 'الرصيد الافتتاحي رقم' })
  .finite('الرصيد الافتتاحي رقم')
  .min(0, 'الرصيد الافتتاحي لا يكون سالباً')
  .max(999_999_999_999, 'الرصيد كبير جداً')
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, 'خانتان عشريتان على الأكثر');

/**
 * «تفعيل الخزينة» — the counted opening balance of every wallet, posted once.
 *
 * Every active wallet must appear (a zero is a real count and is allowed); the
 * server refuses a list that leaves one out, so the go-live moment never
 * happens with a wallet still unknown.
 */
export const activateTreasurySchema = z
  .object({
    balances: z
      .array(z.object({ accountId: z.string().uuid('حساب غير صالح'), amount: openingAmount }))
      .min(1, 'أدخل رصيد كل حساب')
      .max(50, 'عدد الحسابات كبير جداً'),
    note: z.string().trim().max(500, 'الملاحظة طويلة جداً').optional(),
  })
  .refine((value) => new Set(value.balances.map((b) => b.accountId)).size === value.balances.length, {
    message: 'حساب مكرر في القائمة',
    path: ['balances'],
  });

export type ActivateTreasuryInput = z.infer<typeof activateTreasurySchema>;

// ───────────────────────────────  response shapes  ───────────────────────────────

export interface TreasuryAccountView {
  id: string;
  name: string;
  type: TreasuryAccountType;
  currency: string;
  isPrimary: boolean;
  active: boolean;
  /** The collector, for a custody account. A name only — never contact details. */
  ownerName: string | null;
  /** The sum of the account's entries. */
  balance: number;
}

/** What a screen needs to convert one currency into the other: the municipality's own rate. */
export interface TreasuryRate {
  baseCurrency: string;
  secondaryCurrency: string | null;
  /** Units of `baseCurrency` per one unit of `secondaryCurrency`. */
  exchangeRate: number | null;
  exchangeRateUpdatedAt: string | null;
}

export interface TreasuryOverview {
  /** False until the opening balances are posted; nothing credits a wallet before then. */
  active: boolean;
  goLiveAt: string | null;
  accounts: TreasuryAccountView[];
  rate: TreasuryRate;
  /** Held by collectors, per currency — shown beside the safe, never counted into it. */
  heldByCollectors: Array<{ currency: string; amount: number }>;
}

export interface TreasuryStatementEntry {
  id: string;
  amount: number;
  currency: string;
  source: TreasuryEntrySource;
  sourceId: string | null;
  /** True for the opposing entry itself. */
  isReversal: boolean;
  /** True for an entry that has since been reversed. */
  reversed: boolean;
  exchangeRateAtPosting: number | null;
  /** The staff member's name, or null for the system. */
  actorName: string | null;
  note: string | null;
  occurredAt: string;
  /** The account's balance after this entry, oldest first. */
  balanceAfter: number;
}

export interface TreasuryStatement {
  account: TreasuryAccountView;
  /** The balance before the first entry shown. */
  openingBalance: number;
  entries: TreasuryStatementEntry[];
  /** True when more entries exist after the last one shown. */
  truncated: boolean;
}

export interface ActivateTreasuryResult {
  goLiveAt: string;
  /** How many opening entries were written (a zero balance writes none). */
  entriesPosted: number;
}

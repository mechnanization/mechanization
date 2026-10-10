import { z } from 'zod';
import {
  BUDGET_CODES_INCOMPLETE,
  budgetCodeSchema,
  budgetCodesComplete,
  type TreasuryAccountType,
} from './treasury.schema';

/**
 * الإيرادات العامة — money that reaches a municipal wallet without a citizen's
 * bill behind it, and the «سند قبض إيرادات» that says where it came from.
 * Design: docs/finance.md §4.
 *
 * The Independent Municipal Fund's transfer, the state's share of telephone and
 * electricity revenue, a building permit, rent on a municipal shop, a grant, a
 * fine. Citizen fees are not here: they credit the wallets themselves through
 * the payment ledger, and recording one here as well would count it twice.
 *
 * Recording a voucher **is** receiving the money: the wallet's balance rises in
 * the same transaction. A mistake is voided — the manager's alone, with a
 * reason — and never edited, so nothing here describes an update.
 */

/** The state a voucher is in. Derived from `voidedAt`, never stored twice. */
export const INCOME_STATUSES = ['RECORDED', 'VOID'] as const;
export type IncomeStatus = (typeof INCOME_STATUSES)[number];

/**
 * The seeded categories' stable handles (migration 0080), in their seeded
 * order. A category a municipality adds later has no key, so code never looks
 * one of those up by name.
 */
export const INCOME_CATEGORY_KEYS = [
  'INDEPENDENT_MUNICIPAL_FUND',
  'STATE_UTILITIES_FEES',
  'BUILDING_PERMITS_PLANNING',
  'PROPERTY_RENTAL_INVESTMENT',
  'UNCONDITIONAL_GRANTS_DONATIONS',
  'FINES_AND_PENALTIES',
  'MISCELLANEOUS_INCOME',
] as const;
export type IncomeCategoryKey = (typeof INCOME_CATEGORY_KEYS)[number];

/**
 * The wallets income may be received into (docs/finance.md §4.2).
 *
 * Never a collector's custody: that wallet holds a person's pocket on a round,
 * and a voucher putting the Independent Municipal Fund's transfer into it would
 * make him answerable for money he never touched. Never petty cash either: a
 * petty-cash fund is topped up from the safe by a transfer, not paid into from
 * outside. The server refuses the rest; the form only offers these.
 */
export const INCOME_RECEIVING_ACCOUNT_TYPES = [
  'CASH_SAFE',
  'WHISH_ACCOUNT',
  'BANK_ACCOUNT',
] as const satisfies readonly TreasuryAccountType[];

export function canReceiveIncome(type: TreasuryAccountType): boolean {
  return (INCOME_RECEIVING_ACCOUNT_TYPES as readonly string[]).includes(type);
}

/** A received amount: greater than zero, at most two decimals, inside what the ledger holds. */
const receivedAmount = z
  .number({ required_error: 'اكتب المبلغ', invalid_type_error: 'المبلغ رقم' })
  .finite('المبلغ رقم')
  .positive('المبلغ أكبر من صفر')
  .max(999_999_999_999, 'المبلغ كبير جداً')
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, 'خانتان عشريتان على الأكثر');

/** `YYYY-MM-DD` on the municipality's own calendar. */
const businessDate = z
  .string({ required_error: 'اختر التاريخ' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ غير صالح');

/**
 * «سجّل الإيراد» — the whole act, in one request.
 *
 * The currency is deliberately absent: the server takes it from the receiving
 * wallet, so a voucher can never claim a currency its wallet does not hold.
 *
 * `clientRequestId` is required, unlike the expense form's: the column is
 * NOT NULL, because every press of the button carries one and a retry after a
 * lost response must find the first voucher rather than credit the wallet twice.
 */
export const recordIncomeVoucherSchema = z.object({
  categoryId: z.string().uuid('اختر بند الإيراد'),
  accountId: z.string().uuid('اختر الحساب الذي استُلم فيه المبلغ'),
  amount: receivedAmount,
  /** The paying body — «مصرف لبنان / الصندوق البلدي المستقل». Optional; may name a citizen. */
  payerName: z.string().trim().max(200, 'الاسم طويل جداً').optional(),
  description: z
    .string({ required_error: 'اكتب البيان' })
    .trim()
    .min(3, 'اكتب البيان')
    .max(1000, 'البيان طويل جداً'),
  /** A cheque number, a bank or Whish transfer number. */
  externalReference: z.string().trim().max(100, 'المرجع طويل جداً').optional(),
  /** Defaults to the municipality's today when the screen leaves it out. */
  receivedOn: businessDate.optional(),
  /** Required by the server for any back-dated voucher. */
  adjustmentReason: z.string().trim().max(500, 'السبب طويل جداً').optional(),
  /** One id per press of the button, so a retry does not credit the wallet twice. */
  clientRequestId: z.string().uuid(),
});

export type RecordIncomeVoucherInput = z.infer<typeof recordIncomeVoucherSchema>;

/**
 * The fields a municipality owns on an income category, shared by create and
 * edit. The Arabic name is required; the English one is optional, because a
 * category the municipality names itself may only ever have been named in
 * Arabic, and an English page then shows the Arabic rather than an invented
 * translation. Budget codes: both or neither, as on the expense categories.
 */
const incomeCategoryFields = {
  labelAr: z
    .string({ required_error: 'اكتب اسم البند' })
    .trim()
    .min(2, 'اكتب اسم البند')
    .max(120, 'الاسم طويل جداً'),
  labelEn: z.string().trim().max(120, 'الاسم طويل جداً').optional(),
  chapterCode: budgetCodeSchema,
  itemCode: budgetCodeSchema,
};

/** «بند إيراد جديد» — the municipality adds a source of income. Manager only. */
export const createIncomeCategorySchema = z
  .object(incomeCategoryFields)
  .refine(budgetCodesComplete, BUDGET_CODES_INCOMPLETE);

export type CreateIncomeCategoryInput = z.infer<typeof createIncomeCategorySchema>;

/**
 * Renaming, re-coding, stopping or restarting one. Never deleting: every
 * voucher filed under a category still points at it.
 *
 * The names and codes are the category's whole content, replaced as the form
 * holds them: one sent empty or left out is cleared. `active` is a state, not
 * content, and absent leaves the category as it was — renaming a stopped
 * category does not restart it.
 */
export const updateIncomeCategorySchema = z
  .object({ ...incomeCategoryFields, active: z.boolean().optional() })
  .refine(budgetCodesComplete, BUDGET_CODES_INCOMPLETE);

export type UpdateIncomeCategoryInput = z.infer<typeof updateIncomeCategorySchema>;

/** «إلغاء سند القبض» — the manager's cancellation, with its reason. */
export const voidIncomeVoucherSchema = z.object({
  reason: z
    .string({ required_error: 'اكتب سبب الإلغاء' })
    .trim()
    .min(5, 'اكتب سبباً واضحاً للإلغاء')
    .max(500, 'السبب طويل جداً'),
});

export type VoidIncomeVoucherInput = z.infer<typeof voidIncomeVoucherSchema>;

/**
 * The register's filters, as they arrive in the query string.
 *
 * `from` and `to` are days on the municipality's calendar, both inclusive: the
 * server turns them into Beirut midnights, so «تشرين الأول» means the money that
 * arrived in October in Lebanon and not in UTC. An unreadable date refuses
 * rather than quietly widening the range, because the totals beside the table
 * are a figure, and a figure for a different period presented as the one asked
 * for is the one mistake a register may not make.
 */
export const listIncomeVouchersQuerySchema = z
  .object({
    from: businessDate.optional(),
    to: businessDate.optional(),
    categoryId: z.string().uuid().optional(),
    accountId: z.string().uuid().optional(),
    /** ISO 4217, as the wallets store it. */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    /** Matches the voucher number, the payer, the description and the reference. */
    search: z.string().trim().max(120).optional(),
    includeVoid: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'بداية الفترة بعد نهايتها',
    path: ['to'],
  });

export type ListIncomeVouchersQuery = z.infer<typeof listIncomeVouchersQuerySchema>;

// ───────────────────────────────  response shapes  ───────────────────────────────

export interface IncomeCategoryView {
  id: string;
  key: IncomeCategoryKey | null;
  /** The name as the municipality reads it. */
  labelAr: string;
  /** Its English name, or null for a category entered in Arabic only. */
  labelEn: string | null;
  /**
   * باب وبند الموازنة, as the municipality's own budget numbers them. Null until
   * someone enters them: the codes are the municipality's, and nothing here
   * invents one.
   */
  chapterCode: string | null;
  itemCode: string | null;
  active: boolean;
}

export interface IncomeVoucherView {
  id: string;
  /** «RV-2610-0001». */
  voucherNumber: string;
  status: IncomeStatus;
  category: { id: string; labelAr: string; labelEn: string | null };
  account: { id: string; name: string; currency: string };
  amount: number;
  currency: string;
  payerName: string | null;
  description: string;
  externalReference: string | null;
  occurredAt: string;
  adjustmentReason: string | null;
  /** The staff member's name, or null when the account has since been hidden. */
  recordedByName: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
}

export interface IncomeListResult {
  vouchers: IncomeVoucherView[];
  total: number;
  /** What the listed (non-void) vouchers add up to, per currency, over the whole filtered set. */
  totals: Array<{ currency: string; amount: number }>;
}

export interface RecordIncomeVoucherResult {
  voucherNumber: string;
  id: string;
  /** The receiving wallet's balance once the money arrived. */
  balanceAfter: number;
  currency: string;
  /** True when this answers a retry of a voucher already recorded. */
  replayed: boolean;
}

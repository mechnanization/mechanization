import { z } from 'zod';

/**
 * النفقات — money leaving a municipal wallet, and the «أمر صرف» that says why.
 * Design: docs/finance.md §5.
 *
 * Recording an expense **is** paying it: there is no draft and no approval
 * step, by product decision. A mistake is voided, never edited, so nothing here
 * describes an update.
 */

/** The state a voucher is in. Derived from `voidedAt`, never stored twice. */
export const EXPENSE_STATUSES = ['RECORDED', 'VOID'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/**
 * The seeded categories' stable handles (migration 0074). A municipality's own
 * categories have no key, so code never looks those up by name.
 */
export const EXPENSE_CATEGORY_KEYS = [
  'FUEL',
  'SALARIES',
  'MAINTENANCE',
  'WASTE',
  'OFFICE_SUPPLIES',
  'ELECTRICITY',
  'FIELD_COMMISSIONS',
  'SOCIAL_AID',
  'TRANSFER_FEES',
  'MISC',
] as const;
export type ExpenseCategoryKey = (typeof EXPENSE_CATEGORY_KEYS)[number];

/** A paid amount: greater than zero, at most two decimals, inside what the column holds. */
const paidAmount = z
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
 * «سجّل النفقة» — the whole act, in one request.
 *
 * The currency is deliberately absent: the server takes it from the wallet
 * being paid from, so a voucher can never claim a currency its wallet does not
 * hold. The client cannot get that pair wrong because it never states it.
 */
export const recordExpenseSchema = z.object({
  categoryId: z.string().uuid('اختر بند الصرف'),
  accountId: z.string().uuid('اختر الحساب الذي سيُدفع منه'),
  amount: paidAmount,
  payee: z
    .string({ required_error: 'اكتب اسم المستفيد' })
    .trim()
    .min(2, 'اكتب اسم المستفيد')
    .max(200, 'الاسم طويل جداً'),
  description: z
    .string({ required_error: 'اكتب سبب الصرف' })
    .trim()
    .min(3, 'اكتب سبب الصرف')
    .max(1000, 'الوصف طويل جداً'),
  /** Defaults to the municipality's today when the screen leaves it out. */
  paidOn: businessDate.optional(),
  /** Required by the server for any back-dated voucher. */
  adjustmentReason: z.string().trim().max(500, 'السبب طويل جداً').optional(),
  invoiceNumber: z.string().trim().max(100, 'الرقم طويل جداً').optional(),
  hasPhysicalReceipt: z.boolean().optional(),
  /** One id per press of the button, so a retry does not pay twice. */
  clientRequestId: z.string().uuid().optional(),
});

export type RecordExpenseInput = z.infer<typeof recordExpenseSchema>;

/**
 * A budget code: the chapter or the article as the municipality's own budget
 * numbers it. Digits and dots, because that is every shape a Lebanese municipal
 * budget line takes, and free text here would make the codes unsortable.
 */
const budgetCode = z
  .string()
  .trim()
  .regex(/^[0-9][0-9.]{0,15}$/, 'الرمز أرقام، وقد تفصلها نقاط')
  .optional();

/** The fields a municipality owns on a category, shared by create and edit. */
const categoryFields = {
  name: z
    .string({ required_error: 'اكتب اسم البند' })
    .trim()
    .min(2, 'اكتب اسم البند')
    .max(120, 'الاسم طويل جداً'),
  description: z.string().trim().max(500, 'الوصف طويل جداً').optional(),
  /**
   * باب وبند الموازنة. Both or neither: a chapter without its article is a
   * half-entered code no report can use, and the database refuses it.
   */
  chapterCode: budgetCode,
  itemCode: budgetCode,
};

const bothOrNeither = (value: { chapterCode?: string; itemCode?: string }) =>
  Boolean(value.chapterCode) === Boolean(value.itemCode);

export const createExpenseCategorySchema = z
  .object(categoryFields)
  .refine(bothOrNeither, { message: 'اكتب الباب والبند معاً، أو اتركهما فارغين', path: ['itemCode'] });

export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;

/**
 * Editing one. `active: false` is how a category leaves the list: it is never
 * deleted, because every voucher ever filed under it still points here.
 */
export const updateExpenseCategorySchema = z
  .object({ ...categoryFields, active: z.boolean().optional() })
  .refine(bothOrNeither, { message: 'اكتب الباب والبند معاً، أو اتركهما فارغين', path: ['itemCode'] });

export type UpdateExpenseCategoryInput = z.infer<typeof updateExpenseCategorySchema>;

/** «إلغاء سند الصرف» — the manager's cancellation, with its reason. */
export const voidExpenseSchema = z.object({
  reason: z
    .string({ required_error: 'اكتب سبب الإلغاء' })
    .trim()
    .min(5, 'اكتب سبباً واضحاً للإلغاء')
    .max(500, 'السبب طويل جداً'),
});

export type VoidExpenseInput = z.infer<typeof voidExpenseSchema>;

// ───────────────────────────────  response shapes  ───────────────────────────────

export interface ExpenseCategoryView {
  id: string;
  key: ExpenseCategoryKey | null;
  name: string;
  description: string | null;
  /**
   * باب وبند الموازنة, as the municipality's own budget numbers them. Null until
   * someone enters them: the codes are the municipality's, and nothing here
   * invents one. «قطع الحساب» will read them when that report is built.
   */
  chapterCode: string | null;
  itemCode: string | null;
  active: boolean;
}

export interface ExpenseVoucherView {
  id: string;
  voucherNumber: string;
  status: ExpenseStatus;
  category: { id: string; name: string };
  account: { id: string; name: string; currency: string };
  amount: number;
  currency: string;
  payee: string;
  description: string;
  occurredAt: string;
  invoiceNumber: string | null;
  hasPhysicalReceipt: boolean;
  adjustmentReason: string | null;
  /** The staff member's name, or null when the account has since been hidden. */
  recordedByName: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
}

export interface ExpenseListResult {
  vouchers: ExpenseVoucherView[];
  total: number;
  /** What the listed (non-void) vouchers add up to, per currency. */
  totals: Array<{ currency: string; amount: number }>;
}

export interface RecordExpenseResult {
  voucherNumber: string;
  id: string;
  /** The paying wallet's balance once the money left. */
  balanceAfter: number;
  currency: string;
  /** True when this answers a retry of a voucher already recorded. */
  replayed: boolean;
}

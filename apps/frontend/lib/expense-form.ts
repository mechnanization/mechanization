import { isReservedExpenseCategory, type ExpenseCategoryView } from '@mechanization/shared-schemas';

/**
 * The recording form's fields, in the order they sit on the screen, each with
 * the id of the control to focus.
 *
 * A failed submit puts the officer on the first thing to fix rather than
 * leaving them to hunt for it (FRM-2), and "first" is the order on the screen,
 * the form read row by row, in two columns or three (2026-10-12): the reason for
 * an urgent payment at the top; the amount, the wallet, the band; the payee, the
 * date, the invoice number; the reason for a back-dated payment under them; and
 * the reason for the expense across the foot.
 */
const FIELDS = [
  ['urgentReason', 'expense-urgent'],
  ['amount', 'expense-amount'],
  ['accountId', 'expense-account'],
  ['categoryId', 'expense-category'],
  ['payee', 'expense-payee'],
  ['paidOn', 'expense-date'],
  ['invoiceNumber', 'expense-invoice'],
  ['adjustmentReason', 'expense-adjustment'],
  ['description', 'expense-description'],
] as const;

export type ExpenseField = (typeof FIELDS)[number][0];

/** A field the form has a message and a control for. A schema issue on anything else is not the officer's to fix. */
export function isExpenseField(name: string): name is ExpenseField {
  return FIELDS.some(([field]) => field === name);
}

/** The id of the control for the first field with an error, or null when none of them has one. */
export function firstFieldToFix(errors: Readonly<Record<string, string | undefined>>): string | null {
  const first = FIELDS.find(([field]) => Boolean(errors[field]));
  return first ? first[1] : null;
}

/**
 * The بنود the form offers: the active ones, then any added on this screen, once
 * each — and never one reserved to its own path (`RESERVED_EXPENSE_CATEGORY_KEYS`).
 *
 * «تعويضات المسح والجباية» is paid with «صرف عمولة», which writes the payout row
 * that what an inspector is owed is read from. Offered here, a commission paid
 * through the form left him still owed it, and the payout dialog paid it again;
 * the server refuses it too (`EXPENSE_CATEGORY_RESERVED`).
 */
export function formCategories(
  listed: readonly ExpenseCategoryView[],
  added: readonly ExpenseCategoryView[],
): ExpenseCategoryView[] {
  const byId = new Map<string, ExpenseCategoryView>();
  for (const category of listed) if (category.active) byId.set(category.id, category);
  for (const category of added) byId.set(category.id, category);
  return [...byId.values()].filter((category) => !isReservedExpenseCategory(category.key));
}

/**
 * The recording form's fields, in the order they sit on the screen, each with
 * the id of the control to focus.
 *
 * A failed submit puts the officer on the first thing to fix rather than
 * leaving them to hunt for it (FRM-2), and "first" is the order on the screen:
 * the reason for an urgent payment is at the top of the form; at the foot, the
 * date and the invoice number share a row, and the reason for a back-dated
 * payment sits under them.
 */
const FIELDS = [
  ['urgentReason', 'expense-urgent'],
  ['accountId', 'expense-account'],
  ['amount', 'expense-amount'],
  ['categoryId', 'expense-category'],
  ['payee', 'expense-payee'],
  ['description', 'expense-description'],
  ['paidOn', 'expense-date'],
  ['invoiceNumber', 'expense-invoice'],
  ['adjustmentReason', 'expense-adjustment'],
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

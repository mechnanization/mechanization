import {
  TREASURY_ADMIN_ROLES,
  TREASURY_WORK_ROLES,
  type ExpenseOrderStatus,
  type ExpenseRequestStatus,
  type ExpenseStatus,
} from '@mechanization/shared-schemas';
import { hasRole } from './staff-roles';

/**
 * «أمر الصرف» — who may do what with a payment order.
 *
 * Money leaves a municipal wallet on the payment order (حوالة) of the head of
 * the municipality (decree 5595/1982, art. 28, 33, 85). In the app the manager
 * issues orders and the accountant prepares them; salaries, routine petty
 * expenses and urgent ones may be paid first, the order following (art. 35).
 *
 * The server enforces every line here (`ExpensesController` and
 * `ExpensesService`). These decide which controls a screen offers, so that none
 * is shown to a role that can only be refused (CODE-4), and they read the same
 * role lists the controller does.
 */

/** The signed-in staff member, as `useStaffSession` hands them over. */
export interface OrderActor {
  id: string;
  role: string;
}

/**
 * What pressing the recording form's button does.
 *
 * - `ORDER`: the manager. His recording is the payment order, so it pays at once.
 * - `REQUEST`: the accountant's default. Nothing leaves a wallet; the manager
 *   orders it later, on the day the money leaves.
 * - `URGENT`: the accountant paying first (art. 35). It pays at once and the
 *   voucher waits for the manager's order.
 */
export type ExpenseMode = 'ORDER' | 'REQUEST' | 'URGENT';

/** The mode a role works in, given what an accountant chose. The manager has no choice to make. */
export function expenseModeFor(role: string | undefined, choice: Exclude<ExpenseMode, 'ORDER'>): ExpenseMode {
  return hasRole(TREASURY_ADMIN_ROLES, role) ? 'ORDER' : choice;
}

/** Whether the mode moves money now, and so asks for a date and checks the balance as the amount is typed. */
export function paysNow(mode: ExpenseMode): boolean {
  return mode !== 'REQUEST';
}

/** Mirrors `@Roles(...TREASURY_ADMIN_ROLES)` on the order, reject and regularise routes. */
export function mayIssueOrders(role: string | undefined): boolean {
  return hasRole(TREASURY_ADMIN_ROLES, role);
}

/** «أمر بالصرف» and «رفض»: the manager, on a request still waiting. */
export function mayDecideRequest(
  request: { status: ExpenseRequestStatus },
  actor: OrderActor | null,
): boolean {
  return Boolean(actor) && request.status === 'PENDING' && mayIssueOrders(actor?.role);
}

/**
 * «سحب الطلب»: its author, or the manager, while it still waits. The route is
 * open to the working roles (`TREASURY_WORK_ROLES`) and the service refuses
 * anyone but the author and the manager (`EXPENSE_REQUEST_NOT_YOURS`), so the
 * control is offered to exactly those.
 */
export function mayWithdrawRequest(
  request: { status: ExpenseRequestStatus; requestedById: string },
  actor: OrderActor | null,
): boolean {
  if (!actor || request.status !== 'PENDING') return false;
  if (!hasRole(TREASURY_WORK_ROLES, actor.role)) return false;
  return mayIssueOrders(actor.role) || request.requestedById === actor.id;
}

/** «إصدار أمر الصرف» for an urgent payment: the manager, on a paid voucher that has no order yet. */
export function mayRegularize(
  voucher: { status: ExpenseStatus; orderStatus: ExpenseOrderStatus },
  actor: OrderActor | null,
): boolean {
  return (
    Boolean(actor) &&
    mayIssueOrders(actor?.role) &&
    voucher.status === 'RECORDED' &&
    voucher.orderStatus === 'AWAITING_ORDER'
  );
}

/**
 * Refusals that mean the list on screen is out of date rather than that the
 * officer did something wrong: somebody else ordered, rejected, withdrew or
 * cancelled it first. The screen refreshes behind them, so the row that can no
 * longer be acted on goes away instead of inviting the same refusal again.
 */
const OUT_OF_DATE = new Set([
  'EXPENSE_REQUEST_ALREADY_DECIDED',
  'EXPENSE_REQUEST_NOT_FOUND',
  'EXPENSE_ALREADY_ORDERED',
  'EXPENSE_ALREADY_VOID',
  'EXPENSE_NOT_FOUND',
]);

export function meansOutOfDate(code: string): boolean {
  return OUT_OF_DATE.has(code);
}

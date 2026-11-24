import { apiFetch } from './core';

// ── الخزينة (stage 1) ───────────────────────────────────────────────────────

import type {
  ActivateTreasuryInput,
  ActivateTreasuryResult,
  TreasuryOverview,
  TreasuryStatement,
  CreateExpenseCategoryInput,
  ExpenseCategoryView,
  ExpenseListResult,
  ExpenseRequestListResult,
  ExpenseRequestStatus,
  ExpenseRequestView,
  ExpenseVoucherView,
  RecordExpenseInput,
  RecordExpenseResult,
  RejectExpenseRequestInput,
  RequestExpenseInput,
  RequestExpenseResult,
  RecordStaffSalaryInput,
  UpdateExpenseCategoryInput,
  VoidExpenseInput,
  CreateIncomeCategoryInput,
  IncomeCategoryView,
  IncomeVoucherView,
  RecordIncomeVoucherInput,
  RecordIncomeVoucherResult,
  TreasuryMovementDirection,
  TreasuryMovementsResult,
  UpdateIncomeCategoryInput,
  VoidIncomeVoucherInput,
  CollectorCollectionsResult,
  CollectorCustodyView,
  CollectorRoundView,
  ReceiveCustodyInput,
  ReceiveCustodyResult,
  TransferView,
  VoidTransferInput,
  CreateTransferInput,
  CreateTransferResult,
  ListTransfersQuery,
  ReviewTransferInput,
  TransferListResult,
  CreateTreasuryAccountInput,
  TreasuryAccountView,
} from '@mechanization/shared-schemas';

export type {
  ActivateTreasuryInput,
  ActivateTreasuryResult,
  TreasuryAccountView,
  TreasuryOverview,
  TreasuryRate,
  TreasuryStatement,
  TreasuryStatementEntry,
  CreateExpenseCategoryInput,
  ExpenseCategoryView,
  ExpenseListResult,
  ExpenseOrderStatus,
  ExpenseRequestListResult,
  ExpenseRequestStatus,
  ExpenseRequestView,
  ExpenseStatus,
  UpdateExpenseCategoryInput,
  ExpenseVoucherView,
  RecordExpenseInput,
  RecordExpenseResult,
  RejectExpenseRequestInput,
  RequestExpenseInput,
  RequestExpenseResult,
  RecordStaffSalaryInput,
  VoidExpenseInput,
  CreateIncomeCategoryInput,
  IncomeCategoryView,
  IncomeListResult,
  IncomeStatus,
  UpdateIncomeCategoryInput,
  IncomeVoucherView,
  RecordIncomeVoucherInput,
  RecordIncomeVoucherResult,
  VoidIncomeVoucherInput,
  TreasuryMovement,
  TreasuryMovementDay,
  TreasuryMovementDirection,
  TreasuryMovementTotal,
  TreasuryMovementsResult,
  CollectorCollectionRow,
  CollectorCollectionsResult,
  CollectorCustodyView,
  CollectorRoundCurrency,
  CollectorRoundRow,
  CollectorRoundView,
  ReceiveCustodyInput,
  ReceiveCustodyResult,
  TransferView,
  VoidTransferInput,
  CreateTransferInput,
  CreateTransferResult,
  ListTransfersQuery,
  ReviewTransferInput,
  TransferListResult,
  TransferKind,
  CreateTreasuryAccountInput,
} from '@mechanization/shared-schemas';

/** Every wallet with its balance, whether the treasury is live, and the rate to convert with. `GET /treasury`. */
export function getTreasuryOverview(tenant: string, token: string, _args?: undefined, signal?: AbortSignal) {
  return apiFetch<TreasuryOverview>(tenant, '/treasury', { token, signal });
}

/**
 * One wallet's movements inside a range, each with the balance after it.
 * `from` and `to` are dates (`YYYY-MM-DD`) on the municipality's calendar, and a date-only `to` runs to the end of
 * that day in Beirut. `limit` caps the rows at the NEWEST ones in the range, with the opening balance worked out for
 * the rows shown; the answer says when it cut the list short.
 */
export function getTreasuryStatement(
  tenant: string,
  token: string,
  args: { accountId: string; from?: string; to?: string; limit?: number },
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (args.from) query.set('from', args.from);
  if (args.to) query.set('to', args.to);
  if (args.limit !== undefined) query.set('limit', String(args.limit));
  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch<TreasuryStatement>(
    tenant,
    `/treasury/accounts/${encodeURIComponent(args.accountId)}/statement${suffix}`,
    { token, signal },
  );
}

/** «إضافة حساب» — a bank account or a petty-cash fund, opened empty. SUPER_ADMIN. `POST /treasury/accounts`. */
export function createTreasuryAccount(
  tenant: string,
  token: string,
  args: CreateTreasuryAccountInput,
  signal?: AbortSignal,
) {
  return apiFetch<TreasuryAccountView>(tenant, '/treasury/accounts', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/** «تفعيل الخزينة» — the counted opening balances, posted once. SUPER_ADMIN only. `POST /treasury/activate`. */
export function activateTreasury(
  tenant: string,
  token: string,
  args: ActivateTreasuryInput,
  signal?: AbortSignal,
) {
  return apiFetch<ActivateTreasuryResult>(tenant, '/treasury/activate', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/** «ما بعهدة الجباة» — what each collector is still carrying. `GET /treasury/transfers/custody`. */
export function getCollectorCustody(tenant: string, token: string, _args?: undefined, signal?: AbortSignal) {
  return apiFetch<CollectorCustodyView[]>(tenant, '/treasury/transfers/custody', { token, signal });
}

/**
 * «من حصّل الجابي» — the receipts behind one collector's custody balance.
 * `GET /treasury/transfers/custody/:collectorId/collections`.
 */
export function getCollectorCollections(
  tenant: string,
  token: string,
  args: { collectorId: string; limit?: number },
  signal?: AbortSignal,
) {
  const suffix = args.limit === undefined ? '' : `?limit=${args.limit}`;
  return apiFetch<CollectorCollectionsResult>(
    tenant,
    `/treasury/transfers/custody/${encodeURIComponent(args.collectorId)}/collections${suffix}`,
    { token, signal },
  );
}

/**
 * «جولتي» — the signed-in collector's own round: what is in his pocket, and
 * which doors it came from. `GET /treasury/transfers/custody/mine`.
 *
 * No id in the path on purpose — the server scopes it by the session, so there
 * is nothing here for a client to tamper with.
 */
export function getMyRound(tenant: string, token: string, _args?: undefined, signal?: AbortSignal) {
  return apiFetch<CollectorRoundView>(tenant, '/treasury/transfers/custody/mine', { token, signal });
}

/**
 * «سجل المناقلات» — newest first, filtered, with the count waiting for review.
 * `GET /treasury/transfers`.
 */
export function getTransfers(
  tenant: string,
  token: string,
  args: Partial<Omit<ListTransfersQuery, 'includeVoid'>> & { includeVoid?: boolean } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (args.kind) query.set('kind', args.kind);
  if (args.review) query.set('review', args.review);
  if (args.from) query.set('from', args.from);
  if (args.to) query.set('to', args.to);
  if (args.includeVoid) query.set('includeVoid', 'true');
  if (args.page) query.set('page', String(args.page));
  if (args.pageSize) query.set('pageSize', String(args.pageSize));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch<TransferListResult>(tenant, `/treasury/transfers${suffix}`, { token, signal });
}

/** One transfer, for its printed «سند». `GET /treasury/transfers/:id`. */
export function getTransfer(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<TransferView>(tenant, `/treasury/transfers/${encodeURIComponent(args.id)}`, { token, signal });
}

/**
 * «تحويل داخلي» or «مصارفة» — both legs and any fee, in one call.
 * ACCOUNTANT or SUPER_ADMIN. `POST /treasury/transfers`.
 */
export function createTransfer(tenant: string, token: string, args: CreateTransferInput, signal?: AbortSignal) {
  return apiFetch<CreateTransferResult>(tenant, '/treasury/transfers', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/** «اعتماد المراجعة». AUDITOR or SUPER_ADMIN. `POST /treasury/transfers/:id/review`. */
export function reviewTransfer(
  tenant: string,
  token: string,
  args: { id: string } & ReviewTransferInput,
  signal?: AbortSignal,
) {
  const { id, ...body } = args;
  return apiFetch<TransferView>(tenant, `/treasury/transfers/${encodeURIComponent(id)}/review`, {
    method: 'POST',
    token,
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * «استلام صندوق الجابي» — the counted cash leaves custody and reaches the safe.
 * ACCOUNTANT or SUPER_ADMIN. `POST /treasury/transfers/custody/receive`.
 */
export function receiveCollectorCustody(
  tenant: string,
  token: string,
  args: ReceiveCustodyInput,
  signal?: AbortSignal,
) {
  return apiFetch<ReceiveCustodyResult>(tenant, '/treasury/transfers/custody/receive', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/** Cancels a transfer and puts both legs back. SUPER_ADMIN only. `POST /treasury/transfers/:id/void`. */
export function voidTransfer(
  tenant: string,
  token: string,
  args: { id: string } & VoidTransferInput,
  signal?: AbortSignal,
) {
  const { id, ...body } = args;
  return apiFetch<TransferView>(tenant, `/treasury/transfers/${encodeURIComponent(id)}/void`, {
    method: 'POST',
    token,
    body: JSON.stringify(body),
    signal,
  });
}

/** The bands money may be spent under. `GET /treasury/expenses/categories`. */
export function getExpenseCategories(
  tenant: string,
  token: string,
  args?: { includeInactive?: boolean },
  signal?: AbortSignal,
) {
  const suffix = args?.includeInactive ? '?includeInactive=true' : '';
  return apiFetch<ExpenseCategoryView[]>(tenant, `/treasury/expenses/categories${suffix}`, { token, signal });
}

/** «بند صرف جديد». SUPER_ADMIN only. `POST /treasury/expenses/categories`. */
export function createExpenseCategory(
  tenant: string,
  token: string,
  args: CreateExpenseCategoryInput,
  signal?: AbortSignal,
) {
  return apiFetch<ExpenseCategoryView>(tenant, '/treasury/expenses/categories', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/**
 * Renames a band, re-codes it, or takes it out of use. Never deletes one.
 * SUPER_ADMIN only. `PATCH /treasury/expenses/categories/:id`.
 */
export function updateExpenseCategory(
  tenant: string,
  token: string,
  args: { id: string } & UpdateExpenseCategoryInput,
  signal?: AbortSignal,
) {
  const { id, ...body } = args;
  return apiFetch<ExpenseCategoryView>(
    tenant,
    `/treasury/expenses/categories/${encodeURIComponent(id)}`,
    { method: 'PATCH', token, body: JSON.stringify(body), signal },
  );
}

/**
 * The expense register, newest first. `GET /treasury/expenses`.
 *
 * `totals` covers the whole filtered set rather than the page, so «كم صرفنا على
 * المحروقات» is answered by the figure beside the table and not by adding up
 * what happens to be on screen.
 */
export function getExpenses(
  tenant: string,
  token: string,
  args: {
    from?: string;
    to?: string;
    categoryId?: string;
    accountId?: string;
    includeVoid?: boolean;
    /** Only paid vouchers still waiting for their payment order (an urgent payment, art. 35); never a cancelled one. */
    awaitingOrder?: boolean;
    page?: number;
    pageSize?: number;
  } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (args.from) query.set('from', args.from);
  if (args.to) query.set('to', args.to);
  if (args.categoryId) query.set('categoryId', args.categoryId);
  if (args.accountId) query.set('accountId', args.accountId);
  if (args.includeVoid) query.set('includeVoid', 'true');
  if (args.awaitingOrder) query.set('awaitingOrder', 'true');
  if (args.page !== undefined) query.set('page', String(args.page));
  if (args.pageSize !== undefined) query.set('pageSize', String(args.pageSize));
  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch<ExpenseListResult>(tenant, `/treasury/expenses${suffix}`, { token, signal });
}

/** One voucher. `GET /treasury/expenses/:id`. */
export function getExpense(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<ExpenseVoucherView>(tenant, `/treasury/expenses/${encodeURIComponent(args.id)}`, {
    token,
    signal,
  });
}

/**
 * «سجّل النفقة» — records the voucher and takes the money out, in one call.
 * ACCOUNTANT or SUPER_ADMIN. `POST /treasury/expenses`.
 *
 * The manager's recording is the payment order, so the voucher carries it. An
 * accountant is refused (`EXPENSE_ORDER_REQUIRED`) unless the input states an
 * `urgentReason` (art. 35); then it pays now and the voucher waits for the
 * manager's order (`orderStatus: 'AWAITING_ORDER'`). Anything else the
 * accountant prepares goes through `requestExpense`.
 */
export function recordExpense(tenant: string, token: string, args: RecordExpenseInput, signal?: AbortSignal) {
  return apiFetch<RecordExpenseResult>(tenant, '/treasury/expenses', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/**
 * «صرف راتب / أجر» to one staff member. `POST /treasury/expenses/salaries/:staffId`.
 * The server sets the payee and the category; the body cannot.
 */
export function recordStaffSalary(
  tenant: string,
  token: string,
  staffId: string,
  args: RecordStaffSalaryInput,
  signal?: AbortSignal,
) {
  return apiFetch<RecordExpenseResult>(tenant, `/treasury/expenses/salaries/${encodeURIComponent(staffId)}`, {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/** «إلغاء سند الصرف» — cancels it and puts the money back. SUPER_ADMIN only. `POST /treasury/expenses/:id/void`. */
export function voidExpense(
  tenant: string,
  token: string,
  args: { id: string } & VoidExpenseInput,
  signal?: AbortSignal,
) {
  const { id, ...body } = args;
  return apiFetch<ExpenseVoucherView>(tenant, `/treasury/expenses/${encodeURIComponent(id)}/void`, {
    method: 'POST',
    token,
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * «طلب أمر صرف» — the accountant prepares an expense for the manager's order.
 * Nothing leaves a wallet, so there is no date: the money leaves on the day of
 * the order. ACCOUNTANT or SUPER_ADMIN. `POST /treasury/expenses/requests`.
 */
export function requestExpense(tenant: string, token: string, args: RequestExpenseInput, signal?: AbortSignal) {
  return apiFetch<RequestExpenseResult>(tenant, '/treasury/expenses/requests', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/**
 * The requests for a payment order, newest first; by default only those still
 * waiting for the manager. `page` is 1-based. `GET /treasury/expenses/requests`.
 */
export function getExpenseRequests(
  tenant: string,
  token: string,
  args: { status?: ExpenseRequestStatus; page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (args.status) query.set('status', args.status);
  if (args.page !== undefined) query.set('page', String(args.page));
  if (args.pageSize !== undefined) query.set('pageSize', String(args.pageSize));
  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch<ExpenseRequestListResult>(tenant, `/treasury/expenses/requests${suffix}`, { token, signal });
}

/**
 * «أمر بالصرف» — the manager orders a request and the money leaves, in one
 * transaction. Refused with `TREASURY_INSUFFICIENT_FUNDS` when the wallet falls
 * short, and the request then stays waiting. SUPER_ADMIN only.
 * `POST /treasury/expenses/requests/:id/order`.
 */
export function orderExpenseRequest(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<RecordExpenseResult>(
    tenant,
    `/treasury/expenses/requests/${encodeURIComponent(args.id)}/order`,
    { method: 'POST', token, signal },
  );
}

/** «رفض الطلب» — declines a request, with the reason its author will read. SUPER_ADMIN only. `POST /treasury/expenses/requests/:id/reject`. */
export function rejectExpenseRequest(
  tenant: string,
  token: string,
  args: { id: string } & RejectExpenseRequestInput,
  signal?: AbortSignal,
) {
  const { id, ...body } = args;
  return apiFetch<ExpenseRequestView>(tenant, `/treasury/expenses/requests/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    token,
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * «سحب الطلب» — takes back a request that is still waiting. Its author or the
 * manager; anyone else is refused (`EXPENSE_REQUEST_NOT_YOURS`).
 * `POST /treasury/expenses/requests/:id/withdraw`.
 */
export function withdrawExpenseRequest(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<ExpenseRequestView>(
    tenant,
    `/treasury/expenses/requests/${encodeURIComponent(args.id)}/withdraw`,
    { method: 'POST', token, signal },
  );
}

/**
 * «إصدار أمر الصرف» for an urgent payment already made (art. 35): stamps the
 * manager's order on the voucher, once. The money has moved already, so no
 * balance changes. SUPER_ADMIN only. `POST /treasury/expenses/:id/order`.
 */
export function regularizeExpense(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<ExpenseVoucherView>(tenant, `/treasury/expenses/${encodeURIComponent(args.id)}/order`, {
    method: 'POST',
    token,
    signal,
  });
}

// ── الإيرادات العامة (stage 2) ──────────────────────────────────────────────

/** Where income may be filed. `GET /treasury/income/categories`. */
export function getIncomeCategories(
  tenant: string,
  token: string,
  args?: { includeInactive?: boolean },
  signal?: AbortSignal,
) {
  const suffix = args?.includeInactive ? '?includeInactive=true' : '';
  return apiFetch<IncomeCategoryView[]>(tenant, `/treasury/income/categories${suffix}`, { token, signal });
}

/** «بند إيراد جديد». SUPER_ADMIN only. `POST /treasury/income/categories`. */
export function createIncomeCategory(
  tenant: string,
  token: string,
  args: CreateIncomeCategoryInput,
  signal?: AbortSignal,
) {
  return apiFetch<IncomeCategoryView>(tenant, '/treasury/income/categories', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/**
 * Renames an income category, re-codes it, or stops or restarts it. Never
 * deletes one. SUPER_ADMIN only. `PATCH /treasury/income/categories/:id`.
 */
export function updateIncomeCategory(
  tenant: string,
  token: string,
  args: { id: string } & UpdateIncomeCategoryInput,
  signal?: AbortSignal,
) {
  const { id, ...body } = args;
  return apiFetch<IncomeCategoryView>(tenant, `/treasury/income/categories/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    token,
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * «الحركات المالية» — the income and the expense vouchers in one register,
 * newest first. `GET /treasury/movements`, on `TREASURY_READ_ROLES`.
 *
 * `from` and `to` are days on the municipality's calendar, both inclusive.
 * `categoryId` needs `direction`: an income category and an expense band are
 * rows of two tables. `totals` and `days` cover the whole filtered set, not the
 * page, so a day split over two pages still reads whole.
 */
export function getTreasuryMovements(
  tenant: string,
  token: string,
  args: {
    direction?: TreasuryMovementDirection;
    from?: string;
    to?: string;
    accountId?: string;
    categoryId?: string;
    currency?: string;
    search?: string;
    includeVoid?: boolean;
    page?: number;
    pageSize?: number;
  } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (args.direction) query.set('direction', args.direction);
  if (args.from) query.set('from', args.from);
  if (args.to) query.set('to', args.to);
  if (args.accountId) query.set('accountId', args.accountId);
  if (args.categoryId) query.set('categoryId', args.categoryId);
  if (args.currency) query.set('currency', args.currency);
  if (args.search) query.set('search', args.search);
  if (args.includeVoid) query.set('includeVoid', 'true');
  if (args.page !== undefined) query.set('page', String(args.page));
  if (args.pageSize !== undefined) query.set('pageSize', String(args.pageSize));
  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch<TreasuryMovementsResult>(tenant, `/treasury/movements${suffix}`, { token, signal });
}

/** One voucher. `GET /treasury/income/:id`. */
export function getIncomeVoucher(tenant: string, token: string, args: { id: string }, signal?: AbortSignal) {
  return apiFetch<IncomeVoucherView>(tenant, `/treasury/income/${encodeURIComponent(args.id)}`, {
    token,
    signal,
  });
}

/**
 * «سجّل الإيراد» — records the voucher and credits the wallet, in one call.
 * ACCOUNTANT or SUPER_ADMIN. `POST /treasury/income`.
 */
export function recordIncomeVoucher(
  tenant: string,
  token: string,
  args: RecordIncomeVoucherInput,
  signal?: AbortSignal,
) {
  return apiFetch<RecordIncomeVoucherResult>(tenant, '/treasury/income', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/**
 * «إلغاء سند القبض» — cancels it and takes the money back out; refused when the
 * wallet has spent it since. SUPER_ADMIN only. `POST /treasury/income/:id/void`.
 */
export function voidIncomeVoucher(
  tenant: string,
  token: string,
  args: { id: string } & VoidIncomeVoucherInput,
  signal?: AbortSignal,
) {
  const { id, ...body } = args;
  return apiFetch<IncomeVoucherView>(tenant, `/treasury/income/${encodeURIComponent(id)}/void`, {
    method: 'POST',
    token,
    body: JSON.stringify(body),
    signal,
  });
}

// ── جرد الصندوق وإقفال اليومية (stage 5) ────────────────────────────────────

import type {
  CloseDayInput,
  CloseDayResult,
  DailyCashReport,
  DailyCountSheet,
  RecordDailyCountInput,
  ReopenDayInput,
  TreasuryDayClosureView,
  TreasuryDayState,
} from '@mechanization/shared-schemas';

export type {
  CloseDayInput,
  CloseDayResult,
  CountedWalletView,
  DailyCashReport,
  DailyCashReportCustody,
  DailyCashReportTotal,
  DailyCashReportWallet,
  DailyCountLineView,
  DailyCountSheet,
  DailyCountView,
  DayClosureVerdict,
  RecordDailyCountInput,
  ReopenDayInput,
  TreasuryDayClosureView,
  TreasuryDayEvent,
  TreasuryDayState,
  TreasuryDayStatus,
} from '@mechanization/shared-schemas';

/**
 * «جرد وإقفال اليومية» for one day — or, with no `date`, for the day that needs
 * closing next. `GET /treasury/counts`.
 */
export function getDailyCountSheet(
  tenant: string,
  token: string,
  args: { date?: string } = {},
  signal?: AbortSignal,
) {
  const suffix = args.date ? `?date=${encodeURIComponent(args.date)}` : '';
  return apiFetch<DailyCountSheet>(tenant, `/treasury/counts${suffix}`, { token, signal });
}

/**
 * «سجّل الجرد» — one or more wallets counted for one day; answers with the sheet
 * as it now stands. ACCOUNTANT or SUPER_ADMIN. `POST /treasury/counts`.
 */
export function recordDailyCount(tenant: string, token: string, args: RecordDailyCountInput, signal?: AbortSignal) {
  return apiFetch<DailyCountSheet>(tenant, '/treasury/counts', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/** «أقفل اليومية». ACCOUNTANT or SUPER_ADMIN. `POST /treasury/closures`. */
export function closeTreasuryDay(tenant: string, token: string, args: CloseDayInput, signal?: AbortSignal) {
  return apiFetch<CloseDayResult>(tenant, '/treasury/closures', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/** «أعد فتح اليومية» — the latest closed day, with a reason. SUPER_ADMIN only. `POST /treasury/closures/reopen`. */
export function reopenTreasuryDay(tenant: string, token: string, args: ReopenDayInput, signal?: AbortSignal) {
  return apiFetch<TreasuryDayState>(tenant, '/treasury/closures/reopen', {
    method: 'POST',
    token,
    body: JSON.stringify(args),
    signal,
  });
}

/** The closed and reopened days, latest first. `GET /treasury/closures`. */
export function getTreasuryClosures(
  tenant: string,
  token: string,
  args: { limit?: number } = {},
  signal?: AbortSignal,
) {
  const suffix = args.limit === undefined ? '' : `?limit=${args.limit}`;
  return apiFetch<TreasuryDayClosureView[]>(tenant, `/treasury/closures${suffix}`, { token, signal });
}

/** «تقرير الصندوق اليومي». `GET /treasury/reports/daily`. */
export function getDailyCashReport(tenant: string, token: string, args: { date: string }, signal?: AbortSignal) {
  return apiFetch<DailyCashReport>(tenant, `/treasury/reports/daily?date=${encodeURIComponent(args.date)}`, {
    token,
    signal,
  });
}


import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  createExpenseCategorySchema,
  recordExpenseSchema,
  recordStaffSalarySchema,
  rejectExpenseRequestSchema,
  requestExpenseSchema,
  updateExpenseCategorySchema,
  voidExpenseSchema,
  EXPENSE_REQUEST_STATUSES,
  TREASURY_ADMIN_ROLES,
  TREASURY_READ_ROLES,
  TREASURY_WORK_ROLES,
  type CreateExpenseCategoryInput,
  type ExpenseRequestStatus,
  type RecordExpenseInput,
  type RecordStaffSalaryInput,
  type RejectExpenseRequestInput,
  type RequestExpenseInput,
  type UpdateExpenseCategoryInput,
  type VoidExpenseInput,
} from '@mechanization/shared-schemas';
import { ValidationError } from '../../application/common/exceptions';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { ExpensesService } from '../../application/features/treasury/expenses.service';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import { optionalInt, requireRangeEnd, requireRangeStart } from './query-params';

/** A request status from a query string, or nothing; anything else refuses (non-negotiable 6). */
function requestStatus(value: string | undefined): ExpenseRequestStatus | undefined {
  if (value === undefined || value === '') return undefined;
  if ((EXPENSE_REQUEST_STATUSES as readonly string[]).includes(value)) return value as ExpenseRequestStatus;
  throw new ValidationError({ code: 'INVALID_QUERY_VALUE', message: `Not a request status: ${value}` });
}

/**
 * النفقات — «أمر صرف» (docs/finance.md §5).
 *
 * Three role lists, mirroring the product decision rather than the shape of the
 * data: everyone with finance sight reads; the accountant and the manager
 * record, request and pay salaries; and only the manager gives the payment
 * order «أمر الصرف» (decree 5595/1982 art. 28 and 33, docs/finance.md §5.1) —
 * ordering a request, rejecting one, regularising an urgent payment — and
 * cancels. The manager's own voucher is the order. An accountant's is a
 * request, or an art. 35 urgent payment (with its reason, under the manager's
 * ceiling, a salary's reason written by the server) that waits for the order.
 */
@Controller('t/:tenantSlug/treasury/expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  /** The bands money may be spent under. */
  @Roles(...TREASURY_READ_ROLES)
  @Get('categories')
  categories(@Query('includeInactive') includeInactive?: string) {
    return this.expenses.categories(includeInactive === 'true');
  }

  /** «بند صرف جديد» — the municipality names its own band of spending. Manager only. */
  @Roles(...TREASURY_ADMIN_ROLES)
  @Post('categories')
  createCategory(
    @Body(new ZodValidationPipe(createExpenseCategorySchema)) body: CreateExpenseCategoryInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.expenses.createCategory(body, { id: user.sub, role: user.role ?? '' });
  }

  /** Renames a band, re-codes it, or takes it out of use. Never deletes one. */
  @Roles(...TREASURY_ADMIN_ROLES)
  @Patch('categories/:id')
  updateCategory(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateExpenseCategorySchema)) body: UpdateExpenseCategoryInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.expenses.updateCategory(id, body, { id: user.sub, role: user.role ?? '' });
  }

  /** The register, newest first, with what the filtered set adds up to. */
  @Roles(...TREASURY_READ_ROLES)
  @Get()
  list(
    @Query('from') from?: string,
    @Query('to') to?: string,
    // Validated like a path id (non-negotiable 6): an unreadable one is a 400, not a database error.
    @Query('categoryId', new ParseUUIDPipe({ optional: true })) categoryId?: string,
    @Query('accountId', new ParseUUIDPipe({ optional: true })) accountId?: string,
    @Query('includeVoid') includeVoid?: string,
    @Query('awaitingOrder') awaitingOrder?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.expenses.list({
      // A figure, so an unreadable date refuses rather than quietly widening the range; a bare day is Beirut's.
      from: requireRangeStart(from),
      to: requireRangeEnd(to),
      categoryId,
      accountId,
      includeVoid: includeVoid === 'true',
      awaitingOrder: awaitingOrder === 'true',
      page: optionalInt(page),
      pageSize: optionalInt(pageSize),
    });
  }

  /**
   * Declared before `:id`, or it would be read as one. The manager's recording
   * is the payment order; an accountant's is refused unless it says why it is
   * urgent (decree 5595/1982 art. 35) — otherwise it goes to `requests`.
   */
  @Roles(...TREASURY_WORK_ROLES)
  @Post()
  record(
    @Body(new ZodValidationPipe(recordExpenseSchema)) body: RecordExpenseInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.expenses.record(body, { id: user.sub, role: user.role ?? '' });
  }

  // ─────────────────────  «أمر الصرف» — requests and orders  ─────────────────────
  // All declared before `:id`, which would otherwise read "requests" as an id.

  /** The requests — by default those still waiting for the manager's order. */
  @Roles(...TREASURY_READ_ROLES)
  @Get('requests')
  requests(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.expenses.listRequests({
      status: requestStatus(status),
      page: optionalInt(page),
      pageSize: optionalInt(pageSize),
    });
  }

  /** «طلب أمر صرف» — the accountant prepares an expense; nothing leaves a wallet yet. */
  @Roles(...TREASURY_WORK_ROLES)
  @Post('requests')
  requestPayment(
    @Body(new ZodValidationPipe(requestExpenseSchema)) body: RequestExpenseInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.expenses.requestPayment(body, { id: user.sub, role: user.role ?? '' });
  }

  /** «إصدار أمر الصرف» — the manager orders a request, and the money leaves. */
  @Roles(...TREASURY_ADMIN_ROLES)
  @Post('requests/:id/order')
  orderRequest(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: SessionClaims) {
    return this.expenses.orderRequest(id, { id: user.sub, role: user.role ?? '' });
  }

  /** «رفض الطلب» — the manager declines a request, with a reason. */
  @Roles(...TREASURY_ADMIN_ROLES)
  @Post('requests/:id/reject')
  rejectRequest(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(rejectExpenseRequestSchema)) body: RejectExpenseRequestInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.expenses.rejectRequest(id, body.reason, { id: user.sub, role: user.role ?? '' });
  }

  /** «سحب الطلب» — its author (or the manager) takes back a request still waiting. */
  @Roles(...TREASURY_WORK_ROLES)
  @Post('requests/:id/withdraw')
  withdrawRequest(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: SessionClaims) {
    return this.expenses.withdrawRequest(id, { id: user.sub, role: user.role ?? '' });
  }

  /**
   * «صرف راتب / أجر» — a salary paid to the staff member in the path, from the
   * staff page. The same role list as recording any expense: it is one. The
   * payee and the category are the server's to set, never the body's, and so
   * is an accountant's art. 35 reason: his payout is `AWAITING_ORDER`, the
   * manager's `ORDERED` (`orderStatus` in the result).
   */
  @Roles(...TREASURY_WORK_ROLES)
  @Post('salaries/:staffId')
  recordSalary(
    @Param('staffId', new ParseUUIDPipe()) staffId: string,
    @Body(new ZodValidationPipe(recordStaffSalarySchema)) body: RecordStaffSalaryInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.expenses.recordSalary(staffId, body, { id: user.sub, role: user.role ?? '' });
  }

  @Roles(...TREASURY_READ_ROLES)
  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.expenses.get(id);
  }

  /** «تسوية بأمر صرف» — the manager's order for an urgent payment already made (art. 35). */
  @Roles(...TREASURY_ADMIN_ROLES)
  @Post(':id/order')
  regularize(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: SessionClaims) {
    return this.expenses.regularize(id, { id: user.sub, role: user.role ?? '' });
  }

  /** «إلغاء سند الصرف»: the manager's alone, and it puts the money back. */
  @Roles(...TREASURY_ADMIN_ROLES)
  @Post(':id/void')
  void(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(voidExpenseSchema)) body: VoidExpenseInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.expenses.void(id, body.reason, { id: user.sub, role: user.role ?? '' });
  }
}

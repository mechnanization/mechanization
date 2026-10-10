import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  createExpenseCategorySchema,
  recordExpenseSchema,
  recordStaffSalarySchema,
  updateExpenseCategorySchema,
  voidExpenseSchema,
  TREASURY_ADMIN_ROLES,
  TREASURY_READ_ROLES,
  TREASURY_WORK_ROLES,
  type CreateExpenseCategoryInput,
  type RecordExpenseInput,
  type RecordStaffSalaryInput,
  type UpdateExpenseCategoryInput,
  type VoidExpenseInput,
} from '@mechanization/shared-schemas';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { ExpensesService } from '../../application/features/treasury/expenses.service';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import { requireDate } from './query-params';

/**
 * النفقات — «أمر صرف» (docs/finance.md §5).
 *
 * Three role lists, mirroring the product decision rather than the shape of the
 * data: everyone with finance sight reads, the accountant and the manager
 * record and pay, and only the manager cancels. There is no approval route
 * because there is no approval step.
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
    @Query('categoryId') categoryId?: string,
    @Query('accountId') accountId?: string,
    @Query('includeVoid') includeVoid?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const toInt = (raw: string | undefined): number | undefined => {
      if (raw === undefined) return undefined;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    return this.expenses.list({
      // A figure, so an unreadable date refuses rather than quietly widening the range.
      from: requireDate(from),
      to: requireDate(to),
      categoryId,
      accountId,
      includeVoid: includeVoid === 'true',
      page: toInt(page),
      pageSize: toInt(pageSize),
    });
  }

  /** Declared before `:id`, or it would be read as one. */
  @Roles(...TREASURY_WORK_ROLES)
  @Post()
  record(
    @Body(new ZodValidationPipe(recordExpenseSchema)) body: RecordExpenseInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.expenses.record(body, { id: user.sub, role: user.role ?? '' });
  }

  /**
   * «صرف راتب / أجر» — a salary paid to the staff member in the path, from the
   * staff page. The same role list as recording any expense: it is one. The
   * payee and the category are the server's to set, never the body's.
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

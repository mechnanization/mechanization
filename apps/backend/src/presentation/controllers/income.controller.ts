import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  createIncomeCategorySchema,
  listIncomeVouchersQuerySchema,
  recordIncomeVoucherSchema,
  updateIncomeCategorySchema,
  voidIncomeVoucherSchema,
  TREASURY_ADMIN_ROLES,
  TREASURY_READ_ROLES,
  TREASURY_WORK_ROLES,
  type CreateIncomeCategoryInput,
  type ListIncomeVouchersQuery,
  type RecordIncomeVoucherInput,
  type UpdateIncomeCategoryInput,
  type VoidIncomeVoucherInput,
} from '@mechanization/shared-schemas';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { IncomeService } from '../../application/features/treasury/income.service';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';

/**
 * الإيرادات العامة — «سند قبض إيرادات» (docs/finance.md §4).
 *
 * The expense controller's three role lists, for the same product decision:
 * everyone with finance sight reads, the accountant and the manager record,
 * and only the manager cancels and manages the categories (§4.3, §9).
 */
@Controller('t/:tenantSlug/treasury/income')
export class IncomeController {
  constructor(private readonly income: IncomeService) {}

  /** Where income may be filed. Declared before `:id`, or it would be read as one. */
  @Roles(...TREASURY_READ_ROLES)
  @Get('categories')
  categories(@Query('includeInactive') includeInactive?: string) {
    return this.income.categories(includeInactive === 'true');
  }

  /** «بند إيراد جديد» — the municipality names its own source of income. Manager only. */
  @Roles(...TREASURY_ADMIN_ROLES)
  @Post('categories')
  createCategory(
    @Body(new ZodValidationPipe(createIncomeCategorySchema)) body: CreateIncomeCategoryInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.income.createCategory(body, { id: user.sub, role: user.role ?? '' });
  }

  /** Renames a category, re-codes it, or stops or restarts it. Never deletes one. Manager only. */
  @Roles(...TREASURY_ADMIN_ROLES)
  @Patch('categories/:id')
  updateCategory(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateIncomeCategorySchema)) body: UpdateIncomeCategoryInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.income.updateCategory(id, body, { id: user.sub, role: user.role ?? '' });
  }

  /** The register, newest first, with what the filtered set adds up to. */
  @Roles(...TREASURY_READ_ROLES)
  @Get()
  list(@Query(new ZodValidationPipe(listIncomeVouchersQuerySchema)) query: ListIncomeVouchersQuery) {
    return this.income.list(query);
  }

  /** «سجّل الإيراد»: the voucher and the money, together. */
  @Roles(...TREASURY_WORK_ROLES)
  @Post()
  record(
    @Body(new ZodValidationPipe(recordIncomeVoucherSchema)) body: RecordIncomeVoucherInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.income.record(body, { id: user.sub, role: user.role ?? '' });
  }

  @Roles(...TREASURY_READ_ROLES)
  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.income.get(id);
  }

  /** «إلغاء سند القبض»: the manager's alone, and refused if the wallet has spent the money. */
  @Roles(...TREASURY_ADMIN_ROLES)
  @Post(':id/void')
  void(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(voidIncomeVoucherSchema)) body: VoidIncomeVoucherInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.income.void(id, body.reason, { id: user.sub, role: user.role ?? '' });
  }
}

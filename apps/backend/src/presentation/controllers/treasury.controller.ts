import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  activateTreasurySchema,
  createTreasuryAccountSchema,
  listTreasuryMovementsQuerySchema,
  TREASURY_ADMIN_ROLES,
  TREASURY_READ_ROLES,
  type ActivateTreasuryInput,
  type CreateTreasuryAccountInput,
  type ListTreasuryMovementsQuery,
} from '@mechanization/shared-schemas';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { TreasuryMovementsService } from '../../application/features/treasury/treasury-movements.service';
import { TreasuryService } from '../../application/features/treasury/treasury.service';
import { CurrentActor } from '../decorators/current-actor.decorator';
import { StaffActor } from '../../application/common/actor';
import { Roles } from '../decorators/roles.decorator';
import { optionalInt, requireRangeEnd, requireRangeStart } from './query-params';
import { UuidPipe } from '../pipes/uuid.pipe';

/**
 * الخزينة — the wallets and the ledger behind them (docs/finance.md).
 *
 * Reading is open to every finance-facing staff role; activating the treasury
 * is the manager's alone, and so is opening a wallet. The routes that move
 * money (income, expenses, transfers) have their own controllers; the register
 * that reads their vouchers together («الإيرادات والنفقات») is here.
 */
@Controller('t/:tenantSlug/treasury')
export class TreasuryController {
  constructor(
    private readonly treasury: TreasuryService,
    private readonly movementsRegister: TreasuryMovementsService,
  ) {}

  /** Every wallet with its balance, whether the treasury is live, and the rate to convert with. */
  @Roles(...TREASURY_READ_ROLES)
  @Get()
  overview() {
    return this.treasury.overview();
  }

  /** One wallet's movements, each with the balance after it. */
  @Roles(...TREASURY_READ_ROLES)
  @Get('accounts/:accountId/statement')
  statement(
    @Param('accountId', new UuidPipe()) accountId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    /*
      A figure, so a date that will not parse refuses rather than silently
      widening the range, and a bare day is that day in Beirut — `to=2026-10-08`
      includes the 8th, which is what makes a one-day range the day's register.
    */
    return this.treasury.statement(accountId, {
      from: requireRangeStart(from),
      to: requireRangeEnd(to),
      limit: optionalInt(limit),
    });
  }

  /**
   * «الإيرادات والنفقات»: the income and expense vouchers in one register, newest
   * first, with the filtered set's totals and each listed day's whole totals.
   * Read only; the same readers as the two registers it joins.
   */
  @Roles(...TREASURY_READ_ROLES)
  @Get('movements')
  movements(@Query(new ZodValidationPipe(listTreasuryMovementsQuerySchema)) query: ListTreasuryMovementsQuery) {
    return this.movementsRegister.list(query);
  }

  /** «تفعيل الخزينة»: the counted opening balances, posted once. */
  @Roles(...TREASURY_ADMIN_ROLES)
  @Post('activate')
  activate(
    @Body(new ZodValidationPipe(activateTreasurySchema)) body: ActivateTreasuryInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.treasury.activate(body, actor);
  }

  /** «إضافة حساب»: a bank account or a petty-cash fund, opened empty. */
  @Roles(...TREASURY_ADMIN_ROLES)
  @Post('accounts')
  createAccount(
    @Body(new ZodValidationPipe(createTreasuryAccountSchema)) body: CreateTreasuryAccountInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.treasury.createAccount(body, actor);
  }
}

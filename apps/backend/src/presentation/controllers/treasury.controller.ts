import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  activateTreasurySchema,
  createTreasuryAccountSchema,
  TREASURY_ADMIN_ROLES,
  TREASURY_READ_ROLES,
  type ActivateTreasuryInput,
  type CreateTreasuryAccountInput,
} from '@mechanization/shared-schemas';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { TreasuryService } from '../../application/features/treasury/treasury.service';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import { requireDate } from './query-params';

/**
 * الخزينة — the wallets and the ledger behind them (docs/finance.md).
 *
 * Reading is open to every finance-facing staff role; activating the treasury
 * is the manager's alone, and so is opening a wallet. The routes that move
 * money (income, expenses, transfers) have their own controllers.
 */
@Controller('t/:tenantSlug/treasury')
export class TreasuryController {
  constructor(private readonly treasury: TreasuryService) {}

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
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    // A figure, so a date that will not parse refuses rather than silently widening the range.
    const parsed = limit === undefined ? undefined : Number.parseInt(limit, 10);
    return this.treasury.statement(accountId, {
      from: requireDate(from),
      to: requireDate(to),
      limit: parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
    });
  }

  /** «تفعيل الخزينة»: the counted opening balances, posted once. */
  @Roles(...TREASURY_ADMIN_ROLES)
  @Post('activate')
  activate(
    @Body(new ZodValidationPipe(activateTreasurySchema)) body: ActivateTreasuryInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.treasury.activate(body, { id: user.sub, role: user.role ?? '' });
  }

  /** «إضافة حساب»: a bank account or a petty-cash fund, opened empty. */
  @Roles(...TREASURY_ADMIN_ROLES)
  @Post('accounts')
  createAccount(
    @Body(new ZodValidationPipe(createTreasuryAccountSchema)) body: CreateTreasuryAccountInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.treasury.createAccount(body, { id: user.sub, role: user.role ?? '' });
  }
}

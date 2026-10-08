import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  receiveCustodySchema,
  voidTransferSchema,
  TREASURY_ADMIN_ROLES,
  TREASURY_READ_ROLES,
  TREASURY_WORK_ROLES,
  WORKING_STAFF_ROLES,
  type ReceiveCustodyInput,
  type VoidTransferInput,
} from '@mechanization/shared-schemas';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { TransfersService } from '../../application/features/treasury/transfers.service';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';

/**
 * المناقلات — money between the municipality's own wallets (docs/finance.md §6).
 *
 * The same three role lists as the rest of the treasury: everyone with finance
 * sight reads, the accountant and the manager move money, and only the manager
 * cancels. A collector has none of them — he takes cash at a door, and the
 * person who receives it from him is someone else, which is the control.
 */
@Controller('t/:tenantSlug/treasury/transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  /** «ما بعهدة الجباة» — what each collector is still carrying. Declared before `:id`. */
  @Roles(...TREASURY_READ_ROLES)
  @Get('custody')
  custody() {
    return this.transfers.custody();
  }

  /**
   * «جولتي» — the signed-in collector's own round.
   *
   * The one treasury route outside the three role lists, and the only one a
   * collector may call. It is scoped by `user.sub` in the query rather than by
   * a check afterwards, so there is no id to tamper with — the same shape as
   * `inspector/me/profile`, and the reason the path says `mine` rather than
   * taking a parameter. A man is owed the answer to «كم بجيبتي؟» without being
   * given sight of the municipality's books.
   *
   * `WORKING_STAFF_ROLES` rather than `COLLECTOR`, because nothing restricts
   * who may be named on a payment and in practice it is field inspectors who
   * carry the cash. Staff who hold no custody get an empty round, not a 403:
   * being told "nothing on your name" is the correct answer to the question.
   */
  @Roles(...WORKING_STAFF_ROLES)
  @Get('custody/mine')
  myRound(@CurrentUser() user: SessionClaims) {
    return this.transfers.myRound(user.sub);
  }

  /**
   * «من حصّل الجابي» — the receipts behind one collector's custody balance.
   *
   * Reading sight only: this names citizens, so it stays on the finance read
   * roles and carries no رقم مرجعي, which is a sign-in credential and has no
   * business on a reconciliation screen.
   */
  @Roles(...TREASURY_READ_ROLES)
  @Get('custody/:collectorId/collections')
  collections(
    @Param('collectorId', new ParseUUIDPipe()) collectorId: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = limit === undefined ? undefined : Number.parseInt(limit, 10);
    return this.transfers.collections(
      collectorId,
      parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
    );
  }

  /** The transfers recorded, newest first. */
  @Roles(...TREASURY_READ_ROLES)
  @Get()
  list(@Query('limit') limit?: string) {
    const parsed = limit === undefined ? undefined : Number.parseInt(limit, 10);
    return this.transfers.list(parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined);
  }

  /** «استلام صندوق الجابي»: the counted cash leaves custody and reaches the safe. */
  @Roles(...TREASURY_WORK_ROLES)
  @Post('custody/receive')
  receiveCustody(
    @Body(new ZodValidationPipe(receiveCustodySchema)) body: ReceiveCustodyInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.transfers.receiveCustody(body, { id: user.sub, role: user.role ?? '' });
  }

  /** Cancels a transfer and puts both legs back. The manager's alone. */
  @Roles(...TREASURY_ADMIN_ROLES)
  @Post(':id/void')
  void(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(voidTransferSchema)) body: VoidTransferInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.transfers.void(id, body.reason, { id: user.sub, role: user.role ?? '' });
  }
}

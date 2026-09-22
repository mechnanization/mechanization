import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  chargeCitizenSchema,
  createFeeNoticeSchema,
  declarePaymentSchema,
  noticeActiveSchema,
  reverseTransactionSchema,
  reviewPaymentSchema,
  settlePaymentSchema,
  systemSettingsSchema,
  type ChargeCitizen,
  type CreateFeeNotice,
  type DeclarePayment,
  type SettlePayment,
  type SystemSettingsInput,
} from '@mechanization/shared-schemas';
import { FeesService } from '../../application/features/fees/fees.service';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Public } from '../decorators/public.decorator';
import { Roles } from '../decorators/roles.decorator';
import { APP_CONFIG } from '../config/app.config';
import { ForbiddenError } from '../../application/common/exceptions';
import type { SessionClaims } from '../../application/features/identity/identity.service';

/**
 * Fees, invoices, and the settings the citizen portal quotes.
 *
 * Two audiences share this controller because they share the data, but not the
 * routes: everything under `/payments/mine` is scoped to the signed-in citizen
 * by their own token, and everything else is staff-gated. The split is by path
 * rather than by guard so it is visible in the route table.
 */
@Controller('t/:tenantSlug/fees')
export class FeesController {
  private readonly logger = new Logger(FeesController.name);

  // `RecurringBillingJob` is deliberately not injected here. It is the
  // cross-tenant job, and this controller is mounted under `t/:tenantSlug`;
  // having it in reach is how `recurring/run` came to bill every municipality.
  constructor(private readonly fees: FeesService) {}

  // ───────────────────────────  Settings  ───────────────────────────

  /**
   * Readable by any signed-in user, including citizens: the portal has to
   * print the Whish number and the office hours on the payment instructions.
   * Nothing else lives on this record.
   */
  /**
   * @param includeLogo `'true'` to include the crest.
   *
   * Opt-in, not role-derived. Gating it on "is this staff" was the obvious
   * thing and the wrong one: the crest is a data URI in the hundreds of
   * kilobytes, and the fees screen, the payments screen and every citizen
   * profile also read this endpoint — for a phone number and some opening
   * hours. All three were downloading the logo on every load and using none of
   * it. Only the settings form asks for it now.
   */
  @Get('settings')
  async getSettings(
    @CurrentUser() user: SessionClaims,
    @Query('includeLogo') includeLogo?: string,
  ) {
    // Still staff-only when asked for — a citizen cannot opt in.
    return this.fees.getSettings(includeLogo === 'true' && Boolean(user.role));
  }

  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  @Patch('settings')
  async updateSettings(
    @Body(new ZodValidationPipe(systemSettingsSchema)) body: SystemSettingsInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.fees.updateSettings(body, { id: user.sub, role: user.role ?? '' });
  }

  // ──────────────────────────  Fee notices  ──────────────────────────

  @Roles('SUPER_ADMIN', 'AUDITOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER')
  @Get('notices')
  async listNotices() {
    return { items: await this.fees.listNotices() };
  }

  /**
   * Issuing a fee bills every matching citizen at once, so it is limited to
   * the roles that own the municipality's billing — SUPER_ADMIN, ACCOUNTANT
   * and COLLECTOR. An AUDITOR reads the books, it does not add to them.
   */
  @Roles('SUPER_ADMIN', 'COLLECTOR', 'ACCOUNTANT')
  @Post('notices')
  async issue(
    @Body(new ZodValidationPipe(createFeeNoticeSchema)) body: CreateFeeNotice,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.fees.issue(body, { id: user.sub, role: user.role ?? '' });
  }

  @Roles('SUPER_ADMIN', 'AUDITOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER')
  @Get('summary')
  async summary() {
    return this.fees.summary();
  }

  /** Stops or resumes the recurring biller for one notice. */
  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  @Patch('notices/:id/active')
  async setNoticeActive(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(noticeActiveSchema)) body: { isActive: boolean },
  ) {
    return this.fees.setNoticeActive(id, body.isActive);
  }

  /**
   * Runs the recurring biller now for **this municipality**, instead of waiting
   * for tonight's cron.
   *
   * Deliberately safe to press twice: the job is idempotent within a period,
   * so a clerk who clicks it again gets "0 new invoices" rather than a second
   * round of bills.
   *
   * This used to call `runForAllTenants`, on a route that is otherwise
   * tenant-scoped in every respect — the URL carries the municipality, the
   * guard resolves its schema, and every other endpoint on this controller
   * reads and writes only that one. An ACCOUNTANT in Albazourieh pressing it
   * issued invoices in Zahle and in every other municipality on the platform,
   * synchronously, with the audit rows there attributed to SYSTEM rather than
   * to them. Nothing in the UI said so; the button reads «إصدار الفواتير».
   *
   * The platform-wide run has not been removed, it just is not here: the
   * scheduler drives it through `InternalCronController`, behind `CRON_SECRET`
   * and with no municipality in the URL to be misread. That is the right shape
   * for a job that crosses tenants, and a staff role is the wrong key for it.
   *
   * `tenants: 1` is kept in the response so the existing client keeps reading
   * it — and because "one" is now the honest answer.
   */
  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  @Post('recurring/run')
  async runRecurring() {
    const result = await this.fees.runRecurringBilling();
    return { tenants: 1, ...result };
  }

  // ──────────────────────  Staff payment ledger  ──────────────────────

  /**
   * Every invoice, filterable by status, method and by who owes it.
   *
   * `transactionsOnly` flips this from the fees ledger's question ("what is
   * owed") to سجل العمليات' question ("what has been paid"), which also
   * re-orders it by when the money moved. One endpoint rather than two because
   * it is the same rows and the same projection — only the WHERE and ORDER BY
   * differ, and a second route would have drifted from this one the first time
   * a field was added.
   */
  /**
   * Returns distinct fee titles registered across the municipality.
   */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER')
  @Get('titles')
  async listTitles() {
    return this.fees.listDistinctTitles();
  }

  /**
   * What the two money screens' filters may offer — read off the ledger.
   *
   * Same roles as the ledger itself: an option the reader cannot then apply
   * is worse than no option.
   */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER')
  @Get('filter-options')
  async filterOptions() {
    return this.fees.filterOptions();
  }

  @Roles('SUPER_ADMIN', 'AUDITOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER')
  @Get('payments')
  async listPayments(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('feeTitle') feeTitle?: string,
    /** Narrows the ledger to one citizen — the «عرض» drill-down. */
    @Query('citizenId') citizenId?: string,
    @Query('method') method?: string,
    @Query('transactionsOnly') transactionsOnly?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    // `{ items, total }` — the count is what lets the table say "صفحة 2 من 9"
    // rather than counting the rows it happens to be holding.
    return this.fees.listAllPayments({
      status,
      search,
      feeTitle,
      citizenId,
      method,
      transactionsOnly: transactionsOnly === 'true',
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  /**
   * Raises a one-off charge against one citizen — the counterpart to issuing a
   * notice, for a debt that has no rule behind it.
   */
  @Roles('SUPER_ADMIN', 'COLLECTOR', 'ACCOUNTANT')
  @Post('payments')
  async charge(
    @Body(new ZodValidationPipe(chargeCitizenSchema)) body: ChargeCitizen,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.fees.chargeIndividual({
      ...body,
      actor: { id: user.sub, role: user.role ?? '' },
    });
  }

  /**
   * Records money taken at the counter — in full, or in part.
   *
   * An omitted `amount` settles the whole outstanding balance, which is both
   * the common case and the pre-partial-payment behaviour.
   */
  @Roles('SUPER_ADMIN', 'COLLECTOR', 'ACCOUNTANT')
  @Patch('payments/:id/settle')
  async settle(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(settlePaymentSchema)) body: SettlePayment,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.fees.settleInPerson({
      paymentId: id,
      amount: body.amount,
      method: body.method,
      whishTransactionRef: body.whishTransactionRef,
      collectedById: body.collectedById,
      note: body.note,
      actor: { id: user.sub, role: user.role ?? '' },
    });
  }

  /**
   * The receipt history for one invoice.
   *
   * Registered before the `payments/:id/...` routes that follow it for the
   * same reason `payments/pending` is: Nest matches in registration order.
   *
   * This is what the ledger bought. Until it existed the only record of a
   * settlement was the invoice's running total, so a citizen asking for a copy
   * of March's receipt could be told the balance and nothing else.
   */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER')
  @Get('payments/:id/transactions')
  async transactions(@Param('id') id: string) {
    return { items: await this.fees.listTransactions(id) };
  }

  /**
   * Reverses one recorded movement.
   *
   * SUPER_ADMIN only, and deliberately not a delete: it appends an opposing
   * entry, so the original stays on the record with the correction beside it.
   * The ledger refuses updates and deletes at the database, so there is no
   * other shape this could take.
   */
  @Roles('SUPER_ADMIN')
  @Post('transactions/:transactionId/reverse')
  async reverseTransaction(
    @Param('transactionId') transactionId: string,
    @Body(new ZodValidationPipe(reverseTransactionSchema)) body: { note: string },
    @CurrentUser() user: SessionClaims,
  ) {
    return this.fees.reverseTransaction({
      transactionId,
      note: body.note,
      actor: { id: user.sub, role: user.role ?? '' },
    });
  }

  // ────────────────────  Staff verification queue  ────────────────────

  @Roles('SUPER_ADMIN', 'AUDITOR', 'ACCOUNTANT')
  @Get('payments/pending')
  async pending(@Query('unseenOnly') unseenOnly?: string) {
    return { items: await this.fees.listPendingReview(unseenOnly === 'true') };
  }

  /** Marks a pending payment notification as seen. */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'ACCOUNTANT')
  @Patch('payments/:id/seen')
  async markAsSeen(@Param('id') id: string) {
    return this.fees.markAsSeen(id);
  }

  /** Marks all pending payment notifications as seen. */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'ACCOUNTANT')
  @Post('payments/pending/mark-all-seen')
  async markAllAsSeen() {
    return this.fees.markAllPendingAsSeen();
  }

  /** Confirming money arrived is a financial act — SUPER_ADMIN and ACCOUNTANT. */
  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  @Patch('payments/:id/review')
  async review(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reviewPaymentSchema))
    body: { confirmed: boolean; note?: string },
    @CurrentUser() user: SessionClaims,
  ) {
    return this.fees.review({
      paymentId: id,
      confirmed: body.confirmed,
      note: body.note,
      actor: { id: user.sub, role: user.role ?? '' },
    });
  }

  // ─────────────────────────  Citizen portal  ─────────────────────────

  /**
   * The signed-in citizen's own bills.
   *
   * Scoped by `user.sub`, and refused outright for a staff token: a clerk
   * asking for "my payments" is a bug, and answering it with an empty list
   * would hide that rather than surface it.
   */
  @Get('payments/mine')
  async mine(@CurrentUser() user: SessionClaims) {
    if (user.kind !== 'CITIZEN') {
      throw new ForbiddenError('هذا المسار للمواطنين فقط');
    }
    return { items: await this.fees.listForCitizen(user.sub) };
  }

  /**
   * One invoice, for a page loaded directly by id rather than a row already in
   * a fetched list — تسجيل دفعة opens as its own page rather than a dialog, so
   * a refresh, a bookmark, or a link from a receipt has to be able to load it
   * from nothing but this id.
   *
   * Registered after every literal `payments/...` GET route above
   * (`payments/pending`, `payments/mine`) rather than beside `payments/:id/settle`
   * where it reads more naturally — Nest matches routes in registration order,
   * and a `:id` segment ahead of them would swallow `pending` and `mine` as if
   * they were ids, which is exactly the kind of routing bug a test suite run
   * against real HTTP requests catches and a unit test calling the method
   * directly never would.
   */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER')
  @Get('payments/:id')
  async getPayment(@Param('id') id: string) {
    return this.fees.getPaymentById(id);
  }

  /**
   * Opens a Whish checkout for one of the signed-in citizen's own bills.
   *
   * The callback and return URLs are built here from configuration rather than
   * taken from the request: a client-supplied `returnUrl` is an open redirect,
   * and a client-supplied `callbackUrl` would let anyone point the provider's
   * confirmation at a server they control.
   */
  @Post('payments/mine/:id/whish/checkout')
  async whishCheckout(
    @Param('tenantSlug') tenantSlug: string,
    @Param('id') id: string,
    @CurrentUser() user: SessionClaims,
  ) {
    if (user.kind !== 'CITIZEN') {
      throw new ForbiddenError('هذا المسار للمواطنين فقط');
    }

    const apiBase = APP_CONFIG.publicApiUrl;
    const portalBase = APP_CONFIG.publicPortalUrl;

    return this.fees.startWhishCheckout({
      paymentId: id,
      citizenId: user.sub,
      callbackUrl: `${apiBase}/t/${tenantSlug}/fees/whish/callback`,
      returnUrl: `${portalBase}/${tenantSlug}/ar/my-file?whish=done`,
    });
  }

  /**
   * Whish's server-to-server confirmation.
   *
   * `@Public()` because the provider holds no session — the signature over the
   * raw body is the authentication, and `parseCallback` returns nothing at all
   * unless it verifies. Always answers 200: a provider that gets an error
   * retries, and there is nothing to retry when the payload was never genuine.
   */
  @Public()
  @Post('whish/callback')
  async whishCallback(@Req() request: RawBodyRequest<Request>) {
    const raw = request.rawBody?.toString('utf8') ?? '';
    const signature = request.header('x-whish-signature');

    const callback = this.fees.parseWhishCallback({ rawBody: raw, signature });
    if (!callback) {
      this.logger.warn('Rejected an unverified Whish callback');
      return { received: true };
    }

    await this.fees.settleFromWhishCallback(callback);
    return { received: true };
  }

  /** The citizen declaring they have paid — moves to PENDING_REVIEW only. */
  @Post('payments/mine/:id/declare')
  async declare(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(declarePaymentSchema)) body: DeclarePayment,
    @CurrentUser() user: SessionClaims,
  ) {
    if (user.kind !== 'CITIZEN') {
      throw new ForbiddenError('هذا المسار للمواطنين فقط');
    }
    return this.fees.declare({
      paymentId: id,
      citizenId: user.sub,
      method: body.method,
      whishTransactionRef: body.whishTransactionRef,
    });
  }
}

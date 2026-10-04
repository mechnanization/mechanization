import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { OtpCleanupJob } from '../../application/background-jobs/otp-cleanup.job';
import { RecurringBillingJob } from '../../application/background-jobs/recurring-billing.job';
import { StaffRefreshTokenCleanupJob } from '../../application/background-jobs/staff-refresh-token-cleanup.job';
import { Public } from '../decorators/public.decorator';

/**
 * HTTP triggers for the jobs that `@Cron` runs in the long-lived deployment.
 *
 * A serverless instance exists only for the length of a request, so
 * `ScheduleModule`'s in-process timers never fire — the process holding them is
 * gone milliseconds after the response. The schedule therefore has to live
 * outside the app (Vercel Cron, in `vercel.json`) and reach in over HTTP. The
 * job classes are untouched: this controller adds a second way to invoke them,
 * not a second implementation.
 *
 * GET, not POST, because that is the only method Vercel Cron issues. These are
 * not idempotent reads in the REST sense, which is a wart — the authentication
 * below is what keeps it from being a problem.
 */
@Controller('internal/cron')
export class InternalCronController {
  private readonly logger = new Logger(InternalCronController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly otpCleanup: OtpCleanupJob,
    private readonly recurringBilling: RecurringBillingJob,
    private readonly staffRefreshCleanup: StaffRefreshTokenCleanupJob,
  ) {}

  /**
   * Vercel sends `Authorization: Bearer $CRON_SECRET` on every cron invocation
   * when that variable is set on the project. Nothing else can be used to
   * authenticate here: there is no user, no tenant and no session behind a cron
   * request, so `@Public()` is unavoidable and this check is the entire door.
   *
   * A missing secret is a hard failure rather than an open route. The jobs walk
   * every municipality and issue invoices; "we forgot to set the variable"
   * must not be the same thing as "anyone on the internet may re-run billing".
   */
  private authorise(header: string | undefined): void {
    const secret = this.config.get<string>('CRON_SECRET');

    if (!secret) {
      throw new ServiceUnavailableException(
        'CRON_SECRET is not configured — scheduled jobs are disabled',
      );
    }

    /**
     * Length-prefixed comparison rather than `===` would be better still, but
     * the secret is high-entropy and the route is rate-limited by the platform;
     * the realistic threat here is a guessed URL, not a timing oracle.
     */
    if (header !== `Bearer ${secret}`) {
      throw new ForbiddenException();
    }
  }

  @Public()
  @SkipThrottle()
  @Get('otp-cleanup')
  async otp(@Headers('authorization') authorization?: string) {
    this.authorise(authorization);
    await this.otpCleanup.pruneExpiredChallenges();
    return { job: 'otp-cleanup', status: 'ok' };
  }

  /**
   * Not scheduled in `vercel.json`, deliberately. The API's production
   * deployment is a long-lived process, where `@Cron` fires by itself; this
   * gives the job the same HTTP door the other two have, for any deployment
   * where it does not.
   */
  @Public()
  @SkipThrottle()
  @Get('staff-refresh-cleanup')
  async staffRefresh(@Headers('authorization') authorization?: string) {
    this.authorise(authorization);
    await this.staffRefreshCleanup.pruneExpired();
    return { job: 'staff-refresh-cleanup', status: 'ok' };
  }

  @Public()
  @SkipThrottle()
  @Get('recurring-billing')
  async billing(@Headers('authorization') authorization?: string) {
    this.authorise(authorization);
    const result = await this.recurringBilling.runForAllTenants();
    this.logger.log(
      `Recurring billing: ${result.invoicesCreated} invoice(s) across ${result.tenants} tenant(s)`,
    );
    return { job: 'recurring-billing', status: 'ok', ...result };
  }
}

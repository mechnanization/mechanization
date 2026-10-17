import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  closeDaySchema,
  dailyCashReportQuerySchema,
  recordDailyCountSchema,
  reopenDaySchema,
  treasuryClosureHistoryQuerySchema,
  treasuryDayQuerySchema,
  TREASURY_ADMIN_ROLES,
  TREASURY_READ_ROLES,
  TREASURY_WORK_ROLES,
  type CloseDayInput,
  type DailyCashReportQuery,
  type RecordDailyCountInput,
  type ReopenDayInput,
  type TreasuryClosureHistoryQuery,
  type TreasuryDayQuery,
} from '@mechanization/shared-schemas';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { DailyCashReportService } from '../../application/features/treasury/daily-cash-report.service';
import { DailyCountService } from '../../application/features/treasury/daily-count.service';
import { DayClosureService } from '../../application/features/treasury/day-closure.service';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';

/**
 * جرد الصندوق وإقفال اليومية — the day's count, closing the day, reopening it,
 * and the day's report (docs/finance.md §7).
 *
 * The treasury's three role lists, as everywhere in it: every finance reader
 * reads the sheet, the history and the report; the accountant and the manager
 * count and close; only the manager reopens a closed day.
 */
@Controller('t/:tenantSlug/treasury')
export class TreasuryClosingController {
  constructor(
    private readonly counts: DailyCountService,
    private readonly closures: DayClosureService,
    private readonly reports: DailyCashReportService,
  ) {}

  /** «جرد وإقفال اليومية» for one day — or, with no `date`, for the day that needs closing next. */
  @Roles(...TREASURY_READ_ROLES)
  @Get('counts')
  sheet(@Query(new ZodValidationPipe(treasuryDayQuerySchema)) query: TreasuryDayQuery) {
    return this.counts.sheet(query.date);
  }

  /** «سجّل الجرد»: one or more wallets counted for one day. Answers with the sheet as it now stands. */
  @Roles(...TREASURY_WORK_ROLES)
  @Post('counts')
  record(
    @Body(new ZodValidationPipe(recordDailyCountSchema)) body: RecordDailyCountInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.counts.record(body, { id: user.sub, role: user.role ?? '' });
  }

  /** The closed and reopened days, latest first. */
  @Roles(...TREASURY_READ_ROLES)
  @Get('closures')
  history(@Query(new ZodValidationPipe(treasuryClosureHistoryQuerySchema)) query: TreasuryClosureHistoryQuery) {
    return this.closures.history(query.limit);
  }

  /** «أقفل اليومية». */
  @Roles(...TREASURY_WORK_ROLES)
  @Post('closures')
  close(@Body(new ZodValidationPipe(closeDaySchema)) body: CloseDayInput, @CurrentUser() user: SessionClaims) {
    return this.closures.close(body, { id: user.sub, role: user.role ?? '' });
  }

  /** «أعد فتح اليومية» — the latest closed day, with a reason. The manager's alone. */
  @Roles(...TREASURY_ADMIN_ROLES)
  @Post('closures/reopen')
  reopen(@Body(new ZodValidationPipe(reopenDaySchema)) body: ReopenDayInput, @CurrentUser() user: SessionClaims) {
    return this.closures.reopen(body, { id: user.sub, role: user.role ?? '' });
  }

  /** «تقرير الصندوق اليومي». */
  @Roles(...TREASURY_READ_ROLES)
  @Get('reports/daily')
  daily(
    @Query(new ZodValidationPipe(dailyCashReportQuerySchema)) query: DailyCashReportQuery,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.reports.daily(query.date, user.sub);
  }
}

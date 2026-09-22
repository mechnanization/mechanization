import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  assignCheckSchema,
  completeCheckSchema,
  dismissFindingSchema,
  drawSampleSchema,
  QUALITY_CHECK_ROLES,
  QUALITY_FINDING_KIND,
  returnRecordSchema,
  type AssignCheckInput,
  type CompleteCheckInput,
  type DismissFindingInput,
  type DrawSampleInput,
  type ReturnRecordInput,
} from '@mechanization/shared-schemas';
import { z } from 'zod';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { ValidationError } from '../../application/common/exceptions';
import { requireDate } from './query-params';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { DataQualityService } from '../../application/features/quality/data-quality.service';
import {
  RecordReviewService,
  REVIEWER_ROLES,
  TO_REVIEW,
  type ReviewState,
} from '../../application/features/quality/record-review.service';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const restoreSchema = z.object({
  kind: z.enum(QUALITY_FINDING_KIND),
  subjectKey: z.string().trim().min(1).max(500),
});

const actorOf = (user: SessionClaims) => ({ id: user.sub, role: user.role ?? '' });

function optionalUuid(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  if (!UUID.test(value)) throw new ValidationError(`${name} غير صالح`);
  return value;
}

/**
 * «مراجعة الجودة».
 *
 * Deciding on records, drawing the re-check sample and dismissing findings are
 * for the roles that answer for the register — `REVIEWER_ROLES` — and never for
 * the officer whose work is being looked at: an officer who could approve their
 * own filings or dismiss the findings about them would make the screen a
 * formality. An officer does see their own returned records, the checks they
 * can do, and their own figures.
 */
@Controller('t/:tenantSlug/quality')
export class QualityController {
  constructor(
    private readonly reviews: RecordReviewService,
    private readonly dataQuality: DataQualityService,
  ) {}

  // ─────────────────────────────  Reviews  ─────────────────────────────

  @Roles(...REVIEWER_ROLES)
  @Get('reviews')
  async queue(
    @Query('state') state = 'TO_REVIEW',
    @Query('officerId') officerId?: string,
    @Query('flaggedOnly') flaggedOnly?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const states: readonly ReviewState[] =
      state === 'RETURNED' ? ['RETURNED'] : state === 'APPROVED' ? ['APPROVED'] : TO_REVIEW;
    return this.reviews.queue({
      states,
      officerId: optionalUuid(officerId, 'الموظف'),
      flaggedOnly: flaggedOnly === 'true',
      limit: Number(limit) || 20,
      offset: Number(offset) || 0,
    });
  }

  @Roles(...REVIEWER_ROLES)
  @Post('reviews/:registrationId/approve')
  async approve(@Param('registrationId') registrationId: string, @CurrentUser() user: SessionClaims) {
    return this.reviews.approve(optionalUuid(registrationId, 'السجل')!, actorOf(user));
  }

  @Roles(...REVIEWER_ROLES)
  @Post('reviews/:registrationId/return')
  async returnToOfficer(
    @Param('registrationId') registrationId: string,
    @Body(new ZodValidationPipe(returnRecordSchema)) body: ReturnRecordInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.reviews.returnToOfficer(optionalUuid(registrationId, 'السجل')!, body, actorOf(user));
  }

  /** The open return on a citizen's record — shown on its edit form to whoever fixes it. */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ADMINISTRATIVE_OFFICER')
  @Get('citizens/:citizenId/open-return')
  async openReturn(@Param('citizenId') citizenId: string) {
    return { openReturn: await this.reviews.openReturnFor(optionalUuid(citizenId, 'المواطن')!) };
  }

  // ─────────────────────────────  Findings  ─────────────────────────────

  @Roles(...REVIEWER_ROLES)
  @Get('findings')
  async findings(
    @Query('includeDismissed') includeDismissed?: string,
    @Query('officerId') officerId?: string,
  ) {
    return this.dataQuality.findings({
      includeDismissed: includeDismissed === 'true',
      officerId: optionalUuid(officerId, 'الموظف'),
    });
  }

  @Roles(...REVIEWER_ROLES)
  @Post('findings/dismiss')
  async dismiss(
    @Body(new ZodValidationPipe(dismissFindingSchema)) body: DismissFindingInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.dataQuality.dismiss(body, actorOf(user));
  }

  @Roles(...REVIEWER_ROLES)
  @Post('findings/restore')
  async restore(
    @Body(new ZodValidationPipe(restoreSchema)) body: z.infer<typeof restoreSchema>,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.dataQuality.restore(body.kind, body.subjectKey, actorOf(user));
  }

  // ─────────────────────────────  Officers  ─────────────────────────────

  /**
   * Every officer's figures for a reviewer; anyone else gets their own and only
   * their own, whatever `officerId` they send.
   */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER')
  @Get('officers')
  async officers(
    @CurrentUser() user: SessionClaims,
    @Query('officerId') officerId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const reviewer = (REVIEWER_ROLES as readonly string[]).includes(user.role ?? '');
    return this.dataQuality.officerQuality({
      officerId: reviewer ? optionalUuid(officerId, 'الموظف') : user.sub,
      from: requireDate(from),
      to: requireDate(to),
    });
  }

  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER')
  @Get('tasks/mine')
  async myTasks(@CurrentUser() user: SessionClaims) {
    return this.reviews.tasksFor(actorOf(user));
  }

  // ─────────────────────────────  Re-check sample  ─────────────────────────────

  @Roles(...REVIEWER_ROLES)
  @Post('checks/sample')
  async drawSample(
    @Body(new ZodValidationPipe(drawSampleSchema)) body: DrawSampleInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.reviews.drawSample(body, actorOf(user));
  }

  @Roles(...REVIEWER_ROLES)
  @Get('checks')
  async checks(@Query('status') status?: string, @Query('officerId') officerId?: string) {
    return {
      items: await this.reviews.listChecks({
        status: status === 'OPEN' || status === 'DONE' ? status : undefined,
        officerId: optionalUuid(officerId, 'الموظف'),
      }),
    };
  }

  @Roles(...REVIEWER_ROLES)
  @Patch('checks/:id/assign')
  async assign(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignCheckSchema)) body: AssignCheckInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.reviews.assign(optionalUuid(id, 'التحقق')!, body, actorOf(user));
  }

  @Roles(...QUALITY_CHECK_ROLES)
  @Post('checks/:id/complete')
  async complete(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(completeCheckSchema)) body: CompleteCheckInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.reviews.complete(optionalUuid(id, 'التحقق')!, body, actorOf(user));
  }
}

import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  QUALITY_CHECK_ROLES,
  QUALITY_FINDING_KIND,
  QUALITY_RETURN_READ_ROLES,
  QUALITY_REVIEWER_ROLES,
  WORKING_STAFF_ROLES,
  assignCheckSchema,
  completeCheckSchema,
  dismissFindingSchema,
  drawSampleSchema,
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
import { queryLimit, queryOffset, requireDate } from './query-params';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { DataQualityService } from '../../application/features/quality/data-quality.service';
import {
  RecordReviewService,
  TO_REVIEW,
  type ReviewState,
} from '../../application/features/quality/record-review.service';
import { CurrentUser } from '../decorators/current-user.decorator';
import { CurrentActor } from '../decorators/current-actor.decorator';
import { StaffActor } from '../../application/common/actor';
import { Roles } from '../decorators/roles.decorator';
import { UuidPipe } from '../pipes/uuid.pipe';
import { APP_CONFIG } from '../../application/common/app.config';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const restoreSchema = z.object({
  kind: z.enum(QUALITY_FINDING_KIND),
  subjectKey: z.string().trim().min(1).max(500),
});

function optionalUuid(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  if (!UUID.test(value)) throw new ValidationError({
    code: 'INVALID_QUERY_VALUE',
    message: `${name} is not a valid id`,
  });
  return value;
}

/**
 * «مراجعة الجودة».
 *
 * Deciding on records, drawing the re-check sample and dismissing findings are
 * for the roles that answer for the register — `QUALITY_REVIEWER_ROLES` — and never for
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

  @Roles(...QUALITY_REVIEWER_ROLES)
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
      limit: queryLimit(limit, APP_CONFIG.pagination.recordReviews.default, APP_CONFIG.pagination.recordReviews.max),
      offset: queryOffset(offset),
    });
  }

  @Roles(...QUALITY_REVIEWER_ROLES)
  @Post('reviews/:registrationId/approve')
  async approve(@Param('registrationId', new UuidPipe()) registrationId: string, @CurrentActor() actor: StaffActor) {
    return this.reviews.approve(optionalUuid(registrationId, 'السجل')!, actor);
  }

  @Roles(...QUALITY_REVIEWER_ROLES)
  @Post('reviews/:registrationId/return')
  async returnToOfficer(
    @Param('registrationId', new UuidPipe()) registrationId: string,
    @Body(new ZodValidationPipe(returnRecordSchema)) body: ReturnRecordInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.reviews.returnToOfficer(optionalUuid(registrationId, 'السجل')!, body, actor);
  }

  /** The open return on a citizen's record — shown on its edit form to whoever fixes it. */
  @Roles(...QUALITY_RETURN_READ_ROLES)
  @Get('citizens/:citizenId/open-return')
  async openReturn(@Param('citizenId', new UuidPipe()) citizenId: string) {
    return { openReturn: await this.reviews.openReturnFor(optionalUuid(citizenId, 'المواطن')!) };
  }

  // ─────────────────────────────  Findings  ─────────────────────────────

  @Roles(...QUALITY_REVIEWER_ROLES)
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

  @Roles(...QUALITY_REVIEWER_ROLES)
  @Post('findings/dismiss')
  async dismiss(
    @Body(new ZodValidationPipe(dismissFindingSchema)) body: DismissFindingInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.dataQuality.dismiss(body, actor);
  }

  @Roles(...QUALITY_REVIEWER_ROLES)
  @Post('findings/restore')
  async restore(
    @Body(new ZodValidationPipe(restoreSchema)) body: z.infer<typeof restoreSchema>,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.dataQuality.restore(body.kind, body.subjectKey, actor);
  }

  // ─────────────────────────────  Officers  ─────────────────────────────

  /**
   * Every officer's figures for a reviewer; anyone else gets their own and only
   * their own, whatever `officerId` they send.
   */
  @Roles(...WORKING_STAFF_ROLES)
  @Get('officers')
  async officers(
    @CurrentUser() user: SessionClaims,
    @Query('officerId') officerId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const reviewer = (QUALITY_REVIEWER_ROLES as readonly string[]).includes(user.role ?? '');
    return this.dataQuality.officerQuality({
      officerId: reviewer ? optionalUuid(officerId, 'الموظف') : user.sub,
      from: requireDate(from),
      to: requireDate(to),
    });
  }

  @Roles(...WORKING_STAFF_ROLES)
  @Get('tasks/mine')
  async myTasks(@CurrentActor() actor: StaffActor) {
    return this.reviews.tasksFor(actor);
  }

  // ─────────────────────────────  Re-check sample  ─────────────────────────────

  @Roles(...QUALITY_REVIEWER_ROLES)
  @Post('checks/sample')
  async drawSample(
    @Body(new ZodValidationPipe(drawSampleSchema)) body: DrawSampleInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.reviews.drawSample(body, actor);
  }

  @Roles(...QUALITY_REVIEWER_ROLES)
  @Get('checks')
  async checks(@Query('status') status?: string, @Query('officerId') officerId?: string) {
    return {
      items: await this.reviews.listChecks({
        status: status === 'OPEN' || status === 'DONE' ? status : undefined,
        officerId: optionalUuid(officerId, 'الموظف'),
      }),
    };
  }

  @Roles(...QUALITY_REVIEWER_ROLES)
  @Patch('checks/:id/assign')
  async assign(
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(assignCheckSchema)) body: AssignCheckInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.reviews.assign(optionalUuid(id, 'التحقق')!, body, actor);
  }

  @Roles(...QUALITY_CHECK_ROLES)
  @Post('checks/:id/complete')
  async complete(
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(completeCheckSchema)) body: CompleteCheckInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.reviews.complete(optionalUuid(id, 'التحقق')!, body, actor);
  }
}

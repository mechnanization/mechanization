import { Body, Controller, Get, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import {
  approveRequestSchema,
  listRequestsQuerySchema,
  rejectRequestSchema,
  REQUEST_ATTACHMENT_MAX_BYTES,
  REQUEST_BILL_ROLES,
  REQUEST_HANDLE_ROLES,
  REQUEST_READ_ROLES,
  submitCounterFormRequestSchema,
  submitOnlineFormRequestSchema,
  uploadRequestPaperSchema,
  type ApproveRequestInput,
  type ListRequestsQuery,
  type RejectRequestInput,
  type SubmitCounterFormRequestInput,
  type SubmitOnlineFormRequestInput,
  type UploadRequestPaperInput,
} from '@mechanization/shared-schemas';
import { ForbiddenError, ValidationError } from '../../application/common/exceptions';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { CitizenRequestsService } from '../../application/features/citizen-requests/citizen-requests.service';
import { RequestAnswersService } from '../../application/features/request-forms/request-answers.service';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { APP_CONFIG } from '../config/app.config';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import { UuidPipe } from '../pipes/uuid.pipe';

/**
 * A citizen filing and uploading through the portal. Counted per session, not
 * per address: behind nginx with no `trust proxy` every citizen shares one IP
 * bucket (docs/security.md), and ten a minute is room to retry a flaky upload,
 * not to fill a queue.
 */
const CITIZEN_SUBMISSION_THROTTLE = {
  default: {
    limit: APP_CONFIG.throttle.submission.limit,
    ttl: APP_CONFIG.throttle.submission.ttlSeconds * 1000,
    getTracker: (request: Record<string, unknown>) => {
      const headers = request.headers as Record<string, string | string[] | undefined>;
      const authorization = headers.authorization;
      const key = typeof authorization === 'string' ? authorization : `ip:${String(request.ip)}`;
      return `citizen-submission:${createHash('sha256').update(key).digest('hex')}`;
    },
  },
};

/**
 * One paper per upload, read into memory: the size is capped here, before the
 * service sees a byte, and its type is sniffed from the bytes there. The text
 * fields are the paper's kind or the question of the form it answers (`type`,
 * `fieldKey`): up to three, with the file four parts.
 */
const ATTACHMENT_UPLOAD = FileInterceptor('file', {
  limits: { fileSize: REQUEST_ATTACHMENT_MAX_BYTES, files: 1, fields: 3, parts: 4 },
});

/** The citizen's own routes have no `@Roles`: they check the token's kind and read only `user.sub`. */
function asCitizen(user: SessionClaims): string {
  if (user.kind !== 'CITIZEN') {
    throw new ForbiddenError({ code: 'CITIZENS_ONLY', message: 'This is available to citizens only.' });
  }
  return user.sub;
}

function staff(user: SessionClaims): { id: string; role: string } {
  return { id: user.sub, role: user.role ?? '' };
}

function requireFile(file: Express.Multer.File | undefined): { buffer: Buffer; size: number } {
  if (!file) throw new ValidationError({ code: 'REQUEST_ATTACHMENT_EMPTY', message: 'No file was attached.' });
  return { buffer: file.buffer, size: file.size };
}

/**
 * المعاملات والإفادات — municipal requests (docs/municipal-requests-plan.md).
 *
 * `mine/…` is the citizen's portal: role-less, refusing staff tokens, every
 * query scoped by the token's subject — the citizen id is never read from a
 * body or a path. Everything else is staff, each handler with its role set
 * (`REQUEST_*_ROLES`, pinned in `route-inventory.spec.ts`). Static paths come
 * before `:id`, which would otherwise read «mine» and «types» as ids.
 */
@Controller('t/:tenantSlug/requests')
export class CitizenRequestsController {
  constructor(
    private readonly requests: CitizenRequestsService,
    private readonly formAnswers: RequestAnswersService,
  ) {}

  // ─────────────────────────────  The citizen's own  ─────────────────────────────

  @Get('mine')
  mine(@CurrentUser() user: SessionClaims) {
    return this.requests.mine(asCitizen(user));
  }

  /** The forms a citizen may file now, with their questions and, for a linked one, what their own file holds. */
  @Get('mine/forms')
  mineForms(@CurrentUser() user: SessionClaims) {
    return this.formAnswers.offeredForms(asCitizen(user));
  }

  @Throttle(CITIZEN_SUBMISSION_THROTTLE)
  @Post('mine')
  submitMine(
    @Body(new ZodValidationPipe(submitOnlineFormRequestSchema)) body: SubmitOnlineFormRequestInput,
    @CurrentUser() user: SessionClaims,
  ) {
    const citizenId = asCitizen(user);
    return this.requests.submit({ ...body, citizenId }, { kind: 'CITIZEN', id: citizenId });
  }

  @Get('mine/:id')
  mineOne(@Param('id', new UuidPipe()) id: string, @CurrentUser() user: SessionClaims) {
    return this.requests.mineOne(asCitizen(user), id);
  }

  @Throttle(CITIZEN_SUBMISSION_THROTTLE)
  @Post('mine/:id/attachments')
  @UseInterceptors(ATTACHMENT_UPLOAD)
  uploadMine(
    @Param('id', new UuidPipe()) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(uploadRequestPaperSchema)) body: UploadRequestPaperInput,
    @CurrentUser() user: SessionClaims,
  ) {
    const citizenId = asCitizen(user);
    return this.requests.addAttachment(id, requireFile(file), body.type, { kind: 'CITIZEN', id: citizenId }, { citizenId }, body.fieldKey);
  }

  /** «ادفع الآن»: the fee's bill, raised now or answered if it already is. */
  @Throttle(CITIZEN_SUBMISSION_THROTTLE)
  @Post('mine/:id/bill')
  billMine(@Param('id', new UuidPipe()) id: string, @CurrentUser() user: SessionClaims) {
    const citizenId = asCitizen(user);
    return this.requests.raiseBill(id, { kind: 'CITIZEN', id: citizenId }, { citizenId });
  }

  @Post('mine/:id/cancel')
  async cancelMine(@Param('id', new UuidPipe()) id: string, @CurrentUser() user: SessionClaims) {
    const citizenId = asCitizen(user);
    await this.requests.cancel(id, { kind: 'CITIZEN', id: citizenId }, { citizenId });
    return this.requests.mineOne(citizenId, id);
  }

  // ─────────────────────────────  Staff  ─────────────────────────────

  @Roles(...REQUEST_READ_ROLES)
  @Get()
  queue(@Query(new ZodValidationPipe(listRequestsQuerySchema)) query: ListRequestsQuery) {
    return this.requests.queue(query);
  }

  /** The forms the counter may file now (the questions, not a citizen's values). */
  @Roles(...REQUEST_HANDLE_ROLES)
  @Get('forms')
  forms() {
    return this.formAnswers.offeredForms();
  }

  /** What the chosen citizen's file holds for each linked question of a form: so the clerk sees an empty one before filing. */
  @Roles(...REQUEST_HANDLE_ROLES)
  @Get('forms/:formId/prefill')
  prefill(@Param('formId', new UuidPipe()) formId: string, @Query('citizenId', new UuidPipe()) citizenId: string) {
    return this.formAnswers.prefill(formId, citizenId);
  }

  @Roles(...REQUEST_HANDLE_ROLES)
  @Post()
  submit(
    @Body(new ZodValidationPipe(submitCounterFormRequestSchema)) body: SubmitCounterFormRequestInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.requests.submit(body, { kind: 'STAFF', ...staff(user) });
  }

  @Roles(...REQUEST_READ_ROLES)
  @Get(':id')
  get(@Param('id', new UuidPipe()) id: string) {
    return this.requests.get(id);
  }

  /** «تحصيل الرسم»: the fee's bill, for the counter to settle. */
  @Roles(...REQUEST_BILL_ROLES)
  @Post(':id/bill')
  bill(@Param('id', new UuidPipe()) id: string, @CurrentUser() user: SessionClaims) {
    return this.requests.raiseBill(id, { kind: 'STAFF', ...staff(user) });
  }

  @Roles(...REQUEST_HANDLE_ROLES)
  @Post(':id/approve')
  approve(
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(approveRequestSchema)) body: ApproveRequestInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.requests.approve(id, body.statement, staff(user));
  }

  @Roles(...REQUEST_HANDLE_ROLES)
  @Post(':id/reject')
  reject(
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(rejectRequestSchema)) body: RejectRequestInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.requests.reject(id, body.reason, staff(user));
  }

  @Roles(...REQUEST_HANDLE_ROLES)
  @Post(':id/complete')
  complete(@Param('id', new UuidPipe()) id: string, @CurrentUser() user: SessionClaims) {
    return this.requests.complete(id, staff(user));
  }

  @Roles(...REQUEST_HANDLE_ROLES)
  @Post(':id/cancel')
  async cancel(@Param('id', new UuidPipe()) id: string, @CurrentUser() user: SessionClaims) {
    await this.requests.cancel(id, { kind: 'STAFF', ...staff(user) });
    return this.requests.get(id);
  }

  @Roles(...REQUEST_HANDLE_ROLES)
  @Post(':id/attachments')
  @UseInterceptors(ATTACHMENT_UPLOAD)
  upload(
    @Param('id', new UuidPipe()) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(uploadRequestPaperSchema)) body: UploadRequestPaperInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.requests.addAttachment(id, requireFile(file), body.type, { kind: 'STAFF', ...staff(user) }, {}, body.fieldKey);
  }

  /** A five-minute link to one paper; every use is an audit row (D6). */
  @Roles(...REQUEST_READ_ROLES)
  @Get(':id/attachments/:attachmentId/url')
  attachmentUrl(
    @Param('id', new UuidPipe()) id: string,
    @Param('attachmentId', new UuidPipe()) attachmentId: string,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.requests.attachmentUrl(id, attachmentId, staff(user));
  }
}

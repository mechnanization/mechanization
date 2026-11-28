import { Body, Controller, Get, Param, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
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
  REQUEST_SETTINGS_ROLES,
  requestTypeSchema,
  submitCounterRequestSchema,
  submitOnlineRequestSchema,
  updateRequestTypeSettingSchema,
  uploadRequestAttachmentSchema,
  type ApproveRequestInput,
  type ListRequestsQuery,
  type RejectRequestInput,
  type RequestType,
  type SubmitCounterRequestInput,
  type SubmitOnlineRequestInput,
  type UpdateRequestTypeSettingInput,
  type UploadRequestAttachmentInput,
} from '@mechanization/shared-schemas';
import { ForbiddenError, ValidationError } from '../../application/common/exceptions';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { CitizenRequestsService } from '../../application/features/citizen-requests/citizen-requests.service';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { APP_CONFIG } from '../../application/common/app.config';
import { CurrentUser } from '../decorators/current-user.decorator';
import { CurrentActor } from '../decorators/current-actor.decorator';
import { StaffActor } from '../../application/common/actor';
import { SelfService } from '../decorators/self-service.decorator';
import { Roles } from '../decorators/roles.decorator';
import { UuidPipe } from '../pipes/uuid.pipe';

/**
 * A citizen filing and uploading through the portal. Counted per session, not
 * per address: a household, or a café's Wi-Fi, shares one address even with
 * `trust proxy` set (SEC-04), and ten a minute is room to retry a flaky
 * upload, not to fill a queue.
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
 * One paper per request, read into memory: the size is capped here, before the
 * service sees a byte, and its type is sniffed from the bytes there.
 */
const ATTACHMENT_UPLOAD = FileInterceptor('file', {
  limits: { fileSize: REQUEST_ATTACHMENT_MAX_BYTES, files: 1, fields: 2, parts: 3 },
});

/** The citizen's own routes have no `@Roles`: they check the token's kind and read only `user.sub`. */
function asCitizen(user: SessionClaims): string {
  if (user.kind !== 'CITIZEN') {
    throw new ForbiddenError({ code: 'CITIZENS_ONLY', message: 'This is available to citizens only.' });
  }
  return user.sub;
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
  constructor(private readonly requests: CitizenRequestsService) {}

  // ─────────────────────────────  The citizen's own  ─────────────────────────────

  @SelfService("a citizen's own municipal requests; refuses staff")
  @Get('mine')
  mine(@CurrentUser() user: SessionClaims) {
    return this.requests.mine(asCitizen(user));
  }

  /** The types a citizen may file now, with their fees. */
  @SelfService('the request types a citizen may file; refuses staff')
  @Get('mine/types')
  mineTypes(@CurrentUser() user: SessionClaims) {
    asCitizen(user);
    return this.requests.offeredTypes();
  }

  @SelfService('a citizen filing their own request; refuses staff')
  @Throttle(CITIZEN_SUBMISSION_THROTTLE)
  @Post('mine')
  submitMine(
    @Body(new ZodValidationPipe(submitOnlineRequestSchema)) body: SubmitOnlineRequestInput,
    @CurrentUser() user: SessionClaims,
  ) {
    const citizenId = asCitizen(user);
    return this.requests.submit({ ...body, citizenId }, { kind: 'CITIZEN', id: citizenId });
  }

  @SelfService("one of a citizen's own requests; refuses staff")
  @Get('mine/:id')
  mineOne(@Param('id', new UuidPipe()) id: string, @CurrentUser() user: SessionClaims) {
    return this.requests.mineOne(asCitizen(user), id);
  }

  @SelfService("a paper on a citizen's own request; refuses staff")
  @Throttle(CITIZEN_SUBMISSION_THROTTLE)
  @Post('mine/:id/attachments')
  @UseInterceptors(ATTACHMENT_UPLOAD)
  uploadMine(
    @Param('id', new UuidPipe()) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(uploadRequestAttachmentSchema)) body: UploadRequestAttachmentInput,
    @CurrentUser() user: SessionClaims,
  ) {
    const citizenId = asCitizen(user);
    return this.requests.addAttachment(id, requireFile(file), body.type, { kind: 'CITIZEN', id: citizenId }, { citizenId });
  }

  /** «ادفع الآن»: the fee's bill, raised now or answered if it already is. */
  @SelfService("a citizen raising their own request's fee to pay it; refuses staff")
  @Throttle(CITIZEN_SUBMISSION_THROTTLE)
  @Post('mine/:id/bill')
  billMine(@Param('id', new UuidPipe()) id: string, @CurrentUser() user: SessionClaims) {
    const citizenId = asCitizen(user);
    return this.requests.raiseBill(id, { kind: 'CITIZEN', id: citizenId }, { citizenId });
  }

  @SelfService('a citizen cancelling their own unbilled request; refuses staff')
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

  /** Every type, offered or not, with its fee. */
  @Roles(...REQUEST_READ_ROLES)
  @Get('types')
  types() {
    return this.requests.listTypes();
  }

  @Roles(...REQUEST_SETTINGS_ROLES)
  @Put('types/:type')
  updateType(
    @Param('type', new ZodValidationPipe(requestTypeSchema)) type: RequestType,
    @Body(new ZodValidationPipe(updateRequestTypeSettingSchema)) body: UpdateRequestTypeSettingInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.requests.updateType(type, body, actor);
  }

  /** A request filed at the counter for a citizen who is present (D8). */
  @Roles(...REQUEST_HANDLE_ROLES)
  @Post()
  submit(
    @Body(new ZodValidationPipe(submitCounterRequestSchema)) body: SubmitCounterRequestInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.requests.submit(body, { kind: 'STAFF', ...actor });
  }

  @Roles(...REQUEST_READ_ROLES)
  @Get(':id')
  get(@Param('id', new UuidPipe()) id: string) {
    return this.requests.get(id);
  }

  /** «تحصيل الرسم»: the fee's bill, for the counter to settle. */
  @Roles(...REQUEST_BILL_ROLES)
  @Post(':id/bill')
  bill(@Param('id', new UuidPipe()) id: string, @CurrentActor() actor: StaffActor) {
    return this.requests.raiseBill(id, { kind: 'STAFF', ...actor });
  }

  @Roles(...REQUEST_HANDLE_ROLES)
  @Post(':id/approve')
  approve(
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(approveRequestSchema)) body: ApproveRequestInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.requests.approve(id, body.statement, actor);
  }

  @Roles(...REQUEST_HANDLE_ROLES)
  @Post(':id/reject')
  reject(
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(rejectRequestSchema)) body: RejectRequestInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.requests.reject(id, body.reason, actor);
  }

  @Roles(...REQUEST_HANDLE_ROLES)
  @Post(':id/complete')
  complete(@Param('id', new UuidPipe()) id: string, @CurrentActor() actor: StaffActor) {
    return this.requests.complete(id, actor);
  }

  @Roles(...REQUEST_HANDLE_ROLES)
  @Post(':id/cancel')
  async cancel(@Param('id', new UuidPipe()) id: string, @CurrentActor() actor: StaffActor) {
    await this.requests.cancel(id, { kind: 'STAFF', ...actor });
    return this.requests.get(id);
  }

  @Roles(...REQUEST_HANDLE_ROLES)
  @Post(':id/attachments')
  @UseInterceptors(ATTACHMENT_UPLOAD)
  upload(
    @Param('id', new UuidPipe()) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(uploadRequestAttachmentSchema)) body: UploadRequestAttachmentInput,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.requests.addAttachment(id, requireFile(file), body.type, { kind: 'STAFF', ...actor });
  }

  /** A five-minute link to one paper; every use is an audit row (D6). */
  @Roles(...REQUEST_READ_ROLES)
  @Get(':id/attachments/:attachmentId/url')
  attachmentUrl(
    @Param('id', new UuidPipe()) id: string,
    @Param('attachmentId', new UuidPipe()) attachmentId: string,
    @CurrentActor() actor: StaffActor,
  ) {
    return this.requests.attachmentUrl(id, attachmentId, actor);
  }
}

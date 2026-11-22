import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import {
  REQUEST_READ_ROLES,
  REQUEST_SETTINGS_ROLES,
  createRequestFormSchema,
  saveRequestFormDraftSchema,
  updateRequestFormSchema,
  type CreateRequestFormInput,
  type SaveRequestFormDraftInput,
  type UpdateRequestFormInput,
} from '@mechanization/shared-schemas';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { RequestFormsService } from '../../application/features/request-forms/request-forms.service';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import { UuidPipe } from '../pipes/uuid.pipe';

function staff(user: SessionClaims): { id: string; role: string } {
  return { id: user.sub, role: user.role ?? '' };
}

/**
 * «نماذج الإفادات» — the request forms the manager defines (migrations 0112, 0113; docs/request-forms-plan.md §5).
 *
 * Read by the staff who read requests (`REQUEST_READ_ROLES`: the papers' answers are theirs to see anyway) and written by the
 * manager alone (`REQUEST_SETTINGS_ROLES`, F5), every handler pinned in `route-inventory.spec.ts`. A form is deleted only while
 * nothing was filed on it (F7); otherwise it is archived. A citizen reaches a form through `requests/mine/forms`, never here.
 */
@Controller('t/:tenantSlug/request-forms')
export class RequestFormsController {
  constructor(private readonly forms: RequestFormsService) {}

  @Roles(...REQUEST_READ_ROLES)
  @Get()
  list() {
    return this.forms.list();
  }

  @Roles(...REQUEST_READ_ROLES)
  @Get(':id')
  get(@Param('id', new UuidPipe()) id: string) {
    return this.forms.get(id);
  }

  @Roles(...REQUEST_SETTINGS_ROLES)
  @Post()
  create(
    @Body(new ZodValidationPipe(createRequestFormSchema)) body: CreateRequestFormInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.forms.create(body, staff(user));
  }

  @Roles(...REQUEST_SETTINGS_ROLES)
  @Put(':id')
  update(
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(updateRequestFormSchema)) body: UpdateRequestFormInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.forms.update(id, body, staff(user));
  }

  /** «تعديل النموذج»: the draft to edit, started from the published version when there is none. */
  @Roles(...REQUEST_SETTINGS_ROLES)
  @Post(':id/draft')
  startDraft(@Param('id', new UuidPipe()) id: string, @CurrentUser() user: SessionClaims) {
    return this.forms.startDraft(id, staff(user));
  }

  @Roles(...REQUEST_SETTINGS_ROLES)
  @Put(':id/draft')
  saveDraft(
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodValidationPipe(saveRequestFormDraftSchema)) body: SaveRequestFormDraftInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.forms.saveDraft(id, body, staff(user));
  }

  @Roles(...REQUEST_SETTINGS_ROLES)
  @Post(':id/publish')
  publish(@Param('id', new UuidPipe()) id: string, @CurrentUser() user: SessionClaims) {
    return this.forms.publish(id, staff(user));
  }

  @Roles(...REQUEST_SETTINGS_ROLES)
  @Post(':id/enable')
  enable(@Param('id', new UuidPipe()) id: string, @CurrentUser() user: SessionClaims) {
    return this.forms.setEnabled(id, true, staff(user));
  }

  @Roles(...REQUEST_SETTINGS_ROLES)
  @Post(':id/disable')
  disable(@Param('id', new UuidPipe()) id: string, @CurrentUser() user: SessionClaims) {
    return this.forms.setEnabled(id, false, staff(user));
  }

  @Roles(...REQUEST_SETTINGS_ROLES)
  @Post(':id/archive')
  archive(@Param('id', new UuidPipe()) id: string, @CurrentUser() user: SessionClaims) {
    return this.forms.archive(id, staff(user));
  }

  @Roles(...REQUEST_SETTINGS_ROLES)
  @Delete(':id')
  async remove(@Param('id', new UuidPipe()) id: string, @CurrentUser() user: SessionClaims) {
    await this.forms.remove(id, staff(user));
    return { id };
  }
}

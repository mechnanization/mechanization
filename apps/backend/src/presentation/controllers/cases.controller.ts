import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  type CreateCaseInput,
  type UpdateCaseInput,
  createCaseSchema,
  updateCaseSchema,
} from '@mechanization/shared-schemas';
import { CasesService } from '../../application/features/cases/cases.service';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import type { SessionClaims } from '../../application/features/identity/identity.service';

/**
 * Sits under `t/:tenantSlug` like every other tenant-scoped controller — that
 * prefix is what `TenantMiddleware` binds to, so a route outside it would run
 * with no tenant-scoped Prisma client at all.
 *
 * Write roles match citizen registration exactly (`CitizenController`'s
 * POST/PATCH): a logged case is field data of the same kind, filed by the
 * same people. AUDITOR and ACCOUNTANT keep read access, matching every other
 * read-only surface in the register.
 */
@Controller('t/:tenantSlug/cases')
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  /**
   * `propertyNumber` is what the registration form's "an open case exists
   * here" lookup filters on; `status` narrows to OPEN for that same lookup,
   * or is left off entirely for the cases list's own table.
   */
  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER')
  @Get()
  async list(
    @Query('propertyNumber') propertyNumber?: string,
    @Query('status') status?: string,
  ) {
    return { cases: await this.cases.list({ propertyNumber, status }) };
  }

  @Roles('SUPER_ADMIN', 'AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ACCOUNTANT', 'ADMINISTRATIVE_OFFICER')
  @Get(':id')
  async get(@Param('id') id: string) {
    return this.cases.get(id);
  }

  @Roles('SUPER_ADMIN', 'FIELD_INSPECTOR', 'COLLECTOR', 'ADMINISTRATIVE_OFFICER')
  @Post()
  async create(
    @Body(new ZodValidationPipe(createCaseSchema)) body: CreateCaseInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.cases.create(body, { id: user.sub, role: user.role ?? '' });
  }

  @Roles('SUPER_ADMIN', 'FIELD_INSPECTOR', 'COLLECTOR', 'ADMINISTRATIVE_OFFICER')
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCaseSchema)) body: UpdateCaseInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.cases.update(id, body, { id: user.sub, role: user.role ?? '' });
  }

  @Roles('SUPER_ADMIN')
  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: SessionClaims) {
    await this.cases.remove(id, { id: user.sub, role: user.role ?? '' });
    return { deleted: true };
  }
}

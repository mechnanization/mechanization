import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  INSPECTOR_PROFILE_ROLES,
  WORKING_STAFF_ROLES,
  createStaffUserSchema,
  recordInspectorPayoutSchema,
  staffActiveSchema,
  updateStaffUserSchema,
} from '@mechanization/shared-schemas';
import type { RecordInspectorPayoutInput } from '@mechanization/shared-schemas';
import { StaffService } from '../../application/features/staff/staff.service';
import { StaffPresenceService } from '../../application/features/identity/staff-presence.service';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import { ForbiddenError } from '../../application/common/exceptions';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import type { StaffRole } from '../../domain/entities/user.entity';

/**
 * Staff account administration.
 *
 * SUPER_ADMIN at the controller, on every route rather than per-method:
 * creating accounts *is* the privilege escalation path in this system, and an
 * AUDITOR reading the list would also be reading the shape of who can approve
 * what. No password hash ever leaves here — the list projection has no such
 * field to accidentally include.
 */
@Roles('SUPER_ADMIN')
@Controller('t/:tenantSlug/staff')
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly presenceService: StaffPresenceService,
  ) {}

  /**
   * Every staff account, including deactivated ones — not deleted ones.
   * `?include=deleted-earners` adds the deleted accounts that earned or were
   * paid commission, for the earnings roster's totals.
   */
  @Get()
  async list(@Query('include') include?: string) {
    return { items: await this.staff.list({ includeDeletedEarners: include === 'deleted-earners' }) };
  }

  /**
   * «متصل الآن» / «آخر ظهور» for every live account, with the server's clock.
   *
   * What the staff page polls once a minute. Kept apart from `list` because
   * the roster computes every inspector's earnings over every filing they
   * made — not a query to repeat on a timer to learn who is online.
   */
  @Get('presence')
  async presence() {
    return this.presenceService.presence();
  }

  /** The accounts a super admin has deleted, to restore one from. */
  @Get('deleted')
  async listDeleted() {
    return { items: await this.staff.listDeleted() };
  }

  /** Brings a deleted account back onto the list, still disabled. */
  @Post(':id/restore')
  async restore(
    @Param('tenantSlug') tenantSlug: string,
    @Param('id') id: string,
    @CurrentUser() user: SessionClaims,
  ) {
    await this.staff.restore({ tenantSlug, id, actor: { id: user.sub, role: user.role ?? '' } });
    return { restored: true };
  }

  @Post()
  async create(
    @Param('tenantSlug') tenantSlug: string,
    @Body(new ZodValidationPipe(createStaffUserSchema))
    body: {
      email: string;
      password: string;
      firstName: string;
      lastName: string;
      role: StaffRole;
    },
    @CurrentUser() user: SessionClaims,
  ) {
    return this.staff.create({
      tenantSlug,
      ...body,
      actor: { id: user.sub, role: user.role ?? '' },
    });
  }

  @Patch(':id')
  async update(
    @Param('tenantSlug') tenantSlug: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateStaffUserSchema))
    body: {
      email?: string;
      password?: string;
      firstName?: string;
      lastName?: string;
      role?: StaffRole;
    },
    @CurrentUser() user: SessionClaims,
  ) {
    await this.staff.update({
      tenantSlug,
      id,
      ...body,
      actor: { id: user.sub, role: user.role ?? '' },
    });
    return { updated: true };
  }

  /** Soft delete, and its undo — one route because they are one decision. */
  @Patch(':id/active')
  async setActive(
    @Param('tenantSlug') tenantSlug: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(staffActiveSchema)) body: { isActive: boolean },
    @CurrentUser() user: SessionClaims,
  ) {
    await this.staff.setActive({
      tenantSlug,
      id,
      isActive: body.isActive,
      actor: { id: user.sub, role: user.role ?? '' },
    });
    return { isActive: body.isActive };
  }

  /** Hides the account — off the list and signed out, its row and history kept. */
  @Delete(':id')
  async remove(
    @Param('tenantSlug') tenantSlug: string,
    @Param('id') id: string,
    @CurrentUser() user: SessionClaims,
  ) {
    await this.staff.remove({
      tenantSlug,
      id,
      actor: { id: user.sub, role: user.role ?? '' },
    });
    return { deleted: true };
  }

  /**
   * Field Inspector self-service dashboard: stats, $1 commission earnings,
   * balance breakdown, recent registrations, and payout history.
   */
  @Roles(...WORKING_STAFF_ROLES)
  @Get('inspector/me/profile')
  async getMyProfile(
    @Param('tenantSlug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.staff.getInspectorProfile(tenantSlug, user.sub);
  }

  /**
   * Super Admin (or the Inspector themselves) viewing an inspector's dashboard.
   */
  @Roles(...INSPECTOR_PROFILE_ROLES)
  @Get('inspectors/:id/profile')
  async getInspectorProfile(
    @Param('tenantSlug') tenantSlug: string,
    @Param('id') id: string,
    @CurrentUser() user: SessionClaims,
  ) {
    if (user.role !== 'SUPER_ADMIN' && user.sub !== id) {
      throw new ForbiddenError('You do not have permission to view this inspector profile');
    }
    return this.staff.getInspectorProfile(tenantSlug, id);
  }

  /**
   * Super Admin records a commission payout made to a Field Inspector.
   */
  @Roles('SUPER_ADMIN')
  @Post('inspectors/:id/payouts')
  async recordPayout(
    @Param('tenantSlug') tenantSlug: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(recordInspectorPayoutSchema))
    body: RecordInspectorPayoutInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.staff.recordInspectorPayout({
      tenantSlug,
      inspectorId: id,
      payload: body,
      actor: { id: user.sub, role: user.role ?? '' },
    });
  }
}

import { Controller, Get, Query } from '@nestjs/common';
import { AuditService } from '../../application/features/audit/audit.service';
import { Roles } from '../decorators/roles.decorator';

/**
 * Reading the audit trail is itself a privileged act — it shows which staff
 * member opened which citizen's file — so it is SUPER_ADMIN and AUDITOR only.
 * A FIELD_INSPECTOR who could read it would be able to see how closely their own
 * work is being reviewed.
 */
@Controller('t/:tenantSlug/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** The actions, record types and staff the log holds — for the screen's filters. */
  @Roles('SUPER_ADMIN', 'AUDITOR')
  @Get('facets')
  async facets() {
    return this.audit.facets();
  }

  @Roles('SUPER_ADMIN', 'AUDITOR')
  @Get()
  async query(
    @Query('actorId') actorId?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
  ) {
    return this.audit.query({
      actorId,
      entityType,
      entityId,
      // Comma-separated, so one filter can mean a family — «كل التصحيحات».
      actions: action
        ? action
            .split(',')
            .map((value) => value.trim())
            .filter((value) => /^[A-Z_]{2,64}$/.test(value))
        : undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: Math.min(Number(limit) || 50, 200),
      offset: Number(offset) || 0,
    });
  }
}

import { Controller, Get, Query } from '@nestjs/common';
import { AuditService } from '../../application/features/audit/audit.service';
import { Roles } from '../decorators/roles.decorator';

/** Where a municipality of this system is. Used when the browser says nothing. */
const DEFAULT_TIME_ZONE = 'Asia/Beirut';

/**
 * Only a zone Postgres will accept.
 *
 * `AT TIME ZONE 'nonsense'` raises, which would turn a stray query string into
 * a 500 on the log screen. `Intl` throws on exactly the strings Postgres would,
 * so asking it first is the cheapest way to be sure without shipping a list of
 * zone names that goes stale.
 */
function safeTimeZone(value: string | undefined): string {
  if (!value) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return value;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** Comma-separated, so one filter can mean a family — «كل التصحيحات». */
function parseActions(action: string | undefined): string[] | undefined {
  if (!action) return undefined;
  return action
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^[A-Z_]{2,64}$/.test(value));
}

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

  /**
   * «التقرير اليومي» — the same log, one row per staff member per day.
   *
   * The zone comes from the browser because a day is the reader's day. An
   * unknown or malformed one falls back rather than failing: a summary bucketed
   * an hour off is a far smaller problem than a screen that will not open, and
   * `Intl` is the only authority on which strings Postgres will accept.
   */
  @Roles('SUPER_ADMIN', 'AUDITOR')
  @Get('daily')
  async daily(
    @Query('actorId') actorId?: string,
    @Query('entityType') entityType?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('timeZone') timeZone?: string,
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
  ) {
    return this.audit.daily({
      actorId,
      entityType,
      actions: parseActions(action),
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      timeZone: safeTimeZone(timeZone),
      limit: Math.min(Number(limit) || 50, 200),
      offset: Number(offset) || 0,
    });
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
      actions: parseActions(action),
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: Math.min(Number(limit) || 50, 200),
      offset: Number(offset) || 0,
    });
  }
}

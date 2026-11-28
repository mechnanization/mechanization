import { Controller, Get, Query } from '@nestjs/common';
import {
  AUDIT_READ_ROLES,
  AUDIT_SYSTEM_ACTOR,
  MUNICIPAL_TIME_ZONE,
  auditActorFilterSchema,
  type AuditActorFilter,
} from '@mechanization/shared-schemas';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { ValidationError } from '../../application/common/exceptions';
import { isUuid } from '../../application/common/ids';
import { AuditService } from '../../application/features/audit/audit.service';
import { Roles } from '../decorators/roles.decorator';
import { parseDate, queryLimit, queryOffset } from './query-params';
import { APP_CONFIG } from '../../application/common/app.config';

/**
 * Only a zone Postgres will accept.
 *
 * `AT TIME ZONE 'nonsense'` raises, which would turn a stray query string into
 * a 500 on the log screen. `Intl` throws on exactly the strings Postgres would,
 * so asking it first is the cheapest way to be sure without shipping a list of
 * zone names that goes stale.
 */
function safeTimeZone(value: string | undefined): string {
  if (!value) return MUNICIPAL_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return value;
  } catch {
    return MUNICIPAL_TIME_ZONE;
  }
}

/**
 * `?actorId=`, already validated (`auditActorFilterSchema`): a person's id, or
 * «النظام» — the entries with no actor, which have no id to filter by.
 */
function actorFilter(actorId: AuditActorFilter): { actorId?: string; systemActor?: true } {
  if (actorId === AUDIT_SYSTEM_ACTOR) return { systemActor: true };
  return actorId ? { actorId } : {};
}

/**
 * `?entityType=`: a record type as the log files it (`User`, `TreasuryDay`), or
 * nothing.
 *
 * Checked by shape, not against a list. No list of the types exists — each
 * writer names its own — and the screen offers what the log holds (`facets`),
 * types no writer uses any more included, so a list here would refuse a filter
 * the screen itself offered. A well-formed type the log does not hold matches
 * nothing, which is the right answer; free text up to the URL's length went on
 * into the cache key (audit SEC-06).
 */
function entityTypeFilter(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^[A-Z][A-Za-z]{1,63}$/.test(value)) {
    throw new ValidationError({ code: 'INVALID_QUERY_VALUE', message: 'Not a record type the audit log files' });
  }
  return value;
}

/**
 * `?entityId=`: the record a trail is about, or nothing.
 *
 * Most are UUIDs, folded to the lower case the database stores them in: the
 * column is text, so «3F2A…» matched nothing where `UuidPipe` would have made
 * it the row. Not all are: a day of the treasury is filed under its date
 * (`2026-10-08`), the old-debts settings under `singleton`, a News article
 * under Day3ati's own id. So a short key of letters, digits, `-` and `_` is
 * taken too, and anything else is refused (audit SEC-06).
 */
function entityIdFilter(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (isUuid(value)) return value.toLowerCase();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new ValidationError({ code: 'INVALID_QUERY_VALUE', message: 'Not a record id the audit log files' });
  }
  return value;
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
  @Roles(...AUDIT_READ_ROLES)
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
  @Roles(...AUDIT_READ_ROLES)
  @Get('daily')
  async daily(
    @Query('actorId', new ZodValidationPipe(auditActorFilterSchema)) actorId?: AuditActorFilter,
    @Query('entityType') entityType?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('timeZone') timeZone?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.audit.daily({
      ...actorFilter(actorId),
      entityType: entityTypeFilter(entityType),
      actions: parseActions(action),
      /*
        Dropped rather than passed on when it will not parse. An `Invalid Date`
        reaches `cacheKey` before it reaches Postgres, and `.toISOString()` on
        one throws — so a mistyped `?from=` was a 500 on the log screen rather
        than the unfiltered list it plainly meant.
      */
      from: parseDate(from),
      to: parseDate(to),
      timeZone: safeTimeZone(timeZone),
      limit: queryLimit(limit, APP_CONFIG.pagination.audit.default, APP_CONFIG.pagination.audit.max),
      offset: queryOffset(offset),
    });
  }

  @Roles(...AUDIT_READ_ROLES)
  @Get()
  async query(
    @Query('actorId', new ZodValidationPipe(auditActorFilterSchema)) actorId?: AuditActorFilter,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.audit.query({
      ...actorFilter(actorId),
      entityType: entityTypeFilter(entityType),
      entityId: entityIdFilter(entityId),
      actions: parseActions(action),
      from: parseDate(from),
      to: parseDate(to),
      limit: queryLimit(limit, APP_CONFIG.pagination.audit.default, APP_CONFIG.pagination.audit.max),
      offset: queryOffset(offset),
    });
  }
}

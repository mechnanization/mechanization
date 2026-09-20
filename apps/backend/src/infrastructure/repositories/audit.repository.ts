import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/tenant-client';
import { AuditLogEntry } from '../../domain/entities/audit-log-entry.entity';
import {
  AuditDailyQuery,
  AuditDailyRow,
  AuditQuery,
  AuditRepository,
  AuditRow,
} from '../../domain/interfaces/audit-repository.interface';
import { ValidationError } from '../../domain/errors/domain-error';
import { TenantContextService } from '../context/tenant-context.service';
import { tenantSchemaRef } from '../prisma/tenant-schema-ref';
import { withConnectionRetry } from '../prisma/with-connection-retry';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Append and read. There is deliberately no update or delete method — and the
 * tenant migration installs a Postgres trigger that rejects both anyway, so
 * adding one here would fail at runtime rather than quietly work.
 */
@Injectable()
export class PrismaAuditRepository implements AuditRepository {
  constructor(private readonly tenantContext: TenantContextService) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /**
   * The schema prefix every raw query in this class writes into its SQL.
   *
   * Raw SQL is sent to Postgres untouched, so an unqualified table name resolves
   * through `search_path` — session state on a connection shared through a
   * transaction pooler, which is not required to carry it. See
   * `tenant-schema-ref.ts` for the 42P01 this prevents.
   */
  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  async append(entry: AuditLogEntry): Promise<void> {
    await withConnectionRetry(() =>
      this.db.auditLogEntry.create({
        data: {
          actorId: entry.props.actorId ?? null,
          actorType: entry.props.actorType,
          actorRole: (entry.props.actorRole ?? null) as never,
          actorEmail: entry.props.actorEmail ?? null,
          action: entry.props.action,
          entityType: entry.props.entityType,
          entityId: entry.props.entityId ?? null,
          before: (entry.props.before ?? undefined) as never,
          after: (entry.props.after ?? undefined) as never,
          ipAddress: entry.props.ipAddress ?? null,
          userAgent: entry.props.userAgent ?? null,
        },
      }),
    );
  }

  /**
   * One round trip via `count(*) OVER()` rather than a `findMany` + `count`
   * pair: two queries meant two connections briefly competing for the same
   * tenant schema's pool, which is what surfaced as pool-timeout errors under
   * any concurrent request.
   */
  async facets(): Promise<{ actions: string[]; entityTypes: string[]; actorIds: string[] }> {
    const [actions, entityTypes, actors] = await withConnectionRetry(() =>
      Promise.all([
        this.db.$queryRaw<Array<{ value: string }>>`
          SELECT DISTINCT "action" AS value FROM ${this.S}audit_log_entries ORDER BY 1
        `,
        this.db.$queryRaw<Array<{ value: string }>>`
          SELECT DISTINCT "entityType" AS value FROM ${this.S}audit_log_entries ORDER BY 1
        `,
        this.db.$queryRaw<Array<{ value: string }>>`
          SELECT DISTINCT "actorId"::text AS value FROM ${this.S}audit_log_entries
          WHERE "actorType" = 'STAFF' AND "actorId" IS NOT NULL
        `,
      ]),
    );
    return {
      actions: actions.map((row) => row.value),
      entityTypes: entityTypes.map((row) => row.value),
      actorIds: actors.map((row) => row.value),
    };
  }

  /**
   * The filter clause both reads share.
   *
   * One builder rather than two, because `daily` is the same question as
   * `query` asked at a coarser grain — a summary that narrowed differently from
   * the list it drills into would be a summary of something else.
   */
  private where(query: Partial<AuditQuery>): Prisma.Sql {
    const conditions: Prisma.Sql[] = [];
    if (query.actorId !== undefined && query.actorId !== null) {
      // Postgres raises on `'not-a-uuid'::uuid`, which would surface as a 500
      // for what is really a malformed filter the caller sent.
      if (!UUID_PATTERN.test(query.actorId)) {
        throw new ValidationError('actorId filter must be a valid UUID');
      }
      conditions.push(Prisma.sql`"actorId" = ${query.actorId}::uuid`);
    }
    if (query.entityType) conditions.push(Prisma.sql`"entityType" = ${query.entityType}`);
    if (query.actions?.length) conditions.push(Prisma.sql`"action" = ANY(${query.actions}::text[])`);
    if (query.entityId) conditions.push(Prisma.sql`"entityId" = ${query.entityId}`);
    if (query.from) conditions.push(Prisma.sql`"createdAt" >= ${query.from}`);
    if (query.to) conditions.push(Prisma.sql`"createdAt" <= ${query.to}`);

    return conditions.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
      : Prisma.empty;
  }

  /**
   * One row per (day, actor), with that person's actions counted beneath it.
   *
   * Grouped in Postgres rather than in the page, and that is the point: the
   * list view groups the fifty rows it happens to be showing, so a day spanning
   * a page boundary is two half-days and a busy officer's total is whatever
   * fell on screen. A summary has to count the days, not the page — so the
   * paging unit here is the group, and `count(*) OVER()` counts groups too.
   */
  async daily(query: AuditDailyQuery): Promise<{ items: AuditDailyRow[]; total: number }> {
    const where = this.where(query);

    const rows = await withConnectionRetry(() =>
      this.db.$queryRaw<
        Array<{
          day: string;
          actorId: string | null;
          actions: Array<{ action: string; count: number }>;
          total: number;
          lastAt: Date;
          groups: number;
        }>
      >`
        WITH per_action AS (
          -- createdAt is TIMESTAMP(3) -- no zone -- and Prisma writes UTC into
          -- it. The first AT TIME ZONE labels that value as UTC; the second
          -- converts the instant to the reader's wall clock. One alone would
          -- read the stored value as though it had been written in Beirut and
          -- move every day boundary by the offset.
          SELECT to_char(
                   ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${query.timeZone}::text)::date,
                   'YYYY-MM-DD'
                 ) AS day,
                 "actorId",
                 "action",
                 count(*)::int AS n,
                 max("createdAt") AS last_at
          FROM ${this.S}audit_log_entries
          ${where}
          GROUP BY 1, 2, 3
        ),
        per_day AS (
          SELECT day,
                 "actorId",
                 sum(n)::int AS total,
                 max(last_at) AS "lastAt",
                 jsonb_agg(
                   jsonb_build_object('action', "action", 'count', n)
                   ORDER BY n DESC, "action"
                 ) AS actions
          FROM per_action
          GROUP BY day, "actorId"
        )
        SELECT day, "actorId", total, "lastAt", actions,
               count(*) OVER()::int AS groups
        FROM per_day
        ORDER BY day DESC, total DESC, "actorId"
        LIMIT ${query.limit} OFFSET ${query.offset}
      `,
    );

    return {
      items: rows.map((row) => ({
        day: row.day,
        actorId: row.actorId,
        actions: row.actions,
        total: row.total,
        lastAt: row.lastAt,
      })),
      total: rows[0]?.groups ?? 0,
    };
  }

  async query(query: AuditQuery): Promise<{ items: AuditRow[]; total: number }> {
    const where = this.where(query);

    const rows = await withConnectionRetry(() =>
      this.db.$queryRaw<
        Array<{
          id: string;
          actorId: string | null;
          actorType: string;
          actorRole: string | null;
          actorEmail: string | null;
          action: string;
          entityType: string;
          entityId: string | null;
          before: unknown;
          after: unknown;
          ipAddress: string | null;
          userAgent: string | null;
          createdAt: Date;
          total: number;
        }>
      >`
        SELECT *, count(*) OVER()::int AS total
        FROM ${this.S}audit_log_entries
        ${where}
        ORDER BY "createdAt" DESC
        LIMIT ${query.limit} OFFSET ${query.offset}
      `,
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        actorId: row.actorId,
        actorType: row.actorType,
        actorRole: row.actorRole,
        actorEmail: row.actorEmail,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        before: row.before,
        after: row.after,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt,
      })),
      total: rows[0]?.total ?? 0,
    };
  }
}

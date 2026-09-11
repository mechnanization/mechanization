import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/tenant-client';
import { AuditLogEntry } from '../../domain/entities/audit-log-entry.entity';
import {
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
  async query(query: AuditQuery): Promise<{ items: AuditRow[]; total: number }> {
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
    if (query.entityId) conditions.push(Prisma.sql`"entityId" = ${query.entityId}`);
    if (query.from) conditions.push(Prisma.sql`"createdAt" >= ${query.from}`);
    if (query.to) conditions.push(Prisma.sql`"createdAt" <= ${query.to}`);

    const where =
      conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

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

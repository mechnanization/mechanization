import { AuditLogEntry } from '../entities/audit-log-entry.entity';

export interface AuditQuery {
  actorId?: string;
  entityType?: string;
  entityId?: string;
  /** One or more action codes, any of which matches. */
  actions?: string[];
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

export interface AuditRow {
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
  createdAt: Date;
}

/**
 * The same filters as `AuditQuery`, rolled up by day and by who acted.
 *
 * `timeZone` is the reader's, not the server's. A day is a human unit — «what
 * did Jawad do on Tuesday» — and a municipality in Beirut asking a container in
 * UTC would see the evening's work filed under the following morning. Postgres
 * does the bucketing so the boundaries match the ones it pages on.
 */
export interface AuditDailyQuery extends Omit<AuditQuery, 'entityId'> {
  /** An IANA zone, already validated by the caller. */
  timeZone: string;
}

export interface AuditDailyRow {
  /** `YYYY-MM-DD` in the requested zone. */
  day: string;
  actorId: string | null;
  /** Every action this person took that day, commonest first. */
  actions: Array<{ action: string; count: number }>;
  total: number;
  /** The newest entry in the group — what the row is sorted and timed by. */
  lastAt: Date;
}

export interface AuditRepository {
  /** Append only — there is deliberately no update or delete on this port. */
  append(entry: AuditLogEntry): Promise<void>;
  query(query: AuditQuery): Promise<{ items: AuditRow[]; total: number }>;
  /** One row per (day, staff member), for the log's summary view. */
  daily(query: AuditDailyQuery): Promise<{ items: AuditDailyRow[]; total: number }>;
  /** What the filters can offer: the actions and the staff that appear in the log. */
  facets(): Promise<{ actions: string[]; entityTypes: string[]; actorIds: string[] }>;
}

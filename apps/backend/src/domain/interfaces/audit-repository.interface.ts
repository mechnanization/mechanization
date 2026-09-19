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

export interface AuditRepository {
  /** Append only — there is deliberately no update or delete on this port. */
  append(entry: AuditLogEntry): Promise<void>;
  query(query: AuditQuery): Promise<{ items: AuditRow[]; total: number }>;
  /** What the filters can offer: the actions and the staff that appear in the log. */
  facets(): Promise<{ actions: string[]; entityTypes: string[]; actorIds: string[] }>;
}

import { StaffRole } from './user.entity';

export interface AuditLogEntryProps {
  actorId?: string | null;
  actorType: 'STAFF' | 'CITIZEN' | 'SYSTEM';
  actorRole?: StaffRole | null;
  actorEmail?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Fields that must never reach the audit table. An audit trail exists so staff
 * actions can be reviewed — it is not a second, less-guarded copy of the
 * citizen data those actions touched. Anyone with audit read access would
 * otherwise see national ID numbers without ever opening a report.
 */
const REDACTED_KEYS = new Set([
  'passwordhash',
  'password',
  'totpsecret',
  'codehash',
  'identitydocnumber',
  'civilrecordnumber',
  'residencynumber',
  // صفة الإقامة — whether somebody is a refugee. Recorded as "changed", never as a value.
  'residentstatus',
  'phone',
  // The local contact is somebody else, and their number is theirs.
  'localcontactphone',
  // «رقم للتواصل» — the same rule, for the relative an elderly citizen with no
  // phone of their own is reached through (0069).
  'contactphone',
  'whatsapp',
  'landlordphone',
  'token',
  'accesstoken',
  // Staff refresh tokens, and the keyed hash they are stored as. Nothing
  // records either today; this is what keeps it that way if something starts.
  'refreshtoken',
  'tokenhash',
]);

const REDACTED = '[redacted]';

/**
 * Append-only by construction: there is no mutator on this class, and the
 * migration adds a Postgres trigger rejecting UPDATE/DELETE on the table. An
 * audit trail a compromised admin can edit is not an audit trail.
 */
export class AuditLogEntry {
  private constructor(readonly props: Readonly<AuditLogEntryProps>) {}

  static create(props: AuditLogEntryProps): AuditLogEntry {
    return new AuditLogEntry({
      ...props,
      before: AuditLogEntry.redact(props.before),
      after: AuditLogEntry.redact(props.after),
    });
  }

  /** Recurses so a nested `{ citizen: { identityDocNumber } }` is caught too. */
  static redact(
    value: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null {
    if (!value) return null;

    const walk = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map(walk);
      if (input === null || typeof input !== 'object') return input;

      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([key, val]) => [
          key,
          REDACTED_KEYS.has(key.toLowerCase()) ? REDACTED : walk(val),
        ]),
      );
    };

    return walk(value) as Record<string, unknown>;
  }
}

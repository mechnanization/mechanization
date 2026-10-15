import { z } from 'zod';
import { uuid } from './primitives';

/**
 * The audit log's «who» filter for the entries no person made: the scheduler's
 * recurring billing, a payment provider's callback. Those rows carry no
 * `actorId` (NULL), so «النظام» has no id to filter by, and leaving the filter
 * off meant everyone. The daily report's «النظام» row drills down with this.
 *
 * Sent as `?actorId=SYSTEM`; the server reads it as `"actorId" IS NULL`.
 */
export const AUDIT_SYSTEM_ACTOR = 'SYSTEM';

/** `?actorId=` on the audit reads: a person's id, or `AUDIT_SYSTEM_ACTOR`. */
export const auditActorFilterSchema = z.union([uuid, z.literal(AUDIT_SYSTEM_ACTOR)]).optional();

export type AuditActorFilter = z.infer<typeof auditActorFilterSchema>;

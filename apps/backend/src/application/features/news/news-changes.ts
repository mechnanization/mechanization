import type { EventEmitter2 } from '@nestjs/event-emitter';

/** Who is asking: their municipality, and the account Day3ati knows them by (our staff id). */
export interface NewsActor {
  tenantSlug: string;
  id: string;
  role: string;
}

/**
 * Records that a change to News was accepted by Day3ati (`news.changed`, the
 * audit listener's event). Called after Day3ati answered, so a refused change
 * leaves no row. `after` holds ids and switches, never a title, a name or any
 * text a person wrote.
 */
export function emitNewsChanged(
  events: EventEmitter2,
  who: NewsActor,
  change: { action: string; entityType: string; entityId: string; after?: Record<string, unknown> },
): void {
  events.emit('news.changed', {
    tenantSlug: who.tenantSlug,
    ...change,
    actorId: who.id,
    actorRole: who.role,
  });
}

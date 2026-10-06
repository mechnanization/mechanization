import { Injectable, Logger } from '@nestjs/common';
import {
  STAFF_PRESENCE_STAMP_EVERY_SECONDS,
  type StaffPresenceResponse,
} from '@mechanization/shared-schemas';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { withConnectionRetry } from '../../../infrastructure/prisma/with-connection-retry';

/**
 * «متصل الآن» — staff presence, stamped from activity.
 *
 * Kept beside `SessionRevocationService` and shaped like it, for the same
 * reason: the guard decides whether a request may proceed, and this records
 * that it did. The guard would otherwise need the cache and the tenant client,
 * neither of which is a guard's business. The threshold that turns the stamp
 * into a label, and the stamp interval, are one rule in
 * `@mechanization/shared-schemas` (`staff-presence.ts`).
 *
 * ## Why this is safe to call on every request
 *
 * It is not a write on every request. A cache gate decides: held means
 * "stamped within the last minute, do nothing", and only winning it costs an
 * UPDATE. The gate is `setIfAbsent` — an in-process check, then `SET … NX`
 * across instances — so a burst of requests, or two pm2 workers seeing the
 * same officer in the same minute, stamp once.
 *
 * ## Why it never fails a request
 *
 * Presence is a label on one admin screen. A database hiccup while stamping it
 * must not turn an officer's save into a 500, so `touch` swallows its own
 * errors and logs them at debug. This is the one place in the backend where
 * "best effort" is the correct contract, and it is correct precisely because
 * nothing downstream reads the result: a missed stamp shows one officer as
 * «غير متصل» a minute early and loses nothing else.
 */
@Injectable()
export class StaffPresenceService {
  private readonly logger = new Logger(StaffPresenceService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly cache: RedisCacheService,
  ) {}

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  /** Namespaced per tenant, like every other key in this system. */
  private key(userId: string): string {
    return `presence:${this.tenantContext.tenantSlug}:staff:${userId}`;
  }

  /**
   * Records that this account is active, at most once a minute.
   *
   * `kind` is passed in from the token's claims rather than read back from the
   * row: the caller already knows it, and a lookup to decide whether to do a
   * write would cost the round trip the throttle exists to avoid. The UPDATE
   * still says `kind = 'STAFF'` itself, so a citizen row cannot be stamped
   * whatever a caller passes.
   *
   * A raw UPDATE rather than `prisma.user.update`: the model's `@updatedAt`
   * would otherwise move on every stamp, and for staff `updatedAt` would come
   * to mean "last seen" instead of "last edited". `now()` is the database's
   * clock, the same one `presence()` reports as `now`, so the screen compares
   * a stamp and a "now" from one clock.
   */
  async touch(userId: string, kind: string | undefined): Promise<void> {
    if (kind !== 'STAFF') return;

    try {
      /*
        The gate is won before the write, not after.

        Set afterwards, a burst of requests arriving together would each find
        the gate open and each issue its own UPDATE — the thundering herd the
        throttle is for. Won first, the losers of that race skip the write,
        and the cost of a lost stamp is at most a minute of staleness.
      */
      const won = await this.cache.setIfAbsent(
        this.key(userId),
        Date.now(),
        STAFF_PRESENCE_STAMP_EVERY_SECONDS,
      );
      if (!won) return;

      await this.tenantContext.prisma.$executeRaw`
        UPDATE ${this.S}users SET "lastSeenAt" = now()
         WHERE id = ${userId}::uuid AND kind = 'STAFF'
      `;
    } catch (error) {
      /*
        Deliberately swallowed — see the class comment. Debug rather than warn:
        on a pooler blip this would otherwise fire once a minute per signed-in
        officer and bury the errors that matter.
      */
      this.logger.debug(
        `Could not stamp presence for ${userId}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  /**
   * Every live staff account's «آخر ظهور», with the database's clock.
   *
   * What the staff page polls once a minute, so it carries nothing else: the
   * full roster computes every inspector's earnings over every filing they
   * made, which is not a query to repeat on a timer. Deleted accounts are left
   * out, as the roster leaves them out.
   */
  async presence(): Promise<StaffPresenceResponse> {
    const [clock, rows] = await withConnectionRetry(() =>
      Promise.all([
        this.tenantContext.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`,
        this.tenantContext.prisma.$queryRaw<Array<{ id: string; lastSeenAt: Date | null }>>`
          SELECT u.id, u."lastSeenAt"
            FROM ${this.S}users u
           WHERE u.kind = 'STAFF' AND u."deletedAt" IS NULL
        `,
      ]),
    );
    return {
      now: (clock[0]?.now ?? new Date()).toISOString(),
      items: rows.map((row) => ({ id: row.id, lastSeenAt: row.lastSeenAt?.toISOString() ?? null })),
    };
  }
}

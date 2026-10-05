import { Injectable, Logger } from '@nestjs/common';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';

/**
 * How stale «آخر ظهور» is allowed to get while somebody is working.
 *
 * The throttle, and the only thing standing between this feature and a write
 * to `users` on every authenticated request. One minute means an officer
 * clicking through the register costs one UPDATE a minute instead of one per
 * click, and the column is at most a minute behind the truth — which is well
 * inside `ONLINE_WITHIN_SECONDS` below, so the staleness never shows as
 * «غير متصل» for somebody who is in fact there.
 */
const STAMP_EVERY_SECONDS = 60;

/**
 * How recently an account must have been seen to read «متصل الآن».
 *
 * Five minutes, against a one-minute stamp: three of those minutes are slack
 * for the throttle, a slow request and the clock. The question this answers
 * is «is this officer at the system now», so it has to be short enough that
 * «متصل» means something — and long enough that reading one long page, or a
 * tab left on the dashboard between two citizens at the counter, does not
 * flicker somebody offline while they are sitting there.
 *
 * It is deliberately *not* the token lifetime. A fifteen-minute access token
 * says how long a session may go unrefreshed; it says nothing about whether
 * anybody is holding the keyboard.
 */
export const ONLINE_WITHIN_SECONDS = 5 * 60;

/** Whether a stamp this recent counts as present. Shared by every reader. */
export function isOnline(lastSeenAt: Date | string | null | undefined, now = Date.now()): boolean {
  if (!lastSeenAt) return false;
  const seen = lastSeenAt instanceof Date ? lastSeenAt.getTime() : new Date(lastSeenAt).getTime();
  if (Number.isNaN(seen)) return false;
  return now - seen <= ONLINE_WITHIN_SECONDS * 1000;
}

/**
 * «متصل الآن» — staff presence, stamped from activity.
 *
 * Kept beside `SessionRevocationService` and shaped like it, for the same
 * reason: the guard decides whether a request may proceed, and this records
 * that it did. The guard would otherwise need the cache and the tenant client,
 * neither of which is a guard's business.
 *
 * ## Why this is safe to call on every request
 *
 * It is not a write on every request. The Redis key is the gate: present means
 * "stamped within the last minute, do nothing", and only its absence costs an
 * UPDATE. The gate is checked against the same two-tier cache the revocation
 * check already uses, so the common path is an in-process map lookup.
 *
 * ## Why it never fails a request
 *
 * Presence is a convenience on one admin screen. A database hiccup while
 * stamping it must not turn an officer's save into a 500, so `touch` swallows
 * its own errors and logs them at debug. This is the one place in the backend
 * where "best effort" is the correct contract, and it is correct precisely
 * because nothing downstream reads the result: a missed stamp shows one
 * officer as «غير متصل» a minute early and loses nothing else.
 */
@Injectable()
export class StaffPresenceService {
  private readonly logger = new Logger(StaffPresenceService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly cache: RedisCacheService,
  ) {}

  /** Namespaced per tenant, like every other key in this system. */
  private key(userId: string): string {
    return `presence:${this.tenantContext.tenantSlug}:staff:${userId}`;
  }

  /**
   * Records that this account is active, at most once a minute.
   *
   * `kind` is passed in from the token's claims rather than read back from the
   * row: the caller already knows it, and a lookup to decide whether to do a
   * write would cost the round trip the throttle exists to avoid.
   */
  async touch(userId: string, kind: string | undefined): Promise<void> {
    if (kind !== 'STAFF') return;

    try {
      const key = this.key(userId);
      const stamped = await this.cache.get<number>(key);
      if (stamped !== null && stamped !== undefined) return;

      /*
        The gate is set before the write, not after.

        Set afterwards, a burst of requests arriving together would each find
        the gate open and each issue its own UPDATE — the thundering herd the
        throttle is for. Set first, the loser of that race skips the write,
        and the cost of the one lost stamp is at most a minute of staleness.
      */
      await this.cache.set(key, Date.now(), STAMP_EVERY_SECONDS);

      await this.tenantContext.prisma.user.update({
        where: { id: userId },
        data: { lastSeenAt: new Date() },
        select: { id: true },
      });
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
}

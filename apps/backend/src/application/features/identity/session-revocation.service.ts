import { Injectable } from '@nestjs/common';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { withConnectionRetry } from '../../../infrastructure/prisma/with-connection-retry';

/**
 * How long a revoked session may still be honoured.
 *
 * The whole point of `tokenVersion` is that it is checked on *every* request,
 * and the whole cost of that is a database round trip on every request — on the
 * hot path, against a pooler this system already works hard to keep off (see
 * the single-statement rewrites in `ReportingService`). So the answer is
 * cached, and this is the window in which a dismissed staff member's existing
 * session still works.
 *
 * Thirty seconds is chosen against what it replaces, not against zero: before
 * this column existed, revocation took until the token expired — up to thirty
 * days. Thirty seconds is the same guarantee every session-cookie system with a
 * cache gives, and it is short enough that "I have revoked their access" is
 * true by the time the sentence is finished.
 *
 * The bound is per instance: `RedisCacheService`'s L1 tier is not invalidated
 * across replicas, so on a multi-instance deployment this is the worst case on
 * each. Closing that is the pub/sub work tracked as F-14.
 */
const TOKEN_VERSION_TTL_SECONDS = 30;

/** A family id is the root row's UUID; anything else cannot name one. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The revocation check behind every authenticated request.
 *
 * Kept out of `JwtAuthGuard` so the guard stays a guard: it decides whether a
 * request may proceed, and this decides what the current truth is. It also
 * keeps the caching in one place — the guard would otherwise need the cache,
 * the tenant client and the retry helper, none of which is its business.
 */
@Injectable()
export class SessionRevocationService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly cache: RedisCacheService,
  ) {}

  /**
   * Namespaced per tenant, like every other key in this system. A user id is a
   * UUID and so already unique, but a key that reads `…:{tenant}:…` is one that
   * cannot be reasoned about wrongly later.
   */
  private key(userId: string): string {
    return `session:${this.tenantContext.tenantSlug}:tokenVersion:${userId}`;
  }

  /**
   * Whether a token's stamped version still matches the account's.
   *
   * A missing account returns `false` — a token whose subject no longer exists
   * is not a valid session, and treating "cannot find them" as "carry on" is
   * how a deleted staff member keeps working.
   *
   * A token minted before this column existed carries no `tokenVersion` at all.
   * Those are accepted only against version 0, which is every account's
   * starting value — so existing sessions survive the deploy, and the first
   * revocation of any kind invalidates them for good.
   */
  async isCurrent(userId: string, claimed: number | undefined): Promise<boolean> {
    const current = await this.currentVersion(userId);
    if (current === null) return false;
    return (claimed ?? 0) === current;
  }

  private async currentVersion(userId: string): Promise<number | null> {
    const key = this.key(userId);

    const cached = await this.cache.get<number>(key);
    if (cached !== null && cached !== undefined) return cached;

    const row = await withConnectionRetry(() =>
      this.tenantContext.prisma.user.findUnique({
        where: { id: userId },
        select: { tokenVersion: true, isActive: true },
      }),
    );

    if (!row) return null;

    /**
     * A deactivated account is treated as revoked outright rather than as a
     * version mismatch. `setStaffActive` bumps the version too, so this is
     * belt and braces — but it is the belt that holds if a future write path
     * forgets the bump, and the cost is a boolean already fetched.
     */
    if (!row.isActive) return null;

    await this.cache.set(key, row.tokenVersion, TOKEN_VERSION_TTL_SECONDS);
    return row.tokenVersion;
  }

  /**
   * Drops the cached version for one account.
   *
   * Called after a bump so the revocation is immediate on the instance that
   * performed it, rather than waiting out the TTL there too.
   */
  async forget(userId: string): Promise<void> {
    await this.cache.invalidatePrefix(this.key(userId));
  }

  private familyKey(familyId: string): string {
    return `session:${this.tenantContext.tenantSlug}:family:${familyId}`;
  }

  /**
   * Whether the sign-in a staff access token belongs to (its `sid`) is still
   * alive — the check that lets a logout, or a detected refresh-token reuse,
   * end the access token as well as the refresh token.
   *
   * `tokenVersion` cannot do this: it is per account, so bumping it to end one
   * session would end every session that account has on every device.
   *
   * Read from the family's **root** row only, and that is deliberate. A
   * revocation sweeps every row of the family, but a rotation committing a new
   * child just after the sweep's snapshot would leave that child unrevoked. The
   * root is written once at sign-in and revoked by every sweep, so asking it
   * alone means an orphan child can never keep a revoked family alive.
   *
   * Cached for the same window as the version, for the same reason: this runs
   * on every staff request. `false` is cached as well as `true` — a revoked
   * family stays revoked, and a burst of requests from a signed-out tab should
   * not each cost a round trip to find that out.
   */
  async isFamilyLive(familyId: string): Promise<boolean> {
    if (!UUID_SHAPE.test(familyId)) return false;

    const key = this.familyKey(familyId);

    const cached = await this.cache.get<boolean>(key);
    if (cached !== null && cached !== undefined) return cached;

    const root = await withConnectionRetry(() =>
      this.tenantContext.prisma.staffRefreshToken.findUnique({
        where: { id: familyId },
        select: { familyId: true, revokedAt: true, expiresAt: true },
      }),
    );

    const live =
      root !== null &&
      root.familyId === familyId &&
      root.revokedAt === null &&
      root.expiresAt > new Date();

    await this.cache.set(key, live, TOKEN_VERSION_TTL_SECONDS);
    return live;
  }

  /** Drops the cached liveness of one family, after it has been revoked. */
  async forgetFamily(familyId: string): Promise<void> {
    await this.cache.invalidatePrefix(this.familyKey(familyId));
  }
}

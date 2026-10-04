import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { SessionRevocationService } from './session-revocation.service';

/**
 * Revoking a session that has already been issued.
 *
 * Until `tokenVersion` there was no way to do it at all. `role` travels inside
 * the JWT and `RolesGuard` authorises from that claim; `isActive` and the
 * Supabase ban are both consulted only at login. So a dismissed staff member,
 * or a demoted SUPER_ADMIN, kept exactly the access they had until their token
 * expired — up to thirty days with "تذكّرني على هذا الجهاز", with nothing in
 * the UI or the audit trail to suggest the account was still live.
 */
interface FamilyRoot {
  familyId: string;
  revokedAt: Date | null;
  expiresAt: Date;
}

function build(
  row: { tokenVersion: number; isActive: boolean } | null,
  root: FamilyRoot | null = null,
) {
  const findUnique = jest.fn().mockResolvedValue(row);
  const findRoot = jest.fn().mockResolvedValue(root);
  const store = new Map<string, unknown>();

  const cache = {
    get: jest.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    set: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    invalidatePrefix: jest.fn(async (prefix: string) => {
      for (const key of [...store.keys()]) {
        if (key.startsWith(prefix)) store.delete(key);
      }
    }),
  } as unknown as RedisCacheService;

  const service = new SessionRevocationService(
    {
      tenantSlug: 'albazourieh',
      prisma: { user: { findUnique }, staffRefreshToken: { findUnique: findRoot } },
    } as unknown as TenantContextService,
    cache,
  );

  return { service, findUnique, findRoot, cache };
}

describe('SessionRevocationService', () => {
  it('accepts a token stamped with the current version', async () => {
    const { service } = build({ tokenVersion: 3, isActive: true });
    await expect(service.isCurrent('staff-1', 3)).resolves.toBe(true);
  });

  it('rejects a token stamped with a superseded version', async () => {
    // The dismissal case: the row moved on, the token did not.
    const { service } = build({ tokenVersion: 4, isActive: true });
    await expect(service.isCurrent('staff-1', 3)).resolves.toBe(false);
  });

  it('rejects a token for a deactivated account', async () => {
    // Belt and braces: `setStaffActive` bumps the version too, so this only
    // matters if a future write path forgets to.
    const { service } = build({ tokenVersion: 3, isActive: false });
    await expect(service.isCurrent('staff-1', 3)).resolves.toBe(false);
  });

  it('rejects a token whose subject no longer exists', async () => {
    // "Cannot find them" must not read as "carry on".
    const { service } = build(null);
    await expect(service.isCurrent('ghost', 0)).resolves.toBe(false);
  });

  it('accepts a token minted before the column existed', async () => {
    // Those carry no `tokenVersion` at all. Reading a missing claim as 0 — the
    // starting value of every account — is what lets existing sessions survive
    // the deploy; the first revocation of any kind then invalidates them.
    const { service } = build({ tokenVersion: 0, isActive: true });
    await expect(service.isCurrent('staff-1', undefined)).resolves.toBe(true);
  });

  it('rejects a legacy token once the account has been revoked once', async () => {
    const { service } = build({ tokenVersion: 1, isActive: true });
    await expect(service.isCurrent('staff-1', undefined)).resolves.toBe(false);
  });

  it('does not hit the database on every request', async () => {
    // The check runs on every authenticated request, against a pooler this
    // system already works to keep off the hot path.
    const { service, findUnique } = build({ tokenVersion: 2, isActive: true });

    await service.isCurrent('staff-1', 2);
    await service.isCurrent('staff-1', 2);
    await service.isCurrent('staff-1', 2);

    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('re-reads after a revocation drops the cached version', async () => {
    const { service, findUnique } = build({ tokenVersion: 2, isActive: true });
    await expect(service.isCurrent('staff-1', 2)).resolves.toBe(true);

    // What `StaffService` calls after bumping, so the revocation takes effect
    // on this instance immediately rather than at the end of the TTL.
    findUnique.mockResolvedValue({ tokenVersion: 3, isActive: true });
    await service.forget('staff-1');

    await expect(service.isCurrent('staff-1', 2)).resolves.toBe(false);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('does not cache a missing account as a version', async () => {
    // Caching "not found" as a number would make a deleted account's token
    // start working again.
    const { service, cache } = build(null);
    await service.isCurrent('ghost', 0);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('scopes the cache key to the municipality', async () => {
    const { service, cache } = build({ tokenVersion: 1, isActive: true });
    await service.isCurrent('staff-1', 1);

    expect(cache.set).toHaveBeenCalledWith(
      'session:albazourieh:tokenVersion:staff-1',
      1,
      expect.any(Number),
    );
  });
});

/**
 * Whether the sign-in a staff token belongs to (its `sid`) is still alive.
 *
 * `tokenVersion` is per account: bumping it to end one session would end every
 * session that account has on every device. A logout or a detected reuse ends
 * one refresh-token family, and this is how the guard learns of it.
 *
 * Only the family's **root** row is read. A revocation sweeps every row, but a
 * rotation committing a new child just after the sweep's snapshot leaves that
 * child unrevoked; asking the root alone means such an orphan can never keep
 * a revoked family alive.
 */
describe('SessionRevocationService — isFamilyLive', () => {
  const FAMILY = '5b0f6f7e-2f4a-4c55-9d38-0f3c2a8b1e11';
  const LIVE_STAFF = { tokenVersion: 0, isActive: true };
  const inAnHour = () => new Date(Date.now() + 3_600_000);

  const liveRoot = (): FamilyRoot => ({ familyId: FAMILY, revokedAt: null, expiresAt: inAnHour() });

  it('is live while its root is neither revoked nor past its cap', async () => {
    const { service, findRoot } = build(LIVE_STAFF, liveRoot());

    await expect(service.isFamilyLive(FAMILY)).resolves.toBe(true);
    // The root is the row whose id *is* the family id.
    expect(findRoot).toHaveBeenCalledWith(expect.objectContaining({ where: { id: FAMILY } }));
  });

  it('has ended once its root is revoked', async () => {
    const { service } = build(LIVE_STAFF, { ...liveRoot(), revokedAt: new Date('2026-09-26T09:00:00Z') });
    await expect(service.isFamilyLive(FAMILY)).resolves.toBe(false);
  });

  it('has ended once its root is past the session cap', async () => {
    const { service } = build(LIVE_STAFF, { ...liveRoot(), expiresAt: new Date('2000-01-01T00:00:00Z') });
    await expect(service.isFamilyLive(FAMILY)).resolves.toBe(false);
  });

  it('has ended when there is no such row — pruned, cascaded, or never issued', async () => {
    const { service } = build(LIVE_STAFF, null);
    await expect(service.isFamilyLive(FAMILY)).resolves.toBe(false);
  });

  it('does not take a child row for the root', async () => {
    // A `sid` naming a child's id would otherwise be judged by that child's
    // own columns, which a racing rotation can leave unrevoked.
    const { service } = build(LIVE_STAFF, { ...liveRoot(), familyId: 'a-different-family' });
    await expect(service.isFamilyLive(FAMILY)).resolves.toBe(false);
  });

  it('refuses a sid that is not a UUID without querying', async () => {
    // It came out of a token; a malformed one reaching a uuid column would be
    // a 500 on every request that carried it.
    const { service, findRoot } = build(LIVE_STAFF, liveRoot());

    await expect(service.isFamilyLive('not-a-uuid')).resolves.toBe(false);
    expect(findRoot).not.toHaveBeenCalled();
  });

  it('caches a live answer, so a busy tab costs one query per window', async () => {
    const { service, findRoot, cache } = build(LIVE_STAFF, liveRoot());

    await service.isFamilyLive(FAMILY);
    await service.isFamilyLive(FAMILY);
    await service.isFamilyLive(FAMILY);

    expect(findRoot).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(`session:albazourieh:family:${FAMILY}`, true, 30);
  });

  it('caches an ended answer as well — false is a value, not a miss', async () => {
    // A signed-out tab still polling should not cost a round trip per request
    // to be told the same thing. The cache stores `false`, and the read must
    // not mistake it for "nothing cached".
    const { service, findRoot, cache } = build(LIVE_STAFF, { ...liveRoot(), revokedAt: new Date() });

    await expect(service.isFamilyLive(FAMILY)).resolves.toBe(false);
    await expect(service.isFamilyLive(FAMILY)).resolves.toBe(false);

    expect(findRoot).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(`session:albazourieh:family:${FAMILY}`, false, 30);
  });

  it('re-reads after forgetFamily, so a logout stops the token now rather than in 30s', async () => {
    const { service, findRoot } = build(LIVE_STAFF, liveRoot());
    await expect(service.isFamilyLive(FAMILY)).resolves.toBe(true);

    findRoot.mockResolvedValue({ ...liveRoot(), revokedAt: new Date() });
    await service.forgetFamily(FAMILY);

    await expect(service.isFamilyLive(FAMILY)).resolves.toBe(false);
    expect(findRoot).toHaveBeenCalledTimes(2);
  });

  it('forgets only the family it was asked to', async () => {
    const OTHER = '9c1d2e3f-4a5b-4c6d-8e7f-a0b1c2d3e4f5';
    const { service, cache } = build(LIVE_STAFF, liveRoot());
    await service.isCurrent('staff-1', 0);

    await service.forgetFamily(FAMILY);

    expect(cache.invalidatePrefix).toHaveBeenCalledWith(`session:albazourieh:family:${FAMILY}`);
    expect(cache.invalidatePrefix).not.toHaveBeenCalledWith(`session:albazourieh:family:${OTHER}`);
    // The account's cached version is untouched: one sign-in ended, not all of them.
    await expect(cache.get('session:albazourieh:tokenVersion:staff-1')).resolves.toBe(0);
  });
});

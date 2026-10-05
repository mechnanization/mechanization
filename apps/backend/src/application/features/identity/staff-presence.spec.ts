import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import {
  ONLINE_WITHIN_SECONDS,
  StaffPresenceService,
  isOnline,
} from './staff-presence.service';

/**
 * «متصل الآن» / «آخر ظهور» — staff presence.
 *
 * What is actually being protected is not "the column gets written". It is
 * that a feature living on the hot path of *every authenticated request* stays
 * cheap and stays harmless:
 *
 *  1. **The throttle holds.** Without it this is one UPDATE on `users` per
 *     request, on a system that works hard to keep round trips off the pooler.
 *  2. **The gate closes before the write, not after.** Otherwise a burst of
 *     requests arriving together each find it open and each issue an UPDATE —
 *     the thundering herd the throttle exists to prevent.
 *  3. **Citizens are never stamped.** `users` holds both kinds and the portal
 *     is the busier half; a write there would buy nothing, since no screen
 *     asks whether a citizen is online.
 *  4. **It cannot fail a request.** A database hiccup while recording a
 *     convenience on one admin screen must not turn an officer's save into a
 *     500. This is the one place where "best effort" is the right contract.
 */

function harness(options: { gateOpen?: boolean; updateFails?: boolean } = {}) {
  const cache = {
    get: jest.fn().mockResolvedValue(options.gateOpen === false ? Date.now() : null),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const update = options.updateFails
    ? jest.fn().mockRejectedValue(new Error('pooler went away'))
    : jest.fn().mockResolvedValue({ id: 'staff-1' });

  const tenantContext = {
    tenantSlug: 'albazourieh',
    prisma: { user: { update } },
  };

  const service = new StaffPresenceService(
    tenantContext as unknown as TenantContextService,
    cache as unknown as RedisCacheService,
  );

  return { service, cache, update };
}

describe('StaffPresenceService.touch', () => {
  it('stamps the column when the gate is open', async () => {
    const { service, update } = harness();

    await service.touch('staff-1', 'STAFF');

    expect(update).toHaveBeenCalledTimes(1);
    const [[call]] = update.mock.calls as [[{ where: { id: string }; data: { lastSeenAt: Date } }]];
    expect(call.where).toEqual({ id: 'staff-1' });
    expect(call.data.lastSeenAt).toBeInstanceOf(Date);
  });

  it('writes nothing at all while a recent stamp is still cached', async () => {
    /*
      The throttle. This is the assertion that keeps presence off the pooler:
      the common path must cost a cache lookup and nothing else.
    */
    const { service, update } = harness({ gateOpen: false });

    await service.touch('staff-1', 'STAFF');

    expect(update).not.toHaveBeenCalled();
  });

  it('closes the gate before writing, so a burst cannot stampede', async () => {
    const { service, cache, update } = harness();
    const order: string[] = [];
    cache.set.mockImplementation(() => {
      order.push('gate');
      return Promise.resolve();
    });
    update.mockImplementation(() => {
      order.push('write');
      return Promise.resolve({ id: 'staff-1' });
    });

    await service.touch('staff-1', 'STAFF');

    expect(order).toEqual(['gate', 'write']);
  });

  it('namespaces the gate by tenant', async () => {
    const { service, cache } = harness();

    await service.touch('staff-1', 'STAFF');

    expect(cache.get).toHaveBeenCalledWith('presence:albazourieh:staff:staff-1');
    expect(cache.set).toHaveBeenCalledWith(
      'presence:albazourieh:staff:staff-1',
      expect.any(Number),
      60,
    );
  });

  it('never stamps a citizen, and never even asks the cache', async () => {
    const { service, cache, update } = harness();

    await service.touch('citizen-1', 'CITIZEN');

    expect(update).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('never stamps a token with no kind at all', async () => {
    const { service, update } = harness();

    await service.touch('whoever', undefined);

    expect(update).not.toHaveBeenCalled();
  });

  it('swallows a failed write rather than refusing the request', async () => {
    /*
      The guard awaits this on the path every authenticated request takes. A
      throw here would turn a database blip into a 500 on a save, to protect a
      label on one admin screen.
    */
    const { service } = harness({ updateFails: true });

    await expect(service.touch('staff-1', 'STAFF')).resolves.toBeUndefined();
  });
});

describe('isOnline', () => {
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  const agoSeconds = (seconds: number) => new Date(now - seconds * 1000);

  it('reads a stamp from a moment ago as present', () => {
    expect(isOnline(agoSeconds(5), now)).toBe(true);
  });

  it('tolerates a stamp the throttle has let go stale', () => {
    /*
      The reason the window is five minutes against a one-minute throttle: an
      officer clicking steadily is stamped up to a minute behind, and must not
      read «غير متصل» for it.
    */
    expect(isOnline(agoSeconds(90), now)).toBe(true);
  });

  it('reads the boundary itself as present, and a second past it as not', () => {
    expect(isOnline(agoSeconds(ONLINE_WITHIN_SECONDS), now)).toBe(true);
    expect(isOnline(agoSeconds(ONLINE_WITHIN_SECONDS + 1), now)).toBe(false);
  });

  it('reads an account never seen as offline rather than as present', () => {
    /*
      The direction that matters. Every staff row held NULL the moment 0070
      shipped, and defaulting those to «متصل» would have reported the whole
      municipality as online.
    */
    expect(isOnline(null, now)).toBe(false);
    expect(isOnline(undefined, now)).toBe(false);
  });

  it('reads an unparseable value as offline', () => {
    expect(isOnline('not a date', now)).toBe(false);
  });

  it('accepts the ISO string the API actually returns', () => {
    expect(isOnline(agoSeconds(30).toISOString(), now)).toBe(true);
  });
});

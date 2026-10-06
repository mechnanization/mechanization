import {
  STAFF_ONLINE_WITHIN_SECONDS,
  STAFF_PRESENCE_STAMP_EVERY_SECONDS,
  isStaffOnline,
} from '@mechanization/shared-schemas';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { StaffPresenceService } from './staff-presence.service';

/**
 * «متصل الآن» / «آخر ظهور» — staff presence.
 *
 * What is actually being protected is not "the column gets written". It is
 * that a feature living on the hot path of *every authenticated request* stays
 * cheap and stays harmless:
 *
 *  1. **The throttle holds.** Without it this is one UPDATE on `users` per
 *     request, on a system that works hard to keep round trips off the pooler.
 *  2. **The gate is won before the write, atomically.** Otherwise a burst of
 *     requests arriving together each find it open and each issue an UPDATE —
 *     the thundering herd the throttle exists to prevent.
 *  3. **Citizens are never stamped** — by the caller's `kind`, and again by
 *     the UPDATE's own `WHERE kind = 'STAFF'`.
 *  4. **It cannot fail a request.** A database hiccup while recording a
 *     convenience on one admin screen must not turn an officer's save into a
 *     500. This is the one place where "best effort" is the right contract.
 */

/** The SQL text of a tagged-template call, parameters left as `?`. */
function sqlOf(call: unknown[]): string {
  const strings = call[0] as TemplateStringsArray;
  return strings.join('?');
}

function harness(options: { gateWon?: boolean; updateFails?: boolean } = {}) {
  const cache = {
    setIfAbsent: jest.fn().mockResolvedValue(options.gateWon ?? true),
  };
  const executeRaw = options.updateFails
    ? jest.fn().mockRejectedValue(new Error('pooler went away'))
    : jest.fn().mockResolvedValue(1);
  const queryRaw = jest.fn();

  const tenantContext = {
    tenantSlug: 'albazourieh',
    schemaName: 'tenant_albazourieh',
    prisma: { $executeRaw: executeRaw, $queryRaw: queryRaw },
  };

  const service = new StaffPresenceService(
    tenantContext as unknown as TenantContextService,
    cache as unknown as RedisCacheService,
  );

  return { service, cache, executeRaw, queryRaw };
}

describe('StaffPresenceService.touch', () => {
  it('stamps the column, for staff only and on the database clock, when it wins the gate', async () => {
    const { service, executeRaw } = harness();

    await service.touch('staff-1', 'STAFF');

    expect(executeRaw).toHaveBeenCalledTimes(1);
    const call = executeRaw.mock.calls[0] as unknown[];
    const sql = sqlOf(call);
    expect(sql).toMatch(/SET "lastSeenAt" = now\(\)/);
    expect(sql).toMatch(/kind = 'STAFF'/);
    expect(call).toContain('staff-1');
  });

  it('does not touch `updatedAt`: the stamp is a raw UPDATE of one column', async () => {
    const { service, executeRaw } = harness();

    await service.touch('staff-1', 'STAFF');

    expect(sqlOf(executeRaw.mock.calls[0] as unknown[])).not.toMatch(/updatedAt/);
  });

  it('writes nothing at all when another request already holds the gate', async () => {
    /*
      The throttle. This is the assertion that keeps presence off the pooler:
      the common path must cost a cache check and nothing else.
    */
    const { service, executeRaw } = harness({ gateWon: false });

    await service.touch('staff-1', 'STAFF');

    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('wins the gate before writing, so a burst cannot stampede', async () => {
    const { service, cache, executeRaw } = harness();
    const order: string[] = [];
    cache.setIfAbsent.mockImplementation(() => {
      order.push('gate');
      return Promise.resolve(true);
    });
    executeRaw.mockImplementation(() => {
      order.push('write');
      return Promise.resolve(1);
    });

    await service.touch('staff-1', 'STAFF');

    expect(order).toEqual(['gate', 'write']);
  });

  it('namespaces the gate by tenant and holds it for the stamp interval', async () => {
    const { service, cache } = harness();

    await service.touch('staff-1', 'STAFF');

    expect(cache.setIfAbsent).toHaveBeenCalledWith(
      'presence:albazourieh:staff:staff-1',
      expect.any(Number),
      STAFF_PRESENCE_STAMP_EVERY_SECONDS,
    );
  });

  it('never stamps a citizen, and never even asks the cache', async () => {
    const { service, cache, executeRaw } = harness();

    await service.touch('citizen-1', 'CITIZEN');

    expect(executeRaw).not.toHaveBeenCalled();
    expect(cache.setIfAbsent).not.toHaveBeenCalled();
  });

  it('never stamps a token with no kind at all', async () => {
    const { service, executeRaw } = harness();

    await service.touch('whoever', undefined);

    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('swallows a failed write rather than rejecting', async () => {
    /*
      The guard does not await this, so a rejection here would be an unhandled
      one on the path every authenticated request takes.
    */
    const { service } = harness({ updateFails: true });

    await expect(service.touch('staff-1', 'STAFF')).resolves.toBeUndefined();
  });
});

describe('StaffPresenceService.presence', () => {
  it('answers with the database clock and every live staff account, citizens and deleted accounts left out', async () => {
    const { service, queryRaw } = harness();
    const dbNow = new Date('2026-10-05T12:00:00.000Z');
    const seen = new Date('2026-10-05T11:58:00.000Z');
    queryRaw
      .mockResolvedValueOnce([{ now: dbNow }])
      .mockResolvedValueOnce([
        { id: 'staff-1', lastSeenAt: seen },
        { id: 'staff-2', lastSeenAt: null },
      ]);

    const answer = await service.presence();

    expect(answer).toEqual({
      now: dbNow.toISOString(),
      items: [
        { id: 'staff-1', lastSeenAt: seen.toISOString() },
        { id: 'staff-2', lastSeenAt: null },
      ],
    });
    const rosterSql = sqlOf(queryRaw.mock.calls[1] as unknown[]);
    expect(rosterSql).toMatch(/kind = 'STAFF'/);
    expect(rosterSql).toMatch(/"deletedAt" IS NULL/);
  });
});

describe('isStaffOnline', () => {
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  const agoSeconds = (seconds: number) => new Date(now - seconds * 1000);

  it('reads a stamp from a moment ago as present', () => {
    expect(isStaffOnline(agoSeconds(5), now)).toBe(true);
  });

  it('tolerates a stamp the throttle has let go stale', () => {
    /*
      The reason the window is five minutes against a one-minute throttle: an
      officer clicking steadily is stamped up to a minute behind, and must not
      read «غير متصل» for it.
    */
    expect(isStaffOnline(agoSeconds(STAFF_PRESENCE_STAMP_EVERY_SECONDS + 30), now)).toBe(true);
  });

  it('reads the boundary itself as present, and a second past it as not', () => {
    expect(isStaffOnline(agoSeconds(STAFF_ONLINE_WITHIN_SECONDS), now)).toBe(true);
    expect(isStaffOnline(agoSeconds(STAFF_ONLINE_WITHIN_SECONDS + 1), now)).toBe(false);
  });

  it('compares against the clock it is given, not the machine it runs on', () => {
    /*
      A browser whose clock runs ten minutes fast must not read a stamp from a
      moment ago as offline: the screen passes the server's `now`.
    */
    const serverNow = new Date(now).toISOString();
    expect(isStaffOnline(agoSeconds(30).toISOString(), serverNow)).toBe(true);
  });

  it('reads an account never seen as offline rather than as present', () => {
    /*
      The direction that matters. Every staff row held NULL the moment 0070
      shipped, and defaulting those to «متصل» would have reported the whole
      municipality as online.
    */
    expect(isStaffOnline(null, now)).toBe(false);
    expect(isStaffOnline(undefined, now)).toBe(false);
  });

  it('reads an unparseable value as offline', () => {
    expect(isStaffOnline('not a date', now)).toBe(false);
  });
});

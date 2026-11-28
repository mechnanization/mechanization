import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import type { RedisCacheService } from './redis-cache.service';
import { RedisThrottlerStorage } from './redis-throttler-storage';

/**
 * The throttler's store (audit SEC-04). Its Lua script is proven against a real
 * Redis outside this suite (the PR's report); what is pinned here is the rule
 * that matters when Redis is not there: a count is never the reason a request
 * fails, and it falls back to counting in this process.
 */
describe('RedisThrottlerStorage', () => {
  const MINUTE = 60_000;
  const storageWith = (client: Partial<Redis> | null) =>
    new RedisThrottlerStorage({ connectedClient: () => client as Redis | null } as unknown as RedisCacheService);

  afterEach(() => jest.restoreAllMocks());

  it('counts in this process while Redis is unset or not connected', async () => {
    const storage = storageWith(null);
    const hits = [];
    for (let i = 0; i < 3; i++) hits.push(await storage.increment('k', MINUTE, 2, MINUTE, 'default'));
    expect(hits.map((hit) => [hit.totalHits, hit.isBlocked])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    storage.onApplicationShutdown();
  });

  it('answers from Redis in seconds, as the in-memory store does', async () => {
    const evalMock = jest.fn().mockResolvedValue([3, 59_001, 1, 60_000]);
    const storage = storageWith({ eval: evalMock } as Partial<Redis>);

    await expect(storage.increment('k', MINUTE, 2, MINUTE, 'default')).resolves.toEqual({
      totalHits: 3,
      timeToExpire: 60,
      isBlocked: true,
      timeToBlockExpire: 60,
    });
    // Both keys under one hash tag, so a cluster keeps them in one slot.
    expect(evalMock.mock.calls[0].slice(1, 4)).toEqual([2, 'throttle:{default:k}:hits', 'throttle:{default:k}:block']);
  });

  it('falls back to this process when a Redis command fails, and says so once', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const storage = storageWith({ eval: jest.fn().mockRejectedValue(new Error('READONLY')) } as Partial<Redis>);

    const first = await storage.increment('k', MINUTE, 5, MINUTE, 'default');
    const second = await storage.increment('k', MINUTE, 5, MINUTE, 'default');

    expect([first.totalHits, second.totalHits]).toEqual([1, 2]);
    expect(warn).toHaveBeenCalledTimes(1);
    storage.onApplicationShutdown();
  });
});

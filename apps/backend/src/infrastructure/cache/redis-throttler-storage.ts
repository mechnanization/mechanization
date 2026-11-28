import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { RedisCacheService } from './redis-cache.service';

/** What a count answers (the package does not export the record type from its root). */
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * One window's count and the block after it, in one round trip.
 *
 * KEYS[1] the hits, KEYS[2] the block; ARGV the window and the block in
 * milliseconds and the limit. A blocked key is answered without counting, as
 * the library's own storage does; the hit that goes over the limit starts the
 * block and drops the count, so the first hit after the block opens a new
 * window at one. Atomic because it is a script: two instances counting the
 * same client cannot both read nine and write ten.
 */
const INCREMENT = `
local blocked = redis.call('PTTL', KEYS[2])
if blocked > 0 then
  return {tonumber(ARGV[3]) + 1, blocked, 1, blocked}
end
local hits = redis.call('INCR', KEYS[1])
local window = redis.call('PTTL', KEYS[1])
if window < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  window = tonumber(ARGV[1])
end
if hits > tonumber(ARGV[3]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[2])
  redis.call('DEL', KEYS[1])
  return {hits, window, 1, tonumber(ARGV[2])}
end
return {hits, window, 0, 0}
`;

/**
 * The throttler's counters, shared by every API process through Redis
 * (audit SEC-04, decision U-6 of 2026-11-28).
 *
 * In memory, each pm2 process counts on its own, so a client gets the limit
 * once per process: five staff sign-ins a minute became five times the
 * instance count. With `REDIS_URL` set, every process counts in one place.
 *
 * Never the reason a request fails. With `REDIS_URL` unset, or Redis still
 * connecting or offline (`RedisCacheService.connectedClient`), or a command
 * that errors, the hit is counted by the library's in-memory storage instead:
 * the per-process limit this replaced, for the length of the outage. One
 * warning per outage, and one line when it ends.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly memory = new ThrottlerStorageService();
  private degraded = false;

  constructor(private readonly cache: RedisCacheService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const client = this.cache.connectedClient();
    if (!client) return this.memory.increment(key, ttl, limit, blockDuration, throttlerName);

    // One hash tag, so both keys sit in one slot on a cluster too.
    const base = `throttle:{${throttlerName}:${key}}`;
    try {
      const [totalHits, toExpire, blocked, toBlockExpire] = (await client.eval(
        INCREMENT,
        2,
        `${base}:hits`,
        `${base}:block`,
        Math.max(1, Math.ceil(ttl)),
        Math.max(1, Math.ceil(blockDuration)),
        limit,
      )) as [number, number, number, number];
      if (this.degraded) {
        this.degraded = false;
        this.logger.log('Throttle counters are back in Redis');
      }
      return {
        totalHits,
        timeToExpire: Math.ceil(toExpire / 1000),
        isBlocked: blocked === 1,
        timeToBlockExpire: Math.ceil(toBlockExpire / 1000),
      };
    } catch (error) {
      if (!this.degraded) {
        this.degraded = true;
        this.logger.warn(
          `Throttle counter in Redis failed (${(error as Error).message || 'no message'}) — counting in this process until it answers`,
        );
      }
      return this.memory.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }

  onApplicationShutdown(): void {
    this.memory.onApplicationShutdown();
  }
}

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { RedisCacheService } from './redis-cache.service';

/**
 * An L2 hit is kept in L1 for no longer than the key has left in Redis
 * (audit CACHE-01).
 *
 * L1 used to keep every Redis hit for a flat 30 s. The audit cache's keys live
 * 20 s (`AUDIT_CACHE_TTL_SECONDS`), so a read could be served up to 30 s after
 * Redis had dropped it, and any key under 30 s inherited the same stale tail.
 * The service is built without `REDIS_URL` and handed a stand-in client, so
 * nothing here opens a socket.
 */
function serviceWithRedis(stored: Record<string, { raw: string; pttl: number }>) {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const service = new RedisCacheService({ get: () => undefined } as unknown as ConfigService);
  const reads = { count: 0 };
  const client = {
    disconnect: () => undefined,
    // The plain GET the service used before, so this spec also runs against
    // the old refill and fails there on the TTL, not on a missing method.
    get: async (key: string) => {
      reads.count += 1;
      return stored[key]?.raw ?? null;
    },
    pipeline: () => {
      let key = '';
      const chain = {
        get: (k: string) => {
          key = k;
          return chain;
        },
        pttl: () => chain,
        exec: async () => {
          reads.count += 1;
          const entry = stored[key];
          return [
            [null, entry?.raw ?? null],
            [null, entry?.pttl ?? -2],
          ];
        },
      };
      return chain;
    },
  };
  Object.assign(service, { client });
  return { service, reads };
}

describe('RedisCacheService — L1 refill follows the key’s remaining TTL', () => {
  const start = new Date('2026-11-23T10:00:00Z').getTime();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(start);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('keeps a key with 5 s left for 5 s, not 30 s', async () => {
    const { service, reads } = serviceWithRedis({ 'audit:a:1': { raw: '"v1"', pttl: 5_000 } });

    expect(await service.get('audit:a:1')).toBe('v1');
    expect(reads.count).toBe(1);

    jest.setSystemTime(start + 4_000);
    expect(await service.get('audit:a:1')).toBe('v1');
    expect(reads.count).toBe(1); // still served from L1

    jest.setSystemTime(start + 5_001);
    await service.get('audit:a:1');
    expect(reads.count).toBe(2); // L1 let go when Redis did

    service.onModuleDestroy();
  });

  it('caps a long-lived key at 30 s in L1', async () => {
    const { service, reads } = serviceWithRedis({ 'tenant:a': { raw: '"t"', pttl: 600_000 } });

    await service.get('tenant:a');
    jest.setSystemTime(start + 29_000);
    await service.get('tenant:a');
    expect(reads.count).toBe(1);

    jest.setSystemTime(start + 30_001);
    await service.get('tenant:a');
    expect(reads.count).toBe(2);

    service.onModuleDestroy();
  });

  it('keeps a key with no expiry for 30 s, and does not keep one that expired between GET and PTTL', async () => {
    const { service, reads } = serviceWithRedis({
      forever: { raw: '1', pttl: -1 },
      gone: { raw: '2', pttl: -2 },
    });

    expect(await service.get('forever')).toBe(1);
    expect(await service.get('gone')).toBe(2);
    expect(reads.count).toBe(2);

    jest.setSystemTime(start + 10_000);
    await service.get('forever');
    await service.get('gone');
    expect(reads.count).toBe(3); // `forever` from L1, `gone` from Redis again

    service.onModuleDestroy();
  });
});

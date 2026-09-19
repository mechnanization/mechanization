import { createServer } from 'node:net';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { RedisCacheService } from './redis-cache.service';

/**
 * What the log says while Redis is down.
 *
 * L2 being unreachable is a supported mode — L1 keeps serving — so it is worth
 * exactly one line, and that line has to carry the cause. Both halves were
 * broken at once: ioredis emits `error` on every reconnection attempt, so a
 * cache nobody had started wrote an ERROR line about once a second forever; and
 * the line it wrote was «Redis error:» followed by nothing, because a refused
 * connection to localhost arrives as an `AggregateError` whose `message` is the
 * empty string.
 *
 * The flood is the worse of the two. `scripts/start.mjs` holds a 30-line
 * unfiltered window open on any ERROR so a real stack trace is never swallowed,
 * and a second-by-second drip keeps that window open over whatever actually
 * broke — the §8.6 lesson, arriving as log noise instead of a flaky test.
 */

/** A port nothing is listening on: bound to get one assigned, then released. */
function deadPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const configWith = (url: string | undefined) =>
  ({ get: () => url }) as unknown as ConfigService;

describe('RedisCacheService', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let service: RedisCacheService | null = null;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    /*
      ioredis's `disconnect()` arms a 12s timer to force-destroy a stream that
      never politely closes — which a refused connection never does. Nothing
      waits on it in production, where the process is on its way out anyway, but
      it holds Jest's event loop open. Swept here rather than left to expire.
    */
    jest.useFakeTimers();
    service?.onModuleDestroy();
    jest.clearAllTimers();
    jest.useRealTimers();
    service = null;
    jest.restoreAllMocks();
  });

  it('reports an unreachable Redis once, with the cause, however often it retries', async () => {
    const port = await deadPort();
    service = new RedisCacheService(configWith(`redis://127.0.0.1:${port}`));

    // Long enough for several reconnection attempts (200ms, 400ms, 600ms …),
    // each of which emits its own `error` on the client.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('ECONNREFUSED');
    // Not an error: the class contract says offline Redis is a supported mode.
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps serving from L1 while Redis is unreachable', async () => {
    const port = await deadPort();
    service = new RedisCacheService(configWith(`redis://127.0.0.1:${port}`));

    await service.set('tenant:albazourieh', { slug: 'albazourieh' }, 30);
    expect(await service.get('tenant:albazourieh')).toEqual({ slug: 'albazourieh' });

    await service.invalidatePrefix('tenant:');
    expect(await service.get('tenant:albazourieh')).toBeNull();
  });

  it('opens no client at all when REDIS_URL is unset', async () => {
    service = new RedisCacheService(configWith(undefined));

    await service.set('k', 1, 30);
    expect(await service.get('k')).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

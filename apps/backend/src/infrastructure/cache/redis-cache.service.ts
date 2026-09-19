import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

interface MemoryCacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * What actually went wrong, for the case where ioredis hands over an error that
 * does not say.
 *
 * A refused connection to `localhost` is the common one and the worst offender:
 * Node attempts `::1` and `127.0.0.1` together and reports the pair as an
 * `AggregateError`, whose own `message` is the empty string. Logging
 * `error.message` printed «Redis error:» followed by nothing — the one line
 * that was supposed to say the cache was down said nothing at all, once a
 * second. The cause was on the error the entire time, as `code` and `errors[]`.
 */
function describeRedisError(error: Error): string {
  if (error.message) return error.message;

  const code = (error as NodeJS.ErrnoException).code;
  if (error instanceof AggregateError) {
    const addresses = (error.errors as unknown[])
      .map((inner) => inner as { address?: string; port?: number });
    const where = addresses
      .filter((inner) => inner?.address)
      .map((inner) => `${inner.address}:${inner.port}`)
      .join(', ');
    const label = code ?? (addresses[0] as NodeJS.ErrnoException | undefined)?.code ?? 'connection failed';
    return where ? `${label} ${where}` : label;
  }

  return code ?? 'connection failed';
}

/**
 * Fast multi-tier cache service:
 * - L1: In-memory Map cache with TTL and prefix invalidation (always active, ~0ms).
 * - L2: Redis (optional, active when `REDIS_URL` is provided).
 *
 * When Redis is unset or offline, L1 in-memory caching ensures that tenant lookups,
 * dashboard metrics, settings, and queries are fast and cached.
 */
@Injectable()
export class RedisCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  private readonly client: Redis | null;
  private readonly memoryCache = new Map<string, MemoryCacheEntry>();
  private readonly pruneTimer: NodeJS.Timeout;

  /** Whether L2 is currently unreachable — see `reportOffline`. */
  private offline = false;
  private suppressed = 0;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL');
    if (!url) {
      this.logger.log('REDIS_URL not set — using high-performance in-memory cache');
      this.client = null;
    } else {
      this.client = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        /*
          Keep trying, but slowly. Giving up permanently would be worse than a
          cold cache: L2 would stay dead until someone restarted the process,
          with nothing in the log still saying so. Capped well above ioredis's
          2s default because every attempt while Redis is down is wasted work
          and L1 is already serving every read.
        */
        retryStrategy: (times: number) => Math.min(times * 200, 10_000),
      });

      this.client.on('error', (error: Error) => this.reportOffline(describeRedisError(error)));
      this.client.on('ready', () => this.reportOnline());
      this.client.connect().catch((error: Error) => this.reportOffline(describeRedisError(error)));
    }

    // Periodically prune expired items every 60 seconds
    this.pruneTimer = setInterval(() => this.pruneExpired(), 60_000);
    if (this.pruneTimer.unref) this.pruneTimer.unref();
  }

  /**
   * Redis being unreachable is logged once per outage, at `warn`.
   *
   * ioredis emits `error` on every reconnection attempt, so a cache nobody had
   * started produced an ERROR line roughly once a second, forever. That is not
   * a louder signal than one line — it is a quieter one. `scripts/start.mjs`
   * opens a 30-line unfiltered window on any ERROR so that a real stack trace
   * is never swallowed, and a flood of these holds that window open over
   * whatever actually broke. A routine WARN prints itself and nothing else.
   *
   * `warn` rather than `error` because offline Redis is a supported mode and
   * not a fault: L1 keeps serving, and the class contract above says so. The
   * recovery is logged too, because an outage nobody saw end is one people go
   * on believing they still have.
   */
  private reportOffline(reason: string): void {
    if (this.offline) {
      this.suppressed += 1;
      return;
    }
    this.offline = true;
    this.suppressed = 0;
    this.logger.warn(`Redis unreachable (${reason}) — serving from the in-memory cache until it returns`);
  }

  private reportOnline(): void {
    if (!this.offline) return;
    const retries = this.suppressed;
    this.offline = false;
    this.suppressed = 0;
    this.logger.log(
      `Redis reconnected${retries > 0 ? ` — ${retries} retries were not logged` : ''}`,
    );
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.expiresAt <= now) {
        this.memoryCache.delete(key);
      }
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const now = Date.now();
    const mem = this.memoryCache.get(key);
    if (mem) {
      if (mem.expiresAt > now) {
        return mem.value as T;
      }
      this.memoryCache.delete(key);
    }

    if (!this.client) return null;
    try {
      const raw = await this.client.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as T;
      // Populate L1 memory with remaining TTL (default 30s)
      this.memoryCache.set(key, { value: parsed, expiresAt: now + 30_000 });
      return parsed;
    } catch (error) {
      this.logger.warn(`GET ${key} failed: ${describeRedisError(error as Error)}`);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.memoryCache.set(key, { value, expiresAt });

    if (!this.client) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.warn(`SET ${key} failed: ${describeRedisError(error as Error)}`);
    }
  }

  /**
   * Invalidates every key under a prefix across both L1 in-memory cache and Redis.
   */
  async invalidatePrefix(prefix: string): Promise<void> {
    // Invalidate L1 memory
    for (const key of this.memoryCache.keys()) {
      if (key.startsWith(prefix)) {
        this.memoryCache.delete(key);
      }
    }

    if (!this.client) return;
    try {
      const stream = this.client.scanStream({ match: `${prefix}*`, count: 100 });
      const pipeline = this.client.pipeline();
      let keyCount = 0;

      stream.on('data', (keys: string[]) => {
        if (keys.length > 0) {
          for (const key of keys) {
            pipeline.del(key);
          }
          keyCount += keys.length;
        }
      });

      await new Promise<void>((resolve, reject) => {
        stream.on('end', async () => {
          try {
            if (keyCount > 0) {
              await pipeline.exec();
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        stream.on('error', reject);
      });
    } catch (error) {
      this.logger.warn(`Invalidate ${prefix}* failed: ${describeRedisError(error as Error)}`);
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.pruneTimer);
    this.memoryCache.clear();
    this.client?.disconnect();
  }
}

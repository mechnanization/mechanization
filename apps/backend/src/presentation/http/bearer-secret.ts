import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Whether an `Authorization` header is `Bearer <secret>`, compared in constant
 * time: the one comparison for the shared secrets a route is opened with
 * (`METRICS_TOKEN` on `/metrics`, `CRON_SECRET` on `internal/cron`).
 *
 * Digests first, because `timingSafeEqual` throws on inputs of different
 * lengths, and the length check that avoids it would itself leak the length.
 * `!==` stops at the first differing byte, which lets a caller narrow a secret
 * down by timing, and the cron routes skip the throttler.
 */
export function bearerMatches(header: string | undefined, secret: string): boolean {
  return timingSafeEqual(digest(header ?? ''), digest(`Bearer ${secret}`));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

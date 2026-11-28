import { createHash } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerOptions } from '@nestjs/throttler';
import { APP_CONFIG } from '../../application/common/app.config';
import { COUNT_PER_STAFF_ACCOUNT_KEY } from '../decorators/count-per-staff-account.decorator';

/** The throttler that counts per staff account, by name. */
const STAFF_ACCOUNT_THROTTLER = 'staffAccount';

/**
 * The bucket of a staff sign-in: the municipality and the email typed, hashed so
 * the key never holds an address.
 *
 * Read off the body before the pipe has validated it — guards run first — so it
 * is folded as `staffLoginSchema` folds it (trimmed, lower case), and anything
 * that is not a string shares one bucket: that request fails validation anyway.
 */
export function staffAccountTracker(request: Record<string, unknown>): string {
  const body = request.body as { email?: unknown } | undefined;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase().slice(0, 320) : '';
  const tenant = (request.tenant as { slug?: string } | undefined)?.slug ?? '';
  const hash = createHash('sha256').update(`${tenant}\u0000${email}`).digest('hex');
  return `staff-account:${hash}`;
}

/**
 * Every throttler the API counts with (`ThrottlerModule` in `AppModule`, over
 * `RedisThrottlerStorage`). The guard counts each named throttler on every
 * route that does not skip it, so a throttler for a few routes skips the rest:
 *
 * - `default`, per address: `APP_CONFIG.throttle.default` on every route, which a
 *   route's own `@Throttle({ default: … })` replaces.
 * - `staffAccount`, per staff account (`staffAccountTracker`):
 *   `APP_CONFIG.throttle.staffLoginAccount`, only on a route marked
 *   `@CountPerStaffAccount()` (audit SEC-04, decision U-6 of 2026-11-28).
 */
export const THROTTLERS: ThrottlerOptions[] = [
  {
    name: 'default',
    ttl: APP_CONFIG.throttle.default.ttlSeconds * 1000,
    limit: APP_CONFIG.throttle.default.limit,
  },
  {
    name: STAFF_ACCOUNT_THROTTLER,
    ttl: APP_CONFIG.throttle.staffLoginAccount.ttlSeconds * 1000,
    limit: APP_CONFIG.throttle.staffLoginAccount.limit,
    getTracker: staffAccountTracker,
    skipIf: (context: ExecutionContext) =>
      Reflect.getMetadata(COUNT_PER_STAFF_ACCOUNT_KEY, context.getHandler()) !== true,
  },
];

/**
 * The default bar, stated on a public route as its decision (audit SEC-07): the
 * route was read and the default is its bound, rather than a bound it rides
 * because nobody looked. `route-inventory.spec.ts` asks every `@Public()` route
 * for this, another `@Throttle`, or a `@SkipThrottle()` with its reason.
 */
export const DEFAULT_THROTTLE = {
  default: {
    limit: APP_CONFIG.throttle.default.limit,
    ttl: APP_CONFIG.throttle.default.ttlSeconds * 1000,
  },
};

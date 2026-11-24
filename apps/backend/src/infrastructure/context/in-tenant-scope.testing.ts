import type { TenantContextService, TenantScope } from './tenant-context.service';

/**
 * For specs: `service` with every method called inside `scope`, as
 * `TenantMiddleware` runs a request.
 *
 * A service that opens `runInTenantTransaction` needs a real tenant scope —
 * the transaction re-enters it with the transaction client, which is what makes
 * `this.db` inside the work the transaction rather than the pool. A spec that
 * hands the service an object literal standing in for `TenantContextService`
 * has no scope to re-enter (audit ARCH-01 moved `FeesService` onto the helper).
 * Wrapping the service keeps each call site as it was.
 */
export function inTenantScope<T extends object>(
  service: T,
  context: TenantContextService,
  scope: TenantScope,
): T {
  return new Proxy(service, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        context.run(scope, () => (value as (...a: unknown[]) => unknown).apply(target, args));
    },
  });
}

/**
 * A small in-memory cache for reads that several screens make independently.
 *
 * The problem it solves is not slow endpoints — it is the same endpoint being
 * called four times for one page view. `GET /fees/settings` is read by the fees
 * screen, the payments screen, every citizen profile, and by each of the four
 * settings tabs as it opens. None of them knows about the others, and none of
 * them should have to: hoisting the fetch into a parent and threading it down
 * would couple six unrelated screens to make one request cheaper.
 *
 * Two jobs, and the first matters more:
 *
 *  - **In-flight de-duplication.** Concurrent callers share one request. This
 *    is exact, not a heuristic — the second caller gets the first one's promise,
 *    so there is no window in which two requests are outstanding.
 *  - **A short TTL** for callers that arrive after the first has settled, so
 *    switching between settings tabs does not refetch a row that changes a few
 *    times a year.
 *
 * Deliberately not a general data layer. There is no revalidation, no
 * background refresh and no cross-tab coordination; anything needing those
 * wants React Query rather than this. It is memory-only and dies with the page,
 * which is also why it is safe to hold tenant-scoped data in it.
 */

interface Entry<T> {
  /** Resolved value, present once the promise settles. */
  value?: T;
  /** The in-flight request, present until it does. */
  promise?: Promise<T>;
  expiresAt: number;
}

const entries = new Map<string, Entry<unknown>>();

/**
 * Runs `loader` unless a fresh or in-flight result is already held for `key`.
 *
 * The key must include everything that changes the response — the tenant, and
 * any parameter that alters the shape. It must **not** include the access
 * token: two staff members of the same municipality see the same settings, and
 * keying on the token would both defeat the cache and put a credential in a
 * long-lived map.
 */
export function cachedRequest<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const existing = entries.get(key) as Entry<T> | undefined;

  if (existing && existing.expiresAt > now) {
    if (existing.promise) return existing.promise;
    if (existing.value !== undefined) return Promise.resolve(existing.value);
  }

  const promise = loader()
    .then((value) => {
      // Re-read rather than closing over `entry`: an `invalidate` during the
      // request must win, or a save would be overwritten by the stale response
      // that was already in flight when it happened.
      const current = entries.get(key) as Entry<T> | undefined;
      if (current?.promise === promise) {
        entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      }
      return value;
    })
    .catch((error: unknown) => {
      // A failure is never cached: the next attempt should reach the network,
      // not be told for the rest of the TTL that the request failed.
      const current = entries.get(key) as Entry<T> | undefined;
      if (current?.promise === promise) entries.delete(key);
      throw error;
    });

  entries.set(key, { promise, expiresAt: now + ttlMs });
  return promise;
}

/** Drops every entry whose key starts with `prefix`. Call after a write. */
export function invalidateRequests(prefix: string): void {
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}

/**
 * The value held for `key`, if one is there and still fresh. Never fetches.
 *
 * For a caller that can render the answer on its first frame instead of
 * waiting a microtask for `cachedRequest` to hand back something it already
 * has. The difference is not speed — it is whether a control that re-mounts
 * (a card unfolded, an edit form opened on a record whose parcel was read a
 * minute ago) flashes its spinner again. To the officer that flash is
 * indistinguishable from work being redone, which is precisely the complaint:
 * "it keeps reloading — wasn't this saved?"
 *
 * An in-flight request is deliberately reported as absent. There is no value
 * yet, and showing that it is loading is the correct thing to do in that state.
 */
export function peekCachedRequest<T>(key: string): T | undefined {
  const entry = entries.get(key) as Entry<T> | undefined;
  if (!entry || entry.expiresAt <= Date.now()) return undefined;
  return entry.value;
}

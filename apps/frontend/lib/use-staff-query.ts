'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ApiRequestError, logApiError } from './api-client';
import { clearSession } from './session';

/**
 * One authenticated read on a staff screen.
 *
 * Every admin page had the same twenty lines: a `useCallback` wrapping the
 * fetch, a `useEffect` calling it, `items`/`loading`/`error` state beside it,
 * and a catch block that logged, checked for a 401, cleared the session and
 * redirected. Five copies of a thing with three subtle bugs in it —
 *
 *  - **No cancellation.** Two requests for the same table could be in flight
 *    at once (change a filter while on page 3 and the page-reset effect fired
 *    a second one), and whichever answered last won. A clerk who corrected a
 *    search quickly was shown results for the term they had abandoned.
 *  - **No cache.** The data belonged to the component, so leaving a screen
 *    threw it away and returning re-fetched it from nothing behind a skeleton.
 *  - **A refetch after every write**, spelled out by hand at each call site,
 *    which is how one gets forgotten.
 *
 * All three are properties of the query key here: React Query cancels the
 * outgoing request when the key changes, serves the last result for that key
 * immediately, and re-reads whatever a mutation invalidates.
 */
export interface StaffQueryResult<T> {
  data: T | undefined;
  /** True only while there is nothing to show — i.e. the first load. */
  loading: boolean;
  /** True whenever a request is outstanding, including a background refresh. */
  fetching: boolean;
  /** The caller's own message, or null. Never the raw API text. */
  error: string | null;
  refetch: () => void;
}

export function useStaffQuery<T>({
  queryKey,
  queryFn,
  tenant,
  base,
  token,
  errorMessage,
  keepPrevious = false,
  reference = false,
}: {
  /**
   * Must contain the tenant and every parameter that changes the response.
   *
   * The tenant especially: two municipalities open in two tabs share one
   * browser, and a key that named only the resource would serve one of them
   * the other's register.
   */
  queryKey: readonly unknown[];
  /** Receives the session token, and the signal that cancels a superseded read. */
  queryFn: (token: string, signal: AbortSignal) => Promise<T>;
  tenant: string;
  /** `/{tenant}/{locale}/{adminPath}` — what the login redirect hangs off. */
  base: string;
  /** Null until the session has been read; the query waits rather than firing. */
  token: string | null;
  /** What the screen should say if the read fails. Arabic, caller's wording. */
  errorMessage: string;
  /**
   * Keeps the last page on screen while the next one loads.
   *
   * For any table whose rows come from the server: without it, every page turn
   * and every search empties the table to a skeleton and back, which on a fast
   * connection is a flash of nothing rather than a loading state. With it the
   * rows sit still until their replacements are ready.
   */
  keepPrevious?: boolean;
  /**
   * Marks the read as a **reference list** rather than a page of data.
   *
   * The sectors, the bill titles, the values a filter may offer: sets that
   * change when somebody sets the municipality up or files the first record of
   * a kind, not while a clerk works. The default policy — thirty seconds stale,
   * re-read on every window focus — is right for a table of invoices and wrong
   * for these: it puts a request on the wire every time a screen is opened, to
   * be told again what the sectors are called.
   *
   * With this set the list is fetched **once** and then served from the cache
   * for the rest of the session, across every screen that asks for it. It is
   * still a live read, not a constant baked into the page: a screen that adds a
   * value invalidates the key (see the census ledger's `reload`), and the next
   * read picks it up.
   *
   * `gcTime: Infinity` matters as much as `staleTime`. Without it the entry is
   * collected five minutes after the last screen using it unmounts, and moving
   * away from a filter for six minutes and back would fetch it again — which is
   * the behaviour this exists to remove.
   */
  reference?: boolean;
}): StaffQueryResult<T> {
  const router = useRouter();

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => queryFn(token as string, signal),
    // `token` is non-null inside `queryFn` by construction: the query does not
    // run until it is set.
    enabled: Boolean(token),
    placeholderData: keepPrevious ? keepPreviousData : undefined,
    ...(reference
      ? {
          staleTime: Infinity,
          gcTime: Infinity,
          refetchOnWindowFocus: false as const,
          refetchOnMount: false as const,
          refetchOnReconnect: false as const,
        }
      : {}),
  });

  const { error } = query;

  /**
   * A session that has ended mid-visit.
   *
   * `StaffRouteGuard` checks for a session when the screen mounts, which does
   * not cover the token expiring, an administrator revoking it, or a role being
   * changed while someone has the page open. In all three the next read comes
   * back 401, and the honest response is to send them to login rather than to
   * show a table that says «تعذّر التحميل» about an account that no longer has
   * access.
   */
  useEffect(() => {
    if (!error) return;
    logApiError(error);
    if (error instanceof ApiRequestError && error.status === 401) {
      clearSession(tenant);
      router.replace(`${base}/login`);
    }
  }, [error, tenant, base, router]);

  return {
    data: query.data,
    // `isPending` rather than `isLoading`: with `keepPreviousData` the second
    // page is not "loading" in any sense the reader would recognise — there
    // are rows on screen — so only the very first read shows skeletons.
    loading: query.isPending && Boolean(token),
    fetching: query.isFetching,
    error: error ? errorMessage : null,
    refetch: () => void query.refetch(),
  };
}

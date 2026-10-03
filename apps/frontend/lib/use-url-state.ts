'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import type { OnChangeFn, PaginationState } from '@tanstack/react-table';
import {
  applyUrlPatch,
  param,
  readUrlState,
  toSearch,
  type UrlSchema,
  type UrlValues,
} from './url-state';
import { readTabSearch, subscribeTabSearch, writeTabSearch } from './tab-search';

export { param } from './url-state';

/**
 * Writes a new query string for the current page.
 *
 * `history.replaceState`, not `router.replace`. Next (14.1+) patches it to keep
 * `useSearchParams` in step, and unlike the router it does not refetch the
 * page's server payload for what is only a filter change. It is also
 * synchronous: `window.location` holds the new query the moment this returns,
 * so two writes in one tick — `DataTable` commits a search and resets the page
 * together — each build on the other instead of the second erasing the first.
 *
 * Replace rather than push: a filter click is not a place. Back still returns
 * from a citizen's file to the list exactly as it was, because the list's URL
 * carries its filters; it just does not step back through every chip.
 *
 * `null` as the state is deliberate — Next copies its own router state into
 * it, and passing the current `history.state` (which already carries Next's
 * marker) would skip the patch and leave `useSearchParams` stale.
 */
function writeSearch(params: URLSearchParams): void {
  const { pathname, search, hash } = window.location;
  const next = toSearch(params);
  if (next === search) return;
  window.history.replaceState(null, '', `${pathname}${next}${hash}`);
}

export interface UrlStateOptions {
  /** Parameters to remove in the same write — typically `['page']` on a filter change. */
  clear?: readonly string[];
}

/**
 * Page state that lives in the query string, so a reload, a shared link and
 * the back button all restore it.
 *
 * Define the schema at module scope: it is the identity the setter is
 * memoised on. Defaults are never written, so a page with nothing chosen keeps
 * a bare URL.
 *
 * ```ts
 * const FILTERS = { status: param.oneOf(STATUSES, ''), page: param.page() };
 * const [filters, setFilters] = useUrlState(FILTERS);
 * setFilters({ status: 'PAID' }, { clear: ['page'] });
 * ```
 */
export function useUrlState<S extends UrlSchema>(
  schema: S,
): [
  UrlValues<S>,
  (
    patch: Partial<UrlValues<S>> | ((current: UrlValues<S>) => Partial<UrlValues<S>>),
    options?: UrlStateOptions,
  ) => void,
] {
  const searchParams = useSearchParams();
  const values = useMemo(() => readUrlState(schema, searchParams), [schema, searchParams]);

  const setValues = useCallback(
    (
      patch: Partial<UrlValues<S>> | ((current: UrlValues<S>) => Partial<UrlValues<S>>),
      options?: UrlStateOptions,
    ) => {
      // The live URL, not the render's: `useSearchParams` updates in a
      // transition and can be a write behind.
      const current = new URLSearchParams(window.location.search);
      const resolved = typeof patch === 'function' ? patch(readUrlState(schema, current)) : patch;
      writeSearch(applyUrlPatch(current, schema, resolved, options?.clear));
    },
    [schema],
  );

  return [values, setValues];
}

/** Matches `DataTable`'s own page-size menu. */
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export interface UrlPaginationOptions {
  /** The page size when the URL names none. */
  defaultSize: number;
  /** Sizes the URL may select; pass the table's `pageSizeOptions` if it overrides them. */
  sizes?: readonly number[];
  /** Parameter names, for a page with two pagers (`feesPage`). */
  pageKey?: string;
  sizeKey?: string;
}

/**
 * A `DataTable`'s pagination, read from and written to `?page=` / `?limit=`.
 *
 * Returns the pair `DataTable` takes as `pagination` / `onPaginationChange`,
 * including the functional updater it uses to reset to page one on a search.
 * The page parameter is 1-based in the URL (see `param.page`).
 */
export function useUrlPagination({
  defaultSize,
  sizes = PAGE_SIZE_OPTIONS,
  pageKey = 'page',
  sizeKey = 'limit',
}: UrlPaginationOptions): [PaginationState, OnChangeFn<PaginationState>] {
  const sizesKey = sizes.join(',');
  const schema = useMemo(
    () => ({
      [pageKey]: param.page(),
      [sizeKey]: param.pageSize(
        sizesKey.split(',').map(Number),
        defaultSize,
      ),
    }),
    [pageKey, sizeKey, sizesKey, defaultSize],
  );
  const [values, setValues] = useUrlState(schema);

  const pagination = useMemo<PaginationState>(
    () => ({ pageIndex: values[pageKey] as number, pageSize: values[sizeKey] as number }),
    [values, pageKey, sizeKey],
  );

  const setPagination = useCallback<OnChangeFn<PaginationState>>(
    (updater) =>
      setValues((current) => {
        const previous: PaginationState = {
          pageIndex: current[pageKey] as number,
          pageSize: current[sizeKey] as number,
        };
        const next = typeof updater === 'function' ? updater(previous) : updater;
        return { [pageKey]: next.pageIndex, [sizeKey]: next.pageSize } as typeof current;
      }),
    [setValues, pageKey, sizeKey],
  );

  return [pagination, setPagination];
}

/**
 * A list's committed search term, kept in this tab's storage — never the URL.
 * See `tab-search.ts` for why.
 *
 * `scope` names the list (`'citizens'`, `'fees'`); the tenant is added here.
 * Renders `''` on the server and on the hydrating pass, then the stored term —
 * the queries these pages run wait for the session token, which arrives in an
 * effect too, so a reload's first request already carries the stored term.
 *
 * Known cost: committing a search from page 2 or later fetches once at the old
 * offset before the page reset lands, because Next applies the URL through its
 * own asynchronous action queue and the two cannot share a render. React Query
 * aborts the superseded request. Deferring this term into a transition was
 * tried (2026-10-03) and only swapped which request was the wasted one.
 */
export function useTabSearch(tenant: string, scope: string): [string, (value: string) => void] {
  const value = useSyncExternalStore(
    subscribeTabSearch,
    () => readTabSearch(tenant, scope),
    () => '',
  );
  const setValue = useCallback(
    (next: string) => writeTabSearch(tenant, scope, next),
    [tenant, scope],
  );
  return [value, setValue];
}

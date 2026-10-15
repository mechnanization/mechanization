'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiRequestError, listCitizens, logApiError, type CitizenListItem } from '@/lib/api-client';

/** How long a citizen picker waits after the last keystroke before it asks the register. */
export const SEARCH_DEBOUNCE_MS = 350;

/** Fewer characters than this ask nothing: one letter matches half the town. */
export const CITIZEN_SEARCH_MIN_LENGTH = 2;

/** How many files a picker offers under its field. */
export const CITIZEN_PICKER_LIMIT = 8;

export interface CitizenSearchState {
  /**
   * The files the register matched for `searched` and a new act can name: not
   * one «دمج ملفين» folded into another, and not an archived one unless the
   * caller asks (`includeArchived`) — an archived file takes no new fees
   * (`FEE_CITIZEN_ARCHIVED`). Emptied as soon as another term is typed, so a
   * match for the name being corrected is never there to click.
   */
  results: CitizenListItem[];
  /** A search is waiting out the debounce or on its way. */
  searching: boolean;
  /** The last search could not reach the register, or was refused — which is not finding nobody. */
  failed: boolean;
  /**
   * What the failure said, when the API answered (`ApiRequestError.message`,
   * already in the page's language): a lapsed session or a throttle is not «check
   * the connection». Null otherwise.
   */
  error: string | null;
  /** The register holds more matches than the picker lists: the clerk should type more of the name. */
  more: boolean;
  /** The term `results` answer, or `''` when none has been answered. */
  searched: string;
}

export const IDLE_CITIZEN_SEARCH: CitizenSearchState = {
  results: [],
  searching: false,
  failed: false,
  error: null,
  more: false,
  searched: '',
};

/** Asks the register for one term; `listCitizens` in the app, a stub in the tests. */
export type CitizenSearchFetch = (
  term: string,
  signal: AbortSignal,
) => Promise<{ items: CitizenListItem[]; total?: number }>;

/**
 * Schedules one search for `term` after the debounce and returns its cancel.
 *
 * The register is searched on the server (name, phone, رقم مرجعي, document
 * number), never filtered from a page loaded up front: a picker that filtered
 * the first 200 files in the browser could not find anyone filed after them.
 *
 * Cancelling clears the timer and aborts the request, and an answer that
 * arrives after its cancel is dropped, so a clerk who corrects a name quickly
 * never sees the matches for the name they abandoned.
 *
 * Framework-free so the timing and the stale-answer rule are testable in node;
 * `useCitizenSearch` is a thin effect around it.
 */
export function scheduleCitizenSearch(
  term: string,
  search: CitizenSearchFetch,
  update: (patch: Partial<CitizenSearchState>) => void,
  options: { delayMs?: number; onError?: (caught: unknown) => void; includeArchived?: boolean } = {},
): () => void {
  const trimmed = term.trim();
  if (trimmed.length < CITIZEN_SEARCH_MIN_LENGTH) {
    update(IDLE_CITIZEN_SEARCH);
    return () => {};
  }
  const controller = new AbortController();
  // The previous term's matches go at once: picked while this one is on its way, they charge someone else.
  update({ results: [], searching: true, failed: false, error: null, more: false });
  const timer = setTimeout(() => {
    search(trimmed, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        update({
          /*
            A file «دمج ملفين» folded into another is charged on the file that
            stays, and an archived one is charged on nothing: both are left out,
            the archived one unless asked for. The server has no filter for
            either, so a page can come back short.
          */
          results: page.items.filter((row) => (options.includeArchived || row.isActive) && !row.mergedIntoId),
          searching: false,
          failed: false,
          error: null,
          more: (page.total ?? 0) > page.items.length,
          searched: trimmed,
        });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        options.onError?.(caught);
        update({
          results: [],
          searching: false,
          failed: true,
          error: caught instanceof ApiRequestError ? caught.message : null,
          more: false,
          searched: trimmed,
        });
      });
  }, options.delayMs ?? SEARCH_DEBOUNCE_MS);
  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}

/** A picker's search, and the way to ask again after a failure. */
export interface CitizenSearch extends CitizenSearchState {
  /** Sends the current term again — what «إعادة المحاولة» under a failed search does. */
  retry: () => void;
}

/** The rows a screen may offer: without the files it may not (`CitizenSearchOptions.exclude`). */
export function withoutFiles(
  rows: readonly CitizenListItem[],
  exclude: readonly string[] | undefined,
): CitizenListItem[] {
  if (!exclude?.length) return [...rows];
  const ids = new Set(exclude);
  return rows.filter((row) => !ids.has(row.id));
}

/** What a caller can ask of the search beyond its term. */
export interface CitizenSearchOptions {
  /**
   * Offer archived files too. Never for a new fee; for the census and
   * ownership screens, where an archived file is the person come back and
   * the answer is to restore it, not to file them twice.
   */
  includeArchived?: boolean;
  /** Files this screen may not offer: the seller of a sale, the file being merged into. */
  exclude?: readonly string[];
}

/**
 * The register's citizen search, debounced, for `term` — the one every screen
 * that looks a person up uses: `CitizenPicker`, and the screens with a flow of
 * their own around the results («إضافة شخص إلى الوحدة»).
 *
 * `enabled` is false while a file is already chosen or the picker is closed,
 * and the state returns to idle. A failed search says so (`failed`, `error`)
 * rather than reading as «no match», and can be retried without retyping.
 */
export function useCitizenSearch(
  tenant: string,
  token: string | null,
  term: string,
  enabled = true,
  options: CitizenSearchOptions = {},
): CitizenSearch {
  const [state, setState] = useState<CitizenSearchState>(IDLE_CITIZEN_SEARCH);
  /** Bumped by `retry`, so the effect below schedules the same term again. */
  const [attempt, setAttempt] = useState(0);
  const { includeArchived = false, exclude } = options;

  useEffect(() => {
    if (!enabled || !token) {
      setState(IDLE_CITIZEN_SEARCH);
      return;
    }
    return scheduleCitizenSearch(
      term,
      (search, signal) => listCitizens(tenant, token, { search, limit: CITIZEN_PICKER_LIMIT }, signal),
      (patch) => setState((current) => ({ ...current, ...patch })),
      { onError: logApiError, includeArchived },
    );
  }, [enabled, tenant, token, term, attempt, includeArchived]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  // Applied to the answer, not the request, so a caller passing a fresh array each render asks nothing again.
  const excluded = exclude?.join('|') ?? '';
  const results = useMemo(
    () => (excluded ? withoutFiles(state.results, excluded.split('|')) : state.results),
    [state.results, excluded],
  );
  return { ...state, results, retry };
}

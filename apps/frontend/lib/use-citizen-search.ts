'use client';

import { useCallback, useEffect, useState } from 'react';
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
   * one «دمج ملفين» folded into another, and not an archived one (the fee
   * wizard is refused on it, `CITIZEN_NOT_FOUND`). Emptied as soon as another
   * term is typed, so a match for the name being corrected is never there to
   * click.
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
  options: { delayMs?: number; onError?: (caught: unknown) => void } = {},
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
            stays, and an archived one is charged on nothing: both are left out.
            The server has no filter for either, so a page can come back short.
          */
          results: page.items.filter((row) => row.isActive && !row.mergedIntoId),
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

/**
 * A citizen picker's search of the register, debounced, for `term`.
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
): CitizenSearch {
  const [state, setState] = useState<CitizenSearchState>(IDLE_CITIZEN_SEARCH);
  /** Bumped by `retry`, so the effect below schedules the same term again. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !token) {
      setState(IDLE_CITIZEN_SEARCH);
      return;
    }
    return scheduleCitizenSearch(
      term,
      (search, signal) => listCitizens(tenant, token, { search, limit: CITIZEN_PICKER_LIMIT }, signal),
      (patch) => setState((current) => ({ ...current, ...patch })),
      { onError: logApiError },
    );
  }, [enabled, tenant, token, term, attempt]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return { ...state, retry };
}

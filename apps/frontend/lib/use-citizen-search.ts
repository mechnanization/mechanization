'use client';

import { useEffect, useState } from 'react';
import { listCitizens, logApiError, type CitizenListItem } from '@/lib/api-client';

/** How long a citizen picker waits after the last keystroke before it asks the register. */
export const SEARCH_DEBOUNCE_MS = 350;

/** Fewer characters than this ask nothing: one letter matches half the town. */
export const CITIZEN_SEARCH_MIN_LENGTH = 2;

/** How many files a picker offers under its field. */
export const CITIZEN_PICKER_LIMIT = 8;

export interface CitizenSearchState {
  /** The files the register matched, without those «دمج ملفين» folded into another. */
  results: CitizenListItem[];
  /** A search is waiting out the debounce or on its way. */
  searching: boolean;
  /** The last search could not reach the register — which is not finding nobody. */
  failed: boolean;
  /** The term `results` answer, or `''` when none has been answered. */
  searched: string;
}

export const IDLE_CITIZEN_SEARCH: CitizenSearchState = {
  results: [],
  searching: false,
  failed: false,
  searched: '',
};

/** Asks the register for one term; `listCitizens` in the app, a stub in the tests. */
export type CitizenSearchFetch = (term: string, signal: AbortSignal) => Promise<{ items: CitizenListItem[] }>;

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
  update({ searching: true, failed: false });
  const timer = setTimeout(() => {
    search(trimmed, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        update({
          // A file «دمج ملفين» folded into another is charged on the file that stays.
          results: page.items.filter((row) => !row.mergedIntoId),
          searching: false,
          failed: false,
          searched: trimmed,
        });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        options.onError?.(caught);
        update({ results: [], searching: false, failed: true, searched: trimmed });
      });
  }, options.delayMs ?? SEARCH_DEBOUNCE_MS);
  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}

/**
 * A citizen picker's search of the register, debounced, for `term`.
 *
 * `enabled` is false while a file is already chosen or the picker is closed,
 * and the state returns to idle. A failed search says so (`failed`) rather than
 * reading as «no match».
 */
export function useCitizenSearch(
  tenant: string,
  token: string | null,
  term: string,
  enabled = true,
): CitizenSearchState {
  const [state, setState] = useState<CitizenSearchState>(IDLE_CITIZEN_SEARCH);

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
  }, [enabled, tenant, token, term]);

  return state;
}

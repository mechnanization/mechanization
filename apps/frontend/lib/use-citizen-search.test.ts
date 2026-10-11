import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CitizenListItem } from '@/lib/api-client';
import {
  CITIZEN_SEARCH_MIN_LENGTH,
  IDLE_CITIZEN_SEARCH,
  SEARCH_DEBOUNCE_MS,
  scheduleCitizenSearch,
  type CitizenSearchState,
} from '@/lib/use-citizen-search';

function row(id: string, mergedIntoId: string | null = null): CitizenListItem {
  return { id, fullName: `Citizen ${id}`, mergedIntoId } as CitizenListItem;
}

/** Applies each patch the way the hook's `setState` does, and keeps the history. */
function recorder() {
  let state: CitizenSearchState = IDLE_CITIZEN_SEARCH;
  const update = (patch: Partial<CitizenSearchState>) => {
    state = { ...state, ...patch };
  };
  return { update, current: () => state };
}

describe('scheduleCitizenSearch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks the server for the typed term once the debounce has passed', async () => {
    const search = vi.fn().mockResolvedValue({ items: [row('a')] });
    const state = recorder();

    scheduleCitizenSearch('  حسن  ', search, state.update);
    expect(search).not.toHaveBeenCalled();
    expect(state.current().searching).toBe(true);

    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toBe('حسن');
    expect(state.current()).toMatchObject({ searching: false, failed: false, searched: 'حسن' });
    expect(state.current().results.map((r) => r.id)).toEqual(['a']);
  });

  it('drops files folded into another by «دمج ملفين»', async () => {
    const search = vi.fn().mockResolvedValue({ items: [row('kept'), row('folded', 'kept')] });
    const state = recorder();

    scheduleCitizenSearch('محمد', search, state.update);
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    expect(state.current().results.map((r) => r.id)).toEqual(['kept']);
  });

  it('asks nothing for a term shorter than the minimum, and goes idle', async () => {
    const search = vi.fn().mockResolvedValue({ items: [row('a')] });
    const state = recorder();
    state.update({ results: [row('old')], searched: 'old' });

    scheduleCitizenSearch('x'.repeat(CITIZEN_SEARCH_MIN_LENGTH - 1), search, state.update);
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);

    expect(search).not.toHaveBeenCalled();
    expect(state.current()).toEqual(IDLE_CITIZEN_SEARCH);
  });

  it('a cancelled search never asks, and a superseded answer is dropped', async () => {
    let resolveFirst: (value: { items: CitizenListItem[] }) => void = () => {};
    const search = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce({ items: [row('second')] });
    const state = recorder();

    // Typed, then corrected inside the debounce: the first never leaves.
    const cancelTyping = scheduleCitizenSearch('حس', search, state.update);
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    cancelTyping();
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(search).not.toHaveBeenCalled();

    // Sent, then superseded while in flight: its signal aborts and its answer is ignored.
    const cancelFirst = scheduleCitizenSearch('حسن', search, state.update);
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    const firstSignal = search.mock.calls[0]?.[1] as AbortSignal;
    cancelFirst();
    expect(firstSignal.aborted).toBe(true);

    scheduleCitizenSearch('حسين', search, state.update);
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    resolveFirst({ items: [row('first')] });
    await vi.advanceTimersByTimeAsync(0);

    expect(state.current().searched).toBe('حسين');
    expect(state.current().results.map((r) => r.id)).toEqual(['second']);
  });

  it('says a failed search failed, rather than that nobody matched', async () => {
    const failure = new Error('offline');
    const search = vi.fn().mockRejectedValue(failure);
    const onError = vi.fn();
    const state = recorder();

    scheduleCitizenSearch('حسن', search, state.update, { onError });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    expect(onError).toHaveBeenCalledWith(failure);
    expect(state.current()).toMatchObject({ results: [], searching: false, failed: true, searched: 'حسن' });
  });
});

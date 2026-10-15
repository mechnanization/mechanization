/**
 * Which of a read's states a page draws (STA-1), decided once.
 *
 * TanStack keeps the last answer when a background re-read fails — a refocus,
 * an invalidation after a write — and `useStaffQuery` passes the error through
 * beside it. A page that checks the error first swaps the content it already
 * shows for `ErrorState`, and unmounts whatever was mounted in it: the boxes of
 * a half-typed count, an open close dialog and its message. So the error takes
 * the page only while nothing has loaded; once something has, the content stays
 * and the failure is a `RefreshFailedAlert` above it.
 */
export type ReadView<T> =
  | { state: 'failed'; error: string }
  | { state: 'loading' }
  | { state: 'ready'; data: T; refreshFailed: string | null };

export function readView<T>(data: T | undefined, error: string | null): ReadView<T> {
  if (data !== undefined) return { state: 'ready', data, refreshFailed: error };
  if (error !== null) return { state: 'failed', error };
  return { state: 'loading' };
}

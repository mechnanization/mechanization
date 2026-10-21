/**
 * A cached category list with one category the manager just saved written into
 * it, for `queryClient.setQueryData`.
 *
 * The category lists are reference reads (`useStaffQuery`'s `reference`):
 * fetched once and never re-read by themselves, so a category added or edited
 * and not written into them stays missing from the register's filter and the
 * next form until a reload. Written rather than invalidated, because a refetch
 * rebuilds the options under an open select, and Radix answers that with an
 * empty selection (docs/gotchas.md).
 *
 * - A category already in the list is replaced where it stands, so the list
 *   keeps its order.
 * - A new one is appended.
 * - A list of active categories only (`includeInactive: false`) drops a stopped
 *   one rather than showing it.
 * - A list that was never read stays unread (`undefined`): there is nothing to
 *   correct, and inventing a one-row list would pass for the whole of it.
 */
export function withSavedCategory<T extends { id: string; active: boolean }>(
  list: T[] | undefined,
  saved: T,
  includeInactive: boolean,
): T[] | undefined {
  if (!list) return list;
  const keep = includeInactive || saved.active;
  const at = list.findIndex((category) => category.id === saved.id);
  if (at === -1) return keep ? [...list, saved] : list;
  return keep ? list.map((category, index) => (index === at ? saved : category)) : list.filter((_, index) => index !== at);
}

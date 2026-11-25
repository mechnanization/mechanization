/**
 * Where an address that became a tab now goes (NAV-03, NAV-04).
 *
 * «الجودة» was four pages and the field worklists two, and the old addresses are
 * in bookmarks, in a colleague's message and in the browser's history, with
 * filters in their query strings. Each old page is a server redirect to the tab
 * that took its place, and this builds the address: its query kept (a parameter
 * can be renamed where the merged page needed its name for something else), and
 * which tab named.
 */

/** What a server page's `searchParams` holds. */
export type SearchParams = Record<string, string | string[] | undefined>;

export function forwardedHref(
  base: string,
  path: string,
  search: SearchParams,
  options: {
    /** Old parameter name → new, for a name the merged page needs for itself. */
    rename?: Readonly<Record<string, string>>;
    /** Parameters set on the way, after the renames: the tab. */
    set?: Readonly<Record<string, string>>;
  } = {},
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    const name = options.rename?.[key] ?? key;
    for (const each of values) query.append(name, each);
  }
  for (const [key, value] of Object.entries(options.set ?? {})) query.set(key, value);
  const text = query.toString();
  return `${base}${path}${text ? `?${text}` : ''}`;
}

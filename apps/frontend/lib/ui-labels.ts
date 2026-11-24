/*
  The words two kit components say, as plain types (ARCH-20).

  `usePagerLabels` and `useTableLabels` (`lib`) build them from the messages, and
  `Pager` and `DataTable` (`components/ui`) take them as props. Declared in the
  components, the hooks imported from components; declared here, both point at
  `lib`. The components still export both names.
*/

/** The words a `Pager` says — resolved by the caller from the messages (`usePagerLabels`). */
export interface PagerLabels {
  /** The landmark's name, e.g. «صفحات الرسوم». */
  nav: string;
  previous: string;
  next: string;
  /** «صفحة 2 من 3», announced when the page changes. */
  position: (current: number, total: number) => string;
  /** «1–10 من 23». */
  range: (first: number, last: number, total: number) => string;
}

export interface DataTableLabels {
  searchAriaLabel: string;
  searchPlaceholder: string;
  clearSearch: string;
  /**
   * The key that runs the search, shown inside the box while a typed term is
   * still uncommitted. Defaults to «Enter».
   *
   * The box commits on Enter rather than as you type (see `SearchField`),
   * which is defensible and completely invisible: a clerk
   * types a name, nothing moves, and the reasonable conclusion is that search
   * is broken. This is the label that says otherwise.
   */
  searchHint?: string;
  /** Template with a `{term}` placeholder, for the applied-search pill. */
  searchApplied?: string;
  empty: string;
  emptySearch: string;
  /** Optional second line: what would put a row here. */
  emptyHint?: string;
  /** Optional second line for a search that matched nothing. */
  emptySearchHint?: string;
  loadError: string;
  retry: string;
  previous: string;
  next: string;
  /** Template with a `{current}` and `{total}` placeholder. */
  pageOf: string;
  rowsPerPage: string;
  /** Template with a `{count}` placeholder. */
  totalRows: string;
  sortAscending: string;
  sortDescending: string;
  sortNone: string;
  /** The columns menu. Omit the three and the menu is not rendered at all. */
  columns?: string;
  columnsHint?: string;
  resetColumns?: string;
  /** Label for filter toggle button, e.g. "الفلاتر" / "Filters" */
  filters?: string;
  /** Label for clearing filters, e.g. "مسح الفلاتر" / "Clear filters" */
  clearFilters?: string;
}

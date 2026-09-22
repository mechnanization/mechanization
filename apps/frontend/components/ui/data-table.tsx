'use client';

import * as React from 'react';
import {
  Cell,
  ColumnDef,
  OnChangeFn,
  PaginationState,
  Row,
  SortingState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type VisibilityState,
} from '@tanstack/react-table';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Filter,
  RotateCcw,
  Search,
  SearchX,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { Button } from './button';
import { Input } from './input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './table';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { EmptyState, ErrorState } from './states';
import { Skeleton } from './skeleton';
import { scrollElementToTop } from '@/lib/scroll-to-top';
import { cn } from '@/lib/utils';

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    /**
     * Which edge this column's contents sit against — **header and cells
     * together**.
     *
     * One knob rather than a class on each, because the two drifting apart is
     * the failure this replaces: a column whose cells were given `text-end`
     * while its `<th>` kept the default put the heading at one edge of the
     * column and every value at the other, so nothing lined up under its own
     * label. Alignment is a property of the column, so it is declared once.
     *
     * Logical, not physical: `start` is the right edge in this RTL portal and
     * the left in an LTR one, which is what keeps a single set of column
     * definitions correct in both.
     */
    align?: 'start' | 'end' | 'center';
    /**
     * The column's name in the "columns" menu.
     *
     * Needed because `header` is often a render function — and even when it is
     * a string, the menu wants the plain words without whatever the header cell
     * wraps them in. Falls back to a string `header`, then to the column id, so
     * a column that never opted in still appears with *something* readable
     * rather than being silently absent from the list.
     */
    label?: string;
    /** Extra classes applied to this column's `<th>` (e.g. fixed width). */
    headerClassName?: string;
    /** Extra classes applied to this column's `<td>` cells. */
    cellClassName?: string;
    /**
     * How this column behaves in the phone card layout below `sm`.
     *
     * `primary` promotes it to the card's heading line; `hide` drops it from
     * the card entirely — for a column that only earns its width on a desktop
     * grid (an internal id, a secondary timestamp) and would otherwise become
     * one more label/value row on a screen that has none to spare. `actions`
     * pins it to the card footer as a full-width row of controls.
     *
     * A column whose header is blank is treated as `actions` without being
     * told. That covers the unlabelled button columns, but not the ones that
     * *do* carry a heading — «إجراء» — which were landing in the label/value
     * list and squeezing four icon buttons into a right-aligned `<dd>`.
     *
     * Unset, the first column becomes the heading and the rest render as
     * label/value pairs, which is the right default for every table here: they
     * all lead with the name or the number the row is *about*.
     */
    mobile?: 'primary' | 'hide' | 'actions';
  }
}

/** Text alignment per `meta.align`, applied to both `<th>` and `<td>`. */
const ALIGN_TEXT = {
  start: 'text-start',
  end: 'text-end',
  center: 'text-center',
} as const;

/**
 * How the header's inner row distributes itself.
 *
 * A sortable heading is a flex button (label + sort glyph), so `text-*` alone
 * does not move it — it needs a justification to match, or an end-aligned
 * column's heading stays at the start while its values sit at the end.
 */
const ALIGN_JUSTIFY = {
  start: 'justify-start',
  end: 'justify-end',
  center: 'justify-center',
} as const;

/** Where a table's remembered column layout lives. */
const COLUMN_STORAGE_PREFIX = 'mechanization.table.columns';

/**
 * What to call a column in the columns menu.
 *
 * `meta.label` first, then a plain-string `header`, then the column id. The
 * last is a poor label but a visible one — a column that falls through to it
 * shows up in the menu as `overdueTotal` rather than not showing up at all,
 * which is the difference between an obvious omission and an invisible one.
 */
function columnLabel(column: { id: string; columnDef: { header?: unknown; meta?: { label?: string } } }): string {
  if (column.columnDef.meta?.label) return column.columnDef.meta.label;
  if (typeof column.columnDef.header === 'string' && column.columnDef.header.trim()) {
    return column.columnDef.header;
  }
  return column.id;
}

/** 10 first, so it is the default every table opens on. */
const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

/**
 * `{count} طلب` + `{count: 12}` -> `12 طلب`. Keeps pluralisable copy in the
 * labels object rather than concatenated at the use site.
 */
function fillTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

export interface DataTableLabels {
  searchAriaLabel: string;
  searchPlaceholder: string;
  clearSearch: string;
  /**
   * The key that runs the search, shown inside the box while a typed term is
   * still uncommitted. Defaults to «Enter».
   *
   * The box commits on Enter rather than as you type (see the note by
   * `commitSearch`), which is defensible and completely invisible: a clerk
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

export interface DataTableProps<TData, TValue = unknown> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  labels: DataTableLabels;
  getRowId?: (row: TData, index: number) => string;

  /** Set to false to hide the built-in search box entirely. */
  searchable?: boolean;
  /** Controlled search value — required in `manual` mode. */
  searchValue?: string;
  /** Fires with the committed term — on Enter, or when the box is emptied. */
  onSearchChange?: (value: string) => void;

  /**
   * Server-driven mode: pagination, sorting and filtering are computed by
   * the caller (typically a paginated API) instead of in the browser.
   * `pageCount` and the `on*Change` handlers become required in spirit —
   * omitting them just freezes that dimension.
   *
   * Shorthand for all three flags below. Kept because most callers that want
   * one want all three: once a page is a slice of a larger set, sorting and
   * filtering it in the browser would only ever reorder that slice.
   */
  manual?: boolean;
  /**
   * The three axes, separately.
   *
   * They were one flag, and that made a common case unreachable: a table whose
   * *rows* come from a paginated API but whose search box is the browser's, or
   * the reverse. Turning on the shared flag to move one axis silently switched
   * off the row models for the other two — a table that looked fine with 8 rows
   * and lost its pagination entirely at 200.
   *
   * Each defaults to `manual`, so existing callers behave exactly as before.
   */
  manualPagination?: boolean;
  manualSorting?: boolean;
  manualFiltering?: boolean;
  /**
   * Turns every column's sort control off.
   *
   * For a server-paginated table whose endpoint cannot sort: re-ordering the
   * rows currently in hand looks like sorting the table and is not — it sorts
   * one page of many. Hiding the affordance is honest; leaving it is a control
   * that lies about what it did.
   */
  sortable?: boolean;
  pageCount?: number;
  /** Total row count across all pages — falls back to `data.length`. */
  totalRowCount?: number;
  pagination?: PaginationState;
  onPaginationChange?: OnChangeFn<PaginationState>;
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  pageSizeOptions?: readonly number[];

  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;

  /** Extra action buttons rendered in the top-right toolbar next to the Columns button. */
  toolbar?: React.ReactNode;
  /** Dedicated filter bar rendered in its own full-width row below search and actions. */
  filterBar?: React.ReactNode;
  /** Number of active filters, displayed on the mobile filter toggle button. */
  activeFiltersCount?: number;
  /** Optional callback when clear filters is invoked. */
  onClearFilters?: () => void;

  /**
   * Remembers which columns are hidden, per table, in this browser.
   *
   * A column layout is a working preference — a clerk chasing arrears wants
   * المتأخرات and no identity document; the one entering records wants the
   * reverse — and re-picking it on every page load is what makes people stop
   * using the feature. Scoped by caller-supplied key rather than by route so
   * two tables on one page keep separate layouts.
   *
   * Omit it and visibility still works, just for the life of the page.
   */
  columnStorageKey?: string;
  /**
   * Columns hidden the first time this table is opened.
   *
   * For the ones worth having but not worth showing by default — the table
   * would be unreadable with fifteen columns on, and a clerk who never opens
   * the menu should still get a sensible six.
   */
  initialHiddenColumns?: readonly string[];

  /** Renders an expandable sub-row's content (e.g. an evidence gallery). */
  renderSubRow?: (row: Row<TData>) => React.ReactNode;
  getRowCanExpand?: (row: Row<TData>) => boolean;

  className?: string;
  emptyIcon?: React.ReactNode;
}

/**
 * The phone layout: one card per row.
 *
 * Split out of the table body rather than driven by CSS on the same markup,
 * because the two are genuinely different documents. A `<table>` reflowed with
 * `display: block` on its cells loses the header association that makes each
 * value mean something — the reader gets a column of bare values with no
 * labels — and re-attaching labels through `::before` content puts the copy in
 * a stylesheet where it cannot be translated. Rendering the label beside the
 * value is the honest version, and it costs one extra pass over the same
 * column definitions.
 */
function MobileCards<TData>({
  rows,
  loading,
  columnCount,
  pageSize,
}: {
  rows: Row<TData>[];
  loading: boolean;
  columnCount: number;
  pageSize: number;
}): React.JSX.Element {
  /*
   * A column with no header text is an action column — the row's edit and
   * delete buttons. Those are pulled out of the label/value list and pinned to
   * the card footer: rendered inline they read as a value whose label is
   * blank, and they belong under a thumb rather than in the middle of a stack
   * of facts.
   */
  const headerText = (column: Cell<TData, unknown>['column']): string | null => {
    const header = column.columnDef.header;
    return typeof header === 'string' && header.length > 0 ? header : null;
  };

  const isActionColumn = (column: Cell<TData, unknown>['column']): boolean =>
    column.columnDef.meta?.mobile === 'actions' || headerText(column) === null;

  if (loading) {
    return (
      <div className="space-y-3 p-3">
        {Array.from({ length: Math.min(pageSize, 4) }, (_, index) => (
          <div key={index} className="space-y-3 rounded-xl border bg-card p-4">
            <Skeleton className="h-5 w-2/3" />
            <div className="space-y-2 border-t pt-3">
              {Array.from({ length: Math.min(columnCount - 1, 4) }, (_, line) => (
                <Skeleton key={line} className="h-3.5" style={{ width: `${85 - line * 12}%` }} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3">
      {rows.map((row) => {
        /*
         * Partitioned per row from the row's own cells rather than from the
         * column definitions, so nothing here depends on the caller's column
         * objects still being reference-identical to the ones TanStack holds.
         */
        const cells = row
          .getVisibleCells()
          .filter((cell) => cell.column.columnDef.meta?.mobile !== 'hide');
        const actionCells = cells.filter((cell) => isActionColumn(cell.column));
        const dataCells = cells.filter((cell) => !isActionColumn(cell.column));
        const headingCell =
          dataCells.find((cell) => cell.column.columnDef.meta?.mobile === 'primary') ??
          dataCells[0];
        const detailCells = dataCells.filter((cell) => cell !== headingCell);

        return (
          <div key={row.id} className="rounded-xl border bg-card p-4 shadow-sm">
            {headingCell ? (
              // `break-words`: an Arabic full name with four parts often has
              // no space to break on inside a long segment, and a card that
              // cannot wrap it pushes its own border past the screen edge.
              <div className="break-words text-base font-semibold leading-snug text-foreground">
                {flexRender(headingCell.column.columnDef.cell, headingCell.getContext())}
              </div>
            ) : null}

            {detailCells.length > 0 ? (
              <dl className="mt-3 space-y-2 border-t pt-3 text-xs">
                {detailCells.map((cell) => (
                  <div key={cell.id} className="flex items-start justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">{headerText(cell.column)}</dt>
                    <dd className="min-w-0 break-words text-end font-medium text-foreground">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}

            {actionCells.length > 0 ? (
              <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t pt-3 [&_button]:size-9">
                {actionCells.map((cell) => (
                  <React.Fragment key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </React.Fragment>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * General-purpose admin table: client- or server-driven pagination, page
 * size selection, single-input search and column sorting, built on
 * TanStack Table. Search input, loading skeleton, error and empty states
 * are all handled here so feature panels only supply columns + data.
 */
export function DataTable<TData, TValue = unknown>({
  columns,
  data,
  labels,
  getRowId,
  searchable = true,
  searchValue,
  onSearchChange,
  manual = false,
  manualPagination = manual,
  manualSorting = manual,
  manualFiltering = manual,
  sortable = true,
  pageCount,
  totalRowCount,
  pagination: controlledPagination,
  onPaginationChange,
  sorting: controlledSorting,
  onSortingChange,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  loading = false,
  error = null,
  onRetry,
  toolbar,
  filterBar,
  activeFiltersCount,
  onClearFilters,
  columnStorageKey,
  initialHiddenColumns,
  renderSubRow,
  getRowCanExpand,
  className,
  emptyIcon,
}: DataTableProps<TData, TValue>): React.JSX.Element {
  // Uncontrolled fallbacks so the table works fully client-side out of
  // the box; callers only need to pass `manual` + the controlled props
  // once pagination/sorting/search are driven by a server.
  /** The table's own outermost element — the anchor `scrollTableIntoView`
   *  walks up from, so the page returns to the first row. */
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  const [internalPagination, setInternalPagination] =
    React.useState<PaginationState>({ pageIndex: 0, pageSize: pageSizeOptions[0] ?? 20 });
  const [internalSorting, setInternalSorting] = React.useState<SortingState>([]);
  const [internalGlobalFilter, setInternalGlobalFilter] = React.useState('');
  const [filtersOpen, setFiltersOpen] = React.useState(false);

  /**
   * Which columns are hidden.
   *
   * Seeded from `initialHiddenColumns` rather than from storage, so the server
   * render and the first client render agree; the stored layout is applied in
   * the effect below. Without that split, a table whose stored layout differs
   * from its defaults hydrates with a different set of `<th>`s than the server
   * sent, which React reports as a hydration mismatch on every load.
   */
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(() =>
    Object.fromEntries((initialHiddenColumns ?? []).map((id) => [id, false])),
  );

  React.useEffect(() => {
    if (!columnStorageKey) return;
    try {
      const raw = localStorage.getItem(`${COLUMN_STORAGE_PREFIX}.${columnStorageKey}`);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
      // Only booleans survive: a hand-edited or half-migrated entry must not be
      // able to put a non-boolean into TanStack's visibility state.
      setColumnVisibility(
        Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            ([, value]) => typeof value === 'boolean',
          ) as Array<[string, boolean]>,
        ),
      );
    } catch {
      /* the defaults hold */
    }
  }, [columnStorageKey]);

  const changeColumnVisibility = React.useCallback<OnChangeFn<VisibilityState>>(
    (updater) => {
      setColumnVisibility((previous) => {
        const next = typeof updater === 'function' ? updater(previous) : updater;
        if (columnStorageKey) {
          try {
            localStorage.setItem(
              `${COLUMN_STORAGE_PREFIX}.${columnStorageKey}`,
              JSON.stringify(next),
            );
          } catch {
            /* the change still holds for this page load */
          }
        }
        return next;
      });
    },
    [columnStorageKey],
  );

  const resetColumns = React.useCallback(() => {
    changeColumnVisibility(
      Object.fromEntries((initialHiddenColumns ?? []).map((id) => [id, false])),
    );
     
  }, [changeColumnVisibility, initialHiddenColumns]);

  const pagination = controlledPagination ?? internalPagination;
  const sorting = controlledSorting ?? internalSorting;

  // Two values, deliberately: the box shows every keystroke, while the
  // committed term — the one that filters, or is sent to the API — changes
  // only when the reader asks for it with Enter. Neither a slow backend nor a
  // large in-memory table is touched while someone is still typing a name.
  const committedSearch = searchValue ?? internalGlobalFilter;
  const [searchInput, setSearchInput] = React.useState(committedSearch);
  const searchInputRef = React.useRef(searchInput);
  searchInputRef.current = searchInput;

  // Keep the visible input in sync if the committed value changes from
  // outside (e.g. a "clear filters" action elsewhere on the page).
  React.useEffect(() => {
    setSearchInput(committedSearch);
  }, [committedSearch]);

  const commitSearch = React.useCallback(
    (value: string) => {
      if (onSearchChange) {
        onSearchChange(value);
      } else {
        setInternalGlobalFilter(value);
      }
      // Any new search term restarts from the first page. Bailing out
      // when already on page 0 preserves the state reference, so callers
      // relying on it as a `useCallback`/`useEffect` dependency don't
      // see a spurious change.
      const resetPage = (previous: PaginationState): PaginationState =>
        previous.pageIndex === 0 ? previous : { ...previous, pageIndex: 0 };
      if (onPaginationChange) {
        onPaginationChange(resetPage);
      } else {
        setInternalPagination(resetPage);
      }
    },
    [onSearchChange, onPaginationChange],
  );

  /*
   * Typing no longer searches; Enter does.
   *
   * The box used to fire on a timer after every keystroke, which meant a
   * ten-character name was one query if you typed it quickly and three or four
   * if you paused — each one a full round trip, each one replacing the results
   * under a reader's eyes mid-scan. Committing on Enter makes the request
   * something the clerk asks for, so a search costs exactly one query and the
   * table only moves when they meant it to.
   *
   * Clearing the box is the one exception: emptying a filter is unambiguous and
   * nobody presses Enter to say "show everything again".
   */

  const handlePaginationChange = React.useCallback<OnChangeFn<PaginationState>>(
    (updater) => {
      const next =
        typeof updater === 'function' ? updater(pagination) : updater;

      /*
        «التالي» is at the *bottom* of the table, and the rows it loads start at
        the top. Pressing it left the reader parked at the foot of a page they
        had never seen — looking at row 25 of a set whose row 1 is a screen and
        a half above them, with no indication anything had moved except the page
        number under their thumb. On a phone, where the whole list is several
        screens tall, that reads as the button having done nothing.

        Scrolled here rather than in each of the pages that host a table,
        because every one of them has the same footer and the same problem, and
        a fix applied per page is one the next table will be written without.

        Both directions, and page-size changes too: each of them replaces every
        row on screen, and «السابق» strands the reader in exactly the same way.
      */
      if (next.pageIndex !== pagination.pageIndex || next.pageSize !== pagination.pageSize) {
        scrollElementToTop(rootRef.current);
      }

      if (onPaginationChange) {
        onPaginationChange(next);
      } else {
        setInternalPagination(next);
      }
    },
    [pagination, onPaginationChange],
  );

  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: {
      pagination,
      sorting,
      globalFilter: committedSearch,
      columnVisibility,
    },
    onColumnVisibilityChange: changeColumnVisibility,
    enableSorting: sortable,
    manualPagination,
    manualSorting,
    manualFiltering,
    // `-1` means "unknown page count"; TanStack then trusts `pageCount` only
    // when the caller supplies one, and leaves next/previous enabled otherwise.
    pageCount: manualPagination ? (pageCount ?? -1) : undefined,
    onPaginationChange: handlePaginationChange,
    onSortingChange: onSortingChange ?? setInternalSorting,
    onGlobalFilterChange: (updater) => {
      const next =
        typeof updater === 'function' ? updater(committedSearch) : updater;
      commitSearch(next ?? '');
    },
    getRowCanExpand,
    getCoreRowModel: getCoreRowModel(),
    // Each row model is dropped only for the axis the server owns. Dropping
    // all three because one moved is what previously left a server-paginated
    // table unsortable and unpaged at the same time.
    getFilteredRowModel: manualFiltering ? undefined : getFilteredRowModel(),
    getSortedRowModel: manualSorting ? undefined : getSortedRowModel(),
    getPaginationRowModel: manualPagination ? undefined : getPaginationRowModel(),
    getExpandedRowModel: renderSubRow ? getExpandedRowModel() : undefined,
  });

  const rows = table.getRowModel().rows;
  /**
   * How many rows the current view describes — «{count} موظف» in the footer,
   * and beside the applied-search pill.
   *
   * Three cases, and it used to answer only the first two. A caller that knows
   * the figure passes it (a server-paginated table, where the page in hand is
   * a slice). Otherwise it is the *filtered* count, not `data.length`: on a
   * table the browser filters, `data` is everything that was loaded, so a
   * search narrowing twelve staff accounts to one still reported twelve. The
   * footer said the search had not worked, under a table showing that it had.
   */
  const resolvedTotal =
    totalRowCount ?? (manualFiltering ? data.length : table.getFilteredRowModel().rows.length);
  const resolvedPageCount = table.getPageCount();
  const currentPage = pagination.pageIndex + 1;
  const hasSearchTerm = committedSearch.trim().length > 0;
  /**
   * The box holds a term the table has not been filtered by yet.
   *
   * Compared trimmed, because that is what `commitSearch` sends: a draft of
   * `"أحمد "` against an applied `"أحمد"` is the same search, and
   * flagging it as pending would leave an Enter prompt on a box that has
   * already run.
   */
  const isDraft = searchInput.trim() !== committedSearch.trim();
  // Visible, not declared: a `colSpan` counted off the full column list leaves
  // the empty state and every expanded sub-row spanning more cells than the
  // header has, which stretches the table past its own border.
  const columnCount = table.getVisibleLeafColumns().length;

  /**
   * The columns an administrator may hide.
   *
   * `getCanHide` respects a column's own `enableHiding: false`, which is how a
   * table keeps the one column that identifies its rows always on screen — a
   * citizens table with the name hidden is a grid of numbers belonging to
   * nobody.
   */
  const hideableColumns = table.getAllLeafColumns().filter((column) => column.getCanHide());
  const showColumnsMenu = Boolean(labels.columns) && hideableColumns.length > 0;
  const hiddenCount = hideableColumns.filter((column) => !column.getIsVisible()).length;

  // Varied bar widths, cycled deterministically by column. A grid of
  // identical full-width bars reads as a broken layout; an uneven one reads
  // as text that has not arrived yet, which is what this is.
  const skeletonRows = (
    <TableBody>
      {Array.from({ length: Math.min(pagination.pageSize, 8) }, (_, row) => (
        <TableRow key={row} className="hover:bg-transparent">
          {Array.from({ length: columnCount }, (_, col) => (
            <TableCell key={col}>
              <div
                className="h-4 animate-pulse rounded bg-muted"
                style={{ width: `${[70, 90, 55, 80, 45, 65][(row + col) % 6]}%` }}
              />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </TableBody>
  );

  return (
    /*
      One bordered card holding the toolbar, the rows and the footer, rather
      than three stacked blocks with gaps between them. The controls belong to
      the table they act on, and a search box floating above an unrelated
      rounded rectangle reads as page furniture instead.
    */
    <div ref={rootRef} className={cn('overflow-hidden rounded-lg border bg-card', className)}>
      {searchable || toolbar || showColumnsMenu || filterBar ? (
        <div className="flex flex-col gap-3 border-b p-3 sm:flex-row sm:items-center sm:justify-between">
          {searchable ? (
            <div className="relative w-full sm:w-80 md:w-96 lg:w-[26rem]">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                role="searchbox"
                aria-label={labels.searchAriaLabel}
                className="h-9 ps-9 pe-9 text-xs"
                placeholder={labels.searchPlaceholder}
                value={searchInput}
                onChange={(event) => {
                  const next = event.target.value;
                  setSearchInput(next);
                  // Emptying the box applies straight away. It is unambiguous,
                  // and it also covers the native clear button WebKit renders
                  // inside `type="search"` — which would otherwise leave a
                  // blank field still filtering by the previous term.
                  if (next === '' && committedSearch !== '') commitSearch('');
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitSearch(searchInput.trim());
                  }
                }}
              />
              {/*
                Two controls sharing the end edge, and only ever one at a
                time: the key that would run the search while the draft is
                uncommitted, the control that clears it once it has run. They
                cannot both apply — a draft equal to the applied term has
                nothing left to commit — so the field never has to fit both.
              */}
              {isDraft ? (
                <kbd
                  aria-hidden
                  className="pointer-events-none absolute end-2 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-xs font-medium leading-none text-muted-foreground"
                >
                  {labels.searchHint ?? 'Enter'}
                </kbd>
              ) : searchInput ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput('');
                    commitSearch('');
                  }}
                  aria-label={labels.clearSearch}
                  className="absolute end-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 self-end sm:self-auto">
            {filterBar ? (
              <Button
                type="button"
                variant={filtersOpen || (activeFiltersCount ?? 0) > 0 ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => setFiltersOpen((prev) => !prev)}
                className={cn(
                  'h-9 gap-1.5 text-xs sm:hidden',
                  (activeFiltersCount ?? 0) > 0 && 'border-primary/50 text-primary font-medium',
                )}
              >
                <Filter className="size-3.5" aria-hidden />
                {labels.filters ?? (labels.searchAriaLabel?.includes('بحث') ? 'الفلاتر' : 'Filters')}
                {(activeFiltersCount ?? 0) > 0 ? (
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-bold text-primary">
                    {activeFiltersCount}
                  </span>
                ) : null}
              </Button>
            ) : null}

            {toolbar}

            {showColumnsMenu ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs">
                    <SlidersHorizontal className="size-3.5" aria-hidden />
                    {labels.columns}
                    {/*
                      The count of hidden columns, on the button itself. A
                      table missing a column an administrator expects is
                      otherwise indistinguishable from a table whose data did
                      not load — and the menu that explains it is the one
                      place they will not think to look.
                    */}
                    {hiddenCount > 0 ? (
                      <span className="rounded-full bg-primary/10 px-1.5 text-xs font-semibold text-primary">
                        {hiddenCount}
                      </span>
                    ) : null}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>{labels.columnsHint ?? labels.columns}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {hideableColumns.map((column) => (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      checked={column.getIsVisible()}
                      // Radix closes the menu on select by default, which
                      // makes choosing three columns three trips through it.
                      onSelect={(event) => event.preventDefault()}
                      onCheckedChange={(checked) => column.toggleVisibility(checked)}
                    >
                      {columnLabel(column)}
                    </DropdownMenuCheckboxItem>
                  ))}
                  {labels.resetColumns ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => resetColumns()}>
                        <RotateCcw className="size-4" aria-hidden />
                        {labels.resetColumns}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Dedicated Filter Bar */}
      {filterBar ? (
        <div
          className={cn(
            'border-b bg-muted/20 px-3.5 py-2.5 transition-all',
            filtersOpen ? 'block' : 'hidden sm:block',
          )}
        >
          {filterBar}
        </div>
      ) : null}

      {/*
        What the table is actually filtered by, stated once the search has run.

        The box alone cannot say it. A clerk who has typed a correction over a
        committed term sees a field whose contents are *not* what produced the
        rows below, and the difference between "my search found three people"
        and "my search has not run yet" is invisible without this line. It also
        gives the applied term a clear control that survives editing the draft.
      */}
      {searchable && hasSearchTerm ? (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs">
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 font-medium text-foreground">
            <Search className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">
              {fillTemplate(labels.searchApplied ?? '«{term}»', {
                term: committedSearch.trim(),
              })}
            </span>
            <button
              type="button"
              onClick={() => {
                setSearchInput('');
                commitSearch('');
              }}
              aria-label={labels.clearSearch}
              className="-me-1 flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3" />
            </button>
          </span>
          {/*
            The count beside the term, not under the table. `totalRowCount`
            describes the filtered set on a server-driven table and the whole
            set on a client one — in both cases it is the answer to "how many
            did that find", which is the question the pill raises.
          */}
          {!loading && !error ? (
            <span className="text-muted-foreground">
              {fillTemplate(labels.totalRows, { count: resolvedTotal })}
            </span>
          ) : null}
        </div>
      ) : null}

      {error ? (
        // The shared state components rather than three bespoke ones: a table,
        // a chart panel and a drawer answering "where is my data" differently
        // is how a portal stops reading as one product.
        <ErrorState description={labels.loadError} onRetry={onRetry} retryLabel={labels.retry} />
      ) : !loading && rows.length === 0 ? (
        <EmptyState
          title={hasSearchTerm ? labels.emptySearch : labels.empty}
          description={hasSearchTerm ? labels.emptySearchHint : labels.emptyHint}
          icon={hasSearchTerm ? SearchX : undefined}
          iconNode={hasSearchTerm ? undefined : emptyIcon}
          /*
            The way out of a filter that matched nothing.

            This is the one empty state a caller cannot fix from outside: the
            filter controls live in `filterBar`, which is hidden on a phone
            behind the «الفلاتر» toggle, and the row a page might put its own
            reset button in is not rendered when there are no rows. So a clerk
            who narrowed to «بلا مدخل مُثبت» in a قطاع with none of them got
            «لا توجد مبانٍ» — a sentence that reads as "the municipality has no
            buildings" and offers nothing to press.

            Shown only when filters are what emptied the table. A genuinely
            empty register keeps the plain message, because offering to clear
            filters that are not set would explain the emptiness wrongly.
          */
          action={
            onClearFilters && (activeFiltersCount ?? 0) > 0 ? (
              <Button variant="outline" size="sm" onClick={onClearFilters} className="gap-1.5">
                <X className="size-3.5" aria-hidden />
                {labels.clearFilters ?? labels.clearSearch}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
        {/* Phone layout: one card per row.
            A table of eight columns on a 390px screen is a horizontal scroll
            hunt where the reader loses which row they were on the moment the
            first column leaves the viewport — and the first column is the
            name. Each row becomes a card instead: the heading is what the row
            is about, the rest are label/value pairs, and the action buttons
            are pinned to a footer where a thumb can reach them. */}
        <div className="sm:hidden">
          <MobileCards
            rows={rows}
            loading={loading && rows.length === 0}
            columnCount={columnCount}
            pageSize={pagination.pageSize}
          />
        </div>

        {/* The scroll container for horizontal overflow — lets all 10 records show full height without vertical scrolling. */}
        <div className="hidden overflow-x-auto sm:block">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-muted/95 shadow-[inset_0_-1px_0_hsl(var(--border))] backdrop-blur supports-[backdrop-filter]:bg-muted/80">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} className="hover:bg-transparent">
                  {headerGroup.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const sortState = header.column.getIsSorted();
                    const ariaSort =
                      sortState === 'asc'
                        ? 'ascending'
                        : sortState === 'desc'
                          ? 'descending'
                          : canSort
                            ? 'none'
                            : undefined;
                    const align = header.column.columnDef.meta?.align ?? 'start';
                    return (
                      <TableHead
                        key={header.id}
                        scope="col"
                        aria-sort={ariaSort}
                        className={cn(
                          ALIGN_TEXT[align],
                          header.column.columnDef.meta?.headerClassName,
                        )}
                      >
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className={cn(
                              'inline-flex w-full items-center gap-1.5 rounded px-2 py-1 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              ALIGN_JUSTIFY[align],
                              // Pulls the button's own padding back so the
                              // label sits flush with the cells beneath it
                              // rather than inset by 8px — on whichever side
                              // this column is aligned to.
                              align === 'end' ? '-me-2' : align === 'start' ? '-ms-2' : '',
                            )}
                            title={
                              sortState === 'asc'
                                ? labels.sortDescending
                                : sortState === 'desc'
                                  ? labels.sortNone
                                  : labels.sortAscending
                            }
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sortState === 'asc' ? (
                              <ArrowUp className="h-3.5 w-3.5" />
                            ) : sortState === 'desc' ? (
                              <ArrowDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground/50" />
                            )}
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            {loading && rows.length === 0 ? (
              skeletonRows
            ) : (
              <TableBody className={loading ? 'opacity-60 transition-opacity' : ''}>
                {rows.map((row) => (
                  <React.Fragment key={row.id}>
                    <TableRow
                      data-state={row.getIsExpanded() ? 'selected' : undefined}
                      // Zebra stays on `muted` and hover on `primary` so the
                      // two never compete on the same grey — hovering a
                      // striped row is a hue change, not a shade nudge.
                      className={row.index % 2 === 1 ? 'bg-muted/30' : undefined}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell
                          key={cell.id}
                          className={cn(
                            ALIGN_TEXT[cell.column.columnDef.meta?.align ?? 'start'],
                            cell.column.columnDef.meta?.cellClassName,
                          )}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                    {renderSubRow && row.getIsExpanded() ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={columnCount} className="bg-muted/30">
                          {renderSubRow(row)}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </React.Fragment>
                ))}
              </TableBody>
            )}
          </Table>
        </div>
        </>
      )}

      {/* Pagination + page-size footer, inside the card and ruled off from the
          rows above it. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t p-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{labels.rowsPerPage}</span>
          <Select
            value={String(pagination.pageSize)}
            onValueChange={(value) => {
              const pageSize = Number(value);
              if (onPaginationChange) {
                onPaginationChange({ pageIndex: 0, pageSize });
              } else {
                setInternalPagination({ pageIndex: 0, pageSize });
              }
            }}
          >
            <SelectTrigger className="h-8 w-[80px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="whitespace-nowrap">
            {fillTemplate(labels.totalRows, { count: resolvedTotal })}
          </span>
        </div>
        {/* Square icon buttons rather than labelled ones: with the position
            spelled out beside them, «السابق»/«التالي» repeat what the reader
            has just been told and crowd the row on a phone. The labels survive
            as `aria-label` and `title`, so nothing is lost to a screen reader
            or a hover. */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium tabular-nums text-muted-foreground">
            {fillTemplate(labels.pageOf, {
              current: currentPage,
              total: Math.max(resolvedPageCount, 1),
            })}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={labels.previous}
            title={labels.previous}
            disabled={loading || currentPage <= 1}
            onClick={() => {
              handlePaginationChange({
                ...pagination,
                pageIndex: Math.max(pagination.pageIndex - 1, 0),
              });
            }}
          >
            <ChevronRight className="h-4 w-4 rtl:rotate-0 ltr:rotate-180" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={labels.next}
            title={labels.next}
            disabled={loading || currentPage >= resolvedPageCount}
            onClick={() => {
              handlePaginationChange({
                ...pagination,
                pageIndex: Math.min(pagination.pageIndex + 1, Math.max(resolvedPageCount - 1, 0)),
              });
            }}
          >
            <ChevronLeft className="h-4 w-4 rtl:rotate-0 ltr:rotate-180" />
          </Button>
        </div>
      </div>
    </div>
  );
}

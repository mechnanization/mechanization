'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BanknoteArrowDown, BanknoteArrowUp, Receipt, ScrollText, Tags } from 'lucide-react';
import { TREASURY_WORK_ROLES } from '@mechanization/shared-schemas';
import {
  getExpenseCategories,
  getIncomeCategories,
  getTreasuryMovements,
  getTreasuryOverview,
  type TreasuryMovement,
} from '@/lib/api-client';
import { incomeCategoryLabel } from '@/lib/income-category-label';
import { hasRole } from '@/lib/staff-roles';
import {
  apiDirection,
  COMPOSER_DIRECTIONS,
  DEFAULT_MOVEMENT_PERIOD,
  MOVEMENT_DIRECTIONS,
  MOVEMENT_PERIODS,
  movementKey,
  movementRange,
  type ComposerDirection,
} from '@/lib/treasury-movements';
import { applyUrlPatch, toSearch, type UrlValues } from '@/lib/url-state';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { param, useTabSearch, useUrlPagination, useUrlState } from '@/lib/use-url-state';
import { ExpenseQueue } from '@/components/admin/finance/expense-queue';
import { MovementFilters } from '@/components/admin/finance/movements/movement-filters';
import { MovementList, MovementListSkeleton } from '@/components/admin/finance/movements/movement-list';
import { VoucherSheet } from '@/components/admin/finance/movements/voucher-sheet';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { Alert } from '@/components/ui/alert';
import { BackLink } from '@/components/ui/back-link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Pager } from '@/components/ui/pager';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { EmptyState, ErrorState } from '@/components/ui/states';

/** Lines on a page of the list; `Pager` steps through the rest. */
const PAGE_SIZE = 25;

/** The vouchers, or what waits on the head's payment order (`?view=queue`). */
const VIEWS = ['register', 'queue'] as const;

/**
 * The page's state, in the URL (`lib/use-url-state.ts`): a reload, a shared
 * link and the back button all come back to the same slice of the books, with
 * the same voucher open. Ids, enums and days only — the search term, which can
 * hold a person's name, lives in tab storage.
 *
 * - `period` (+ `from`, `to` for a range of one's own), `dir`, `account`,
 *   `category`, `void`: the filter bar; `page`/`limit` the list's page.
 * - `voucher` + `kind`: the voucher open in the side panel — what the
 *   recording page's «عرض» links to.
 */
const PAGE_URL = {
  view: param.oneOf(VIEWS, 'register'),
  dir: param.oneOf(MOVEMENT_DIRECTIONS, 'all'),
  period: param.oneOf(MOVEMENT_PERIODS, DEFAULT_MOVEMENT_PERIOD),
  from: param.date(),
  to: param.date(),
  account: param.id(),
  category: param.id(),
  void: param.flag(),
  voucher: param.id(),
  kind: param.oneOf(COMPOSER_DIRECTIONS, 'in'),
};
type PageUrl = UrlValues<typeof PAGE_URL>;

/** The list's own parameters, cleared on the way to the queue, which keeps its own. */
const REGISTER_PARAMS = ['dir', 'period', 'from', 'to', 'account', 'category', 'void', 'page', 'limit'] as const;
/** The queue's own parameters (`ExpenseQueue`), cleared on the way back. */
const QUEUE_PARAMS = ['status', 'page', 'limit'] as const;

/**
 * «الحركات المالية» — every voucher the treasury wrote, money in and money out,
 * as one list: the filter bar, the lines, and nothing else. Recording is the
 * page before it, «الإيرادات والنفقات» (`/finance/movements`); this one is for
 * reading — what came in and went out, over which period, and the voucher
 * behind each line. Design: docs/finance.md §4.6; the surface's reasoning:
 * docs/ui-ux-standards.md (PRIM-3).
 *
 * ## The list (2026-10-12)
 *
 * The vouchers of both kinds, newest first (`GET treasury/movements`), one row
 * each with its day in a column of its own (`MovementList`), in one frame with
 * the filter bar at its top (`MovementFilters`: search, period, direction,
 * wallet, category, cancelled) and the pager at its foot — drawn as
 * `DataTable`'s frame is. It was a register grouped under day headings with the
 * period's figures in a block above it, and the voucher in a pane that
 * narrowed it; the figures and the headings went, and the voucher moved over
 * the list.
 *
 * ## A line, opened
 *
 * A line opens its voucher in a side panel over the list (`VoucherSheet`, the
 * kit's `Sheet`): every field, who recorded it, its order and its
 * cancellation, and print, order and cancel in its footer. Opening it is
 * pushed onto history, so the browser's back button closes it as the panel's
 * own close control does; a voucher opened by its address — the recording
 * page's «عرض» — closes back to the list.
 *
 * ## What waits on the head of the municipality
 *
 * «بانتظار أمر الصرف» swaps the list for `ExpenseQueue`: the accountant's
 * requests, and the urgent payments made before the order (decree 5595/1982
 * art. 35), with the manager's decisions on them.
 *
 * Reading is `TREASURY_READ_ROLES` (its nav row and `TreasuryController`);
 * cancelling and ordering are `TREASURY_ADMIN_ROLES`, offered here by
 * `hasRole` and enforced by `IncomeController` and `ExpensesController`
 * (CODE-4). The links to record show to `TREASURY_WORK_ROLES` only. The old
 * registers' addresses lead here (`/finance/income`, `/finance/expenses`).
 */
export default function TransactionsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('finance.movements');
  const tCommon = useTranslations('common');
  const { token, user } = useStaffSession(tenant, base);
  const canRecord = user ? hasRole(TREASURY_WORK_ROLES, user.role) : false;

  const [url, setUrl] = useUrlState(PAGE_URL);
  const [pagination, setPagination] = useUrlPagination({ defaultSize: PAGE_SIZE });
  const [search, setSearch] = useTabSearch(tenant, 'movements');
  /** A new narrowing starts again from the newest page, in the same URL write. */
  const narrow = (patch: Partial<PageUrl>): void => setUrl(patch, { clear: ['page'] });

  const range = useMemo(
    () => movementRange(url.period, { from: url.from, to: url.to }),
    [url.period, url.from, url.to],
  );

  const overview = useStaffQuery({
    queryKey: ['treasury', tenant, 'overview'],
    queryFn: (accessToken, signal) => getTreasuryOverview(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });

  /*
    For the category filter. Stopped categories included, on both sides: a
    voucher filed under one is still in the list, and a filter that could not
    name its category could not find it. The two keys are the ones the
    recording forms' inline category editors write a new category into.
  */
  const incomeCategories = useStaffQuery({
    queryKey: ['treasury', tenant, 'income-categories', 'all'],
    queryFn: (accessToken, signal) => getIncomeCategories(tenant, accessToken, { includeInactive: true }, signal),
    tenant,
    base,
    token,
    reference: true,
    errorMessage: t('loadError'),
  });
  const expenseCategories = useStaffQuery({
    queryKey: ['treasury', tenant, 'expense-categories', 'all'],
    queryFn: (accessToken, signal) => getExpenseCategories(tenant, accessToken, { includeInactive: true }, signal),
    tenant,
    base,
    token,
    reference: true,
    errorMessage: t('loadError'),
  });

  const list = useStaffQuery({
    queryKey: [
      'treasury',
      tenant,
      'movements',
      url.dir,
      range.from,
      range.to,
      url.account,
      url.category,
      url.void,
      search,
      pagination.pageIndex,
      pagination.pageSize,
    ],
    queryFn: (accessToken, signal) =>
      getTreasuryMovements(
        tenant,
        accessToken,
        {
          direction: apiDirection(url.dir),
          from: range.from,
          to: range.to,
          accountId: url.account || undefined,
          // A category belongs to one direction's list; without one it is no filter.
          categoryId: url.dir !== 'all' ? url.category || undefined : undefined,
          search: search || undefined,
          includeVoid: url.void,
          // The server counts pages from 1; the URL's `?page=` is 1-based and the state 0-based.
          page: pagination.pageIndex + 1,
          pageSize: pagination.pageSize,
        },
        signal,
      ),
    tenant,
    base,
    // Read only while the list is the view on screen: the queue reads its own lists.
    token: url.view === 'register' ? token : null,
    keepPrevious: true,
    errorMessage: t('list.loadError'),
  });

  const active = overview.data?.active ?? false;
  const treasuryOff = Boolean(overview.data) && !active;
  const records = canRecord && active;
  const accounts = overview.data?.accounts ?? [];
  const waiting = (overview.data?.pendingExpenseRequests ?? 0) + (overview.data?.vouchersAwaitingOrder ?? 0);
  const movements = useMemo(() => list.data?.movements ?? [], [list.data]);
  /**
   * Narrowed by something other than the period: the empty list then says the
   * filters emptied it. Listing the cancelled vouchers too widens the list, so
   * it is not one of them.
   */
  const filtered = url.dir !== 'all' || Boolean(url.account || url.category || search);

  /*
    A page past the end — the last voucher of the last page cancelled while
    cancelled ones are hidden, or an old link — steps back to the last page
    that holds lines, rather than saying the period is empty.
  */
  const pastTheEnd = Boolean(list.data && list.data.movements.length === 0 && list.data.total > 0);
  useEffect(() => {
    if (!list.data || !pastTheEnd) return;
    const last = Math.max(0, Math.ceil(list.data.total / pagination.pageSize) - 1);
    if (pagination.pageIndex > last) setPagination((current) => ({ ...current, pageIndex: last }));
  }, [list.data, pastTheEnd, pagination.pageIndex, pagination.pageSize, setPagination]);

  const sideReadFailed = overview.error ?? incomeCategories.error ?? expenseCategories.error;
  const retrySideReads = (): void => {
    if (overview.error) overview.refetch();
    if (incomeCategories.error) incomeCategories.refetch();
    if (expenseCategories.error) expenseCategories.refetch();
  };

  const recordHref = (direction: ComposerDirection): string => `${base}/finance/movements?dir=${direction}`;
  /** The list's frame: a page change brings its top back into view. */
  const frameRef = useRef<HTMLDivElement>(null);

  // ── the voucher's side panel ────────────────────────────────────────────────

  /** The panel was opened from a line, onto history: closing it steps back. */
  const pushed = useRef(false);
  useEffect(() => {
    // The back button closed it (or left the page's state): nothing of ours is on top any more.
    const onPop = (): void => {
      pushed.current = false;
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /**
   * Opens a voucher in the side panel. Opening it is a place, pushed so the
   * back button closes it — on a phone, where the panel is the screen, the
   * back button is how people leave it.
   */
  const openVoucher = useCallback((direction: ComposerDirection, id: string) => {
    const current = new URLSearchParams(window.location.search);
    const href = `${window.location.pathname}${toSearch(applyUrlPatch(current, PAGE_URL, { voucher: id, kind: direction }))}`;
    if (current.get('voucher')) {
      window.history.replaceState(null, '', href);
    } else {
      window.history.pushState(null, '', href);
      pushed.current = true;
    }
  }, []);

  const closeVoucher = (): void => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
      return;
    }
    // The voucher and its kind leave the address together: `?kind=` alone means nothing.
    setUrl({ voucher: '' }, { clear: ['kind'] });
  };

  /**
   * The voucher the panel last showed. Kept after the address lets it go, so the
   * panel slides out with its content rather than going blank first. While a
   * voucher is in the address, that one is the panel's at once: read from this
   * state alone, a second voucher opened the first one's panel for a render.
   */
  const [lastShown, setLastShown] = useState<{ kind: ComposerDirection; id: string } | null>(null);
  useEffect(() => {
    if (url.voucher) setLastShown({ kind: url.kind, id: url.voucher });
  }, [url.voucher, url.kind]);
  const shown = url.voucher ? { kind: url.kind, id: url.voucher } : lastShown;

  const panelOpen = Boolean(url.voucher);
  const shownLine = shown
    ? (movements.find(
        (movement) => movement.voucher.id === shown.id && movement.direction === (shown.kind === 'in' ? 'IN' : 'OUT'),
      ) ?? null)
    : null;
  const selectedKey = url.voucher ? movementKey({ direction: url.kind === 'in' ? 'IN' : 'OUT', voucher: { id: url.voucher } }) : null;

  // ── the filter bar ──────────────────────────────────────────────────────────

  const accountOptions = accounts.map((account) => ({ value: account.id, label: account.name }));
  const categoryOptions =
    url.dir === 'in'
      ? (incomeCategories.data ?? []).map((category) => ({ value: category.id, label: incomeCategoryLabel(category, locale) }))
      : url.dir === 'out'
        ? (expenseCategories.data ?? []).map((category) => ({ value: category.id, label: category.name }))
        : [];

  const clearFilters = (): void => {
    narrow({ period: DEFAULT_MOVEMENT_PERIOD, from: '', to: '', dir: 'all', account: '', category: '', void: false });
    setSearch('');
  };

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/finance`} label={t('back')} />

      <PageHeader
        icon={ScrollText}
        title={t('transactionsTitle')}
        actions={
          <>
            {/* The way to record, from the list; on a phone it is the bar at the foot. */}
            {records ? (
              <>
                <Button asChild variant="secondary" className="hidden md:inline-flex">
                  <Link href={recordHref('in')}>
                    <BanknoteArrowUp className="size-4" aria-hidden />
                    {t('recordIn')}
                  </Link>
                </Button>
                <Button asChild variant="secondary" className="hidden md:inline-flex">
                  <Link href={recordHref('out')}>
                    <BanknoteArrowDown className="size-4" aria-hidden />
                    {t('recordOut')}
                  </Link>
                </Button>
              </>
            ) : null}
            {/*
              Readable by everyone here; the categories page offers its write controls
              to the manager only. On a phone it is a button beside the view switch, so
              the heading stays one line and the first lines reach the first screen.
            */}
            <Button asChild variant="outline" className="hidden sm:inline-flex">
              <Link href={`${base}/finance/income/categories`}>
                <Tags className="size-4" aria-hidden />
                {t('manageCategories')}
              </Link>
            </Button>
          </>
        }
      />

      {treasuryOff ? (
        <Alert variant="warning" title={t('notActiveTitle')}>
          {t('notActiveBody')}
        </Alert>
      ) : null}

      {/*
        The wallets and the categories are side reads, but two of the filters
        hang on them: when one fails, the page says so and offers the retry
        rather than quietly offering less.
      */}
      {sideReadFailed ? (
        <RefreshFailedAlert title={t('partialLoad')} message={sideReadFailed} onRetry={retrySideReads} />
      ) : null}

      <div className="space-y-4">
        {/* Wraps where a locale's words do not fit one phone line: the categories button drops under the switch. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SegmentedControl
            className="sm:inline-flex sm:w-auto"
            fullWidth={false}
            value={url.view}
            // Each view's filters and page belong to it: leaving one takes them out of the address.
            onChange={(next) =>
              setUrl({ view: next as PageUrl['view'] }, { clear: next === 'queue' ? REGISTER_PARAMS : QUEUE_PARAMS })
            }
            aria-label={t('views.aria')}
            options={[
              { value: 'register', label: t('views.register') },
              { value: 'queue', label: t('views.queue', { count: waiting }) },
            ]}
          />
          {/*
            «بنود الإيرادات» on a phone, where the heading's actions are hidden: at
            the top, with a word on it — a touch screen never shows a tooltip, so
            an icon alone would be a picture to guess.
          */}
          <Button asChild variant="outline" size="sm" className="shrink-0 sm:hidden">
            <Link href={`${base}/finance/income/categories`} aria-label={t('manageCategories')}>
              <Tags className="size-4" aria-hidden />
              {t('categoriesShort')}
            </Link>
          </Button>
        </div>

        {url.view === 'queue' ? (
          <ExpenseQueue tenant={tenant} base={base} token={token} locale={locale} actor={user} />
        ) : (
          <>
            {/* A re-read that failed with lines on screen keeps them, and says so (STA-1). */}
            {list.error && list.data ? <RefreshFailedAlert message={list.error} onRetry={list.refetch} /> : null}

            {/*
              One frame, as `DataTable`'s: the filter bar at its top, the lines, the
              pager at its foot. Not `overflow-hidden`: the period's day pickers open
              an in-tree calendar that a short list would cut off. The lines round
              their own corners when nothing is under them.
            */}
            <div ref={frameRef} className="rounded-lg border bg-card">
              <MovementFilters
                locale={locale}
                search={search}
                onSearch={(term) => {
                  setSearch(term);
                  setPagination((current) => (current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }));
                }}
                period={url.period}
                onPeriod={(period) => narrow({ period, from: '', to: '' })}
                from={url.from}
                onFrom={(from) => narrow({ from })}
                to={url.to}
                onTo={(to) => narrow({ to })}
                direction={url.dir}
                onDirection={(dir) => narrow({ dir, category: '' })}
                accountId={url.account}
                onAccount={(account) => narrow({ account })}
                accountOptions={accountOptions}
                categoryId={url.dir === 'all' ? '' : url.category}
                onCategory={(category) => narrow({ category })}
                categoryOptions={categoryOptions}
                includeVoid={url.void}
                onIncludeVoid={(include) => narrow({ void: include })}
                onClear={clearFilters}
              />

              {list.error && !list.data ? (
                <ErrorState title={list.error} onRetry={list.refetch} retryLabel={tCommon('retry')} />
              ) : !list.data || pastTheEnd ? (
                <MovementListSkeleton />
              ) : movements.length === 0 ? (
                <EmptyState
                  icon={Receipt}
                  title={filtered ? t('list.emptyFiltered') : url.period === 'all' ? t('list.emptyAll') : t('list.emptyPeriod')}
                  description={filtered ? t('list.emptyFilteredHint') : records ? t('list.emptyHintRecord') : t('list.emptyHint')}
                  action={
                    // A treasury that is not live has no voucher in any period: nothing to widen to.
                    filtered || (url.period !== 'all' && !treasuryOff) ? (
                      <div className="flex flex-wrap justify-center gap-2">
                        {url.period !== 'all' && !treasuryOff ? (
                          <Button variant="outline" onClick={() => narrow({ period: 'all', from: '', to: '' })}>
                            {t('list.allPeriods')}
                          </Button>
                        ) : null}
                        {filtered ? (
                          <Button variant="ghost" onClick={clearFilters}>
                            {t('filters.clear')}
                          </Button>
                        ) : null}
                      </div>
                    ) : undefined
                  }
                />
              ) : (
                <>
                  <MovementList
                    locale={locale}
                    movements={movements}
                    selectedKey={selectedKey}
                    fetching={list.fetching}
                    onSelect={(movement: TreasuryMovement) =>
                      openVoucher(movement.direction === 'IN' ? 'in' : 'out', movement.voucher.id)
                    }
                  />
                  <Pager
                    className="border-t p-3"
                    page={pagination.pageIndex}
                    pageSize={pagination.pageSize}
                    total={list.data.total}
                    onPageChange={(page) => setPagination({ ...pagination, pageIndex: page })}
                    locale={locale}
                    label={t('list.pages')}
                    scrollTarget={frameRef}
                  />
                </>
              )}
            </div>
          </>
        )}
      </div>

      {shown ? (
        <VoucherSheet
          key={`${shown.kind}:${shown.id}`}
          open={panelOpen}
          onClose={closeVoucher}
          tenant={tenant}
          base={base}
          token={token}
          locale={locale}
          actor={user}
          kind={shown.kind}
          voucherId={shown.id}
          fromList={shownLine}
        />
      ) : null}

      {/*
        A phone's way to record: at the foot of the screen, under the thumb, while
        the list is what is on it. A solid surface, no blur (BAN-2), a direct
        child of the page root, and above the home indicator.
      */}
      {records && url.view === 'register' ? (
        <div className="sticky bottom-0 z-10 -mx-4 grid grid-cols-2 gap-2 border-t bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:-mx-6 sm:px-6 md:hidden">
          <Button asChild variant="secondary">
            <Link href={recordHref('in')}>
              <BanknoteArrowUp className="size-4" aria-hidden />
              {t('recordIn')}
            </Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href={recordHref('out')}>
              <BanknoteArrowDown className="size-4" aria-hidden />
              {t('recordOut')}
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

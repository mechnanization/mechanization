'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, Plus, Receipt, X } from 'lucide-react';
import { TREASURY_ADMIN_ROLES, TREASURY_WORK_ROLES } from '@mechanization/shared-schemas';
import {
  getExpenseCategories,
  getExpenses,
  getTreasuryOverview,
  type ExpenseVoucherView,
} from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { mayRegularize } from '@/lib/expense-order';
import { hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { param, useUrlPagination, useUrlState } from '@/lib/use-url-state';
import { cn } from '@/lib/utils';
import { RegularizeExpenseDialog, VoidExpenseDialog } from '@/components/admin/finance/expense-dialogs';
import { ExpenseQueue } from '@/components/admin/finance/expense-queue';
import { TreasuryAmount } from '@/components/admin/finance/treasury-amount';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { Alert } from '@/components/ui/alert';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { DatePicker } from '@/components/ui/date-picker';
import { FilterSelect } from '@/components/ui/filter-controls';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';

/** Rows a page of the register starts at; the table's own menu offers the others. */
const PAGE_SIZE = 25;

/**
 * Two readings of the expenses, in the URL: the vouchers already paid, and what
 * is still waiting for the manager's payment order. A link to the queue —
 * from the treasury page, or from the form once a request is sent — is
 * `?view=queue`.
 */
const VIEWS = ['register', 'queue'] as const;

/**
 * The register's filters, beside the view, in the URL (`lib/use-url-state.ts`):
 * a reload, a shared link and the back button from a voucher all come back to
 * the same slice of the register. Ids and days only — nothing here names a
 * person. The page number is `useUrlPagination`'s `?page=` / `?limit=`.
 *
 * `void` is a flag: absent, the register lists the vouchers still standing;
 * `?void=1` lists the cancelled ones among them, struck through.
 */
const PAGE_URL = {
  view: param.oneOf(VIEWS, 'register'),
  category: param.id(),
  account: param.id(),
  void: param.flag(),
  from: param.date(),
  to: param.date(),
};

/** The register's own parameters, cleared on the way to the queue, which keeps its own. */
const REGISTER_PARAMS = ['category', 'account', 'void', 'from', 'to', 'page', 'limit'] as const;
/** The queue's own parameters, cleared on the way back to the register. */
const QUEUE_PARAMS = ['status', 'page', 'limit'] as const;

/**
 * النفقات — what the municipality spent, and the «أمر صرف» behind each figure.
 *
 * Money leaves a wallet on the payment order of the head of the municipality
 * (decree 5595/1982 art. 28, 33), so the page has two halves. The register is
 * the vouchers already paid: recording is paying, there is no queue of drafts to
 * work through, and a mistake is cancelled, never edited — a cancelled voucher
 * stays in the list greyed and struck through rather than disappearing, because
 * an auditor asking what happened to PV-000012 is owed the answer, not a gap.
 * The queue (`ExpenseQueue`) is what is still waiting for an order: the
 * accountant's requests, and the urgent payments made before one (art. 35).
 *
 * The register is paged on the server and narrowed by band, wallet, status and
 * the days the money left (`from`, `to`, the municipality's calendar days). It
 * showed the newest fifty with no way past them, which made last month's
 * voucher unreachable once a busy fortnight had passed. The totals beside it
 * cover every voucher the filters match, not the page on screen.
 *
 * «سجّل نفقة» is the one action on the page. What it does depends on who presses
 * it: the manager's recording is the order, and an accountant sends a request or
 * pays urgently (`RecordExpenseForm`).
 *
 * It sits under `/finance`, so `canAccessPath` matches the `/finance` nav row by
 * prefix and the page inherits `TREASURY_READ_ROLES` (CODE-4). The server
 * enforces the same three lists.
 */
export default function ExpensesPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('finance.expenses');
  const { token, user } = useStaffSession(tenant, base);

  const canRecord = user ? hasRole(TREASURY_WORK_ROLES, user.role) : false;
  const canVoid = user ? hasRole(TREASURY_ADMIN_ROLES, user.role) : false;

  const [filters, setUrl] = useUrlState(PAGE_URL);
  const { view, category: categoryId, account: accountId, void: includeVoid, from, to } = filters;
  const [pagination, setPagination] = useUrlPagination({ defaultSize: PAGE_SIZE });
  /** A new narrowing starts again from the newest page, in the same URL write. */
  const narrow = (patch: Parameters<typeof setUrl>[0]): void => setUrl(patch, { clear: ['page'] });
  const filtered = Boolean(categoryId || accountId || includeVoid || from || to);

  const [voiding, setVoiding] = useState<ExpenseVoucherView | null>(null);
  const [regularizing, setRegularizing] = useState<ExpenseVoucherView | null>(null);

  const overview = useStaffQuery({
    queryKey: ['treasury', tenant, 'overview'],
    queryFn: (accessToken, signal) => getTreasuryOverview(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });

  const categories = useStaffQuery({
    queryKey: ['treasury', tenant, 'expense-categories'],
    queryFn: (accessToken, signal) => getExpenseCategories(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    reference: true,
    errorMessage: t('categoriesLoadError'),
  });

  const list = useStaffQuery({
    queryKey: [
      'treasury',
      tenant,
      'expenses',
      categoryId,
      accountId,
      includeVoid,
      from,
      to,
      pagination.pageIndex,
      pagination.pageSize,
    ],
    queryFn: (accessToken, signal) =>
      getExpenses(
        tenant,
        accessToken,
        {
          categoryId: categoryId || undefined,
          accountId: accountId || undefined,
          includeVoid,
          from: from || undefined,
          to: to || undefined,
          // The server counts pages from 1; the table counts from 0.
          page: pagination.pageIndex + 1,
          pageSize: pagination.pageSize,
        },
        signal,
      ),
    tenant,
    base,
    // Read only while the register is the view on screen: the queue reads its own lists.
    token: view === 'register' ? token : null,
    keepPrevious: true,
    errorMessage: t('loadError'),
  });

  const accounts = overview.data?.accounts ?? [];
  const total = list.data?.total ?? 0;
  const sideReadFailed = overview.error ?? categories.error;
  const retrySideReads = (): void => {
    if (overview.error) overview.refetch();
    if (categories.error) categories.refetch();
  };
  /** What is waiting for the manager's order: requests, and urgent payments paid before one. */
  const waiting = (overview.data?.pendingExpenseRequests ?? 0) + (overview.data?.vouchersAwaitingOrder ?? 0);
  const tableLabels = useTableLabels({
    empty: filtered ? t('emptyFiltered') : t('empty'),
    emptyHint: filtered ? t('emptyFilteredHint') : t('emptyHint'),
    loadError: t('loadError'),
  });

  const columns = useMemo<ColumnDef<ExpenseVoucherView>[]>(
    () => [
      {
        id: 'voucher',
        header: t('columns.voucher'),
        meta: { mobile: 'primary' },
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {/* A voucher number is a code: `font-mono`, Latin, left to right (BAN-9, RTL-2). */}
              <span dir="ltr" className="font-mono text-xs font-medium">
                {row.original.voucherNumber}
              </span>
              {row.original.status === 'VOID' ? (
                <Badge variant="soft-warning">{t('cancelled')}</Badge>
              ) : row.original.orderStatus === 'AWAITING_ORDER' ? (
                <Badge variant="soft-warning">{t('awaitingBadge')}</Badge>
              ) : null}
            </div>
            <p className="truncate font-medium text-foreground">{row.original.payee}</p>
            <p className="truncate text-xs text-muted-foreground">{row.original.description}</p>
            {/*
              The order is the legal basis of the payment, so the register says
              whose it is and when — or, for an urgent payment still waiting,
              why it was paid first. Quiet, because it is on every row.
            */}
            {row.original.orderStatus === 'AWAITING_ORDER' && row.original.urgentReason ? (
              <p className="text-xs text-muted-foreground">{t('urgentLine', { reason: row.original.urgentReason })}</p>
            ) : null}
            {row.original.orderStatus === 'ORDERED' && row.original.orderedAt ? (
              <p className="text-xs text-muted-foreground">
                {t('orderedLine', {
                  hasName: row.original.orderedByName ? 'yes' : 'no',
                  name: row.original.orderedByName ?? '',
                  date: formatDate(row.original.orderedAt),
                })}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'category',
        header: t('columns.category'),
        cell: ({ row }) => <span className="text-sm">{row.original.category.name}</span>,
      },
      {
        id: 'account',
        header: t('columns.account'),
        cell: ({ row }) => <span className="text-sm">{row.original.account.name}</span>,
      },
      {
        id: 'date',
        header: t('columns.date'),
        cell: ({ row }) => <span className="tabular-nums">{formatDate(row.original.occurredAt)}</span>,
      },
      {
        id: 'amount',
        header: t('columns.amount'),
        meta: { align: 'end' },
        cell: ({ row }) => (
          <TreasuryAmount
            amount={row.original.amount}
            currency={row.original.currency}
            locale={locale}
            /*
              A cancelled voucher moved no money in the end, so its figure is
              struck through as well as dimmed: the strike is the signal that
              survives a greyscale screen and a printout (COL-3).
            */
            className={cn(
              'font-semibold',
              row.original.status === 'VOID' && 'text-muted-foreground line-through',
            )}
          />
        ),
      },
      {
        id: 'actions',
        header: t('columns.actions'),
        enableSorting: false,
        meta: { align: 'end', mobile: 'actions' },
        cell: ({ row }) => {
          const voucher = row.original;
          const regularizes = mayRegularize(voucher, user);
          const voids = canVoid && voucher.status === 'RECORDED';
          if (!regularizes && !voids) return null;
          return (
            <div className="flex flex-wrap items-center justify-end gap-2 max-sm:w-full">
              {regularizes ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="max-sm:flex-1"
                  aria-label={t('queue.urgent.regularizeFor', { number: voucher.voucherNumber })}
                  onClick={() => setRegularizing(voucher)}
                >
                  {t('queue.urgent.regularize')}
                </Button>
              ) : null}
              {voids ? (
                // Named for its voucher: a column of «إلغاء» buttons says nothing about which one (DES-1, A11Y-2).
                <Button
                  variant="ghost"
                  size="sm"
                  className="max-sm:flex-1"
                  aria-label={t('voidFor', { number: voucher.voucherNumber })}
                  onClick={() => setVoiding(voucher)}
                >
                  <Ban className="size-4" aria-hidden />
                  {t('void')}
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [t, locale, canVoid, user],
  );

  const totals = list.data?.totals ?? [];

  /* «المصروف بالليرة», not «المصروف بـ LBP»: a sentence, not a code glued to a preposition (TXT-5). */
  const spentLabel = (currency: string): string =>
    currency === 'LBP' ? t('spentInLBP') : currency === 'USD' ? t('spentInUSD') : t('spentInOther', { currency });

  const pickerLocale = locale === 'en' ? 'en' : 'ar';

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/finance`} label={t('back')} />

      <PageHeader
        icon={Receipt}
        title={t('title')}
        actions={
          canRecord && overview.data?.active ? (
            <Button asChild>
              <Link href={`${base}/finance/expenses/new`}>
                <Plus className="size-4" aria-hidden />
                {t('record')}
              </Link>
            </Button>
          ) : undefined
        }
      />

      {overview.data && !overview.data.active ? (
        <Alert variant="warning" title={t('notActiveTitle')}>
          {t('notActiveBody')}
        </Alert>
      ) : null}

      {/*
        The wallets and the bands are side reads, but «سجّل نفقة» and two of the
        filters hang on them: when one fails, the page says so and offers the
        retry rather than quietly showing less.
      */}
      {sideReadFailed ? (
        <RefreshFailedAlert title={t('partialLoad')} message={sideReadFailed} onRetry={retrySideReads} />
      ) : null}

      <SegmentedControl
        className="sm:inline-flex sm:w-auto"
        fullWidth={false}
        value={view}
        // Each view's filters and page belong to it: leaving one takes them out of the address.
        onChange={(next) =>
          setUrl(
            { view: next as (typeof VIEWS)[number] },
            { clear: next === 'queue' ? REGISTER_PARAMS : QUEUE_PARAMS },
          )
        }
        aria-label={t('views.aria')}
        options={[
          { value: 'register', label: t('views.register') },
          { value: 'queue', label: t('views.queue', { count: waiting }) },
        ]}
      />

      {view === 'queue' ? (
        <ExpenseQueue tenant={tenant} base={base} token={token} locale={locale} actor={user} />
      ) : (
        <>
          {/* A re-read that failed with rows on screen keeps them, and says so. */}
          {list.error && list.data ? <RefreshFailedAlert message={list.error} onRetry={list.refetch} /> : null}

          {list.data && totals.length > 0 ? (
            <StatStrip>
              {totals.map((sum) => (
                <StatItem
                  key={sum.currency}
                  label={spentLabel(sum.currency)}
                  value={<TreasuryAmount amount={sum.amount} currency={sum.currency} locale={locale} wrap />}
                />
              ))}
              <StatItem label={t('voucherCount')} value={String(total)} />
            </StatStrip>
          ) : null}

          {/*
            The table keeps its filter bar when a read fails (`error`, `onRetry`):
            a bad range is one of the things that fails it, and the way out is to
            change it.
          */}
          <DataTable
            columns={columns}
            data={list.data?.vouchers ?? []}
            labels={tableLabels}
            getRowId={(voucher) => voucher.id}
            searchable={false}
            sortable={false}
            manualPagination
            manualFiltering
            pageCount={Math.max(Math.ceil(total / pagination.pageSize), 1)}
            totalRowCount={total}
            pagination={pagination}
            onPaginationChange={setPagination}
            loading={list.loading}
            error={list.data ? null : list.error}
            onRetry={list.refetch}
            emptyIcon={<Receipt className="size-10 text-muted-foreground/60" />}
            filterBar={
              <div className="flex flex-wrap items-center gap-2">
                <FilterSelect
                  label={t('filters.category')}
                  value={categoryId}
                  onChange={(value) => narrow({ category: value })}
                  allLabel={t('filters.allCategories')}
                  options={(categories.data ?? []).map((category) => ({
                    value: category.id,
                    label: category.name,
                  }))}
                />
                <FilterSelect
                  label={t('filters.account')}
                  value={accountId}
                  onChange={(value) => narrow({ account: value })}
                  allLabel={t('filters.allAccounts')}
                  options={accounts.map((account) => ({ value: account.id, label: account.name }))}
                />
                <FilterSelect
                  label={t('filters.status')}
                  value={includeVoid ? 'all' : ''}
                  onChange={(value) => narrow({ void: value === 'all' })}
                  allLabel={t('filters.recordedOnly')}
                  options={[{ value: 'all', label: t('filters.includeCancelled') }]}
                />
                {/* The days the money left, on the municipality's calendar: the server reads `to` to its last minute. */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="shrink-0 text-xs text-muted-foreground">{t('filters.paidOn')}</span>
                  <DatePicker
                    id="expenses-from"
                    value={from}
                    onChange={(value) => narrow({ from: value })}
                    max={to || undefined}
                    placeholder={t('filters.from')}
                    locale={pickerLocale}
                  />
                  <DatePicker
                    id="expenses-to"
                    value={to}
                    onChange={(value) => narrow({ to: value })}
                    min={from || undefined}
                    placeholder={t('filters.to')}
                    locale={pickerLocale}
                  />
                </div>
                {filtered ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 gap-1.5 text-xs"
                    onClick={() => narrow({ category: '', account: '', void: false, from: '', to: '' })}
                  >
                    <X className="size-3.5" aria-hidden />
                    {t('filters.clear')}
                  </Button>
                ) : null}
              </div>
            }
          />
        </>
      )}

      {voiding && token ? (
        <VoidExpenseDialog
          tenant={tenant}
          token={token}
          voucher={voiding}
          onDone={() => setVoiding(null)}
          onCancel={() => setVoiding(null)}
        />
      ) : null}
      {regularizing && token ? (
        <RegularizeExpenseDialog
          tenant={tenant}
          token={token}
          locale={locale}
          voucher={regularizing}
          onDone={() => setRegularizing(null)}
          onCancel={() => setRegularizing(null)}
        />
      ) : null}
    </div>
  );
}

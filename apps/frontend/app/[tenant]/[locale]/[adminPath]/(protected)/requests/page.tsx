'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { Eye, FileCheck, Plus, Tags } from 'lucide-react';
import {
  getLabels,
  REQUEST_CHANNEL,
  REQUEST_STATUS,
  REQUEST_TYPE,
  type RequestChannel,
  type RequestStatus,
  type RequestType,
} from '@mechanization/shared-schemas';
import { formatDate } from '@/lib/dates';
import { requestStatusTone } from '@/lib/request-status';
import { getRequestQueue, type CitizenRequestListItem } from '@/lib/requests-api';
import { hasRole, REQUEST_HANDLE_ROLES } from '@/lib/staff-roles';
import { applyUrlPatch, toSearch, type UrlValues } from '@/lib/url-state';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { param, useTabSearch, useUrlPagination, useUrlState } from '@/lib/use-url-state';
import { RequestSheet } from '@/components/admin/requests/request-sheet';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CellTag } from '@/components/ui/cell-tag';
import { DataTable } from '@/components/ui/data-table';
import { FilterSelect } from '@/components/ui/filter-controls';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { ChipGroup } from '@/components/ui/segmented-control';

/**
 * The queue's state, in the URL: a reload, a shared link and the back button
 * come back to the same slice, with the same request open. Enums and an id only
 * — the search term can hold a name and lives in tab storage.
 */
const PAGE_URL = {
  status: param.oneOf(['', ...REQUEST_STATUS] as const, ''),
  channel: param.oneOf(['', ...REQUEST_CHANNEL] as const, ''),
  type: param.oneOf(['', ...REQUEST_TYPE] as const, ''),
  /** The request open in the panel — what the counter page's «عرض الطلب» links to. */
  request: param.id(),
};
type PageUrl = UrlValues<typeof PAGE_URL>;

/**
 * «طلبات المعاملات» — what citizens ask the municipality for, online or at the
 * counter, newest first (docs/municipal-requests-plan.md). A line opens the
 * request in a side panel (`RequestSheet`) where the clerk takes its fee,
 * approves it with what the paper certifies, rejects it, prints it and hands it
 * over.
 *
 * Reading is `REQUEST_READ_ROLES` (its nav row and `CitizenRequestsController`):
 * not «مشاهد فقط», because the papers are identity copies. Filing at the counter
 * and every decision are `REQUEST_HANDLE_ROLES`, offered here by `hasRole` and
 * enforced by the server (CODE-4).
 *
 * Opening a request is pushed onto history, so the browser's back button closes
 * the panel as its own close control does; one opened by its address closes
 * back to the queue — the pattern of «الحركات المالية».
 */
export default function RequestsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('requests.queue');
  const labels = getLabels(locale);
  const { token, user } = useStaffSession(tenant, base);
  const canHandle = user ? hasRole(REQUEST_HANDLE_ROLES, user.role) : false;

  const [url, setUrl] = useUrlState(PAGE_URL);
  const [pagination, setPagination] = useUrlPagination({ defaultSize: 25 });
  const [search, setSearch] = useTabSearch(tenant, 'requests');
  /** A new narrowing starts again from the first page, in the same URL write. */
  const narrow = (patch: Partial<PageUrl>) => setUrl(patch, { clear: ['page'] });

  const query = useStaffQuery({
    queryKey: ['requests', tenant, 'queue', url.status, url.channel, url.type, search, pagination.pageIndex, pagination.pageSize],
    queryFn: (accessToken, signal) =>
      getRequestQueue(
        tenant,
        accessToken,
        {
          status: url.status || undefined,
          channel: url.channel || undefined,
          type: url.type || undefined,
          search: search || undefined,
          // The server counts pages from 1; the URL's page is 1-based and the state 0-based.
          page: pagination.pageIndex + 1,
          pageSize: pagination.pageSize,
        },
        signal,
      ),
    tenant,
    base,
    token,
    keepPrevious: true,
    errorMessage: t('loadError'),
  });
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  // ── the panel ────────────────────────────────────────────────────────────────

  /** The panel was opened from a line, onto history: closing it steps back. */
  const pushed = useRef(false);
  useEffect(() => {
    const onPop = () => {
      pushed.current = false;
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const openRequest = useCallback((id: string) => {
    const current = new URLSearchParams(window.location.search);
    const href = `${window.location.pathname}${toSearch(applyUrlPatch(current, PAGE_URL, { request: id }))}`;
    if (current.get('request')) {
      window.history.replaceState(null, '', href);
    } else {
      window.history.pushState(null, '', href);
      pushed.current = true;
    }
  }, []);

  const closeRequest = () => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
      return;
    }
    setUrl({ request: '' });
  };

  /** The request the panel last showed, kept so it slides out with its content. */
  const [lastShown, setLastShown] = useState<string | null>(null);
  useEffect(() => {
    if (url.request) setLastShown(url.request);
  }, [url.request]);
  const shown = url.request || lastShown;

  // ── the table ────────────────────────────────────────────────────────────────

  const tableLabels = useTableLabels({
    loadError: t('loadError'),
    searchPlaceholder: t('searchPlaceholder'),
    empty: url.status || url.channel || url.type || search ? t('emptyFiltered') : t('empty'),
    emptyHint: url.status || url.channel || url.type || search ? t('emptyFilteredHint') : t('emptyHint'),
  });

  const columns = useMemo<ColumnDef<CitizenRequestListItem>[]>(
    () => [
      {
        id: 'number',
        header: t('columns.number'),
        meta: { mobile: 'primary' },
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <bdi dir="ltr" className="block font-mono text-xs font-medium">
              {row.original.requestNumber}
            </bdi>
            <span className="block truncate text-sm font-medium">{labels.requestType[row.original.requestType]}</span>
          </div>
        ),
      },
      {
        id: 'citizen',
        header: t('columns.citizen'),
        cell: ({ row }) => (
          <span className="block max-w-56 truncate text-sm" title={row.original.citizenName}>
            {row.original.citizenName}
          </span>
        ),
      },
      {
        id: 'property',
        header: t('columns.property'),
        cell: ({ row }) =>
          row.original.propertyNumber ? (
            <CellTag className="font-mono" dir="ltr">
              {row.original.propertyNumber}
            </CellTag>
          ) : (
            <CellTag tone="muted">—</CellTag>
          ),
      },
      {
        id: 'fee',
        header: t('columns.fee'),
        cell: ({ row }) =>
          // Null: never billed and never will be (closed, or past review without a fee).
          row.original.fee === null ? (
            <CellTag tone="muted">—</CellTag>
          ) : row.original.fee > 0 ? (
            <div className="space-y-0.5">
              <Money amount={row.original.fee} locale={locale} className="text-sm" />
              <CellTag
                tone={row.original.billStatus === 'PAID' ? 'success' : row.original.billStatus ? 'warning' : 'muted'}
                className="block text-xs"
              >
                {row.original.billStatus ? labels.paymentStatus[row.original.billStatus] : t('noBill')}
              </CellTag>
            </div>
          ) : (
            <CellTag tone="muted">{t('free')}</CellTag>
          ),
      },
      {
        id: 'status',
        header: t('columns.status'),
        cell: ({ row }) => (
          <CellTag tone={requestStatusTone(row.original.status)}>{labels.requestStatus[row.original.status]}</CellTag>
        ),
      },
      {
        id: 'channel',
        header: t('columns.channel'),
        meta: { mobile: 'hide' },
        cell: ({ row }) => <CellTag tone="muted">{labels.requestChannel[row.original.channel]}</CellTag>,
      },
      {
        id: 'date',
        header: t('columns.date'),
        cell: ({ row }) => <span className="whitespace-nowrap text-sm tabular-nums">{formatDate(row.original.createdAt)}</span>,
      },
      {
        id: 'actions',
        header: t('columns.actions'),
        enableSorting: false,
        meta: { align: 'end', mobile: 'actions' },
        cell: ({ row }) => (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs max-sm:w-full"
            aria-label={t('openOf', { number: row.original.requestNumber })}
            onClick={() => openRequest(row.original.id)}
          >
            <Eye className="size-3.5" aria-hidden />
            {t('open')}
          </Button>
        ),
      },
    ],
    [t, labels, locale, openRequest],
  );

  const activeFilters = [url.channel, url.type].filter(Boolean).length;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={FileCheck}
        title={t('title')}
        actions={
          <>
            <Button asChild variant="outline">
              <Link href={`${base}/requests/types`}>
                <Tags className="size-4" aria-hidden />
                {t('types')}
              </Link>
            </Button>
            {canHandle ? (
              <Button asChild>
                <Link href={`${base}/requests/new`}>
                  <Plus className="size-4" aria-hidden />
                  {t('new')}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <ChipGroup
        size="sm"
        aria-label={t('statusFilter')}
        value={url.status}
        onChange={(value) => narrow({ status: value as RequestStatus | '' })}
        options={[
          { value: '', label: t('allStatuses') },
          ...REQUEST_STATUS.map((status) => ({ value: status, label: labels.requestStatus[status] })),
        ]}
      />

      <Card className="overflow-hidden">
        <CardHeader className="border-b px-4 py-3.5 sm:px-6">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <FileCheck className="size-5 text-primary" aria-hidden />
            {url.status ? labels.requestStatus[url.status] : t('allRequests')}
            {query.data ? <span className="text-sm font-normal tabular-nums text-muted-foreground">({total})</span> : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            className="rounded-none border-0 shadow-none"
            columns={columns}
            data={items}
            labels={tableLabels}
            getRowId={(row) => row.id}
            loading={query.loading}
            error={query.error}
            onRetry={query.refetch}
            emptyIcon={<FileCheck className="size-10 text-muted-foreground/60" />}
            manualPagination
            manualFiltering
            sortable={false}
            pageCount={Math.max(Math.ceil(total / pagination.pageSize), 1)}
            totalRowCount={total}
            pagination={pagination}
            onPaginationChange={setPagination}
            searchValue={search}
            onSearchChange={(term) => {
              setSearch(term);
              setPagination((current) => (current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }));
            }}
            activeFiltersCount={activeFilters}
            onClearFilters={() => narrow({ channel: '', type: '' })}
            filterBar={
              <div className="flex flex-wrap items-center gap-2">
                <FilterSelect
                  label={t('filters.type')}
                  value={url.type}
                  onChange={(value) => narrow({ type: value as RequestType | '' })}
                  allLabel={t('filters.allTypes')}
                  options={REQUEST_TYPE.map((value) => ({ value, label: labels.requestType[value] }))}
                />
                <FilterSelect
                  label={t('filters.channel')}
                  value={url.channel}
                  onChange={(value) => narrow({ channel: value as RequestChannel | '' })}
                  allLabel={t('filters.allChannels')}
                  options={REQUEST_CHANNEL.map((value) => ({ value, label: labels.requestChannel[value] }))}
                />
              </div>
            }
          />
        </CardContent>
      </Card>

      {shown ? (
        <RequestSheet
          key={shown}
          open={Boolean(url.request)}
          onClose={closeRequest}
          tenant={tenant}
          base={base}
          token={token}
          locale={locale}
          role={user?.role}
          requestId={shown}
        />
      ) : null}
    </div>
  );
}

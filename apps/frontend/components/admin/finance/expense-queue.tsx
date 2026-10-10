'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, ClipboardCheck, Zap } from 'lucide-react';
import { EXPENSE_REQUEST_STATUSES } from '@mechanization/shared-schemas';
import {
  getExpenseRequests,
  getExpenses,
  type ExpenseRequestStatus,
  type ExpenseRequestView,
  type ExpenseVoucherView,
} from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import {
  mayDecideRequest,
  mayRegularize,
  mayWithdrawRequest,
  type OrderActor,
} from '@/lib/expense-order';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useTableLabels } from '@/lib/use-table-labels';
import { param, useUrlPagination, useUrlState } from '@/lib/use-url-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CellTag } from '@/components/ui/cell-tag';
import { DataTable } from '@/components/ui/data-table';
import { FilterSelect } from '@/components/ui/filter-controls';
import {
  OrderRequestDialog,
  RegularizeExpenseDialog,
  RejectRequestDialog,
  VoidExpenseDialog,
  WithdrawRequestDialog,
} from './expense-dialogs';
import { TreasuryAmount } from './treasury-amount';

/** Urgent payments listed at once. A queue this long is a manager who has stopped regularising, and the page says so. */
const URGENT_LIMIT = 50;

/** Which decision the requests table shows, in the URL: a link to «المرفوضة» is a link to that list. */
const QUEUE_URL = { status: param.oneOf(EXPENSE_REQUEST_STATUSES, 'PENDING') };

/** The decisions the status filter can show besides the default, the requests still waiting. */
const DECIDED = EXPENSE_REQUEST_STATUSES.filter((status) => status !== 'PENDING') as Array<
  Exclude<ExpenseRequestStatus, 'PENDING'>
>;

/**
 * «بانتظار أمر الصرف» — what the manager has to decide, and what he has yet to
 * regularise.
 *
 * Two lists, because they are two different debts:
 *
 * - **Requests** an accountant prepared. Nothing has left a wallet; the manager
 *   orders one (the money leaves, on a voucher that carries his order) or
 *   rejects it with a reason. Its author can withdraw it while it waits. The
 *   status filter reads the decided ones back — ordered, rejected with the
 *   reason, withdrawn — so a rejection is not something an accountant has to
 *   ask about.
 * - **Urgent payments** an accountant made first (decree 5595/1982 art. 35:
 *   salaries, routine petty expenses, an emergency). The money has moved; the
 *   manager issues the order after the fact, or cancels the voucher, which
 *   returns the money.
 *
 * Everyone who reads the treasury reads both lists. Which buttons a row offers
 * comes from `lib/expense-order.ts`, which mirrors the controller's `@Roles` and
 * the service's own rules, so a role is never shown a control that can only fail
 * (CODE-4). The requests list is paged on the server and its page and status are
 * in the URL.
 */
export function ExpenseQueue({
  tenant,
  base,
  token,
  locale,
  actor,
}: {
  tenant: string;
  /** `/{tenant}/{locale}/{adminPath}` — what a dead session redirects from. */
  base: string;
  token: string | null;
  locale: string;
  actor: OrderActor | null;
}): React.JSX.Element {
  const t = useTranslations('finance.expenses.queue');
  const tx = useTranslations('finance.expenses');

  const [{ status }, setUrl] = useUrlState(QUEUE_URL);
  const [pagination, setPagination] = useUrlPagination({ defaultSize: 10 });
  const narrow = (next: ExpenseRequestStatus): void => setUrl({ status: next }, { clear: ['page'] });

  const requests = useStaffQuery({
    queryKey: ['treasury', tenant, 'expense-requests', status, pagination.pageIndex, pagination.pageSize],
    queryFn: (accessToken, signal) =>
      getExpenseRequests(
        tenant,
        accessToken,
        // The server counts pages from 1; the table and the URL's `?page=` count from 0 and 1 respectively.
        { status, page: pagination.pageIndex + 1, pageSize: pagination.pageSize },
        signal,
      ),
    tenant,
    base,
    token,
    keepPrevious: true,
    errorMessage: t('requests.loadError'),
  });

  const urgent = useStaffQuery({
    queryKey: ['treasury', tenant, 'expenses-awaiting-order'],
    queryFn: (accessToken, signal) =>
      getExpenses(tenant, accessToken, { awaitingOrder: true, pageSize: URGENT_LIMIT }, signal),
    tenant,
    base,
    token,
    errorMessage: t('urgent.loadError'),
  });

  const [ordering, setOrdering] = useState<ExpenseRequestView | null>(null);
  const [rejecting, setRejecting] = useState<ExpenseRequestView | null>(null);
  const [withdrawing, setWithdrawing] = useState<ExpenseRequestView | null>(null);
  const [regularizing, setRegularizing] = useState<ExpenseVoucherView | null>(null);
  const [voiding, setVoiding] = useState<ExpenseVoucherView | null>(null);

  const requestTotal = requests.data?.total ?? 0;
  const vouchers = urgent.data?.vouchers ?? [];
  const urgentTotal = urgent.data?.total ?? 0;

  const requestLabels = useTableLabels({
    empty: status === 'PENDING' ? t('requests.empty') : t('requests.emptyDecided'),
    emptyHint: status === 'PENDING' ? t('requests.emptyHint') : t('requests.emptyDecidedHint'),
    loadError: t('requests.loadError'),
  });
  const urgentLabels = useTableLabels({
    empty: t('urgent.empty'),
    emptyHint: t('urgent.emptyHint'),
    loadError: t('urgent.loadError'),
  });

  const requestColumns = useMemo<ColumnDef<ExpenseRequestView>[]>(
    () => [
      {
        id: 'request',
        header: t('requests.columns.request'),
        meta: { mobile: 'primary' },
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <p className="truncate font-medium text-foreground" title={row.original.payee}>
              {row.original.payee}
            </p>
            <p className="truncate text-xs text-muted-foreground" title={row.original.description}>
              {row.original.description}
            </p>
          </div>
        ),
      },
      {
        id: 'category',
        header: tx('columns.category'),
        cell: ({ row }) => <span className="text-sm">{row.original.category.name}</span>,
      },
      {
        id: 'account',
        header: tx('columns.account'),
        cell: ({ row }) => <span className="text-sm">{row.original.account.name}</span>,
      },
      {
        id: 'requestedBy',
        header: t('requests.columns.requestedBy'),
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <p className="truncate text-sm">{row.original.requestedByName ?? '—'}</p>
            <p className="text-xs tabular-nums text-muted-foreground">{formatDate(row.original.createdAt)}</p>
          </div>
        ),
      },
      {
        id: 'amount',
        header: tx('columns.amount'),
        meta: { align: 'end' },
        cell: ({ row }) => (
          <TreasuryAmount
            amount={row.original.amount}
            currency={row.original.currency}
            locale={locale}
            className="font-semibold"
          />
        ),
      },
      // Only a decided list has decisions to read; the waiting one has the buttons instead.
      ...(status === 'PENDING'
        ? []
        : ([
            {
              id: 'decision',
              header: t('requests.columns.decision'),
              cell: ({ row }) => {
                const request = row.original;
                if (request.status === 'PENDING') return null;
                return (
                  <div className="min-w-0 space-y-0.5">
                    <CellTag
                      tone={
                        request.status === 'ORDERED' ? 'success' : request.status === 'REJECTED' ? 'destructive' : 'muted'
                      }
                    >
                      {t(`requests.decision.${request.status}`)}
                    </CellTag>
                    <p className="text-xs text-muted-foreground">
                      {t('requests.decisionWhen', {
                        name: request.decidedByName ?? '—',
                        date: request.decidedAt ? formatDate(request.decidedAt) : '—',
                      })}
                    </p>
                    {request.status === 'REJECTED' && request.decisionReason ? (
                      <p className="text-xs text-foreground">
                        {t('requests.reasonLine', { reason: request.decisionReason })}
                      </p>
                    ) : null}
                    {request.status === 'ORDERED' && request.voucherNumber ? (
                      <p className="text-xs text-muted-foreground">
                        {t('requests.voucherLabel')}{' '}
                        <bdi dir="ltr" className="font-mono">
                          {request.voucherNumber}
                        </bdi>
                      </p>
                    ) : null}
                  </div>
                );
              },
            },
          ] satisfies ColumnDef<ExpenseRequestView>[])),
      {
        id: 'actions',
        header: tx('columns.actions'),
        enableSorting: false,
        meta: { align: 'end', mobile: 'actions' },
        cell: ({ row }) => {
          const request = row.original;
          const decides = mayDecideRequest(request, actor);
          const withdraws = mayWithdrawRequest(request, actor);
          if (!decides && !withdraws) return null;
          return (
            <div className="flex flex-wrap items-center justify-end gap-2 max-sm:w-full">
              {decides ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="max-sm:flex-1"
                  aria-label={t('requests.orderFor', { payee: request.payee })}
                  onClick={() => setOrdering(request)}
                >
                  {t('requests.order')}
                </Button>
              ) : null}
              {decides ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="max-sm:flex-1"
                  aria-label={t('requests.rejectFor', { payee: request.payee })}
                  onClick={() => setRejecting(request)}
                >
                  {t('requests.reject')}
                </Button>
              ) : null}
              {withdraws ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="max-sm:flex-1"
                  aria-label={t('requests.withdrawFor', { payee: request.payee })}
                  onClick={() => setWithdrawing(request)}
                >
                  {t('requests.withdraw')}
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [t, tx, locale, status, actor],
  );

  const urgentColumns = useMemo<ColumnDef<ExpenseVoucherView>[]>(
    () => [
      {
        id: 'voucher',
        header: t('urgent.columns.voucher'),
        meta: { mobile: 'primary' },
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            {/*
              A voucher number is a code: `font-mono`, Latin, left to right (BAN-9,
              RTL-2). `<bdi>` inside the block, never `dir` on the block itself — that
              would send the code to the opposite edge from the payee under it.
            */}
            <span className="block font-mono text-xs font-medium">
              <bdi dir="ltr">{row.original.voucherNumber}</bdi>
            </span>
            <p className="truncate font-medium text-foreground" title={row.original.payee}>
              {row.original.payee}
            </p>
            <p className="truncate text-xs text-muted-foreground" title={row.original.description}>
              {row.original.description}
            </p>
            {row.original.urgentReason ? (
              <p className="text-xs text-foreground">{t('urgent.reasonLine', { reason: row.original.urgentReason })}</p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'category',
        header: tx('columns.category'),
        cell: ({ row }) => <span className="text-sm">{row.original.category.name}</span>,
      },
      {
        id: 'account',
        header: tx('columns.account'),
        cell: ({ row }) => <span className="text-sm">{row.original.account.name}</span>,
      },
      {
        id: 'recordedBy',
        header: t('urgent.columns.recordedBy'),
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <p className="truncate text-sm">{row.original.recordedByName ?? '—'}</p>
            <p className="text-xs tabular-nums text-muted-foreground">{formatDate(row.original.occurredAt)}</p>
          </div>
        ),
      },
      {
        id: 'amount',
        header: tx('columns.amount'),
        meta: { align: 'end' },
        cell: ({ row }) => (
          <TreasuryAmount
            amount={row.original.amount}
            currency={row.original.currency}
            locale={locale}
            className="font-semibold"
          />
        ),
      },
      {
        id: 'actions',
        header: tx('columns.actions'),
        enableSorting: false,
        meta: { align: 'end', mobile: 'actions' },
        cell: ({ row }) => {
          const voucher = row.original;
          if (!mayRegularize(voucher, actor)) return null;
          return (
            <div className="flex flex-wrap items-center justify-end gap-2 max-sm:w-full">
              <Button
                variant="outline"
                size="sm"
                className="max-sm:flex-1"
                aria-label={t('urgent.regularizeFor', { number: voucher.voucherNumber })}
                onClick={() => setRegularizing(voucher)}
              >
                {t('urgent.regularize')}
              </Button>
              {/* The way to refuse after the fact: cancelling returns the money. Named for its voucher (DES-1, A11Y-2). */}
              <Button
                variant="ghost"
                size="sm"
                className="max-sm:flex-1"
                aria-label={tx('voidFor', { number: voucher.voucherNumber })}
                onClick={() => setVoiding(voucher)}
              >
                <Ban className="size-4" aria-hidden />
                {tx('void')}
              </Button>
            </div>
          );
        },
      },
    ],
    [t, tx, locale, actor],
  );

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeader className="border-b px-4 py-3.5 sm:px-6">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <ClipboardCheck
              className={status === 'PENDING' ? 'size-5 text-warning' : 'size-5 text-muted-foreground'}
              aria-hidden
            />
            {t('requests.title')}
            {requests.data ? (
              <span className="text-sm font-normal tabular-nums text-muted-foreground">({requestTotal})</span>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {/* One frame: the card's (BAN-4). */}
          <DataTable
            className="rounded-none border-0 shadow-none"
            columns={requestColumns}
            data={requests.data?.requests ?? []}
            labels={requestLabels}
            getRowId={(request) => request.id}
            searchable={false}
            sortable={false}
            manualPagination
            manualFiltering
            pageCount={Math.max(Math.ceil(requestTotal / pagination.pageSize), 1)}
            totalRowCount={requestTotal}
            pagination={pagination}
            onPaginationChange={setPagination}
            loading={requests.loading}
            error={requests.error}
            onRetry={requests.refetch}
            emptyIcon={<ClipboardCheck className="size-10 text-muted-foreground/60" />}
            filterBar={
              <div className="flex flex-wrap items-center gap-2">
                {/* The default is the unfiltered state, so «بانتظار أمر الصرف» takes the slot «الكل» has on other filters. */}
                <FilterSelect
                  label={t('requests.filterAria')}
                  value={status === 'PENDING' ? '' : status}
                  onChange={(next) => narrow(next || 'PENDING')}
                  allLabel={t('requests.filter.PENDING')}
                  options={DECIDED.map((decided) => ({ value: decided, label: t(`requests.filter.${decided}`) }))}
                />
              </div>
            }
          />
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="border-b px-4 py-3.5 sm:px-6">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Zap className="size-5 text-warning" aria-hidden />
            {t('urgent.title')}
            {urgent.data ? (
              <span className="text-sm font-normal tabular-nums text-muted-foreground">({urgentTotal})</span>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            className="rounded-none border-0 shadow-none"
            columns={urgentColumns}
            data={vouchers}
            labels={urgentLabels}
            getRowId={(voucher) => voucher.id}
            searchable={false}
            sortable={false}
            paginated={false}
            loading={urgent.loading}
            error={urgent.error}
            onRetry={urgent.refetch}
            emptyIcon={<Zap className="size-10 text-muted-foreground/60" />}
          />
          {urgentTotal > vouchers.length ? (
            <div className="border-t p-3 sm:px-6">
              <Alert variant="info" live="status">
                {t('urgent.truncated', { shown: vouchers.length, total: urgentTotal })}
              </Alert>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {ordering && token ? (
        <OrderRequestDialog
          tenant={tenant}
          token={token}
          locale={locale}
          request={ordering}
          onDone={() => setOrdering(null)}
          onCancel={() => setOrdering(null)}
        />
      ) : null}
      {rejecting && token ? (
        <RejectRequestDialog
          tenant={tenant}
          token={token}
          request={rejecting}
          onDone={() => setRejecting(null)}
          onCancel={() => setRejecting(null)}
        />
      ) : null}
      {withdrawing && token ? (
        <WithdrawRequestDialog
          tenant={tenant}
          token={token}
          locale={locale}
          request={withdrawing}
          onDone={() => setWithdrawing(null)}
          onCancel={() => setWithdrawing(null)}
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
      {voiding && token ? (
        <VoidExpenseDialog
          tenant={tenant}
          token={token}
          voucher={voiding}
          onDone={() => setVoiding(null)}
          onCancel={() => setVoiding(null)}
        />
      ) : null}
    </div>
  );
}

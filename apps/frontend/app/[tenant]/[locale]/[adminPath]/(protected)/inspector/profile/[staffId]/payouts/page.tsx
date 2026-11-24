'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { BadgeDollarSign, HandCoins, Printer, Receipt, RefreshCw } from 'lucide-react';
import { TREASURY_READ_ROLES, type InspectorProfileResponse } from '@mechanization/shared-schemas';
import { getInspectorProfile, getMyInspectorProfile } from '@/lib/api-client';
import { formatMoney } from '@/lib/currency';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useTableLabels } from '@/lib/use-table-labels';
import { useStaffSession } from '@/lib/use-staff-session';
import { formatDate, formatDateTime } from '@/lib/dates';
import { payoutHistory, type PayoutHistoryRow } from '@/lib/inspector-payouts';
import { readView } from '@/lib/read-view';
import { hasRole } from '@/lib/staff-roles';
import { cn } from '@/lib/utils';
import { InspectorPayoutDialog } from '@/components/admin/inspector-payout-dialog';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ActionTooltip } from '@/components/ui/tooltip';

/** One row of the history: the payout and the balance as it stood once it was made. */
type PayoutRow = PayoutHistoryRow<InspectorProfileResponse['payouts'][number]>;

/**
 * Every payout handed to one staff member, oldest question first: «what has
 * this person actually been paid, and by whom».
 *
 * A page rather than a tab because it is the thing somebody opens with a
 * paper receipt in hand, months after the fact, and a ledger you have to
 * reach through another screen's tab is a ledger nobody links to. The running
 * balance column is why: each row shows what was still owed once that payout
 * had been made, so a disputed figure can be pinned to the payment that
 * produced it.
 *
 * Commissions are counted in dollars, so every figure here is drawn as one
 * (`Money` with `currency`, PRIM-11), and the copy is `staff.commission.history`.
 */
export default function InspectorPayoutHistoryPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; staffId: string }>;
}): React.JSX.Element {
  const { tenant, locale, adminPath, staffId } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;

  const queryClient = useQueryClient();
  const t = useTranslations('staff.commission.history');
  const { token, user } = useStaffSession(tenant, base);
  const [payoutOpen, setPayoutOpen] = useState(false);

  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  /* A payment order is a treasury document: its print-out sits behind the expense register's guard. */
  const canPrintOrders = user ? hasRole(TREASURY_READ_ROLES, user.role) : false;
  /** A dollar figure inside a sentence, where a `Money` cannot go (PRIM-11). */
  const dollars = (amount: number): string => formatMoney(amount, 'USD', locale);

  /*
    The same key the dashboard uses, because it is the same response — this
    page is a second view of it. Recording a payout from either screen
    refreshes both, and arriving here from the dashboard paints from cache.
  */
  const queryKey = ['staff', tenant, 'inspector-profile', staffId] as const;

  const { data: read, loading, fetching, error, refetch } = useStaffQuery<InspectorProfileResponse>({
    queryKey,
    queryFn: (tok, signal) => {
      // See `InspectorProfileDetail`: every role can read its own figures
      // through `me/profile`, but only a SUPER_ADMIN may ask by id.
      if (staffId !== user?.id) {
        return getInspectorProfile(tenant, tok, staffId, signal);
      }
      return getMyInspectorProfile(tenant, tok, signal);
    },
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  /*
    A failed re-read keeps the page, and the payout dialog mounted on it (STA-1).
    After a payout with no answer the dialog re-reads this very key; when that
    read failed too, the page swapped itself for ErrorState and unmounted the
    dialog — the amount, the statement and the failure message — and reopened it
    empty (review of 2026-10-11).
  */
  const view = readView(read, error);
  const data = view.state === 'ready' ? view.data : undefined;

  /*
    Each payout with the balance as it stood once it was made: earned by then
    less paid by then, not today's total less the running sum. A payout whose
    voucher was cancelled stays listed and is not counted as paid, as on the
    server. Recomputed from today's records, which the note under the table
    says — see `payoutHistory`.
  */
  const rows = useMemo(
    () => (data ? payoutHistory(data.payouts, data.recentRegistrations) : []),
    [data],
  );
  const overpaid = data?.overpaidBalance ?? 0;

  /** The API already orders payouts newest-first, so this is the most recent. */
  const latestPayout = data?.payouts[0];

  const title = data ? t('title', { name: data.inspector.name }) : t('titleLoading');

  const tableLabels = useTableLabels();

  const columns = useMemo<ColumnDef<PayoutRow>[]>(
    () => [
      {
        id: 'paidOn',
        header: t('paidOn'),
        meta: { mobile: 'primary', cellClassName: 'whitespace-nowrap' },
        cell: ({ row }) => formatDateTime(row.original.payout.paidAt),
      },
      {
        /*
          `Money` isolates each figure left to right and leaves its unit in
          the page's direction, so each one sits under the heading that names
          it. The receipt number is plain text for the same reason a payout
          amount is: it is a value being read off a paper slip, not a control.
        */
        id: 'amount',
        header: t('amount'),
        meta: { cellClassName: 'whitespace-nowrap font-bold tabular-nums' },
        cell: ({ row }) => (
          <span className={cn('text-success', row.original.payout.voucher?.voided && 'text-muted-foreground line-through')}>
            <Money amount={row.original.payout.amount} currency={row.original.payout.currency} locale={locale} />
          </span>
        ),
      },
      {
        /*
          The «PV-» voucher that paid it, once the treasury is live; a payout
          from before has none. A cancelled one is struck through on the amount
          and badged here, and stays listed: it happened, and so did its
          cancellation.
        */
        id: 'order',
        header: t('order'),
        meta: { cellClassName: 'whitespace-nowrap' },
        cell: ({ row }) => {
          const { voucher } = row.original.payout;
          if (!voucher) return <span className="text-muted-foreground">—</span>;
          return (
            <div className="flex items-center gap-2">
              <span dir="ltr" className="font-mono text-xs">
                {voucher.voucherNumber}
              </span>
              {voucher.voided ? <Badge variant="soft-warning">{t('cancelled')}</Badge> : null}
              {canPrintOrders ? (
                <ActionTooltip label={t('print')}>
                  <Button asChild variant="ghost" size="icon-sm">
                    <Link
                      href={`${base}/finance/expenses/${voucher.id}/print?print=1`}
                      aria-label={t('printFor', { number: voucher.voucherNumber })}
                    >
                      <Printer className="size-4" aria-hidden />
                    </Link>
                  </Button>
                </ActionTooltip>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'receipt',
        header: t('receipt'),
        meta: { cellClassName: 'whitespace-nowrap font-mono text-xs' },
        cell: ({ row }) =>
          row.original.payout.reference ? (
            <bdi>{row.original.payout.reference}</bdi>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'recordedBy',
        header: t('recordedBy'),
        meta: { cellClassName: 'text-muted-foreground' },
        cell: ({ row }) => row.original.payout.recordedByName ?? '—',
      },
      {
        id: 'owedAfter',
        header: t('owedAfter'),
        meta: { cellClassName: 'whitespace-nowrap tabular-nums' },
        cell: ({ row }) =>
          row.original.overpaidAfter > 0 ? (
            <span className="text-warning">
              {t('overpaidAfter', { amount: formatMoney(row.original.overpaidAfter, 'USD', locale) })}
            </span>
          ) : (
            <Money amount={row.original.owedAfter} currency="USD" locale={locale} />
          ),
      },
      {
        /*
          The one cell here that is prose rather than a figure, so it opts out
          of the table's `whitespace-nowrap` — a note is written to be read, and
          nowrap would push «دفعة نقدية عن مسح حي الزهور» off the side instead
          of wrapping it.
        */
        id: 'notes',
        header: t('notes'),
        meta: { cellClassName: 'max-w-xs whitespace-normal text-muted-foreground' },
        cell: ({ row }) => row.original.payout.note ?? '—',
      },
    ],
    [t, locale, base, canPrintOrders],
  );

  if (loading || !token) {
    return (
      <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <Skeleton className="h-4 w-40" />
        <div className="flex items-center gap-3">
          <Skeleton className="size-11 rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-64" />
            <Skeleton className="h-4 w-96" />
          </div>
        </div>
        <Skeleton className="h-36 rounded-lg sm:h-20" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={`${base}/inspector/profile`} label={t('back')} />

      <PageHeader
        icon={Receipt}
        title={title}
        actions={
          <div className="flex items-center gap-2">
            {data ? (
              <Button asChild variant="outline" size="sm" className="gap-1.5">
                <Link href={`${base}/inspector/profile/${data.inspector.id}`}>
                  <BadgeDollarSign className="size-4" aria-hidden />
                  {t('dashboard')}
                </Link>
              </Button>
            ) : null}

            {isSuperAdmin && data ? (
              <Button
                size="sm"
                className="gap-1.5 bg-success text-success-foreground hover:bg-success/90"
                onClick={() => setPayoutOpen(true)}
              >
                <HandCoins className="size-4" aria-hidden />
                {t('pay')}
              </Button>
            ) : null}

            <ActionTooltip label={t('refresh')}>
              <Button variant="outline" size="icon-sm" disabled={fetching} onClick={() => refetch()}>
                <RefreshCw className={`size-4 ${fetching ? 'animate-spin' : ''}`} aria-hidden />
                <span className="sr-only">{t('refresh')}</span>
              </Button>
            </ActionTooltip>
          </div>
        }
      />

      {view.state !== 'ready' || !data ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState
              description={view.state === 'failed' ? view.error : t('notFound')}
              onRetry={() => refetch()}
              retryLabel={t('retry')}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          {view.refreshFailed ? <RefreshFailedAlert message={view.refreshFailed} onRetry={() => refetch()} /> : null}

          {/* PRIM-20: the kit's strip, each sum with `wrap` so its unit drops under it at 360px. */}
          <StatStrip>
            <StatItem
              label={t('totalEarned')}
              value={<Money amount={data.totalEarnings} currency="USD" locale={locale} wrap />}
              hint={t('billableUnits', { count: data.totalProperties })}
            />
            <StatItem
              label={t('totalPaid')}
              value={<Money amount={data.paidBalance} currency="USD" locale={locale} wrap />}
            />
            <StatItem
              label={t('payoutCount')}
              value={data.payouts.length.toLocaleString('en-US')}
              hint={latestPayout ? t('latest', { date: formatDate(latestPayout.paidAt) }) : undefined}
            />
            {/* Two balances, never both, as on the inspector's dashboard: `pendingBalance` clamps at zero. */}
            {overpaid > 0 ? (
              <StatItem
                label={t('overpaid')}
                value={<Money amount={overpaid} currency="USD" locale={locale} wrap />}
                className="text-warning"
              />
            ) : (
              <StatItem
                label={t('stillOwed')}
                value={<Money amount={data.pendingBalance} currency="USD" locale={locale} wrap />}
                className="text-warning"
              />
            )}
          </StatStrip>

          <Card className="overflow-hidden border-border/70">
            <CardContent className="p-0">
              {rows.length === 0 ? (
                <EmptyState
                  icon={Receipt}
                  title={t('emptyTitle')}
                  description={t('emptyBody', {
                    name: data.inspector.name,
                    amount: dollars(data.pendingBalance),
                  })}
                  action={
                    isSuperAdmin ? (
                      <Button
                        size="sm"
                        className="gap-1.5 bg-success text-success-foreground hover:bg-success/90"
                        onClick={() => setPayoutOpen(true)}
                      >
                        <HandCoins className="size-4" aria-hidden />
                        {t('payFirst')}
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                /*
                  One frame: the card's, around a borderless table (BAN-4). Seven
                  columns do not fit a phone, so below `sm` each payout is a card
                  (`meta.mobile`) and no column is clipped or scrolled sideways.
                */
                <DataTable
                  className="rounded-none border-0 shadow-none"
                  columns={columns}
                  data={rows}
                  labels={tableLabels}
                  getRowId={(row) => row.payout.id}
                  searchable={false}
                  sortable={false}
                  paginated={false}
                />
              )}
            </CardContent>
          </Card>

          {/*
            Each row's balance is worked out on the page from today's records
            (`payoutHistory`), and a reader settling a dispute from it must know that.
          */}
          {rows.length > 0 ? <p className="text-xs text-muted-foreground">{t('recomputed')}</p> : null}

          <InspectorPayoutDialog
            open={payoutOpen}
            onOpenChange={setPayoutOpen}
            tenant={tenant}
            base={base}
            token={token}
            locale={locale}
            staff={{ id: data.inspector.id, name: data.inspector.name }}
            onRecorded={async () => {
              await Promise.all([
                queryClient.invalidateQueries({ queryKey }),
                queryClient.invalidateQueries({ queryKey: ['staff', tenant] }),
              ]);
            }}
          />
        </>
      )}
    </div>
  );
}

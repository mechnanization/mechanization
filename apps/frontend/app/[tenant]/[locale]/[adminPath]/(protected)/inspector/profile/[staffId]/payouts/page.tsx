'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import {
  BadgeDollarSign,
  Clock,
  HandCoins,
  Receipt,
  RefreshCw,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import type { InspectorProfileResponse } from '@mechanization/shared-schemas';
import { getInspectorProfile, getMyInspectorProfile } from '@/lib/api-client';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { formatDate, formatDateTime } from '@/lib/dates';
import { InspectorPayoutDialog } from '@/components/admin/inspector-payout-dialog';
import { BackLink } from '@/components/ui/back-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ActionTooltip } from '@/components/ui/tooltip';

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
 */
export default function InspectorPayoutHistoryPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; staffId: string }>;
}): React.JSX.Element {
  const { tenant, locale, adminPath, staffId } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const isAr = locale !== 'en';

  const queryClient = useQueryClient();
  const { token, user } = useStaffSession(tenant, base);
  const [payoutOpen, setPayoutOpen] = useState(false);

  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const money = (value: number): string =>
    value.toLocaleString(locale === 'en' ? 'en-US' : 'en-GB', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  /*
    The same key the dashboard uses, because it is the same response — this
    page is a second view of it. Recording a payout from either screen
    refreshes both, and arriving here from the dashboard paints from cache.
  */
  const queryKey = ['staff', tenant, 'inspector-profile', staffId] as const;

  const { data, loading, fetching, error, refetch } = useStaffQuery<InspectorProfileResponse>({
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
    errorMessage: isAr ? 'تعذّر تحميل سجل الدفعات' : 'Failed to load the payout history',
  });

  /*
    Oldest first, with the balance carried down the column. The API returns
    payouts newest-first, which is the right order to *read* but the wrong one
    to accumulate against: a running balance only means anything if it is
    computed in the order the money actually moved.
  */
  const rows = useMemo(() => {
    if (!data) return [];
    const chronological = [...data.payouts].sort(
      (a, b) => new Date(a.paidAt).getTime() - new Date(b.paidAt).getTime(),
    );
    let paidSoFar = 0;
    const withBalance = chronological.map((payout) => {
      paidSoFar += payout.amount;
      return { payout, remaining: Math.max(0, data.totalEarnings - paidSoFar) };
    });
    return withBalance.reverse();
  }, [data]);

  /** The API already orders payouts newest-first, so this is the most recent. */
  const latestPayout = data?.payouts[0];

  const title = data
    ? isAr
      ? `سجل دفعات: ${data.inspector.name}`
      : `Payout history: ${data.inspector.name}`
    : isAr
      ? 'سجل الدفعات'
      : 'Payout history';

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
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-24 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-80 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink
        fallbackHref={`${base}/inspector/profile`}
        label={isAr ? 'العودة إلى الأرباح' : 'Back to earnings'}
      />

      <PageHeader
        icon={Receipt}
        title={title}
        subtitle={
          isAr
            ? 'كل مبلغ سُلّم لهذا الموظف عن مسحه الميداني، بتاريخه ورقم إيصاله ومن سجّله'
            : 'Every amount handed to this staff member for their field survey, with its date, receipt number and who recorded it'
        }
        actions={
          <div className="flex items-center gap-2">
            {data ? (
              <Button asChild variant="outline" size="sm" className="gap-1.5">
                <Link href={`${base}/inspector/profile/${data.inspector.id}`}>
                  <BadgeDollarSign className="size-4" aria-hidden />
                  {isAr ? 'لوحة المفتش' : 'Dashboard'}
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
                {isAr ? 'تسجيل دفعة' : 'Pay'}
              </Button>
            ) : null}

            <ActionTooltip label={isAr ? 'تحديث البيانات' : 'Refresh'}>
              <Button variant="outline" size="icon-sm" disabled={fetching} onClick={() => refetch()}>
                <RefreshCw className={`size-4 ${fetching ? 'animate-spin' : ''}`} aria-hidden />
                <span className="sr-only">{isAr ? 'تحديث' : 'Refresh'}</span>
              </Button>
            </ActionTooltip>
          </div>
        }
      />

      {error || !data ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState
              description={error ?? (isAr ? 'الموظف غير موجود' : 'Staff member not found')}
              onRetry={() => refetch()}
              retryLabel={isAr ? 'إعادة المحاولة' : 'Retry'}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              icon={TrendingUp}
              label={isAr ? 'إجمالي الأرباح' : 'Total earned'}
              value={`$${money(data.totalEarnings)}`}
              note={`${data.totalProperties.toLocaleString(locale)} ${isAr ? 'عقار / وحدة' : 'properties & units'}`}
            />
            <Stat
              icon={Wallet}
              label={isAr ? 'إجمالي المدفوع' : 'Total paid'}
              value={`$${money(data.paidBalance)}`}
            />
            <Stat
              icon={Receipt}
              label={isAr ? 'عدد الدفعات' : 'Payouts recorded'}
              value={data.payouts.length.toLocaleString(locale)}
              note={
                latestPayout
                  ? `${isAr ? 'آخر دفعة:' : 'Latest:'} ${formatDate(latestPayout.paidAt)}`
                  : undefined
              }
            />
            <Stat
              icon={Clock}
              label={isAr ? 'المتبقي المستحق' : 'Still owed'}
              value={`$${money(data.pendingBalance)}`}
              emphasis
            />
          </div>

          <Card className="overflow-hidden border-border/70">
            <CardContent className="p-0">
              {rows.length === 0 ? (
                <EmptyState
                  icon={Receipt}
                  title={isAr ? 'لا دفعات مسجلة' : 'No payouts recorded'}
                  description={
                    isAr
                      ? `لم يُسلَّم أي مبلغ لـ ${data.inspector.name} بعد. الرصيد المستحق $${money(data.pendingBalance)}.`
                      : `Nothing has been handed to ${data.inspector.name} yet. $${money(data.pendingBalance)} is outstanding.`
                  }
                  action={
                    isSuperAdmin ? (
                      <Button
                        size="sm"
                        className="gap-1.5 bg-success text-success-foreground hover:bg-success/90"
                        onClick={() => setPayoutOpen(true)}
                      >
                        <HandCoins className="size-4" aria-hidden />
                        {isAr ? 'تسجيل أول دفعة' : 'Record the first payout'}
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                /*
                  `Table` is a bare `<table>` by design — it leaves the scroll
                  container to whoever knows how wide the screen is. Six
                  columns do not fit a phone, and without this the card's
                  `overflow-hidden` would clip the notes rather than let them
                  be reached.
                */
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{isAr ? 'تاريخ الدفع' : 'Paid on'}</TableHead>
                        <TableHead>{isAr ? 'المبلغ' : 'Amount'}</TableHead>
                        <TableHead>{isAr ? 'رقم الإيصال' : 'Receipt'}</TableHead>
                        <TableHead>{isAr ? 'سُجّلت بواسطة' : 'Recorded by'}</TableHead>
                        <TableHead>{isAr ? 'المتبقي بعدها' : 'Owed after'}</TableHead>
                        <TableHead>{isAr ? 'ملاحظات' : 'Notes'}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map(({ payout, remaining }) => (
                        <TableRow key={payout.id}>
                          <TableCell className="whitespace-nowrap">
                            {formatDateTime(payout.paidAt)}
                          </TableCell>
                          {/*
                            `<bdi>` on the figures rather than `dir="ltr"` on
                            the cell, so each one sits under the heading that
                            names it — see `FactGrid` for the whole story. The
                            receipt number is plain text for the same reason a
                            payout amount is: it is a value being read off a
                            paper slip, not a control.
                          */}
                          <TableCell className="whitespace-nowrap font-bold tabular-nums text-success">
                            <bdi>
                              ${money(payout.amount)} {payout.currency}
                            </bdi>
                          </TableCell>
                          <TableCell className="whitespace-nowrap font-mono text-xs">
                            {payout.reference ? (
                              <bdi>{payout.reference}</bdi>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {payout.recordedByName ?? '—'}
                          </TableCell>
                          <TableCell className="whitespace-nowrap tabular-nums">
                            <bdi>${money(remaining)}</bdi>
                          </TableCell>
                          {/*
                            The one cell here that is prose rather than a
                            figure, so it opts out of the table's
                            `whitespace-nowrap` — a note is written to be read,
                            and nowrap would push «دفعة نقدية عن مسح حي الزهور»
                            off the side of the scroll container instead of
                            wrapping it.
                          */}
                          <TableCell className="max-w-xs whitespace-normal text-muted-foreground">
                            {payout.note ?? '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <InspectorPayoutDialog
            open={payoutOpen}
            onOpenChange={setPayoutOpen}
            tenant={tenant}
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

function Stat({
  icon: Icon,
  label,
  value,
  note,
  emphasis,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  note?: string;
  emphasis?: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
      </div>
      {/*
        `<bdi>` rather than a `dir` override: the label sits above the value,
        and a value with its own direction lands on the opposite edge from the
        word naming it. The isolate keeps «$412.00» in the right order without
        moving where it starts — so counts and amounts now line up with each
        other too, which the `plain` flag used to exist to work around.
      */}
      <div
        className={`mt-2 text-2xl font-bold tabular-nums ${
          emphasis ? 'text-warning' : 'text-foreground'
        }`}
      >
        <bdi>{value}</bdi>
      </div>
      {note ? <p className="mt-1 truncate text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

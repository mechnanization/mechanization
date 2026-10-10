'use client';

import { use, useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { Phone, Users } from 'lucide-react';
import { getCollectorCollections, type CollectorCollectionRow } from '@/lib/api-client';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatPhone } from '@/lib/phone';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { cn } from '@/lib/utils';
import { TreasuryAmount } from '@/components/admin/finance/treasury-amount';
import { Alert } from '@/components/ui/alert';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { ErrorState } from '@/components/ui/states';

const LIMIT = 200;

/**
 * «من حصّل الجابي» — the people one collector took money from.
 *
 * The companion to «استلام الصندوق» on the treasury page. Custody is one
 * number; a round is thirty doors. This is the list the accountant reads while
 * the notes are on the desk, and the one the collector is asked about when a
 * citizen says he paid.
 *
 * **These are receipts, not handovers, and the two totals will differ.** A
 * handover moves an amount, not a set of receipts — nothing in the data says
 * which notes were in which envelope — so once he has handed anything in, what
 * he collected and what he still holds differ by exactly what he brought. The
 * page says that out loud rather than letting two honest figures look like a
 * discrepancy.
 *
 * **The list starts at go-live** (`since`), and the page says so with the date.
 * A receipt from before the treasury went live never reached his custody, so
 * counting it would make «the difference is what he handed in» false by exactly
 * those receipts. Before go-live every receipt is listed and none is in custody,
 * so the page says that instead and makes no claim about the difference.
 *
 * No رقم مرجعي anywhere: it is a citizen's sign-in credential and has no
 * business on a reconciliation screen (docs/security.md).
 *
 * Under `/finance/collectors`, so `canAccessPath` matches the «الجباة والتحصيل»
 * nav row by prefix (the longest match) and the page inherits
 * `TREASURY_READ_ROLES` (CODE-4). The server enforces it.
 */
export default function CollectorCollectionsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; collectorId: string }>;
}) {
  const { tenant, locale, adminPath, collectorId } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('finance.collections');
  const tCommon = useTranslations('common');
  const { token } = useStaffSession(tenant, base);

  const query = useStaffQuery({
    queryKey: ['treasury', tenant, 'collections', collectorId],
    queryFn: (accessToken, signal) =>
      getCollectorCollections(tenant, accessToken, { collectorId, limit: LIMIT }, signal),
    tenant,
    base,
    token,
    keepPrevious: true,
    errorMessage: t('loadError'),
  });

  const tableLabels = useTableLabels({ empty: t('empty'), emptyHint: t('emptyHint') });

  const columns = useMemo<ColumnDef<CollectorCollectionRow>[]>(
    () => [
      {
        id: 'citizen',
        header: t('columns.citizen'),
        meta: { mobile: 'primary' },
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {/*
                The citizen's own file, so «قال إنه دفع» is one click from here.
                A plain link, not an action: nothing on this page changes money.
              */}
              <Link
                href={`${base}/citizens/${row.original.citizenId}`}
                className="truncate font-medium text-foreground underline-offset-4 hover:underline"
              >
                {row.original.citizenName}
              </Link>
              {row.original.isReversal ? (
                <Badge variant="soft-warning">{t('reversalRow')}</Badge>
              ) : row.original.reversed ? (
                <Badge variant="soft-warning">{t('reversed')}</Badge>
              ) : null}
            </div>
            <p className="truncate text-xs text-muted-foreground">{row.original.paymentTitle}</p>
          </div>
        ),
      },
      {
        id: 'phone',
        header: t('columns.phone'),
        enableSorting: false,
        cell: ({ row }) => {
          const { citizenPhone, citizenContactPhone, citizenHasNoPhone } = row.original;
          if (citizenPhone) {
            return (
              /* A number is dialled, not read: `tel:`, and LTR inside RTL (RTL-2). */
              <a
                href={`tel:${citizenPhone}`}
                dir="ltr"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
              >
                <Phone className="size-3.5 shrink-0" aria-hidden />
                {formatPhone(citizenPhone)}
              </a>
            );
          }
          if (citizenContactPhone) {
            /*
              A relative's number is shown as a relative's, never as his own —
              the same rule the register follows. A collector ringing it must
              know who will answer.
            */
            return (
              <a
                href={`tel:${citizenContactPhone}`}
                className="block text-xs text-primary hover:underline"
              >
                {t('contactPhone')} <bdi dir="ltr">{formatPhone(citizenContactPhone)}</bdi>
              </a>
            );
          }
          /* «لا يملك رقم هاتف» is an answer; a dash is a gap. They are not the same. */
          return (
            <span className="text-sm text-muted-foreground">
              {citizenHasNoPhone ? t('noPhone') : '—'}
            </span>
          );
        },
      },
      {
        id: 'zone',
        header: t('columns.zone'),
        cell: ({ row }) =>
          row.original.zoneName ? (
            <span className="text-sm">{row.original.zoneName}</span>
          ) : (
            /* No open occupancy on his file — not "no sector", which we cannot claim. */
            <span className="text-sm text-muted-foreground">{t('noZone')}</span>
          ),
      },
      {
        id: 'receipt',
        header: t('columns.receipt'),
        cell: ({ row }) => (
          /* A receipt number is a code: `font-mono`, Latin, left to right (BAN-9, RTL-2). */
          <span dir="ltr" className="font-mono text-xs">
            {row.original.receiptNumber}
          </span>
        ),
      },
      {
        id: 'date',
        header: t('columns.date'),
        cell: ({ row }) => (
          <span className="tabular-nums text-sm">{formatDateTime(row.original.occurredAt)}</span>
        ),
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
              A reversal is a negative row and a reversed receipt took nothing in
              the end; both are struck through as well as dimmed, because the
              strike is the signal that survives a greyscale screen (COL-3).
            */
            className={cn(
              'font-semibold',
              (row.original.isReversal || row.original.reversed) && 'text-muted-foreground line-through',
            )}
          />
        ),
      },
    ],
    [t, base, locale],
  );

  const data = query.data;
  const rows = data?.rows ?? [];
  const held = data?.custody ?? [];
  const collected = data?.totals ?? [];

  /* «المحصّل بالليرة», not «المحصّل بـ LBP»: a sentence, not a code glued to a preposition (TXT-5). */
  const inCurrency = (key: 'collectedIn' | 'heldIn', currency: string): string =>
    currency === 'LBP'
      ? t(`${key}LBP`)
      : currency === 'USD'
        ? t(`${key}USD`)
        : t(`${key}Other`, { currency });

  /** Go-live: where the list starts. Null while the treasury is not live, when every receipt is listed. */
  const since = data?.since ?? null;

  /*
    Shown only when the two figures actually differ, which is the moment the
    question «لماذا الرقمان مختلفان؟» occurs to anyone. Before his first
    handover they are equal and the note would be noise. And only once the
    treasury is live: before that nothing reaches custody, so the difference is
    every receipt, not what he handed in.
  */
  const differs =
    Boolean(since) &&
    collected.some((total) => {
      const wallet = held.find((entry) => entry.currency === total.currency);
      return Math.abs((wallet?.held ?? 0) - total.amount) > 0.009;
    });

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/finance/collectors`} label={t('back')} />

      <PageHeader
        icon={Users}
        title={data ? t('title', { name: data.collector.name ?? '' }) : t('titleLoading')}
      />

      {query.error ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={query.error} onRetry={query.refetch} retryLabel={tCommon('retry')} />
          </CardContent>
        </Card>
      ) : (
        <>
          {collected.length > 0 || held.length > 0 ? (
            <StatStrip>
              {collected.map((total) => (
                <StatItem
                  key={`collected-${total.currency}`}
                  label={inCurrency('collectedIn', total.currency)}
                  value={<TreasuryAmount amount={total.amount} currency={total.currency} locale={locale} wrap />}
                />
              ))}
              {held.map((wallet) => (
                <StatItem
                  key={`held-${wallet.currency}`}
                  label={inCurrency('heldIn', wallet.currency)}
                  value={<TreasuryAmount amount={wallet.held} currency={wallet.currency} locale={locale} wrap />}
                />
              ))}
              <StatItem label={t('receiptCount')} value={String(data?.total ?? 0)} />
            </StatStrip>
          ) : null}

          {/* Where the list starts, so the totals above can be read for what they are. */}
          {data ? (
            since ? (
              <p className="text-xs text-muted-foreground">{t('since', { date: formatDate(since) })}</p>
            ) : (
              <Alert variant="info">{t('notLive')}</Alert>
            )
          ) : null}

          {differs ? <Alert variant="info">{t('handedInNote')}</Alert> : null}

          <DataTable
            columns={columns}
            data={rows}
            labels={tableLabels}
            getRowId={(receipt) => receipt.id}
            searchable={false}
            sortable={false}
            paginated={false}
            loading={query.loading}
            error={null}
          />

          {(data?.total ?? 0) > LIMIT ? (
            <Alert variant="info" title={t('truncatedTitle')}>
              {t('truncated', { shown: LIMIT, total: data?.total ?? 0 })}
            </Alert>
          ) : null}
        </>
      )}
    </div>
  );
}

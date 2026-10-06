'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { getLabels } from '@mechanization/shared-schemas';
import type { TreasuryStatement, TreasuryStatementEntry } from '@/lib/api-client';
import { formatMoney } from '@/lib/currency';
import { formatDateTime } from '@/lib/dates';
import { useTableLabels } from '@/lib/use-table-labels';
import { cn } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/ui/data-table';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { ErrorState } from '@/components/ui/states';
import { TreasuryAmount } from './treasury-amount';

/** Rows asked for; the server says when it cut the list short. */
export const STATEMENT_LIMIT = 200;

/**
 * One wallet's statement: every movement with the balance it left behind.
 *
 * ## Why a page and not the dialog this replaces
 *
 * Two hundred rows of six columns is a reading task, and BAN-10 refuses a modal
 * for a task that needs neither interruption nor protected focus. The dialog
 * also had no address: an accountant could not send «كشف صندوق الليرة» to the
 * manager, bookmark it, or open two wallets side by side, and on a phone its
 * six columns were a table inside an overlay inside a scroll. A route fixes all
 * of it, and `DataTable` already draws its own frame — the dialog wrapped it in
 * a second border, which is the double frame BAN-4 names.
 *
 * Presentational: the page owns the read, because the page heading is the
 * wallet's own name and that name arrives inside the statement. One read, one
 * owner, and opening the page by URL needs no overview in hand.
 */
export function AccountStatementView({
  statement,
  loading,
  error,
  onRetry,
  locale,
}: {
  statement: TreasuryStatement | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  locale: string;
}): React.JSX.Element {
  const t = useTranslations('finance.statement');
  const labels = getLabels(locale);

  const tableLabels = useTableLabels({ empty: t('empty'), emptyHint: t('emptyHint') });

  const columns = useMemo<ColumnDef<TreasuryStatementEntry>[]>(
    () => [
      {
        id: 'date',
        header: t('date'),
        cell: ({ row }) => <span className="tabular-nums">{formatDateTime(row.original.occurredAt)}</span>,
      },
      {
        id: 'source',
        header: t('source'),
        meta: { mobile: 'primary' },
        cell: ({ row }) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{labels.treasuryEntrySource[row.original.source]}</span>
            {row.original.isReversal ? <Badge variant="soft-info">{t('reversal')}</Badge> : null}
            {row.original.reversed ? <Badge variant="soft-warning">{t('reversed')}</Badge> : null}
          </span>
        ),
      },
      {
        id: 'amount',
        header: t('amount'),
        meta: { align: 'end' },
        cell: ({ row }) => {
          const { amount, currency } = row.original;
          const incoming = amount > 0;
          // Colour is never the only signal: the sign carries it in print, and a
          // screen-reader-only word carries it for anyone who hears the row (COL-3).
          return (
            <span
              dir="ltr"
              className={cn(
                'inline-flex items-baseline gap-1 whitespace-nowrap font-semibold tabular-nums',
                incoming ? 'text-success' : 'text-destructive',
              )}
            >
              <span className="sr-only">{incoming ? t('in') : t('out')}</span>
              <span>
                {incoming ? '+' : '−'}
                {formatMoney(Math.abs(amount), currency, locale)}
              </span>
            </span>
          );
        },
      },
      {
        id: 'balanceAfter',
        header: t('balanceAfter'),
        meta: { align: 'end' },
        cell: ({ row }) => (
          <TreasuryAmount
            amount={row.original.balanceAfter}
            currency={row.original.currency}
            locale={locale}
            className="font-medium"
          />
        ),
      },
      {
        id: 'actor',
        header: t('actor'),
        cell: ({ row }) => (
          <span className={cn(!row.original.actorName && 'text-muted-foreground')}>
            {row.original.actorName ?? t('system')}
          </span>
        ),
      },
      {
        id: 'note',
        header: t('note'),
        meta: { cellClassName: 'min-w-48 whitespace-normal' },
        cell: ({ row }) => row.original.note ?? <span className="text-muted-foreground">—</span>,
      },
    ],
    [t, labels, locale],
  );

  if (error) {
    return <ErrorState title={error} onRetry={onRetry} />;
  }

  return (
    <div className="space-y-4">
      {statement ? (
        /*
          A `StatStrip`, not a `SummaryList`: these are two figures bracketing
          the rows, not facts read against a record, and the strip is what
          PRIM-20 names for a handful of numbers taken in at a glance. It also
          survives 360px, which the rows did not — `SummaryRow` keeps its label
          at full width (`shrink-0`), so «Balance after the last movement shown»
          pushed the figure off the panel's edge (LAY-6).
        */
        <StatStrip>
          <StatItem
            label={t('opening')}
            value={
              <TreasuryAmount
                amount={statement.openingBalance}
                currency={statement.account.currency}
                locale={locale}
              />
            }
          />
          <StatItem
            label={t('closing')}
            value={
              <TreasuryAmount
                amount={statement.account.balance}
                currency={statement.account.currency}
                locale={locale}
              />
            }
          />
        </StatStrip>
      ) : null}

      <DataTable
        columns={columns}
        data={statement?.entries ?? []}
        labels={tableLabels}
        getRowId={(entry) => entry.id}
        searchable={false}
        sortable={false}
        paginated={false}
        loading={loading}
        error={null}
      />

      {statement?.truncated ? (
        <Alert variant="warning" title={t('truncatedTitle')}>
          {t('truncated', { count: statement.entries.length })}
        </Alert>
      ) : null}
    </div>
  );
}

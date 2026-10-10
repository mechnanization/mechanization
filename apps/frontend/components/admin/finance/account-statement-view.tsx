'use client';

import { useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, Printer } from 'lucide-react';
import { getLabels, municipalToday } from '@mechanization/shared-schemas';
import type { TreasuryStatement, TreasuryStatementEntry } from '@/lib/api-client';
import { formatMoney } from '@/lib/currency';
import { formatDate, formatDateTime } from '@/lib/dates';
import { closingBalance, mayVoidTransfer, type StatementRange } from '@/lib/treasury-statement';
import { useTableLabels } from '@/lib/use-table-labels';
import { cn } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { ErrorState } from '@/components/ui/states';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { TreasuryAmount } from './treasury-amount';
import { VoidTransferDialog } from './void-transfer-dialog';

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
 * ## Why it has a date range
 *
 * The server returns the newest `STATEMENT_LIMIT` movements inside the range
 * asked for, so a busy wallet asked for everything opens on its latest two
 * hundred with no way to reach the day being checked. The range defaults to the
 * month so far, and «اليوم» is the daily cash register: one day, printed and
 * signed, with the cash counted against it (Decree 5595/1982, art. 101).
 *
 * ## Printing
 *
 * The one-day statement is the daily register, printed, counted and signed
 * (docs/finance.md §7), so it prints: the movements and the two balances sit in
 * the page's print root (`data-print-root`, `globals.css`), which is all that
 * reaches the paper. Inside it, and only on paper, are the heading a sheet needs
 * on its own — the municipality, the wallet, the day or the range — and, under
 * the rows, the lines the cashier and the accountant sign, with the moment it
 * was printed. The range controls, the page heading and the actions stay on
 * screen.
 *
 * ## «إلغاء التسليم»
 *
 * A collector's handover is a `TRANSFER` movement. The manager can cancel one
 * that should not stand from its own row (`mayVoidTransfer`,
 * `VoidTransferDialog`): the money goes back onto the collector's name.
 *
 * Presentational for the read: the page owns it and the range, because the page
 * heading is the wallet's own name and that name arrives inside the statement.
 * One read, one owner, and opening the page by URL needs no overview in hand.
 */
export function AccountStatementView({
  tenant,
  token,
  role,
  statement,
  loading,
  fetching,
  error,
  onRetry,
  range,
  onRangeChange,
  locale,
  municipalityName,
}: {
  tenant: string;
  /** Null until the session is read; the void action waits for it. */
  token: string | null;
  /** The signed-in role, for «إلغاء التسليم» (`mayVoidTransfer`). */
  role: string | undefined;
  statement: TreasuryStatement | undefined;
  loading: boolean;
  /** A read is outstanding while an earlier answer is still on screen (another range loading). */
  fetching: boolean;
  error: string | null;
  onRetry: () => void;
  range: StatementRange;
  onRangeChange: (range: StatementRange) => void;
  locale: string;
  /** The municipality's name in the page's language, for the printed heading; empty while unknown. */
  municipalityName: string;
}): React.JSX.Element {
  const t = useTranslations('finance.statement');
  const tCommon = useTranslations('common');
  const labels = getLabels(locale);
  const [voiding, setVoiding] = useState<TreasuryStatementEntry | null>(null);

  // Read on every render, not once: a screen left open past midnight must still offer today.
  const today = municipalToday();
  const pickerLocale = locale === 'en' ? 'en' : 'ar';
  const isToday = range.from === today && range.to === today;
  const refreshing = fetching && !loading;
  /*
    The range the rows on screen belong to — which is not `range` while another
    range loads behind them (`keepPrevious`). The printed heading names this
    one, so a sheet never says one day over another day's rows; and the print
    button waits while a read is outstanding.
  */
  const [shownRange, setShownRange] = useState(range);
  useEffect(() => {
    if (statement && !fetching) setShownRange(range);
  }, [statement, fetching, range]);
  /** The void needs the session's token as well as the role; both arrive after the first paint. */
  const signedIn = Boolean(token);
  const anyVoidable = signedIn && (statement?.entries ?? []).some((entry) => mayVoidTransfer(entry, role));

  /*
    The moment printed under the signatures. Set as the print starts, not when
    the page rendered: a register left open all morning and printed at noon
    says noon. `flushSync`, because the browser lays the sheet out straight
    after `beforeprint` returns, before React would otherwise render.
  */
  const [printedAt, setPrintedAt] = useState(() => new Date());
  useEffect(() => {
    const stamp = (): void => flushSync(() => setPrintedAt(new Date()));
    window.addEventListener('beforeprint', stamp);
    return () => window.removeEventListener('beforeprint', stamp);
  }, []);

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
          /*
            Colour is never the only signal: the sign carries it, on paper too,
            and a screen-reader-only word carries it for anyone who hears the
            row (COL-3). The sign is `Money`'s, so this column and the balance
            beside it write one minus.
          */
          return (
            <span className={cn('font-semibold', incoming ? 'text-success' : 'text-destructive')}>
              <span className="sr-only">{incoming ? t('in') : t('out')}</span>
              <TreasuryAmount amount={amount} currency={currency} locale={locale} signed />
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
      // Only where there is something to act on; never on paper.
      ...(anyVoidable
        ? ([
            {
              id: 'actions',
              header: t('actions'),
              enableSorting: false,
              meta: {
                align: 'end',
                mobile: 'actions',
                headerClassName: 'print:hidden',
                cellClassName: 'print:hidden',
              },
              cell: ({ row }) =>
                signedIn && mayVoidTransfer(row.original, role) ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="max-sm:flex-1"
                    // The row's own amount and moment name which handover (DES-1, A11Y-2).
                    aria-label={t('voidTransfer.actionFor', {
                      amount: formatMoney(Math.abs(row.original.amount), row.original.currency, locale),
                      when: formatDateTime(row.original.occurredAt),
                    })}
                    onClick={() => setVoiding(row.original)}
                  >
                    <Ban className="size-4" aria-hidden />
                    {t('voidTransfer.action')}
                  </Button>
                ) : null,
            },
          ] satisfies ColumnDef<TreasuryStatementEntry>[])
        : []),
    ],
    [t, labels, locale, anyVoidable, signedIn, role],
  );

  return (
    <div className="space-y-4">
      {/*
        The range stays on screen when the read fails: a bad range is one of the
        things that fails it, and the way out is to change it.
      */}
      <div role="group" aria-label={t('rangeAria')} className="space-y-2">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('from')} htmlFor="statement-from" optionalLabel="" className="w-full sm:w-52">
            <DatePicker
              id="statement-from"
              value={range.from}
              max={range.to}
              locale={pickerLocale}
              onChange={(from) => onRangeChange({ ...range, from })}
            />
          </Field>
          <Field label={t('to')} htmlFor="statement-to" optionalLabel="" className="w-full sm:w-52">
            <DatePicker
              id="statement-to"
              value={range.to}
              min={range.from}
              max={today}
              locale={pickerLocale}
              onChange={(to) => onRangeChange({ ...range, to })}
            />
          </Field>
          <Button
            type="button"
            variant={isToday ? 'secondary' : 'outline'}
            className="w-full sm:w-auto"
            aria-pressed={isToday}
            onClick={() => onRangeChange({ from: today, to: today })}
          >
            {t('today')}
          </Button>
          {/* The register is signed on paper; the browser's print prints the sheet (`data-print-root`). */}
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            disabled={!statement || fetching}
            onClick={() => window.print()}
          >
            <Printer className="size-4" aria-hidden />
            {t('print.action')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('dailyRegisterHint')}</p>
      </div>

      {/*
        A failed re-read of the rows on screen keeps them, and the dialog open
        over them; only a read that never answered is an error panel.
      */}
      {error && statement ? <RefreshFailedAlert message={error} onRetry={onRetry} /> : null}

      {error && !statement ? (
        <ErrorState title={error} onRetry={onRetry} retryLabel={tCommon('retry')} />
      ) : (
        // Dimmed, not blanked, while another range loads: the figures on screen belong to the previous one.
        <div
          data-print-root
          aria-busy={refreshing}
          className={cn('space-y-4 transition-opacity', refreshing && 'opacity-60')}
        >
          {/* The sheet's own heading: on paper there is no page heading or address bar to say whose register it is. */}
          {statement ? (
            <div className="hidden space-y-1 print:block">
              {municipalityName ? (
                <p className="text-sm font-semibold">{t('print.municipality', { name: municipalityName })}</p>
              ) : null}
              <h2 className="text-lg font-bold">{t('title', { name: statement.account.name })}</h2>
              <p className="text-sm">
                {shownRange.from === shownRange.to
                  ? t('print.day', { date: formatDate(shownRange.from) })
                  : t('print.range', { from: formatDate(shownRange.from), to: formatDate(shownRange.to) })}
              </p>
            </div>
          ) : null}

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
                    wrap
                  />
                }
              />
              <StatItem
                label={t('closing')}
                value={
                  <TreasuryAmount
                    amount={closingBalance(statement)}
                    currency={statement.account.currency}
                    locale={locale}
                    wrap
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

          {/*
            Signed on paper: the cashier who counted the cash, the accountant who
            checked it (art. 101). The rule is the text's own colour, which the
            print root sets to black whatever the theme.
          */}
          {statement ? (
            <div className="hidden pt-12 print:block">
              <div className="grid grid-cols-2 gap-12">
                <p className="border-t border-current pt-2 text-sm">{t('print.cashier')}</p>
                <p className="border-t border-current pt-2 text-sm">{t('print.accountant')}</p>
              </div>
              <p className="pt-6 text-xs">{t('print.printedAt', { when: formatDateTime(printedAt) })}</p>
            </div>
          ) : null}
        </div>
      )}

      {voiding && token ? (
        <VoidTransferDialog
          tenant={tenant}
          token={token}
          locale={locale}
          entry={voiding}
          onDone={() => setVoiding(null)}
          onCancel={() => setVoiding(null)}
        />
      ) : null}
    </div>
  );
}

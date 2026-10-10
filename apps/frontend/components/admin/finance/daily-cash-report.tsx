'use client';

import { useTranslations } from 'next-intl';
import { getLabels } from '@mechanization/shared-schemas';
import type {
  DailyCashReport as DailyCashReportData,
  DailyCashReportWallet,
} from '@/lib/api-client';
import { formatDateTime, formatDayLong } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DayStatusBadge } from './day-status-badge';
import {
  LetterheadCrest,
  LetterheadLines,
  SignatureBlock,
  documentPrintCss,
  type MunicipalLetterhead,
} from './official-document';
import { TreasuryAmount } from './treasury-amount';

/** Eight columns of figures, each with its unit, do not fit a portrait page at a size anyone can read. */
const PRINT_CSS = documentPrintCss('daily-cash-report', 'A4 landscape');

/**
 * «تقرير الصندوق اليومي» — one municipal day on one sheet, to print and sign.
 *
 * Every figure is the server's (STA-6): opening, money in, money out, closing,
 * the count and its difference, all computed from the ledger. Collector custody
 * is set apart and labelled as not part of the count (§3.5). The day's history
 * — counted, closed, reopened and why — comes from the audit log.
 */
export function DailyCashReport({
  report,
  letterhead,
  locale,
}: {
  report: DailyCashReportData;
  letterhead: MunicipalLetterhead;
  locale: string;
}): React.JSX.Element {
  const t = useTranslations('dailyClosing.report');
  const tAudit = useTranslations('auditActions');
  const labels = getLabels(locale);
  const { day } = report;
  const moved = report.wallets.filter((wallet) => wallet.movements > 0);

  return (
    <article id="daily-cash-report" className="space-y-6 rounded-lg border bg-card p-4 text-sm shadow-sm sm:p-6">
      <style>{PRINT_CSS}</style>

      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <LetterheadLines letterhead={letterhead} />
        <LetterheadCrest crest={letterhead.crest} />

        <div className="space-y-1 text-end">
          <h2 className="text-lg font-semibold">{t('title')}</h2>
          <p className="font-medium">{formatDayLong(day.businessDate, locale)}</p>
          <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
            <span>{t('status', { status: labels.treasuryDayStatus[day.status] })}</span>
            <DayStatusBadge status={day.status} locale={locale} className="print:hidden" />
          </div>
          {day.status === 'CLOSED' ? (
            <p className="text-xs text-muted-foreground">
              {day.autoClosed
                ? t('autoClosedLine')
                : t('closedLine', { name: day.closedByName ?? '—', date: formatDateTime(day.closedAt!) })}
            </p>
          ) : null}
        </div>
      </header>

      {/* Inside the printed area on purpose: an unsigned day's figures can still move, and the paper must say so. */}
      {day.status !== 'CLOSED' ? (
        <Alert variant="warning" title={t('draftTitle')}>
          {t('draftBody')}
        </Alert>
      ) : null}

      <section aria-labelledby="report-wallets" className="space-y-2">
        <h3 id="report-wallets" className="text-base font-semibold">
          {t('walletsHeading')}
        </h3>
        {report.wallets.length === 0 ? (
          <p className="text-muted-foreground">{t('noWallets')}</p>
        ) : (
          <ReportTable>
            <TableHeader>
              <TableRow>
                <Th>{t('columns.wallet')}</Th>
                <Th numeric>{t('columns.opening')}</Th>
                <Th numeric>{t('columns.receipts')}</Th>
                <Th numeric>{t('columns.payments')}</Th>
                <Th numeric>{t('columns.closing')}</Th>
                <Th numeric>{t('columns.counted')}</Th>
                <Th numeric>{t('columns.difference')}</Th>
                <Th>{t('columns.notes')}</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.wallets.map((wallet) => (
                <WalletRow key={wallet.account.id} wallet={wallet} locale={locale} />
              ))}
              {report.totals.map((total) => (
                <TableRow key={total.currency} className="border-t-2 font-semibold">
                  <Td>{t('total', { currency: total.currency })}</Td>
                  <Money value={total.openingBalance} currency={total.currency} locale={locale} />
                  <Money value={total.receipts} currency={total.currency} locale={locale} />
                  <Money value={total.payments} currency={total.currency} locale={locale} />
                  <Money value={total.closingBalance} currency={total.currency} locale={locale} />
                  <Money value={total.counted} currency={total.currency} locale={locale} />
                  <Money value={total.difference} currency={total.currency} locale={locale} />
                  <Td />
                </TableRow>
              ))}
            </TableBody>
          </ReportTable>
        )}
      </section>

      <section aria-labelledby="report-sources" className="space-y-2">
        <h3 id="report-sources" className="text-base font-semibold">
          {t('sourcesHeading')}
        </h3>
        {moved.length === 0 ? (
          <p className="text-muted-foreground">{t('noMovement')}</p>
        ) : (
          <ReportTable>
            <TableHeader>
              <TableRow>
                <Th>{t('sourceColumns.wallet')}</Th>
                <Th>{t('sourceColumns.source')}</Th>
                <Th numeric>{t('sourceColumns.receipts')}</Th>
                <Th numeric>{t('sourceColumns.payments')}</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {moved.flatMap((wallet) =>
                wallet.bySource.map((line, index) => (
                  <TableRow key={`${wallet.account.id}-${line.source}`}>
                    <Td>{index === 0 ? wallet.account.name : ''}</Td>
                    <Td>{labels.treasuryEntrySource[line.source]}</Td>
                    <Money value={line.receipts} currency={wallet.account.currency} locale={locale} />
                    <Money value={line.payments} currency={wallet.account.currency} locale={locale} />
                  </TableRow>
                )),
              )}
            </TableBody>
          </ReportTable>
        )}
      </section>

      <section aria-labelledby="report-custody" className="space-y-2">
        <h3 id="report-custody" className="text-base font-semibold">
          {t('custodyHeading')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('custodyNote')}</p>
        {report.custody.length === 0 ? (
          <p className="text-muted-foreground">{t('noCustody')}</p>
        ) : (
          <ReportTable>
            <TableHeader>
              <TableRow>
                <Th>{t('custodyColumns.collector')}</Th>
                <Th numeric>{t('custodyColumns.receipts')}</Th>
                <Th numeric>{t('custodyColumns.payments')}</Th>
                <Th numeric>{t('custodyColumns.held')}</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.custody.map((row) => (
                <TableRow key={`${row.collectorId ?? 'none'}-${row.currency}`}>
                  <Td>{row.collectorName ?? t('unknownCollector')}</Td>
                  <Money value={row.receipts} currency={row.currency} locale={locale} />
                  <Money value={row.payments} currency={row.currency} locale={locale} />
                  <Money value={row.heldAtClose} currency={row.currency} locale={locale} />
                </TableRow>
              ))}
              {report.custodyTotals.map((total) => (
                <TableRow key={total.currency} className="border-t-2 font-semibold">
                  <Td colSpan={3}>{t('custodyTotal', { currency: total.currency })}</Td>
                  <Money value={total.heldAtClose} currency={total.currency} locale={locale} />
                </TableRow>
              ))}
            </TableBody>
          </ReportTable>
        )}
      </section>

      <section aria-labelledby="report-timeline" className="space-y-2">
        <h3 id="report-timeline" className="text-base font-semibold">
          {t('timelineHeading')}
        </h3>
        {report.timeline.length === 0 ? (
          <p className="text-muted-foreground">{t('timelineEmpty')}</p>
        ) : (
          <ol className="space-y-1.5">
            {report.timeline.map((event, index) => (
              <li key={`${event.at}-${index}`} className="flex flex-wrap gap-x-2 gap-y-0.5">
                <span className="tabular-nums text-muted-foreground">
                  {formatDateTime(event.at)}
                </span>
                <span className="font-medium">{tAudit(event.action)}</span>
                <span>— {event.actorName ?? t('systemActor')}</span>
                {event.accounts !== null ? <span>({t('eventAccounts', { count: event.accounts })})</span> : null}
                {event.reason ? <span className="w-full ps-4">{t('eventReason', { reason: event.reason })}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="grid gap-8 pt-4 sm:grid-cols-2">
        <SignatureBlock title={t('signatures.accountant')} />
        <SignatureBlock title={t('signatures.mayor')} />
      </section>

      <footer className="border-t pt-3 text-xs text-muted-foreground">
        {report.generatedByName
          ? t('generated', { date: formatDateTime(report.generatedAt), name: report.generatedByName })
          : t('generatedAnonymous', { date: formatDateTime(report.generatedAt) })}
      </footer>
    </article>
  );
}

/** One wallet's day across the columns, with the count's reason as its note. */
function WalletRow({ wallet, locale }: { wallet: DailyCashReportWallet; locale: string }): React.JSX.Element {
  const t = useTranslations('dailyClosing.report');
  const { account, count } = wallet;
  const differs = count !== null && count.difference !== 0;
  const notes = [count === null ? t('notCounted') : null, count?.stale ? t('staleNote') : null, count?.varianceReason ?? null]
    .filter(Boolean)
    .join(' — ');

  return (
    <TableRow>
      <Td>
        <span className="font-medium">{account.name}</span>
      </Td>
      <Money value={wallet.openingBalance} currency={account.currency} locale={locale} />
      <Money value={wallet.receipts} currency={account.currency} locale={locale} />
      <Money value={wallet.payments} currency={account.currency} locale={locale} />
      <Money value={wallet.closingBalance} currency={account.currency} locale={locale} className="font-semibold" />
      <Money value={count?.countedAmount ?? null} currency={account.currency} locale={locale} />
      <Money
        value={count?.difference ?? null}
        currency={account.currency}
        locale={locale}
        className={differs ? 'font-semibold text-warning' : undefined}
      />
      <Td className="min-w-48 whitespace-normal text-xs">{notes}</Td>
    </TableRow>
  );
}

/**
 * The kit's `Table` (PRIM-3's parts, not a hand-rolled one) in a box that
 * scrolls on its own on a phone, so the page never does (LAY-5). Not
 * `DataTable`: this is a printed statement, with no paging, sorting or search
 * to offer, and its totals rows are part of the document.
 */
function ReportTable({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table className="text-xs">{children}</Table>
    </div>
  );
}

function Th({ children, numeric }: { children: React.ReactNode; numeric?: boolean }): React.JSX.Element {
  return (
    <TableHead scope="col" className={cn('h-9 px-2', numeric && 'text-end')}>
      {children}
    </TableHead>
  );
}

function Td({
  children,
  className,
  colSpan,
}: {
  children?: React.ReactNode;
  className?: string;
  colSpan?: number;
}): React.JSX.Element {
  return (
    <TableCell colSpan={colSpan} className={cn('px-2 py-1.5 align-top', className)}>
      {children}
    </TableCell>
  );
}

/** A figure cell: the wallet's own currency, in full, `tabular-nums` (TYP-4). A dash when there is none. */
function Money({
  value,
  currency,
  locale,
  className,
}: {
  value: number | null;
  currency: string;
  locale: string;
  className?: string;
}): React.JSX.Element {
  return (
    <TableCell className={cn('px-2 py-1.5 text-end align-top', className)}>
      {value === null ? '—' : <TreasuryAmount amount={value} currency={currency} locale={locale} />}
    </TableCell>
  );
}

'use client';

import { use, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { Download, FileBarChart, Printer } from 'lucide-react';
import {
  getLabels,
  type ArrearsReportBatch,
  type ArrearsReportCollection,
  type ArrearsReportRow,
  type ArrearsReportYear,
} from '@mechanization/shared-schemas';
import { getArrearsReport } from '@/lib/arrears-api';
import { arrearsReportCsv, arrearsReportFilename, coveragePercent } from '@/lib/arrears-report';
import { downloadCsv } from '@/lib/csv';
import { formatLbp } from '@/lib/currency';
import { formatDate } from '@/lib/dates';
import { readView } from '@/lib/read-view';
import { ARREARS_REPORT_ROLES, hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { Alert } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { CellTag } from '@/components/ui/cell-tag';
import { DataTable } from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';

/**
 * «تقرير المتأخرات» — old debts, «متأخرات سنوات سابقة» (docs/old-debts-plan.md §8,
 * task 11): by year and fee type what the approved batches billed, what was
 * collected, cancelled and written off, and what is still owed; each year against
 * the old books' total; the files checked over all files; and what was collected
 * on old debts, apart from every other bill, because the annual closing of
 * accounts needs them apart.
 *
 * `ARREARS_REPORT_ROLES`, the finance reports' readers: every figure is a sum and
 * no row names a person, so «مشاهد فقط» may read it. The old books' totals are
 * read here and entered nowhere: whether the municipality enters them is
 * open-decisions §23.4, so «غير مدخل» is the honest answer for now.
 */
export default function ArrearsReportPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('arrears.report');
  const labels = getLabels(locale);
  const { token, user } = useStaffSession(tenant, base);
  const allowed = user ? hasRole(ARREARS_REPORT_ROLES, user.role) : false;

  const report = useStaffQuery({
    queryKey: ['arrears-report', tenant],
    queryFn: (session, signal) => getArrearsReport(tenant, session, signal),
    tenant,
    base,
    token: allowed ? token : null,
    errorMessage: t('loadFailed'),
  });
  // A failed re-read leaves the report on screen with its alert (STA-1).
  const view = readView(report.data, report.error);
  const data = view.state === 'ready' ? view.data : undefined;

  const lbp = useCallback((amount: number) => <Money amount={amount} currency="LBP" locale={locale} exact wrap />, [locale]);
  const tableLabels = useTableLabels({ empty: t('emptyRows') });
  const yearLabels = useTableLabels({ empty: t('emptyYears') });
  const collectionLabels = useTableLabels({ empty: t('emptyCollections') });
  const batchLabels = useTableLabels({ empty: t('emptyBatches') });

  const rowColumns = useMemo<ColumnDef<ArrearsReportRow>[]>(
    () => [
      { id: 'year', header: t('colYear'), meta: { mobile: 'primary' }, cell: ({ row }) => <bdi dir="ltr">{row.original.year}</bdi> },
      {
        id: 'fee',
        header: t('colFee'),
        meta: { cellClassName: 'whitespace-normal' },
        cell: ({ row }) => (labels.arrearsFeeType as Record<string, string>)[row.original.feeType] ?? row.original.feeType,
      },
      { id: 'billed', header: t('colBilled'), meta: { align: 'end' as const }, cell: ({ row }) => lbp(row.original.billed) },
      { id: 'collected', header: t('colCollected'), meta: { align: 'end' as const }, cell: ({ row }) => lbp(row.original.collected) },
      { id: 'cancelled', header: t('colCancelled'), meta: { align: 'end' as const }, cell: ({ row }) => lbp(row.original.cancelled) },
      { id: 'writtenOff', header: t('colWrittenOff'), meta: { align: 'end' as const }, cell: ({ row }) => lbp(row.original.writtenOff) },
      { id: 'owed', header: t('colOwed'), meta: { align: 'end' as const }, cell: ({ row }) => lbp(row.original.owed) },
      { id: 'waiting', header: t('colWaiting'), meta: { align: 'end' as const }, cell: ({ row }) => lbp(row.original.waiting) },
    ],
    [t, labels, lbp],
  );

  const yearColumns = useMemo<ColumnDef<ArrearsReportYear>[]>(
    () => [
      { id: 'year', header: t('colYear'), meta: { mobile: 'primary' }, cell: ({ row }) => <bdi dir="ltr">{row.original.year}</bdi> },
      { id: 'imported', header: t('colImported'), meta: { align: 'end' as const }, cell: ({ row }) => lbp(row.original.imported) },
      { id: 'prescribed', header: t('colPrescribed'), meta: { align: 'end' as const }, cell: ({ row }) => lbp(row.original.prescribed) },
      { id: 'dropped', header: t('colDropped'), meta: { align: 'end' as const }, cell: ({ row }) => lbp(row.original.dropped) },
      {
        id: 'books',
        header: t('colBooks'),
        meta: { align: 'end' as const },
        cell: ({ row }) =>
          row.original.controlTotal === null ? <CellTag tone="muted">{t('notEntered')}</CellTag> : lbp(row.original.controlTotal),
      },
      {
        id: 'remaining',
        header: t('colRemaining'),
        meta: { align: 'end' as const },
        cell: ({ row }) =>
          row.original.remainingToImport === null ? <CellTag tone="muted">{t('notEntered')}</CellTag> : lbp(row.original.remainingToImport),
      },
    ],
    [t, lbp],
  );

  const collectionColumns = useMemo<ColumnDef<ArrearsReportCollection>[]>(
    () => [
      { id: 'year', header: t('colYear'), meta: { mobile: 'primary' }, cell: ({ row }) => <bdi dir="ltr">{row.original.year}</bdi> },
      { id: 'currency', header: t('colCurrency'), cell: ({ row }) => <bdi dir="ltr">{row.original.currency}</bdi> },
      {
        id: 'arrears',
        header: t('colArrearsCollected'),
        meta: { align: 'end' as const },
        cell: ({ row }) => <Money amount={row.original.arrears} currency={row.original.currency} locale={locale} exact wrap />,
      },
      {
        id: 'other',
        header: t('colOtherCollected'),
        meta: { align: 'end' as const },
        cell: ({ row }) => <Money amount={row.original.other} currency={row.original.currency} locale={locale} exact wrap />,
      },
    ],
    [t, locale],
  );

  const batchColumns = useMemo<ColumnDef<ArrearsReportBatch>[]>(
    () => [
      {
        id: 'code',
        header: t('colCode'),
        meta: { mobile: 'primary' },
        cell: ({ row }) => (
          <bdi dir="ltr" className="font-mono">
            {row.original.code}
          </bdi>
        ),
      },
      { id: 'approved', header: t('colApproved'), cell: ({ row }) => (row.original.approvedAt ? formatDate(row.original.approvedAt) : '—') },
      { id: 'approvedBy', header: t('colApprovedBy'), cell: ({ row }) => row.original.approvedBy ?? '—' },
      { id: 'preparedBy', header: t('colPreparedBy'), cell: ({ row }) => row.original.preparedBy },
      {
        id: 'counts',
        header: t('colCounts'),
        meta: { cellClassName: 'whitespace-normal' },
        cell: ({ row }) => t('countsValue', { citizens: row.original.citizenCount, lines: row.original.lineCount }),
      },
      {
        id: 'actions',
        header: t('colActions'),
        meta: { align: 'end' as const, mobile: 'actions' as const },
        cell: ({ row }) => (
          <Link
            href={`${base}/fees/arrears/batches/${encodeURIComponent(row.original.id)}/sheet`}
            className={buttonVariants({ variant: 'ghost', size: 'sm', className: '!w-auto' })}
          >
            <Printer className="size-4" aria-hidden />
            {t('sheet')}
          </Link>
        ),
      },
    ],
    [t, base],
  );

  if (!user || !token) return <LoadingState />;

  const exportCsv = () => {
    if (!data) return;
    downloadCsv(
      arrearsReportFilename(),
      arrearsReportCsv(data, {
        header: {
          year: t('colYear'),
          fee: t('colFee'),
          billedCount: t('csvBilledCount'),
          billed: t('colBilled'),
          collected: t('colCollected'),
          cancelled: t('colCancelled'),
          writtenOff: t('colWrittenOff'),
          owed: t('colOwed'),
          waitingCount: t('csvWaitingCount'),
          waiting: t('colWaiting'),
        },
        feeName: (feeType) => (labels.arrearsFeeType as Record<string, string>)[feeType] ?? feeType,
      }),
    );
  };

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={`${base}/fees`} label={t('back')} />
      <PageHeader
        icon={FileBarChart}
        title={t('title')}
        actions={
          data ? (
            <Button variant="outline" onClick={exportCsv}>
              <Download className="size-4" aria-hidden />
              {t('export')}
            </Button>
          ) : null
        }
      />

      {!allowed ? (
        <EmptyState icon={FileBarChart} title={t('notAllowedTitle')} description={t('notAllowedBody')} />
      ) : view.state === 'failed' ? (
        <ErrorState title={view.error} description={report.refusal ?? undefined} onRetry={report.refetch} />
      ) : !data ? (
        <LoadingState />
      ) : (
        <>
          {view.state === 'ready' && view.refreshFailed ? (
            <RefreshFailedAlert message={view.refreshFailed} onRetry={report.refetch} />
          ) : null}

          <p className="max-w-3xl text-sm text-muted-foreground">
            {data.cutoffYear === null ? t('noCutoff') : t('cutoff', { year: String(data.cutoffYear) })}
          </p>

          <StatStrip>
            <StatItem label={t('billed')} value={lbp(data.totals.billed)} hint={t('billedHint', { count: data.totals.billedCount })} />
            <StatItem label={t('collected')} value={lbp(data.totals.collected)} className="text-success" />
            <StatItem label={t('cancelled')} value={lbp(data.totals.cancelled)} />
            <StatItem label={t('writtenOff')} value={lbp(data.totals.writtenOff)} />
            <StatItem label={t('owed')} value={lbp(data.totals.owed)} />
          </StatStrip>

          {data.totals.waitingCount > 0 ? (
            <Alert variant="info">
              {t('waiting', { count: data.totals.waitingCount, amount: formatLbp(data.totals.waiting, locale) })}
            </Alert>
          ) : null}

          <section className="space-y-3" aria-labelledby="arrears-report-by-year">
            <h2 id="arrears-report-by-year" className="text-lg font-semibold">
              {t('byYearTitle')}
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">{t('byYearIntro')}</p>
            <DataTable
              columns={rowColumns}
              data={data.rows}
              labels={tableLabels}
              getRowId={(row) => `${row.year}|${row.feeType}`}
              searchable={false}
              sortable={false}
              paginated={false}
              loading={false}
              error={null}
            />
          </section>

          <section className="space-y-3" aria-labelledby="arrears-report-books">
            <h2 id="arrears-report-books" className="text-lg font-semibold">
              {t('booksTitle')}
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">{t('booksIntro')}</p>
            <DataTable
              columns={yearColumns}
              data={data.years}
              labels={yearLabels}
              getRowId={(row) => String(row.year)}
              searchable={false}
              sortable={false}
              paginated={false}
              loading={false}
              error={null}
            />
          </section>

          <section className="space-y-2" aria-labelledby="arrears-report-coverage">
            <h2 id="arrears-report-coverage" className="text-lg font-semibold">
              {t('coverageTitle')}
            </h2>
            <p className="text-base font-medium">
              {t('coverageValue', {
                checked: data.coverage.checked,
                total: data.coverage.total,
                percent: coveragePercent(data.coverage.checked, data.coverage.total),
              })}
            </p>
            <p className="max-w-3xl text-sm text-muted-foreground">{t('coverageNote')}</p>
          </section>

          <section className="space-y-3" aria-labelledby="arrears-report-collections">
            <h2 id="arrears-report-collections" className="text-lg font-semibold">
              {t('collectionsTitle')}
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">{t('collectionsIntro')}</p>
            <DataTable
              columns={collectionColumns}
              data={data.collections}
              labels={collectionLabels}
              getRowId={(row) => `${row.year}|${row.currency}`}
              searchable={false}
              sortable={false}
              paginated={false}
              loading={false}
              error={null}
            />
          </section>

          <section className="space-y-3" aria-labelledby="arrears-report-batches">
            <h2 id="arrears-report-batches" className="text-lg font-semibold">
              {t('batchesTitle')}
            </h2>
            {data.approvedBatchCount > data.batches.length ? (
              <Alert variant="warning" live="status">
                {t('batchesTruncated', { shown: data.batches.length, total: data.approvedBatchCount })}
              </Alert>
            ) : null}
            <DataTable
              columns={batchColumns}
              data={data.batches}
              labels={batchLabels}
              getRowId={(row) => row.id}
              searchable={false}
              sortable={false}
              paginated={false}
              loading={false}
              error={null}
            />
          </section>
        </>
      )}
    </div>
  );
}

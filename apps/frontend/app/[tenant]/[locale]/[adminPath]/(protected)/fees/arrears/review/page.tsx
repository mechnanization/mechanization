'use client';

import { use, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { ClipboardCheck, Eye } from 'lucide-react';
import type { ArrearsBatchView } from '@mechanization/shared-schemas';
import { listArrearsBatches } from '@/lib/arrears-api';
import { formatDate } from '@/lib/dates';
import { ARREARS_APPROVE_ROLES, hasRole } from '@/lib/staff-roles';
import { param } from '@/lib/url-state';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { useUrlState } from '@/lib/use-url-state';
import { BatchReview } from '@/components/admin/arrears/batch-review';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';

const REVIEW_URL = { batch: param.id() };

/**
 * «اعتماد المتأخرات» (old debts task 8): the batches sent for approval, and the
 * one under review in `?batch=`. `ARREARS_APPROVE_ROLES`, the manager alone.
 * Approving raises the bills and locks the batch (task 5's route, proposed in
 * `lib/arrears-api.ts`).
 */
export default function ArrearsReviewPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('arrears.review');
  const { token, user } = useStaffSession(tenant, base);
  const canApprove = user ? hasRole(ARREARS_APPROVE_ROLES, user.role) : false;
  const [{ batch: batchId }, setUrl] = useUrlState(REVIEW_URL);

  const batches = useStaffQuery({
    queryKey: ['arrears-batches', tenant],
    queryFn: (session, signal) => listArrearsBatches(tenant, session, signal),
    tenant,
    base,
    token: canApprove ? token : null,
    errorMessage: t('listFailed'),
  });
  const submitted = useMemo(
    () => (batches.data?.items ?? []).filter((batch) => batch.status === 'SUBMITTED'),
    [batches.data],
  );
  const tableLabels = useTableLabels({ empty: t('nothingToReview') });
  const columns = useMemo<ColumnDef<ArrearsBatchView>[]>(
    () => [
      {
        id: 'submitted',
        header: t('submittedAt'),
        meta: { mobile: 'primary' },
        cell: ({ row }) => (row.original.submittedAt ? formatDate(row.original.submittedAt) : '—'),
      },
      { id: 'preparedBy', header: t('preparedBy'), cell: ({ row }) => row.original.preparedBy.name },
      {
        id: 'lines',
        header: t('lines'),
        meta: { align: 'end' as const },
        cell: ({ row }) => row.original.lineCount.toLocaleString('en-US'),
      },
      {
        id: 'control',
        header: t('controlTotal'),
        meta: { align: 'end' as const },
        cell: ({ row }) =>
          row.original.controlTotal === null ? '—' : <Money amount={row.original.controlTotal} currency="LBP" locale={locale} exact />,
      },
      {
        id: 'open',
        header: t('actions'),
        meta: { align: 'end' as const, mobile: 'actions' as const },
        cell: ({ row }) => (
          <Button variant="ghost" size="sm" className="!w-auto" onClick={() => setUrl({ batch: row.original.id })}>
            <Eye className="size-4" aria-hidden />
            {t('open')}
          </Button>
        ),
      },
    ],
    [t, locale, setUrl],
  );

  if (!user || !token) return <LoadingState />;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={`${base}/fees/arrears`} label={t('back')} />
      <PageHeader icon={ClipboardCheck} title={t('title')} />
      {!canApprove ? (
        <EmptyState icon={ClipboardCheck} title={t('notAllowedTitle')} description={t('notAllowedBody')} />
      ) : (
        <>
          {batchId ? (
            <section className="space-y-3" aria-labelledby="arrears-review-heading">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="arrears-review-heading" className="text-lg font-semibold">
                  {t('heading')}
                </h2>
                <Button variant="ghost" size="sm" className="!w-auto" onClick={() => setUrl({ batch: '' })}>
                  {t('close')}
                </Button>
              </div>
              <BatchReview
                key={batchId}
                tenant={tenant}
                base={base}
                token={token}
                locale={locale}
                batchId={batchId}
                onDone={() => setUrl({ batch: '' })}
              />
            </section>
          ) : null}
          {batches.error && !batches.data ? (
            <ErrorState title={t('listFailed')} description={batches.refusal ?? batches.error} offline={batches.offline} onRetry={batches.refetch} />
          ) : (
            <DataTable
              columns={columns}
              data={submitted}
              labels={tableLabels}
              getRowId={(row) => row.id}
              searchable={false}
              sortable={false}
              loading={batches.loading}
              error={null}
            />
          )}
        </>
      )}
    </div>
  );
}

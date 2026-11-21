'use client';

import { use, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Download, History, Plus, Upload } from 'lucide-react';
import { getLabels, type ArrearsBatchView } from '@mechanization/shared-schemas';
import { listArrearsBatches } from '@/lib/arrears-api';
import { formatDate } from '@/lib/dates';
import { ARREARS_PREPARE_ROLES, hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { param } from '@/lib/url-state';
import { useUrlState } from '@/lib/use-url-state';
import { ArrearsImportPanel } from '@/components/admin/arrears/arrears-import-panel';
import { ExportTemplateDialog } from '@/components/admin/arrears/export-template-dialog';
import { SingleLineDialog } from '@/components/admin/arrears/single-line-dialog';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { Button } from '@/components/ui/button';
import { CellTag } from '@/components/ui/cell-tag';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';

/** The batch being imported, in the URL so a reload keeps it. */
const ARREARS_URL = { batch: param.id() };

const STATUS_TONE = { DRAFT: 'muted', SUBMITTED: 'warning', APPROVED: 'success', DISCARDED: 'muted' } as const;

/**
 * «المتأخرات» — old debts, «متأخرات سنوات سابقة» (docs/old-debts-plan.md, task 7):
 * export a template for N citizens, import it into its DRAFT batch, check it,
 * decide the flagged lines, save it, reconcile it against the pages' total and
 * send it for approval; or enter one line found later. `ARREARS_PREPARE_ROLES`
 * (the accountant and the manager); anyone else who reaches it by its address
 * is told so. Nothing here is seen by a citizen until the manager approves.
 *
 * No nav row: «الرسوم والجباية» already has five, so the page sits under the
 * `/fees` row and is linked from the fees page, as «قائمة الإعفاء» is.
 */
export default function ArrearsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('arrears');
  const labels = getLabels(locale);
  const toast = useToast();
  const queryClient = useQueryClient();
  const { token, user } = useStaffSession(tenant, base);
  const canPrepare = user ? hasRole(ARREARS_PREPARE_ROLES, user.role) : false;
  const [{ batch: batchId }, setUrl] = useUrlState(ARREARS_URL);
  const [exportOpen, setExportOpen] = useState(false);
  const [singleOpen, setSingleOpen] = useState(false);

  const batches = useStaffQuery({
    queryKey: ['arrears-batches', tenant],
    queryFn: (session, signal) => listArrearsBatches(tenant, session, signal),
    tenant,
    base,
    token: canPrepare ? token : null,
    errorMessage: t('batches.loadFailed'),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['arrears-batches', tenant] });
  const tableLabels = useTableLabels({ empty: t('batches.empty') });

  const columns = useMemo<ColumnDef<ArrearsBatchView>[]>(
    () => [
      {
        id: 'created',
        header: t('batches.created'),
        meta: { mobile: 'primary' },
        cell: ({ row }) => formatDate(row.original.createdAt),
      },
      {
        id: 'status',
        header: t('batches.status'),
        cell: ({ row }) => (
          <CellTag tone={STATUS_TONE[row.original.status]}>{labels.arrearsBatchStatus[row.original.status]}</CellTag>
        ),
      },
      { id: 'preparedBy', header: t('batches.preparedBy'), cell: ({ row }) => row.original.preparedBy.name },
      {
        id: 'counts',
        header: t('batches.counts'),
        meta: { cellClassName: 'whitespace-normal' },
        cell: ({ row }) =>
          t('batches.countsValue', { citizens: row.original.citizenCount, lines: row.original.lineCount }),
      },
      {
        id: 'actions',
        header: t('batches.actions'),
        meta: { align: 'end' as const, mobile: 'actions' as const },
        cell: ({ row }) =>
          row.original.status === 'DRAFT' ? (
            <Button variant="ghost" size="sm" className="!w-auto" onClick={() => setUrl({ batch: row.original.id })}>
              <Upload className="size-4" aria-hidden />
              {t('batches.import')}
            </Button>
          ) : null,
      },
    ],
    [t, labels, setUrl],
  );

  if (!user || !token) return <LoadingState />;
  if (!canPrepare) {
    return (
      <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <PageHeader icon={History} title={t('title')} />
        <EmptyState icon={History} title={t('notAllowedTitle')} description={t('notAllowedBody')} />
      </div>
    );
  }

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={`${base}/fees`} label={t('back')} />
      <PageHeader
        icon={History}
        title={t('title')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setSingleOpen(true)}>
              <Plus className="size-4" aria-hidden />
              {t('single.open')}
            </Button>
            <Button onClick={() => setExportOpen(true)}>
              <Download className="size-4" aria-hidden />
              {t('export.open')}
            </Button>
          </div>
        }
      />
      <p className="max-w-3xl text-sm text-muted-foreground">{t('intro')}</p>

      {batchId ? (
        <section className="space-y-3" aria-labelledby="arrears-import-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="arrears-import-heading" className="text-lg font-semibold">
              {t('import.heading')}
            </h2>
            <Button variant="ghost" size="sm" className="!w-auto" onClick={() => setUrl({ batch: '' })}>
              {t('import.close')}
            </Button>
          </div>
          <ArrearsImportPanel key={batchId} tenant={tenant} token={token} locale={locale} batchId={batchId} onChanged={refresh} />
        </section>
      ) : null}

      <section className="space-y-3" aria-labelledby="arrears-batches-heading">
        <h2 id="arrears-batches-heading" className="text-lg font-semibold">
          {t('batches.heading')}
        </h2>
        {batches.error && !batches.data ? (
          <ErrorState
            title={t('batches.loadFailed')}
            description={batches.refusal ?? batches.error}
            retryLabel={t('retry')}
            onRetry={batches.refetch}
          />
        ) : (
          <DataTable
            columns={columns}
            data={batches.data?.items ?? []}
            labels={tableLabels}
            getRowId={(row) => row.id}
            searchable={false}
            sortable={false}
            loading={batches.loading}
            error={null}
          />
        )}
      </section>

      <ExportTemplateDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        tenant={tenant}
        base={base}
        token={token}
        onExported={(id) => {
          toast.success(t('export.done'));
          setUrl({ batch: id });
          refresh();
        }}
      />
      <SingleLineDialog
        open={singleOpen}
        onOpenChange={setSingleOpen}
        tenant={tenant}
        token={token}
        locale={locale}
        onAdded={() => {
          toast.success(t('single.done'));
          refresh();
        }}
      />
    </div>
  );
}

'use client';

import { use, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Link2, UserSearch } from 'lucide-react';
import { getLabels, type ArrearsUnmatchedLine } from '@mechanization/shared-schemas';
import { logApiError } from '@/lib/api-client';
import { getUnmatchedArrearsLines, linkArrearsLine } from '@/lib/arrears-api';
import { ARREARS_PREPARE_ROLES, hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { CitizenPicker, type PickedCitizen } from '@/components/admin/citizen-picker';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable } from '@/components/ui/data-table';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';

/**
 * «للمطابقة» (old debts decision 8, task 8): the lines of approved batches whose
 * person is not on the register, as the old books wrote them. A clerk links each
 * to a file with the one `CitizenPicker` (archived files offered too, decision
 * 12); its bill is raised then. Never matched by name automatically.
 * `ARREARS_PREPARE_ROLES`; the routes are task 5's, proposed in `lib/arrears-api.ts`.
 */
export default function ArrearsMatchPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('arrears.match');
  const labels = getLabels(locale);
  const toast = useToast();
  const queryClient = useQueryClient();
  const { token, user } = useStaffSession(tenant, base);
  const canLink = user ? hasRole(ARREARS_PREPARE_ROLES, user.role) : false;
  const [linking, setLinking] = useState<ArrearsUnmatchedLine | null>(null);
  const [citizen, setCitizen] = useState<PickedCitizen | null>(null);

  const lines = useStaffQuery({
    queryKey: ['arrears-unmatched', tenant],
    queryFn: (session, signal) => getUnmatchedArrearsLines(tenant, session, signal),
    tenant,
    base,
    token: canLink ? token : null,
    errorMessage: t('loadFailed'),
  });
  const tableLabels = useTableLabels({ empty: t('empty') });
  const columns = useMemo<ColumnDef<ArrearsUnmatchedLine>[]>(
    () => [
      {
        id: 'name',
        header: t('name'),
        meta: { mobile: 'primary', cellClassName: 'whitespace-normal' },
        cell: ({ row }) => (
          <div className="space-y-0.5">
            <p className="font-medium">{row.original.sourceName}</p>
            <p className="text-xs text-muted-foreground">
              <bdi dir="ltr">{row.original.propertyNumber}</bdi>
              {row.original.unitCode ? (
                <>
                  {' · '}
                  <bdi dir="ltr">{row.original.unitCode}</bdi>
                </>
              ) : null}
            </p>
          </div>
        ),
      },
      {
        id: 'debt',
        header: t('debt'),
        cell: ({ row }) => (
          <span>
            {labels.arrearsFeeType[row.original.feeType]} · <bdi dir="ltr">{row.original.year}</bdi> ·{' '}
            {labels.arrearsComponent[row.original.component]}
          </span>
        ),
      },
      {
        id: 'amount',
        header: t('amount'),
        meta: { align: 'end' as const },
        cell: ({ row }) => <Money amount={row.original.amount} currency="LBP" locale={locale} exact />,
      },
      {
        id: 'link',
        header: t('actions'),
        meta: { align: 'end' as const, mobile: 'actions' as const },
        cell: ({ row }) => (
          <Button variant="ghost" size="sm" className="!w-auto" onClick={() => setLinking(row.original)}>
            <Link2 className="size-4" aria-hidden />
            {t('link')}
          </Button>
        ),
      },
    ],
    [t, labels, locale],
  );

  const confirm = async (): Promise<void> => {
    if (!token || !linking || !citizen) return;
    try {
      await linkArrearsLine(tenant, token, linking.id, { citizenId: citizen.id });
    } catch (caught) {
      logApiError(caught);
      throw caught;
    }
    toast.success(t('done', { name: citizen.fullName }));
    setLinking(null);
    setCitizen(null);
    await queryClient.invalidateQueries({ queryKey: ['arrears-unmatched', tenant] });
  };

  if (!user || !token) return <LoadingState />;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={`${base}/fees/arrears`} label={t('back')} />
      <PageHeader icon={UserSearch} title={t('title')} />
      {!canLink ? (
        <EmptyState icon={UserSearch} title={t('notAllowedTitle')} description={t('notAllowedBody')} />
      ) : (
        <>
          <p className="max-w-3xl text-sm text-muted-foreground">{t('intro')}</p>
          {lines.error && !lines.data ? (
            <ErrorState title={t('loadFailed')} description={lines.refusal ?? lines.error} offline={lines.offline} onRetry={lines.refetch} />
          ) : (
            <DataTable
              columns={columns}
              data={lines.data?.items ?? []}
              labels={tableLabels}
              getRowId={(row) => row.id}
              searchable={false}
              sortable={false}
              loading={lines.loading}
              error={null}
            />
          )}
        </>
      )}

      <ConfirmDialog
        open={linking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setLinking(null);
            setCitizen(null);
          }
        }}
        destructive={false}
        title={t('linkTitle', { name: linking?.sourceName ?? '' })}
        description={t('linkBody')}
        confirmLabel={t('link')}
        cancelLabel={t('cancel')}
        busyLabel={t('busy')}
        confirmDisabled={!citizen}
        onConfirm={confirm}
      >
        <Field label={t('citizen')} htmlFor="arrears-match-citizen" required>
          <CitizenPicker
            id="arrears-match-citizen"
            tenant={tenant}
            token={token}
            value={citizen}
            onChange={setCitizen}
            includeArchived
          />
        </Field>
      </ConfirmDialog>
    </div>
  );
}

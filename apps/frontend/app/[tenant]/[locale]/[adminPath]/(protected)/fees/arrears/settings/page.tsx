'use client';

import { use, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Loader2, Save, Settings2 } from 'lucide-react';
import { arrearsCutoffSchema, type ArrearsControlTotalInput } from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError } from '@/lib/api-client';
import { getArrearsSettings, saveArrearsCutoff } from '@/lib/arrears-api';
import { ARREARS_APPROVE_ROLES, hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';

/**
 * Old debts' settings (task 8), the manager's (`ARREARS_APPROVE_ROLES`): the
 * cutoff year — old debt is a year before it; while none is set every import is
 * refused (decision 5), and once a batch is approved it is fixed
 * (`ARREARS_CUTOFF_LOCKED`) — and the old books' arrears total per year, shown
 * read-only: whether the municipality enters them is open-decisions §23.4, so
 * nothing here writes them and no route takes them.
 */
export default function ArrearsSettingsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('arrears.settings');
  const toast = useToast();
  const queryClient = useQueryClient();
  const { token, user } = useStaffSession(tenant, base);
  const canEdit = user ? hasRole(ARREARS_APPROVE_ROLES, user.role) : false;
  const [cutoff, setCutoff] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const settings = useStaffQuery({
    queryKey: ['arrears-settings', tenant],
    queryFn: (session, signal) => getArrearsSettings(tenant, session, signal),
    tenant,
    base,
    token: canEdit ? token : null,
    errorMessage: t('loadFailed'),
  });
  const shownCutoff = cutoff ?? (settings.data?.arrearsCutoffYear?.toString() ?? '');
  const cutoffInput = arrearsCutoffSchema.safeParse({
    arrearsCutoffYear: shownCutoff.trim() === '' ? null : Number(shownCutoff),
  });

  const saveCutoff = async () => {
    if (!token || inFlight.current || !cutoffInput.success) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await saveArrearsCutoff(tenant, token, cutoffInput.data);
      toast.success(t('cutoffSaved'));
      setCutoff(null);
      await queryClient.invalidateQueries({ queryKey: ['arrears-settings', tenant] });
    } catch (caught) {
      logApiError(caught);
      setError(caught instanceof ApiRequestError ? caught.message : t('saveFailed'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const tableLabels = useTableLabels({ empty: t('noTotals') });
  const columns = useMemo<ColumnDef<ArrearsControlTotalInput>[]>(
    () => [
      { id: 'year', header: t('year'), cell: ({ row }) => <bdi dir="ltr">{row.original.year}</bdi> },
      {
        id: 'amount',
        header: t('amount'),
        meta: { align: 'end' as const },
        cell: ({ row }) => <Money amount={row.original.amount} currency="LBP" locale={locale} exact />,
      },
    ],
    [t, locale],
  );

  if (!user || !token) return <LoadingState />;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={`${base}/fees/arrears`} label={t('back')} />
      <PageHeader icon={Settings2} title={t('title')} />
      {!canEdit ? (
        <EmptyState icon={Settings2} title={t('notAllowedTitle')} description={t('notAllowedBody')} />
      ) : settings.error && !settings.data ? (
        <ErrorState title={t('loadFailed')} description={settings.refusal ?? settings.error} offline={settings.offline} onRetry={settings.refetch} />
      ) : (
        <>
          {error ? (
            <Alert variant="destructive" live="alert">
              {error}
            </Alert>
          ) : null}
          <Card>
            <CardContent className="space-y-4 p-5">
              <h2 className="text-base font-semibold">{t('cutoffTitle')}</h2>
              <p className="text-sm text-muted-foreground">{t('cutoffBody')}</p>
              <div className="flex flex-wrap items-end gap-3">
                <Field label={t('cutoff')} htmlFor="arrears-cutoff" className="w-40">
                  <Input
                    id="arrears-cutoff"
                    inputMode="numeric"
                    dir="ltr"
                    value={shownCutoff}
                    disabled={settings.loading}
                    onChange={(event) => setCutoff(event.target.value)}
                  />
                </Field>
                <Button onClick={() => void saveCutoff()} disabled={!cutoffInput.success || busy || cutoff === null}>
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
                  {t('save')}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-4 p-5">
              <h2 className="text-base font-semibold">{t('totalsTitle')}</h2>
              <p className="text-sm text-muted-foreground">{t('totalsBody')}</p>
            </CardContent>
          </Card>
          <DataTable
            columns={columns}
            data={settings.data?.controlTotals ?? []}
            labels={tableLabels}
            getRowId={(row) => String(row.year)}
            searchable={false}
            sortable={false}
            paginated={false}
            loading={settings.loading}
            error={null}
          />
        </>
      )}
    </div>
  );
}

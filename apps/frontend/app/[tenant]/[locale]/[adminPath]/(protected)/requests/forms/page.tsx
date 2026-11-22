'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { FilePlus2, FileText, Pencil } from 'lucide-react';
import { getRequestForms, type RequestFormListItem } from '@/lib/request-forms-api';
import { hasRole, REQUEST_SETTINGS_ROLES } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { NewFormDialog } from '@/components/admin/request-forms/new-form-dialog';
import { Button } from '@/components/ui/button';
import { CellTag } from '@/components/ui/cell-tag';
import { DataTable } from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';

/** The state a form is in, said as one word; the word carries it and the colour only repeats it (COL-3). */
function stateOf(form: RequestFormListItem): 'archived' | 'live' | 'off' | 'unpublished' {
  if (form.archivedAt) return 'archived';
  if (form.fieldCount === 0) return 'unpublished';
  return form.enabled ? 'live' : 'off';
}

/**
 * «نماذج الإفادات» — the request forms the manager defines (open decisions §24, docs/request-forms-plan.md §6). Every form is
 * listed, archived ones included; a form is opened in the builder. Everyone who reads the queue may read the list
 * (`REQUEST_READ_ROLES`); only the manager creates (`REQUEST_SETTINGS_ROLES`), and the server enforces the same (CODE-4).
 */
export default function RequestFormsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('requests.forms.list');
  const router = useRouter();
  const { token, user } = useStaffSession(tenant, base);
  const canManage = user ? hasRole(REQUEST_SETTINGS_ROLES, user.role) : false;
  const [creating, setCreating] = useState(false);

  const query = useStaffQuery({
    queryKey: ['request-forms', tenant, 'list'],
    queryFn: (accessToken, signal) => getRequestForms(tenant, accessToken, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  const forms = useMemo(() => query.data ?? [], [query.data]);
  const tableLabels = useTableLabels({ empty: t('empty'), loadError: t('loadError') });

  const columns = useMemo<ColumnDef<RequestFormListItem>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        meta: { mobile: 'primary', cellClassName: 'whitespace-normal' },
        cell: ({ row }) => {
          const form = row.original;
          return (
            <div className="min-w-0 space-y-0.5">
              <Link href={`${base}/requests/forms/${form.id}`} className="font-medium hover:underline">
                {locale === 'en' && form.nameEn ? form.nameEn : form.nameAr}
              </Link>
              {form.systemType ? <p className="text-xs text-muted-foreground">{t('system')}</p> : null}
              {form.hasDraft && form.fieldCount > 0 ? <p className="text-xs text-muted-foreground">{t('draftPending')}</p> : null}
            </div>
          );
        },
      },
      {
        id: 'fee',
        header: t('columns.fee'),
        cell: ({ row }) =>
          row.original.feeAmount > 0 ? (
            <Money amount={row.original.feeAmount} locale={locale} exact className="text-sm" />
          ) : (
            <CellTag tone="muted">{t('free')}</CellTag>
          ),
      },
      {
        id: 'status',
        header: t('columns.status'),
        cell: ({ row }) => {
          const state = stateOf(row.original);
          return <CellTag tone={state === 'live' ? 'success' : 'muted'}>{t(`status.${state}`)}</CellTag>;
        },
      },
      { id: 'questions', header: t('columns.questions'), cell: ({ row }) => t('questions', { count: row.original.fieldCount }) },
      { id: 'requests', header: t('columns.requests'), cell: ({ row }) => t('requests', { count: row.original.requestCount }) },
      {
        id: 'actions',
        header: t('columns.actions'),
        enableSorting: false,
        meta: { align: 'end' as const, mobile: 'actions' as const },
        cell: ({ row }) => (
          <div className="flex items-center justify-end max-sm:w-full">
            <Button asChild variant="ghost" size="sm">
              <Link href={`${base}/requests/forms/${row.original.id}`}>
                <Pencil className="size-4" aria-hidden />
                {t('open')}
              </Link>
            </Button>
          </div>
        ),
      },
    ],
    [t, base, locale],
  );

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={`${base}/requests`} label={t('back')} />
      <PageHeader
        icon={FileText}
        title={t('title')}
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <FilePlus2 className="size-4" aria-hidden />
              {t('new')}
            </Button>
          ) : undefined
        }
      />

      {creating && token ? (
        <NewFormDialog
          tenant={tenant}
          token={token}
          locale={locale}
          onCancel={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            router.push(`${base}/requests/forms/${id}`);
          }}
        />
      ) : null}

      {/* `DataTable` draws its own frame; a card around it would be the double frame BAN-4 refuses. */}
      <DataTable
        columns={columns}
        data={forms}
        labels={tableLabels}
        getRowId={(form) => form.id}
        searchable={false}
        sortable={false}
        paginated={false}
        loading={query.loading}
        error={query.error}
        onRetry={query.refetch}
      />

      <p className="text-xs text-muted-foreground">{t('footnote')}</p>
    </div>
  );
}

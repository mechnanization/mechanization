'use client';

import { use, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { CirclePause, CirclePlay, Pencil, Plus, Tags } from 'lucide-react';
import { TREASURY_ADMIN_ROLES } from '@mechanization/shared-schemas';
import {
  getIncomeCategories,
  logApiError,
  updateIncomeCategory,
  type IncomeCategoryView,
} from '@/lib/api-client';
import { hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { IncomeCategoryEditor } from '@/components/admin/finance/income-category-editor';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';

/** Which editor is open: a new category, one being edited, or none. */
type Editing = { mode: 'new' } | { mode: 'edit'; category: IncomeCategoryView } | null;

/**
 * «بنود الإيرادات» — where income may be filed, and the manager's control of it.
 *
 * Every category is listed, stopped ones included: a voucher filed under a
 * category points at it for ever, so a category leaves the *forms* when it is
 * stopped but never leaves the record. Nothing here deletes one, and the
 * foreign key would refuse it anyway (migration 0080).
 *
 * The manager adds a category, renames it, gives it an English name or its
 * budget chapter and article, and stops or restarts it. The editor opens above
 * the list rather than in a dialog (BAN-10): it is a four-field form read
 * against the list beneath it — «is this one already here?» — and a modal would
 * cover exactly what it is checked against. Stopping is one press, reversible,
 * and says so; it asks no confirmation (DES-2, DES-4).
 *
 * Everyone who may read the register may read this list. It sits under
 * `/finance/income`, so `canAccessPath` matches that nav row by prefix
 * (`TREASURY_READ_ROLES`, CODE-4); the write controls are shown to
 * `TREASURY_ADMIN_ROLES` only, and `IncomeController` enforces the same.
 */
export default function IncomeCategoriesPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('finance.income.categories');
  const queryClient = useQueryClient();
  const toast = useToast();
  const { token, user } = useStaffSession(tenant, base);
  const canManage = user ? hasRole(TREASURY_ADMIN_ROLES, user.role) : false;

  const [editing, setEditing] = useState<Editing>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const toggleInFlight = useRef(false);

  const query = useStaffQuery({
    queryKey: ['treasury', tenant, 'income-categories', 'all'],
    queryFn: (accessToken, signal) =>
      getIncomeCategories(tenant, accessToken, { includeInactive: true }, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  const categories = useMemo(() => query.data ?? [], [query.data]);

  /** Every list that names categories — the forms', the register's and this one. */
  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ['treasury', tenant, 'income-categories'] });

  /*
    Stop or restart: the category's own content sent back as it is, with
    `active` flipped. In flight per row, so a double press cannot send the
    opposite of what was meant (STA-4).
  */
  const toggle = async (category: IncomeCategoryView): Promise<void> => {
    if (!token || toggleInFlight.current) return;
    toggleInFlight.current = true;
    setToggling(category.id);
    try {
      await updateIncomeCategory(tenant, token, {
        id: category.id,
        labelAr: category.labelAr,
        labelEn: category.labelEn ?? undefined,
        chapterCode: category.chapterCode ?? undefined,
        itemCode: category.itemCode ?? undefined,
        active: !category.active,
      });
      await refresh();
      toast.success(category.active ? t('stopped', { name: category.labelAr }) : t('restarted', { name: category.labelAr }));
    } catch (caught) {
      logApiError(caught);
      // Already the localised text for the code (TXT-6).
      toast.error(caught instanceof Error ? caught.message : t('toggleError'));
    } finally {
      toggleInFlight.current = false;
      setToggling(null);
    }
  };

  const tableLabels = useTableLabels({ empty: t('empty') });

  const columns = useMemo<ColumnDef<IncomeCategoryView>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        meta: { mobile: 'primary', cellClassName: 'whitespace-normal' },
        cell: ({ row }) => (
          <div className={row.original.active ? 'min-w-0 space-y-0.5' : 'min-w-0 space-y-0.5 text-muted-foreground'}>
            <p className="font-medium">{row.original.labelAr}</p>
            {row.original.labelEn ? (
              <p dir="ltr" className="text-start text-xs text-muted-foreground">
                {row.original.labelEn}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'budget',
        header: t('columns.budget'),
        cell: ({ row }) =>
          row.original.chapterCode && row.original.itemCode ? (
            <span className="text-sm tabular-nums">
              {t('budgetCodes', { chapter: row.original.chapterCode, item: row.original.itemCode })}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'status',
        header: t('columns.status'),
        cell: ({ row }) =>
          // The word carries the state; the colour only repeats it (COL-3).
          row.original.active ? (
            <Badge variant="soft-success">{t('active')}</Badge>
          ) : (
            <Badge variant="soft-muted">{t('inactive')}</Badge>
          ),
      },
      ...(canManage
        ? [
            {
              id: 'actions',
              header: t('columns.actions'),
              enableSorting: false,
              meta: { align: 'end' as const, mobile: 'actions' as const },
              cell: ({ row }: { row: { original: IncomeCategoryView } }) => (
                <div className="flex items-center justify-end gap-1 max-sm:w-full">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing({ mode: 'edit', category: row.original })}
                  >
                    <Pencil className="size-4" aria-hidden />
                    {t('edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={toggling === row.original.id}
                    onClick={() => void toggle(row.original)}
                  >
                    {row.original.active ? (
                      <CirclePause className="size-4" aria-hidden />
                    ) : (
                      <CirclePlay className="size-4" aria-hidden />
                    )}
                    {row.original.active ? t('stop') : t('restart')}
                  </Button>
                </div>
              ),
            } satisfies ColumnDef<IncomeCategoryView>,
          ]
        : []),
    ],
    // `toggle` closes over the token and the in-flight ref; the row state it reads is `toggling`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, canManage, toggling, token],
  );

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/finance/income`} label={t('back')} />

      <PageHeader
        icon={Tags}
        title={t('title')}
        actions={
          canManage && editing?.mode !== 'new' ? (
            <Button onClick={() => setEditing({ mode: 'new' })}>
              <Plus className="size-4" aria-hidden />
              {t('add')}
            </Button>
          ) : undefined
        }
      />

      {canManage && editing && token ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              <h2>
                {editing.mode === 'new' ? t('addTitle') : t('editTitle', { name: editing.category.labelAr })}
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Keyed by what is open, so switching rows starts the editor from that row's values. */}
            <IncomeCategoryEditor
              key={editing.mode === 'new' ? 'new' : editing.category.id}
              tenant={tenant}
              token={token}
              category={editing.mode === 'edit' ? editing.category : undefined}
              existing={categories}
              onCancel={() => setEditing(null)}
              onSaved={(saved) => {
                setEditing(null);
                void refresh();
                toast.success(editing.mode === 'new' ? t('added', { name: saved.labelAr }) : t('saved', { name: saved.labelAr }));
              }}
            />
          </CardContent>
        </Card>
      ) : null}

      {/* `DataTable` draws its own frame; a card around it would be the double frame BAN-4 refuses. */}
      <DataTable
        columns={columns}
        data={categories}
        labels={tableLabels}
        getRowId={(category) => category.id}
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

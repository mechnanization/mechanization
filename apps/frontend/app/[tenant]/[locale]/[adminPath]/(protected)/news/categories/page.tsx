'use client';

import { use, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Pencil, Plus, Power, Tags } from 'lucide-react';
import type { NewsCategoryView } from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError, updateNewsCategory } from '@/lib/api-client';
import { newsName, useNewsCategories } from '@/lib/news';
import { NEWS_EDITOR_ROLES, hasRole } from '@/lib/staff-roles';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { NewsCategoryDialog } from '@/components/admin/news/news-category-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable } from '@/components/ui/data-table';
import { ErrorState } from '@/components/ui/states';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';

/**
 * «أقسام الأخبار» — the categories an article is filed under, on Day3ati.
 *
 * Read and written as the signed-in user (`NEWS_EDITOR_ROLES`: the
 * administrator and the administrative officer). The list is Day3ati's, so it
 * is the same one its dashboard and the residents' app show; a category is
 * switched off and on, never deleted, and its key is fixed once it is added.
 * A switch sends the whole record, because Day3ati replaces it.
 */
export default function NewsCategoriesPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('news.categories');
  const toast = useToast();
  const queryClient = useQueryClient();
  const { token, user } = useStaffSession(tenant, base);
  const canEdit = user ? hasRole(NEWS_EDITOR_ROLES, user.role) : false;

  const query = useNewsCategories(tenant, base, token, { locale, errorMessage: t('loadError') });
  const categories = useMemo(
    () => [...(query.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key)),
    [query.data],
  );
  /** A new category goes after the last one, ten places on. */
  const suggestedOrder = categories.reduce((max, category) => Math.max(max, category.sortOrder), 0) + 10;

  /** The dialog: undefined closed, null adding, a category editing it. */
  const [editing, setEditing] = useState<NewsCategoryView | null | undefined>(undefined);
  const [toggling, setToggling] = useState<NewsCategoryView | null>(null);
  const inFlight = useRef(false);

  /** «إيقاف» / «تفعيل»: the whole record goes back, with the switch turned. */
  const toggle = async (): Promise<void> => {
    if (!token || !toggling || inFlight.current) return;
    inFlight.current = true;
    try {
      await updateNewsCategory(tenant, token, locale, toggling.id, {
        nameAr: toggling.name.ar,
        nameEn: toggling.name.en,
        nameFr: toggling.name.fr,
        icon: toggling.icon,
        sortOrder: toggling.sortOrder,
        isActive: !toggling.isActive,
      });
      toast.success(t(toggling.isActive ? 'deactivated' : 'activated', { name: newsName(toggling.name, locale) }));
      setToggling(null);
      await queryClient.invalidateQueries({ queryKey: ['news-categories', tenant] });
    } catch (caught) {
      logApiError(caught);
      throw new Error(caught instanceof ApiRequestError ? caught.message : t('saveFailed'));
    } finally {
      inFlight.current = false;
    }
  };

  const tNews = useTranslations('news');
  const tableLabels = useTableLabels({ empty: t('empty') });

  const columns = useMemo<ColumnDef<NewsCategoryView>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        meta: { mobile: 'primary', cellClassName: 'whitespace-normal' },
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium">{newsName(row.original.name, locale)}</p>
            {locale === 'en' ? (
              <p className="text-xs text-muted-foreground">{row.original.name.ar}</p>
            ) : row.original.name.en ? (
              <p className="text-xs text-muted-foreground" dir="ltr">
                {row.original.name.en}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'key',
        header: t('columns.key'),
        cell: ({ row }) => (
          <span className="font-mono text-xs" dir="ltr">
            {row.original.key}
          </span>
        ),
      },
      {
        id: 'icon',
        header: t('columns.icon'),
        meta: { mobile: 'hide' },
        cell: ({ row }) =>
          row.original.icon ? (
            <span className="font-mono text-xs" dir="ltr">
              {row.original.icon}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'order',
        header: t('columns.sortOrder'),
        meta: { align: 'end' as const, mobile: 'hide' },
        cell: ({ row }) => <span className="tabular-nums">{row.original.sortOrder.toLocaleString('en-US')}</span>,
      },
      {
        id: 'status',
        header: t('columns.status'),
        // The word carries the state; the colour only repeats it (COL-3).
        cell: ({ row }) => (
          <Badge variant={row.original.isActive ? 'soft-default' : 'soft-muted'}>
            {row.original.isActive ? t('active') : t('inactive')}
          </Badge>
        ),
      },
      ...(canEdit
        ? [
            {
              id: 'actions',
              header: t('columns.actions'),
              enableSorting: false,
              meta: { align: 'end' as const, mobile: 'actions' as const },
              cell: ({ row }: { row: { original: NewsCategoryView } }) => (
                <div className="flex flex-wrap items-center justify-end gap-1">
                  <Button variant="ghost" size="sm" className="!w-auto" onClick={() => setEditing(row.original)}>
                    <Pencil className="size-4" aria-hidden />
                    {t('edit')}
                  </Button>
                  <Button variant="ghost" size="sm" className="!w-auto" onClick={() => setToggling(row.original)}>
                    <Power className="size-4" aria-hidden />
                    {row.original.isActive ? t('deactivate') : t('activate')}
                  </Button>
                </div>
              ),
            } satisfies ColumnDef<NewsCategoryView>,
          ]
        : []),
    ],
    [t, locale, canEdit],
  );

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={Tags}
        title={t('title')}
        actions={
          canEdit ? (
            <Button onClick={() => setEditing(null)}>
              <Plus className="size-4" aria-hidden />
              {t('add')}
            </Button>
          ) : null
        }
      />

      <p className="max-w-3xl text-sm text-muted-foreground">{t('intro')}</p>

      {query.error && !query.data ? (
        // `DataTable` shows one generic line for any failure. Here the reason matters: no News access, News switched
        // off for the municipality and Day3ati being down each need a different next step, so it is said.
        <ErrorState
          title={tNews('loadFailedTitle')}
          description={query.refusal ?? query.error} offline={query.offline}
          retryLabel={tNews('retry')}
          onRetry={query.refetch}
        />
      ) : (
        /* `DataTable` draws its own frame; a card around it would be the double frame BAN-4 refuses. */
        <DataTable
          columns={columns}
          data={categories}
          labels={tableLabels}
          getRowId={(category) => category.id}
          searchable={false}
          sortable={false}
          paginated={false}
          loading={query.loading}
          error={null}
        />
      )}

      {editing !== undefined && token ? (
        <NewsCategoryDialog
          tenant={tenant}
          token={token}
          locale={locale}
          editing={editing}
          suggestedOrder={suggestedOrder}
          onClose={() => setEditing(undefined)}
        />
      ) : null}

      <ConfirmDialog
        open={toggling !== null}
        onOpenChange={(next) => {
          if (!next) setToggling(null);
        }}
        destructive={false}
        title={t(toggling?.isActive ? 'deactivateTitle' : 'activateTitle', {
          name: toggling ? newsName(toggling.name, locale) : '',
        })}
        description={t(toggling?.isActive ? 'deactivateBody' : 'activateBody')}
        confirmLabel={toggling?.isActive ? t('deactivate') : t('activate')}
        cancelLabel={t('cancel')}
        onConfirm={toggle}
      />
    </div>
  );
}

'use client';

import { use, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Megaphone, Pencil, Plus, Power } from 'lucide-react';
import { getLabels, type NewsPublisherView } from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError, updateNewsPublisher } from '@/lib/api-client';
import { newsName, useNewsPublishers } from '@/lib/news';
import { NEWS_EDITOR_ROLES, hasRole } from '@/lib/staff-roles';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { NewsPublisherDialog } from '@/components/admin/news/news-publisher-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CellTag } from '@/components/ui/cell-tag';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable } from '@/components/ui/data-table';
import { ErrorState } from '@/components/ui/states';
import { PageHeader } from '@/components/ui/page-header';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { readView } from '@/lib/read-view';
import { useToast } from '@/components/ui/toast';
import { navLabel } from '@/components/admin/nav';

/**
 * «ناشرو الأخبار» — who an article is published as, on Day3ati: the
 * municipality, a department, a committee or an organization.
 *
 * Read and written as the signed-in user (`NEWS_EDITOR_ROLES`). A publisher is
 * switched off and on, never deleted; a switch sends the whole record, because
 * Day3ati replaces it.
 */
export default function NewsPublishersPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('news.publishers');
  const labels = getLabels(locale);
  const toast = useToast();
  const queryClient = useQueryClient();
  const { token, user } = useStaffSession(tenant, base);
  const canEdit = user ? hasRole(NEWS_EDITOR_ROLES, user.role) : false;

  const query = useNewsPublishers(tenant, base, token, { locale, errorMessage: t('loadError') });
  const publishers = useMemo(() => query.data ?? [], [query.data]);

  /** The dialog: undefined closed, null adding, a publisher editing it. */
  const [editing, setEditing] = useState<NewsPublisherView | null | undefined>(undefined);
  const [toggling, setToggling] = useState<NewsPublisherView | null>(null);
  const inFlight = useRef(false);

  /** «إيقاف» / «تفعيل»: the whole record goes back, with the switch turned. */
  const toggle = async (): Promise<void> => {
    if (!token || !toggling || inFlight.current) return;
    inFlight.current = true;
    try {
      await updateNewsPublisher(tenant, token, locale, toggling.id, {
        nameAr: toggling.name.ar,
        nameEn: toggling.name.en,
        nameFr: toggling.name.fr,
        kind: toggling.kind,
        isActive: !toggling.isActive,
      });
      toast.success(t(toggling.isActive ? 'deactivated' : 'activated', { name: newsName(toggling.name, locale) }));
      setToggling(null);
      await queryClient.invalidateQueries({ queryKey: ['news-publishers', tenant] });
    } catch (caught) {
      logApiError(caught);
      throw new Error(caught instanceof ApiRequestError ? caught.message : t('saveFailed'));
    } finally {
      inFlight.current = false;
    }
  };

  const tNews = useTranslations('news');
  const tableLabels = useTableLabels({ empty: t('empty') });

  const columns = useMemo<ColumnDef<NewsPublisherView>[]>(
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
        id: 'kind',
        header: t('columns.kind'),
        cell: ({ row }) => <CellTag>{labels.newsPublisherKind[row.original.kind]}</CellTag>,
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
              cell: ({ row }: { row: { original: NewsPublisherView } }) => (
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
            } satisfies ColumnDef<NewsPublisherView>,
          ]
        : []),
    ],
    [t, labels, locale, canEdit],
  );

  const view = readView(query.data, query.error);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={`${base}/news/articles`} label={t('back')} />

      <PageHeader
        icon={Megaphone}
        title={navLabel('newsPublishers', locale)}
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

      {view.state === 'ready' && view.refreshFailed ? (
        <RefreshFailedAlert message={query.refusal ?? view.refreshFailed} onRetry={query.refetch} />
      ) : null}

      {view.state === 'failed' ? (
        // `DataTable` shows one generic line for any failure. Here the reason matters: no News access, News switched
        // off for the municipality and Day3ati being down each need a different next step, so it is said.
        <ErrorState
          title={tNews('loadFailedTitle')}
          description={query.refusal ?? view.error} offline={query.offline}
          retryLabel={tNews('retry')}
          onRetry={query.refetch}
        />
      ) : (
        /* `DataTable` draws its own frame; a card around it would be the double frame BAN-4 refuses. */
        <DataTable
          columns={columns}
          data={publishers}
          labels={tableLabels}
          getRowId={(publisher) => publisher.id}
          searchable={false}
          sortable={false}
          paginated={false}
          loading={query.loading}
          error={null}
        />
      )}

      {editing !== undefined && token ? (
        <NewsPublisherDialog
          tenant={tenant}
          token={token}
          locale={locale}
          editing={editing}
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

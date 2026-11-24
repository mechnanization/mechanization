'use client';

import Link from 'next/link';
import { use, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { Newspaper, Plus } from 'lucide-react';
import {
  NEWS_ARTICLES_PAGE_DEFAULT,
  NEWS_ARTICLE_STATUS,
  getLabels,
  type NewsArticleListItem,
} from '@mechanization/shared-schemas';
import { getNewsArticles, logApiError } from '@/lib/api-client';
import { formatMunicipalDateTime, newsName, newsStatusVariant, useNewsArticlesPage, useNewsCategories } from '@/lib/news';
import { param } from '@/lib/url-state';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { useUrlState } from '@/lib/use-url-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { ErrorState } from '@/components/ui/states';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedControl } from '@/components/ui/segmented-control';

const FILTERS = { status: param.oneOf(['all', ...NEWS_ARTICLE_STATUS] as const, 'all') };

/**
 * «الأخبار» — the municipality's News articles, kept on Day3ati: every status,
 * newest edit first, a page at a time (Day3ati pages by cursor, so «عرض
 * المزيد» asks for the next page and the list grows).
 *
 * Reached by `NEWS_EDITOR_ROLES` (the nav row and the route guard). An article
 * opens in the editor; «خبر جديد» starts a draft.
 */
export default function NewsArticlesPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('news.articles');
  const labels = getLabels(locale);
  const router = useRouter();
  const { token } = useStaffSession(tenant, base);
  const [filters, setFilters] = useUrlState(FILTERS);
  const status = filters.status === 'all' ? undefined : filters.status;

  const first = useNewsArticlesPage(tenant, base, token, { locale, status, errorMessage: t('loadError') });
  const categories = useNewsCategories(tenant, base, token, { locale, errorMessage: t('loadError') });

  /** The pages after the first, once asked for. The first page is the query's, so a re-read resets them. */
  const [tail, setTail] = useState<{ items: NewsArticleListItem[]; nextCursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const ask = useRef(0);

  useEffect(() => {
    ask.current += 1;
    setTail(null);
    setMoreFailed(false);
  }, [first.data, status]);

  const items = useMemo(() => [...(first.data?.items ?? []), ...(tail?.items ?? [])], [first.data, tail]);
  const nextCursor = tail ? tail.nextCursor : (first.data?.nextCursor ?? null);

  const loadMore = async (): Promise<void> => {
    if (!token || !nextCursor || loadingMore) return;
    const mine = ask.current;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const page = await getNewsArticles(tenant, token, locale, { status, cursor: nextCursor, limit: NEWS_ARTICLES_PAGE_DEFAULT });
      // The list changed (another filter, a re-read) while this was on its way: its answer belongs to the old one.
      if (ask.current !== mine) return;
      setTail((current) => ({ items: [...(current?.items ?? []), ...page.items], nextCursor: page.nextCursor }));
    } catch (caught) {
      logApiError(caught);
      if (ask.current === mine) setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const categoryName = useMemo(() => {
    const byId = new Map((categories.data ?? []).map((category) => [category.id, newsName(category.name, locale)]));
    return (id: string): string => byId.get(id) ?? t('noCategory');
  }, [categories.data, locale, t]);

  const tNews = useTranslations('news');
  const tableLabels = useTableLabels({ empty: t('empty') });

  const columns = useMemo<ColumnDef<NewsArticleListItem>[]>(
    () => [
      {
        id: 'title',
        header: t('columns.title'),
        meta: { mobile: 'primary', cellClassName: 'whitespace-normal' },
        cell: ({ row }) => (
          <div className="min-w-0 space-y-1">
            <Link
              href={`${base}/news/articles/${row.original.id}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {row.original.title}
            </Link>
            {row.original.isPinned || row.original.isFeatured ? (
              <div className="flex flex-wrap gap-1">
                {row.original.isPinned ? <Badge variant="soft-default">{t('pinned')}</Badge> : null}
                {row.original.isFeatured ? <Badge variant="soft-default">{t('featured')}</Badge> : null}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'status',
        header: t('columns.status'),
        cell: ({ row }) => (
          <Badge variant={newsStatusVariant(row.original.status)}>{labels.newsArticleStatus[row.original.status]}</Badge>
        ),
      },
      {
        id: 'category',
        header: t('columns.category'),
        meta: { mobile: 'hide' },
        cell: ({ row }) => categoryName(row.original.categoryId),
      },
      {
        id: 'date',
        header: t('columns.date'),
        meta: { mobile: 'hide' },
        cell: ({ row }) => {
          const { status: rowStatus, publishAt, publishedAt, updatedAt } = row.original;
          // The moment that matters for the status: when it goes out, when it did, or when it was last touched.
          const text =
            rowStatus === 'scheduled' && publishAt
              ? t('scheduledFor', { when: formatMunicipalDateTime(publishAt) })
              : rowStatus === 'published' && publishedAt
                ? t('publishedOn', { when: formatMunicipalDateTime(publishedAt) })
                : t('editedOn', { when: formatMunicipalDateTime(updatedAt) });
          return (
            <span className="tabular-nums" dir="ltr">
              {text}
            </span>
          );
        },
      },
    ],
    [t, labels, base, categoryName],
  );

  const statusOptions = useMemo(
    () => [
      { value: 'all', label: t('filterAll') },
      ...NEWS_ARTICLE_STATUS.map((value) => ({ value, label: labels.newsArticleStatus[value] })),
    ],
    [t, labels],
  );

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={Newspaper}
        title={t('title')}
        actions={
          <Button onClick={() => router.push(`${base}/news/articles/new`)}>
            <Plus className="size-4" aria-hidden />
            {t('new')}
          </Button>
        }
      />

      <p className="max-w-3xl text-sm text-muted-foreground">{t('intro')}</p>

      <SegmentedControl
        aria-label={t('filterLabel')}
        value={filters.status}
        options={statusOptions}
        onChange={(value) => setFilters({ status: value as typeof filters.status })}
        fullWidth={false}
      />

      {first.error && !first.data ? (
        // `DataTable` shows one generic line for any failure. Here the reason matters: no News access, News switched
        // off for the municipality and Day3ati being down each need a different next step, so it is said.
        <ErrorState
          title={tNews('loadFailedTitle')}
          description={first.refusal ?? first.error} offline={first.offline}
          retryLabel={tNews('retry')}
          onRetry={first.refetch}
        />
      ) : (
        /* `DataTable` draws its own frame; a card around it would be the double frame BAN-4 refuses. */
        <DataTable
          columns={columns}
          data={items}
          labels={tableLabels}
          getRowId={(article) => article.id}
          searchable={false}
          sortable={false}
          paginated={false}
          loading={first.loading}
          error={null}
        />
      )}

      {moreFailed ? (
        <Alert variant="destructive" live="alert">
          {t('loadMoreFailed')}
        </Alert>
      ) : null}

      {nextCursor ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? t('loadingMore') : t('loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

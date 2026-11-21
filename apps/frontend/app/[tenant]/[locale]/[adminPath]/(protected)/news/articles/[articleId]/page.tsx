'use client';

import { use } from 'react';
import { useTranslations } from 'next-intl';
import { useNewsArticle } from '@/lib/news';
import { useStaffSession } from '@/lib/use-staff-session';
import { ArticleEditor } from '@/components/admin/news/article-editor';
import { ErrorState, LoadingState } from '@/components/ui/states';

/**
 * One article in the editor. It is read fresh from Day3ati each time the page
 * opens, because it is about to be changed; the editor starts from that read
 * and keeps its own copy from then on.
 */
export default function NewsArticlePage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; articleId: string }>;
}) {
  const { tenant, locale, adminPath, articleId } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('news.articles.editor');
  const tNews = useTranslations('news');
  const { token } = useStaffSession(tenant, base);
  const query = useNewsArticle(tenant, base, token, articleId, {
    locale: locale === 'en' ? 'en' : 'ar',
    errorMessage: t('loadError'),
  });

  if (!query.data) {
    if (query.error) {
      return (
        <ErrorState
          title={tNews('loadFailedTitle')}
          description={query.refusal ?? query.error}
          retryLabel={tNews('retry')}
          onRetry={query.refetch}
        />
      );
    }
    return <LoadingState />;
  }
  if (!token) return <LoadingState />;

  return (
    <ArticleEditor
      key={query.data.id}
      tenant={tenant}
      base={base}
      locale={locale === 'en' ? 'en' : 'ar'}
      token={token}
      initial={query.data}
    />
  );
}

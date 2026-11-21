'use client';

import { use } from 'react';
import { useStaffSession } from '@/lib/use-staff-session';
import { ArticleEditor } from '@/components/admin/news/article-editor';
import { LoadingState } from '@/components/ui/states';

/** «خبر جديد» — a blank article. Saving it makes a draft on Day3ati and moves on to that draft's own address. */
export default function NewNewsArticlePage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const { token } = useStaffSession(tenant, base);

  if (!token) return <LoadingState />;
  return (
    <ArticleEditor tenant={tenant} base={base} locale={locale === 'en' ? 'en' : 'ar'} token={token} initial={null} />
  );
}

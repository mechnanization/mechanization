import { redirect } from 'next/navigation';
import { forwardedHref, type SearchParams } from '@/lib/legacy-address';

/** «ملاحظات الجودة» is a tab of «الجودة» now (NAV-03): `/quality?tab=findings`, its filters and open finding kept. */
export default async function QualityFindingsForward({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
  searchParams: Promise<SearchParams>;
}): Promise<never> {
  const { tenant, locale, adminPath } = await params;
  redirect(
    forwardedHref(`/${tenant}/${locale}/${adminPath}`, '/quality', await searchParams, { set: { tab: 'findings' } }),
  );
}

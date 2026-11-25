import { redirect } from 'next/navigation';
import { forwardedHref, type SearchParams } from '@/lib/legacy-address';

/**
 * «السجلات» is the first tab of «الجودة» now (NAV-03): `/quality?tab=reviews`.
 *
 * The queue's own state filter was `?tab=` here and is `?queue=` there, because
 * the page's `?tab=` says which of the four screens is open; an old link's
 * filters carry over under the new name. A server redirect, as the treasury's
 * old addresses are: nothing renders here.
 */
export default async function QualityReviewsForward({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
  searchParams: Promise<SearchParams>;
}): Promise<never> {
  const { tenant, locale, adminPath } = await params;
  redirect(
    forwardedHref(`/${tenant}/${locale}/${adminPath}`, '/quality', await searchParams, {
      rename: { tab: 'queue' },
      set: { tab: 'reviews' },
    }),
  );
}

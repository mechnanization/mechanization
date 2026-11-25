import { redirect } from 'next/navigation';
import { forwardedHref, type SearchParams } from '@/lib/legacy-address';
import {
  REINSPECTIONS_OWNER_KEY,
  REINSPECTIONS_PAGE_KEY,
  REINSPECTIONS_SIZE_KEY,
} from '@/lib/worklist-tabs';

/**
 * «بانتظار إعادة الكشف» is the second tab of «قوائم العمل الميداني» now (NAV-04):
 * `/buildings/worklists?tab=reinspections`. Its page, page size and officer filter
 * carry over under the names the tab keeps them by, so «وحدات غير ممسوحة» beside
 * it can keep `?page=`, `?limit=` and `?owner=`. A server redirect: nothing renders here.
 */
export default async function ReinspectionsForward({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
  searchParams: Promise<SearchParams>;
}): Promise<never> {
  const { tenant, locale, adminPath } = await params;
  redirect(
    forwardedHref(`/${tenant}/${locale}/${adminPath}`, '/buildings/worklists', await searchParams, {
      rename: { page: REINSPECTIONS_PAGE_KEY, limit: REINSPECTIONS_SIZE_KEY, owner: REINSPECTIONS_OWNER_KEY },
      set: { tab: 'reinspections' },
    }),
  );
}

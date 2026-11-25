import { redirect } from 'next/navigation';
import { forwardedHref, type SearchParams } from '@/lib/legacy-address';

/**
 * «وحدات غير ممسوحة» is the first tab of «قوائم العمل الميداني» now (NAV-04):
 * `/buildings/worklists`, its `?page=`, `?limit=` and `?owner=` kept as they are.
 * A server redirect: nothing renders here.
 */
export default async function UnsurveyedUnitsForward({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
  searchParams: Promise<SearchParams>;
}): Promise<never> {
  const { tenant, locale, adminPath } = await params;
  redirect(
    forwardedHref(`/${tenant}/${locale}/${adminPath}`, '/buildings/worklists', await searchParams, {
      set: { tab: 'unsurveyed' },
    }),
  );
}

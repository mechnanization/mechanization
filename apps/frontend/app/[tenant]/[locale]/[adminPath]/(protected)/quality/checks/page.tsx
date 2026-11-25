import { redirect } from 'next/navigation';
import { forwardedHref, type SearchParams } from '@/lib/legacy-address';

/** «التحقق الميداني» is a tab of «الجودة» now (NAV-03): `/quality?tab=checks`, its status filter kept. */
export default async function QualityChecksForward({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
  searchParams: Promise<SearchParams>;
}): Promise<never> {
  const { tenant, locale, adminPath } = await params;
  redirect(
    forwardedHref(`/${tenant}/${locale}/${adminPath}`, '/quality', await searchParams, { set: { tab: 'checks' } }),
  );
}

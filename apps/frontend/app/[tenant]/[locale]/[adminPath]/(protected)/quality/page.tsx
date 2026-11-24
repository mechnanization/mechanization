import { redirect } from 'next/navigation';

/**
 * «مراجعة الجودة» was one page with four tabs; it is four pages now.
 *
 * This address stays as a forward rather than a 404. It is what the sidebar
 * pointed at until that change, so it is in browser histories and in at least
 * one bookmark, and a link that silently became nothing is worse than one that
 * still lands somewhere sensible.
 *
 * «السجلات» is the destination because it is the one with a queue: the other
 * three are things you go and look at, that one is work waiting to be done.
 *
 * A server redirect (NAV-12), as the treasury's old addresses are
 * (`finance/income`): nothing renders here, so there is no skeleton to flash
 * before a client effect runs, and nothing for the route guard to check — the
 * page it lands on is guarded by its own nav row.
 */
export default async function QualityIndexPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}): Promise<never> {
  const { tenant, locale, adminPath } = await params;
  redirect(`/${tenant}/${locale}/${adminPath}/quality/reviews`);
}

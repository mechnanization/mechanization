import { redirect } from 'next/navigation';

/**
 * «حسابي» is retired (PAGE-03, decision U-21, 2026-11-24): «ملفّي» shows the same
 * file, properties and bills, and signs a citizen out the same way. The address
 * stays so a bookmark or an old link lands on «ملفّي».
 */
export default async function MyAccountRetired({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant, locale } = await params;
  redirect(`/${tenant}/${locale}/my-file`);
}

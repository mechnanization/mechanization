import { redirect } from 'next/navigation';

/**
 * «تسجيل نفقة»'s old address. Receiving and paying are recorded on one page
 * now, «الإيرادات والنفقات» (`/finance/movements`, 2026-10-12), and `?dir=out`
 * opens it on «صرف».
 */
export default async function NewExpenseMoved({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}): Promise<never> {
  const { tenant, locale, adminPath } = await params;
  redirect(`/${tenant}/${locale}/${adminPath}/finance/movements?dir=out`);
}

import { redirect } from 'next/navigation';

/**
 * The income register's old address. «الإيرادات» and «النفقات» are one register
 * now, «الحركات المالية» (`/finance/transactions`, 2026-10-12); a bookmark or a
 * link written before that lands on it, narrowed to money received.
 *
 * A server redirect: nothing renders here, so there is nothing for the route
 * guard to check — the page it lands on is guarded by its own nav row.
 */
export default async function IncomeRegisterMoved({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}): Promise<never> {
  const { tenant, locale, adminPath } = await params;
  redirect(`/${tenant}/${locale}/${adminPath}/finance/transactions?dir=in`);
}

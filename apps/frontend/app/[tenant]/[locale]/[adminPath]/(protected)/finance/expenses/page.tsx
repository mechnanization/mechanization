import { redirect } from 'next/navigation';
import { EXPENSE_REQUEST_STATUSES } from '@mechanization/shared-schemas';

/**
 * The expense register's old address. «الإيرادات» and «النفقات» are one register
 * now, «الحركات المالية» (`/finance/transactions`, 2026-10-12); a bookmark or a
 * link written before that lands on it, narrowed to money paid out — or on
 * what waits for the head's order, for a link to `?view=queue`, keeping the
 * queue's `?status=` when it names one.
 *
 * A server redirect: nothing renders here, so there is nothing for the route
 * guard to check — the page it lands on is guarded by its own nav row.
 */
export default async function ExpenseRegisterMoved({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const { tenant, locale, adminPath } = await params;
  const query = await searchParams;
  const target = new URLSearchParams();
  if (query.view === 'queue') {
    target.set('view', 'queue');
    const status = typeof query.status === 'string' ? query.status : '';
    if ((EXPENSE_REQUEST_STATUSES as readonly string[]).includes(status)) target.set('status', status);
  } else {
    target.set('dir', 'out');
  }
  redirect(`/${tenant}/${locale}/${adminPath}/finance/transactions?${target.toString()}`);
}

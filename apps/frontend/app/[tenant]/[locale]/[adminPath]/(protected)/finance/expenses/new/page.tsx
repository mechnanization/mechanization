'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Receipt } from 'lucide-react';
import { TREASURY_WORK_ROLES } from '@mechanization/shared-schemas';
import { getExpenseCategories, getTreasuryOverview } from '@/lib/api-client';
import { hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { RecordExpenseForm } from '@/components/admin/finance/record-expense-form';
import { Alert } from '@/components/ui/alert';
import { BackLink } from '@/components/ui/back-link';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';

/**
 * «سجّل نفقة» — the recording form, at its own address.
 *
 * It was a dialog over the register, which BAN-10 refuses for a task that needs
 * neither interruption nor protected focus: this is a nine-field form worked
 * through with an invoice in hand. A route also means the browser's back button
 * does what it says and a half-filled form cannot be lost to a stray click on an
 * overlay.
 *
 * It sits under `/finance/expenses`, so `canAccessPath` matches that nav row by
 * prefix and the page is reachable by everyone who may *read* the register —
 * recording is narrower, so the page checks the role itself and says who may do
 * it, while `ExpensesController` is what actually enforces it (CODE-4).
 */
export default function NewExpensePage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const registerHref = `${base}/finance/expenses`;
  const t = useTranslations('finance.expenses');
  const router = useRouter();
  const { token, user } = useStaffSession(tenant, base);

  const canRecord = user ? hasRole(TREASURY_WORK_ROLES, user.role) : false;

  const overview = useStaffQuery({
    queryKey: ['treasury', tenant, 'overview'],
    queryFn: (accessToken, signal) => getTreasuryOverview(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });

  const categories = useStaffQuery({
    queryKey: ['treasury', tenant, 'expense-categories'],
    queryFn: (accessToken, signal) => getExpenseCategories(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    reference: true,
    errorMessage: t('loadError'),
  });

  const ready = Boolean(token) && Boolean(overview.data) && Boolean(categories.data);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Named for where it goes — the register, not the treasury the register sits under. */}
      <BackLink fallbackHref={registerHref} label={t('backToRegister')} />

      <PageHeader icon={Receipt} title={t('form.title')} />

      {overview.error ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={overview.error} onRetry={overview.refetch} />
          </CardContent>
        </Card>
      ) : !user || !ready ? (
        <FormSkeleton />
      ) : !canRecord ? (
        <Alert variant="warning" title={t('notAllowedTitle')}>
          {t('notAllowedBody')}
        </Alert>
      ) : !overview.data?.active ? (
        <Alert variant="warning" title={t('notActiveTitle')}>
          {t('notActiveBody')}
        </Alert>
      ) : (
        <RecordExpenseForm
          tenant={tenant}
          token={token!}
          locale={locale}
          role={user.role}
          backHref={registerHref}
          accounts={overview.data.accounts}
          categories={categories.data ?? []}
          onRecorded={() => router.push(registerHref)}
        />
      )}
    </div>
  );
}

/** The shape the form leaves, so the page does not jump when the wallets land. */
function FormSkeleton(): React.JSX.Element {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start" aria-hidden>
      <div className="space-y-6">
        {Array.from({ length: 3 }, (_, section) => (
          <div key={section} className="space-y-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-lg" />
    </div>
  );
}

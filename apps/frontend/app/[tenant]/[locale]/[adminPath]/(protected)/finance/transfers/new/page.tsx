'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowRightLeft } from 'lucide-react';
import { TREASURY_WORK_ROLES } from '@mechanization/shared-schemas';
import { getTreasuryOverview } from '@/lib/api-client';
import { hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { RecordTransferForm } from '@/components/admin/finance/record-transfer-form';
import { Alert } from '@/components/ui/alert';
import { BackLink } from '@/components/ui/back-link';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';

/**
 * «مناقلة جديدة» — an internal transfer or an exchange, on its own page.
 *
 * Under `/finance/transfers`, so `canAccessPath` matches that nav row by prefix
 * and every finance reader reaches it; recording is narrower, so the page
 * checks the role and says who may, while `TransfersController` enforces it
 * (CODE-4). The wallets and the rule come from the treasury overview, which
 * already leaves a collector's custody out.
 */
export default function NewTransferPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const registerHref = `${base}/finance/transfers`;
  const t = useTranslations('finance.transfers');
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

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={registerHref} label={t('backToRegister')} />

      <PageHeader icon={ArrowRightLeft} title={t('form.title')} />

      {overview.error ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={overview.error} onRetry={overview.refetch} />
          </CardContent>
        </Card>
      ) : !user || !token || !overview.data ? (
        <FormSkeleton />
      ) : !canRecord ? (
        <Alert variant="warning" title={t('notAllowedTitle')}>
          {t('notAllowedBody')}
        </Alert>
      ) : !overview.data.active ? (
        <Alert variant="warning" title={t('notActiveTitle')}>
          {t('notActiveBody')}
        </Alert>
      ) : (
        <RecordTransferForm
          tenant={tenant}
          token={token}
          locale={locale}
          backHref={registerHref}
          accounts={overview.data.accounts}
          rate={overview.data.rate}
          onRecorded={() => router.push(registerHref)}
          onPrint={(transferId) => router.push(`${base}/finance/transfers/${transferId}/print?print=1`)}
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
        <Skeleton className="h-10 w-full" />
        {Array.from({ length: 3 }, (_, section) => (
          <div key={section} className="space-y-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-lg" />
    </div>
  );
}

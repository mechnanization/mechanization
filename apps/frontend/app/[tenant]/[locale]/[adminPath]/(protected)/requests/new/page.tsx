'use client';

import { use } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { FilePlus2 } from 'lucide-react';
import { getRequestTypes } from '@/lib/requests-api';
import { hasRole, REQUEST_HANDLE_ROLES, REQUEST_SETTINGS_ROLES } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { CounterRequestForm } from '@/components/admin/requests/counter-request-form';
import { Alert } from '@/components/ui/alert';
import { BackLink } from '@/components/ui/back-link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';

/**
 * «طلب جديد عند الشبّاك» — a municipal request filed by a clerk for a citizen
 * at the counter (docs/municipal-requests-plan.md, open decisions §20 D8).
 *
 * A page, not a dialog (BAN-10): finding the person, their property and the
 * papers they hand over is a sitting's work. Filing is `REQUEST_HANDLE_ROLES`;
 * anyone else who reaches the address is told so, and the server refuses them
 * regardless (CODE-4). The types offered are the manager's list, switched on.
 */
export default function NewCounterRequestPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('requests.form');
  const { token, user } = useStaffSession(tenant, base);
  const canHandle = user ? hasRole(REQUEST_HANDLE_ROLES, user.role) : false;
  const canSet = user ? hasRole(REQUEST_SETTINGS_ROLES, user.role) : false;

  const types = useStaffQuery({
    queryKey: ['requests', tenant, 'types'],
    queryFn: (accessToken, signal) => getRequestTypes(tenant, accessToken, signal),
    tenant,
    base,
    token: canHandle ? token : null,
    errorMessage: t('typesError'),
  });
  const offered = (types.data ?? []).filter((setting) => setting.enabled);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/requests`} label={t('back')} />
      <PageHeader icon={FilePlus2} title={t('title')} />

      {!user ? (
        <Skeleton className="h-64 w-full" />
      ) : !canHandle ? (
        <Alert variant="warning">{t('notAllowed')}</Alert>
      ) : types.loading ? (
        <Skeleton className="h-64 w-full" />
      ) : types.error ? (
        <ErrorState title={types.error} onRetry={types.refetch} retryLabel={t('retry')} />
      ) : offered.length === 0 ? (
        <EmptyState
          icon={FilePlus2}
          title={t('noTypes')}
          description={canSet ? t('noTypesManager') : t('noTypesAsk')}
          action={
            canSet ? (
              <Button asChild variant="outline">
                <Link href={`${base}/requests/types`}>{t('openTypes')}</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <CounterRequestForm
          tenant={tenant}
          base={base}
          locale={locale}
          token={token}
          role={user.role}
          types={offered}
        />
      )}
    </div>
  );
}

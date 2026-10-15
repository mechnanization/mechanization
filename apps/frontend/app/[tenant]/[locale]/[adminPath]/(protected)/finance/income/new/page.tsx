'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CircleDollarSign } from 'lucide-react';
import { TREASURY_WORK_ROLES } from '@mechanization/shared-schemas';
import { getIncomeCategories, getTreasuryOverview } from '@/lib/api-client';
import { hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { RecordIncomeForm } from '@/components/admin/finance/record-income-form';
import { TreasuryFormSkeleton } from '@/components/admin/finance/treasury-form-parts';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { Alert } from '@/components/ui/alert';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';

/**
 * «تسجيل إيراد جديد» — the recording form, at its own address.
 *
 * A page and not a dialog, for the reason the expense form is one (BAN-10): a
 * seven-field form worked through with a bank slip or a cheque in hand, which
 * a stray click on an overlay must not throw away, and which a clerk can be
 * sent to by its address.
 *
 * It sits under `/finance/income`, so `canAccessPath` matches that nav row by
 * prefix and the page is reachable by everyone who may *read* the register —
 * recording is narrower, so the page checks the role itself and says who may do
 * it, while `IncomeController` is what actually enforces it (CODE-4).
 */
export default function NewIncomePage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const registerHref = `${base}/finance/income`;
  const t = useTranslations('finance.income');
  const tCommon = useTranslations('common');
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
    queryKey: ['treasury', tenant, 'income-categories'],
    queryFn: (accessToken, signal) => getIncomeCategories(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    reference: true,
    errorMessage: t('loadError'),
  });

  const ready = Boolean(token) && Boolean(overview.data) && Boolean(categories.data);
  /*
    Either read failing *before it ever answered* is a panel that says so and
    offers the retry (STA-1). A re-read that fails once the form is on screen —
    a refocus, the refresh after a press whose answer was lost — is a note above
    it, and the form stays mounted with what was typed: the expense form's page
    replaced it with the panel, unmounting the form in the middle of an act
    whose outcome was in doubt.
  */
  const failure = (!overview.data && overview.error) || (!categories.data && categories.error) || null;
  const stale = overview.error ?? categories.error;
  const retry = (): void => {
    if (overview.error) overview.refetch();
    if (categories.error) categories.refetch();
  };

  return (
    /*
      The screen's height from `xl`, so the form below can split what the heading
      leaves into two panes: the fields scroll, the summary does not move
      (`treasury-form-parts.tsx`).
    */
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8 xl:flex xl:h-full xl:flex-col">
      {/* Named for where it goes — the register, not the treasury the register sits under. */}
      <HeaderBackLink fallbackHref={registerHref} label={t('backToRegister')} />

      <PageHeader icon={CircleDollarSign} title={t('form.title')} />

      {!failure && stale ? <RefreshFailedAlert message={stale} onRetry={retry} /> : null}

      {failure ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={failure} onRetry={retry} retryLabel={tCommon('retry')} />
          </CardContent>
        </Card>
      ) : !user || !ready ? (
        <TreasuryFormSkeleton />
      ) : !canRecord ? (
        <Alert variant="warning" title={t('notAllowedTitle')}>
          {t('notAllowedBody')}
        </Alert>
      ) : !overview.data?.active ? (
        <Alert variant="warning" title={t('notActiveTitle')}>
          {t('notActiveBody')}
        </Alert>
      ) : (
        <RecordIncomeForm
          tenant={tenant}
          token={token!}
          locale={locale}
          role={user.role}
          backHref={registerHref}
          accounts={overview.data.accounts}
          categories={categories.data ?? []}
          onRecorded={() => router.push(registerHref)}
          onPrint={(voucherId) => router.push(`${base}/finance/income/${voucherId}/print?print=1`)}
        />
      )}
    </div>
  );
}

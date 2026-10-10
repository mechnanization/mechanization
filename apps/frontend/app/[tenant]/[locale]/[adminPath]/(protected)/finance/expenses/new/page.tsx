'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Receipt } from 'lucide-react';
import { TREASURY_WORK_ROLES } from '@mechanization/shared-schemas';
import { getExpenseCategories, getMunicipalitySettings, getTreasuryOverview } from '@/lib/api-client';
import { hasRole } from '@/lib/staff-roles';
import { activeAccounts } from '@/lib/treasury-accounts';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { RecordExpenseForm } from '@/components/admin/finance/record-expense-form';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
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
 * What the form does depends on the role (`RecordExpenseForm`): the manager's
 * recording is the payment order and pays at once, while an accountant sends a
 * request to the register's queue (`?view=queue`) or pays urgently.
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
    queryKey: ['treasury', tenant, 'expense-categories'],
    queryFn: (accessToken, signal) => getExpenseCategories(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    reference: true,
    errorMessage: t('categoriesLoadError'),
  });

  /*
    The manager's urgent-payment ceiling, for the form to say and to check
    before the round trip. Not part of `failure` or `stale`: the server enforces
    the ceiling whatever this screen knows, so a failed read leaves the form
    exactly as it was before the ceiling existed rather than blocking a payment.
  */
  const settings = useStaffQuery({
    queryKey: ['municipality-settings', tenant],
    queryFn: (accessToken) => getMunicipalitySettings(tenant, accessToken),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  const urgentCeilings = settings.data
    ? { LBP: settings.data.urgentExpenseCeilingLbp ?? null, USD: settings.data.urgentExpenseCeilingUsd ?? null }
    : undefined;

  const ready = Boolean(token) && Boolean(overview.data) && Boolean(categories.data);
  /*
    Either read failing *before it ever answered* is a panel that says so and
    offers the retry (STA-1): a failed band list left the skeleton up for good,
    because the form needs both and nothing said which had failed. A re-read
    that fails once the form is on screen (a refocus, the refresh after a
    press) is a note above it, and the form stays mounted with what was typed:
    replacing it with the panel unmounted the form in the middle of a payment
    whose answer was lost.
  */
  const failure = (!overview.data && overview.error) || (!categories.data && categories.error) || null;
  const stale = overview.error ?? categories.error;
  const retry = (): void => {
    if (overview.error) overview.refetch();
    if (categories.error) categories.refetch();
  };

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Named for where it goes — the register, not the treasury the register sits under. */}
      <BackLink fallbackHref={registerHref} label={t('backToRegister')} />

      <PageHeader icon={Receipt} title={t('form.title')} />

      {!failure && stale ? <RefreshFailedAlert message={stale} onRetry={retry} /> : null}

      {failure ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={failure} onRetry={retry} retryLabel={tCommon('retry')} />
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
          // Money is paid only from an active wallet; a retired one could only be refused.
          accounts={activeAccounts(overview.data)}
          categories={categories.data ?? []}
          urgentCeilings={urgentCeilings}
          // A request goes to the queue where the manager will find it; a payment, to the register it joined.
          onRecorded={(outcome) => router.push(outcome === 'REQUESTED' ? `${registerHref}?view=queue` : registerHref)}
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

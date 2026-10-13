'use client';

import { use, useRef } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowDownUp, ScrollText, Tags } from 'lucide-react';
import { TREASURY_WORK_ROLES } from '@mechanization/shared-schemas';
import {
  getExpenseCategories,
  getIncomeCategories,
  getMunicipalitySettings,
  getTreasuryOverview,
} from '@/lib/api-client';
import { hasRole } from '@/lib/staff-roles';
import { activeAccounts } from '@/lib/treasury-accounts';
import { COMPOSER_DIRECTIONS, type ComposerDirection } from '@/lib/treasury-movements';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { param, useUrlState } from '@/lib/use-url-state';
import { scrollElementToTop } from '@/lib/scroll-to-top';
import { MovementComposer } from '@/components/admin/finance/movements/movement-composer';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { Alert } from '@/components/ui/alert';
import { BackLink } from '@/components/ui/back-link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';

/**
 * The side being written, in the URL: «سجّل صرفاً» has an address a clerk can
 * be sent to (`?dir=out`), and a reload keeps the side.
 */
const PAGE_URL = {
  dir: param.oneOf(COMPOSER_DIRECTIONS, 'in'),
};

/**
 * «الإيرادات والنفقات» — where a receipt or a payment is recorded: one card,
 * «قبض | صرف» at its top and the voucher's form under it, the whole voucher on
 * one screen with its submit. Design: docs/finance.md §4.6.
 *
 * ## Recording, and nothing beside it
 *
 * Until 2026-10-12 the register shared this page, the form in a pane beside
 * it. Each wanted the width the other took, so the register moved to its own
 * page, «الحركات المالية» (`/finance/transactions`), linked from the heading
 * here and from each recorded voucher («عرض»).
 *
 * After a press the composer says what the server wrote — the voucher's number,
 * with print and view one press away — above a fresh form for the next one
 * (`MovementComposer`), and the page brings that line into view.
 *
 * Recording is `TREASURY_WORK_ROLES` (its nav row; `IncomeController` and
 * `ExpensesController` enforce it, CODE-4). A reader who reaches the address
 * anyway — `/finance` is their row, and its prefix matches — is told who
 * records and sent to the register. The old «new» addresses
 * (`/finance/income/new`, `/finance/expenses/new`) lead here.
 */
export default function MovementsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const transactionsHref = `${base}/finance/transactions`;
  const t = useTranslations('finance.movements');
  const tCommon = useTranslations('common');
  const { token, user } = useStaffSession(tenant, base);
  const canRecord = user ? hasRole(TREASURY_WORK_ROLES, user.role) : false;
  const [url, setUrl] = useUrlState(PAGE_URL);
  /** The composer's card: after a press, its top — the confirmation — is brought into view. */
  const composerRef = useRef<HTMLDivElement>(null);

  // Read only for those who record: a reader is shown the way to the register.
  const recorderToken = canRecord ? token : null;

  const overview = useStaffQuery({
    queryKey: ['treasury', tenant, 'overview'],
    queryFn: (accessToken, signal) => getTreasuryOverview(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token: recorderToken,
    errorMessage: t('loadError'),
  });

  /*
    The keys the inline category editors write a new category into, so neither
    list is re-read under an open select (docs/gotchas.md). Both include the
    stopped categories (the register's filter needs them, and they share the
    keys); the forms offer the active ones.
  */
  const incomeCategories = useStaffQuery({
    queryKey: ['treasury', tenant, 'income-categories', 'all'],
    queryFn: (accessToken, signal) => getIncomeCategories(tenant, accessToken, { includeInactive: true }, signal),
    tenant,
    base,
    token: recorderToken,
    reference: true,
    errorMessage: t('loadError'),
  });
  const expenseCategories = useStaffQuery({
    queryKey: ['treasury', tenant, 'expense-categories', 'all'],
    queryFn: (accessToken, signal) => getExpenseCategories(tenant, accessToken, { includeInactive: true }, signal),
    tenant,
    base,
    token: recorderToken,
    reference: true,
    errorMessage: t('loadError'),
  });

  /*
    The manager's urgent-payment ceiling, for the expense form to say and check
    before the round trip. A failed read leaves the form as it was before the
    ceiling existed: the server enforces it whatever this screen knows.
  */
  const settings = useStaffQuery({
    queryKey: ['municipality-settings', tenant],
    queryFn: (accessToken) => getMunicipalitySettings(tenant, accessToken),
    tenant,
    base,
    token: recorderToken,
    errorMessage: t('loadError'),
  });
  const urgentCeilings = settings.data
    ? { LBP: settings.data.urgentExpenseCeilingLbp ?? null, USD: settings.data.urgentExpenseCeilingUsd ?? null }
    : undefined;

  const reads = [overview, incomeCategories, expenseCategories];
  const loaded = Boolean(overview.data && incomeCategories.data && expenseCategories.data);
  const readError = reads.find((read) => read.error)?.error ?? null;
  const retryReads = (): void => {
    for (const read of reads) if (read.error) read.refetch();
  };

  const voucherHref = (direction: ComposerDirection, id: string): string =>
    `${transactionsHref}?voucher=${id}&kind=${direction}`;
  const printHref = (direction: ComposerDirection, id: string): string =>
    `${base}/finance/${direction === 'in' ? 'income' : 'expenses'}/${id}/print?print=1`;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/finance`} label={t('back')} />

      <PageHeader
        icon={ArrowDownUp}
        title={t('title')}
        actions={
          <>
            <Button asChild variant="outline">
              <Link href={transactionsHref}>
                <ScrollText className="size-4" aria-hidden />
                {t('transactionsTitle')}
              </Link>
            </Button>
            {/*
              The categories page, beside the register's link; on a phone the form's
              own «+ بند جديد» covers the one thing a clerk needs from it mid-entry.
            */}
            <Button asChild variant="outline" className="hidden sm:inline-flex">
              <Link href={`${base}/finance/income/categories`}>
                <Tags className="size-4" aria-hidden />
                {t('manageCategories')}
              </Link>
            </Button>
          </>
        }
      />

      {user && !canRecord ? (
        <Alert variant="info" title={t('notAllowedTitle')}>
          <div className="space-y-2">
            <p>{t('notAllowedBody')}</p>
            <Button asChild variant="outline" size="sm">
              <Link href={transactionsHref}>
                <ScrollText className="size-4" aria-hidden />
                {t('transactionsTitle')}
              </Link>
            </Button>
          </div>
        </Alert>
      ) : !loaded && readError ? (
        // Nothing to write with yet: the read failed before anything landed (STA-1).
        <Card>
          <ErrorState title={readError} onRetry={retryReads} retryLabel={tCommon('retry')} />
        </Card>
      ) : !user || !token || !loaded || !overview.data || !incomeCategories.data || !expenseCategories.data ? (
        <ComposerSkeleton />
      ) : !overview.data.active ? (
        <Alert variant="warning" title={t('notActiveTitle')}>
          {t('notActiveBody')}
        </Alert>
      ) : (
        <>
          {/* A re-read that failed with the form on screen keeps the form, and says so. */}
          {readError ? <RefreshFailedAlert message={readError} onRetry={retryReads} /> : null}

          <Card ref={composerRef} className="p-4 sm:p-6">
            <MovementComposer
              tenant={tenant}
              token={token}
              locale={locale}
              role={user.role}
              direction={url.dir}
              onDirectionChange={(dir) => setUrl({ dir })}
              // Money moves only through an active wallet; a retired one could only be refused.
              accounts={activeAccounts(overview.data)}
              incomeCategories={incomeCategories.data}
              expenseCategories={expenseCategories.data}
              urgentCeilings={urgentCeilings}
              onRecorded={() => scrollElementToTop(composerRef.current)}
              voucherHref={voucherHref}
              printHref={printHref}
              queueHref={`${transactionsHref}?view=queue`}
            />
          </Card>
        </>
      )}
    </div>
  );
}

/** The composer's shape while the wallets and categories load, so the page does not jump. */
function ComposerSkeleton(): React.JSX.Element {
  return (
    <Card className="space-y-5 p-4 sm:p-6" aria-hidden>
      <Skeleton className="h-10 w-full" />
      <div className="grid gap-x-4 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, field) => (
          <div key={field} className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
        <div className="space-y-2 md:col-span-2 xl:col-span-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
      <Skeleton className="h-10 w-full" />
    </Card>
  );
}

'use client';

import { use } from 'react';
import { useTranslations } from 'next-intl';
import { Landmark } from 'lucide-react';
import { getTreasuryStatement } from '@/lib/api-client';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import {
  AccountStatementView,
  STATEMENT_LIMIT,
} from '@/components/admin/finance/account-statement-view';
import { TreasuryAmount } from '@/components/admin/finance/treasury-amount';
import { BackLink } from '@/components/ui/back-link';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * «كشف حساب» — one wallet's movements, at its own address.
 *
 * It lives under `/finance`, so `canAccessPath` matches the `/finance` nav row
 * by prefix and the page inherits `TREASURY_READ_ROLES` without declaring a row
 * of its own (CODE-4). The server enforces the same list.
 *
 * The read happens here rather than inside the view because the page heading is
 * the wallet's name, and that name arrives in the statement.
 */
export default function TreasuryAccountStatementPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; accountId: string }>;
}) {
  const { tenant, locale, adminPath, accountId } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('finance.statement');
  const { token } = useStaffSession(tenant, base);

  const query = useStaffQuery({
    queryKey: ['treasury', tenant, 'statement', accountId, STATEMENT_LIMIT],
    queryFn: (accessToken, signal) =>
      getTreasuryStatement(tenant, accessToken, { accountId, limit: STATEMENT_LIMIT }, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  const account = query.data?.account;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/finance`} label={t('back')} />

      <PageHeader
        icon={Landmark}
        title={account ? t('title', { name: account.name }) : <Skeleton className="h-7 w-56" />}
        actions={
          account ? (
            <div className="text-end">
              <p className="text-xs text-muted-foreground">{t('currentBalance')}</p>
              <p className="text-lg font-semibold">
                <TreasuryAmount amount={account.balance} currency={account.currency} locale={locale} />
              </p>
            </div>
          ) : undefined
        }
      />

      <AccountStatementView
        statement={query.data}
        loading={query.loading}
        error={query.error}
        onRetry={query.refetch}
        locale={locale}
      />
    </div>
  );
}

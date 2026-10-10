'use client';

import { use, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Landmark } from 'lucide-react';
import { municipalToday } from '@mechanization/shared-schemas';
import { getMunicipalitySettings, getTenantConfig, getTreasuryStatement } from '@/lib/api-client';
import { municipalityNameFor } from '@/lib/municipality-name';
import { monthSoFar, type StatementRange } from '@/lib/treasury-statement';
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
 * the wallet's name, and that name arrives in the statement. So does the range:
 * it opens on the month so far on the municipality's calendar (`municipalToday`,
 * not the browser's), because the server answers with the newest
 * `STATEMENT_LIMIT` movements in it and a wallet asked for everything would
 * open on its latest two hundred. A read that fails leaves the heading saying
 * «كشف حساب» and the view its `ErrorState`, never a skeleton that waits for good.
 */
export default function TreasuryAccountStatementPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; accountId: string }>;
}) {
  const { tenant, locale, adminPath, accountId } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('finance.statement');
  const { token, user } = useStaffSession(tenant, base);
  const [range, setRange] = useState<StatementRange>(() => monthSoFar(municipalToday()));

  const query = useStaffQuery({
    queryKey: ['treasury', tenant, 'statement', accountId, range.from, range.to, STATEMENT_LIMIT],
    queryFn: (accessToken, signal) =>
      getTreasuryStatement(
        tenant,
        accessToken,
        { accountId, from: range.from, to: range.to, limit: STATEMENT_LIMIT },
        signal,
      ),
    tenant,
    base,
    token,
    // Another range loads behind the heading and the figures already on screen, not behind a blank page.
    keepPrevious: true,
    errorMessage: t('loadError'),
  });
  const account = query.data?.account;

  /*
    The municipality's name, for the printed register's heading. The read and
    the key the payments page and «جولتي» print their receipts from, so it is
    one request per session; a failure costs the sheet one line, not the page.
  */
  const context = useStaffQuery({
    queryKey: ['receipt-context', tenant],
    queryFn: async (accessToken) => {
      const [settings, config] = await Promise.all([
        getMunicipalitySettings(tenant, accessToken),
        getTenantConfig(tenant),
      ]);
      return { settings, municipalityName: config.nameAr || config.name };
    },
    tenant,
    base,
    token,
    reference: true,
    errorMessage: t('loadError'),
  });
  const municipalityName = municipalityNameFor(locale, {
    nameAr: context.data?.municipalityName,
    nameEn: context.data?.settings.nameEn,
  });

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/finance`} label={t('back')} />

      <PageHeader
        icon={Landmark}
        title={
          account ? (
            t('title', { name: account.name })
          ) : query.error ? (
            t('titleUnknown')
          ) : (
            <Skeleton className="h-7 w-56" />
          )
        }
        actions={
          account ? (
            <div className="text-end">
              <p className="text-xs text-muted-foreground">{t('currentBalance')}</p>
              <p className="text-lg font-semibold">
                <TreasuryAmount amount={account.balance} currency={account.currency} locale={locale} wrap />
              </p>
            </div>
          ) : undefined
        }
      />

      <AccountStatementView
        tenant={tenant}
        token={token}
        role={user?.role}
        statement={query.data}
        loading={query.loading}
        fetching={query.fetching}
        error={query.error}
        onRetry={query.refetch}
        range={range}
        onRangeChange={setRange}
        locale={locale}
        municipalityName={municipalityName}
      />
    </div>
  );
}

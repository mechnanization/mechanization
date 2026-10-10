'use client';

import { use, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, Printer } from 'lucide-react';
import { getTransfer, getTreasuryOverview } from '@/lib/api-client';
import { param } from '@/lib/url-state';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useUrlState } from '@/lib/use-url-state';
import {
  BLANK_LETTERHEAD,
  useAutoPrint,
  useMunicipalLetterhead,
} from '@/components/admin/finance/official-document';
import { TransferDocument } from '@/components/admin/finance/transfer-document';
import { BackLink } from '@/components/ui/back-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';

const URL_STATE = { print: param.flag() };

/**
 * «سند المناقلة» — one transfer on an A4 sheet, to print and sign.
 *
 * Guarded by the `/finance/transfers` nav row's prefix: the same finance
 * readers as the register. Reached from the register's print button and from
 * the toast after recording, each with `?print=1`, which opens the print dialog
 * once the transfer, the letterhead and the base currency are in, then drops
 * the flag so a reload does not print again.
 */
export default function TransferPrintPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; transferId: string }>;
}) {
  const { tenant, locale, adminPath, transferId } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('finance.transfers');
  const { token } = useStaffSession(tenant, base);
  const [{ print }, setUrl] = useUrlState(URL_STATE);

  const transfer = useStaffQuery({
    queryKey: ['treasury', tenant, 'transfer', transferId],
    queryFn: (accessToken, signal) => getTransfer(tenant, accessToken, { id: transferId }, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  // The base currency a rate is counted in; the treasury page's own read, usually cached.
  const overview = useStaffQuery({
    queryKey: ['treasury', tenant, 'overview'],
    queryFn: (accessToken, signal) => getTreasuryOverview(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  const letterhead = useMunicipalLetterhead({ tenant, base, token, locale, errorMessage: t('loadError') });

  const printed = useCallback(() => setUrl({ print: false }), [setUrl]);
  useAutoPrint(print && Boolean(transfer.data) && Boolean(overview.data) && !letterhead.loading, printed);

  const error = transfer.error ?? overview.error;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/finance/transfers`} label={t('backToRegister')} />
      <PageHeader
        icon={FileText}
        title={transfer.data ? t('document.pageTitleNumbered', { number: transfer.data.transferNumber }) : t('document.pageTitle')}
        actions={
          transfer.data ? (
            <Button onClick={() => window.print()}>
              <Printer aria-hidden className="size-4" />
              {t('print')}
            </Button>
          ) : null
        }
      />

      {error ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState
              title={error}
              onRetry={() => {
                transfer.refetch();
                overview.refetch();
              }}
            />
          </CardContent>
        </Card>
      ) : !transfer.data || !overview.data ? (
        <Card className="mx-auto max-w-3xl space-y-4 p-4 sm:p-8">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-48 w-full" />
        </Card>
      ) : (
        <TransferDocument
          transfer={transfer.data}
          letterhead={letterhead.data ?? BLANK_LETTERHEAD}
          locale={locale}
          baseCurrency={overview.data.rate.baseCurrency}
        />
      )}
    </div>
  );
}

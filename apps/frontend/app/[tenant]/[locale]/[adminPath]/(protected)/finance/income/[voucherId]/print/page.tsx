'use client';

import { use, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, Printer } from 'lucide-react';
import { getIncomeVoucher } from '@/lib/api-client';
import { param } from '@/lib/url-state';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useUrlState } from '@/lib/use-url-state';
import {
  BLANK_LETTERHEAD,
  useAutoPrint,
  useMunicipalLetterhead,
} from '@/components/admin/finance/official-document';
import { IncomeVoucherDocument } from '@/components/admin/finance/voucher-documents';
import { BackLink } from '@/components/ui/back-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';

const URL_STATE = { print: param.flag() };

/**
 * «سند القبض» — one income voucher on an A4 sheet, to print on the
 * municipality's stationery or save as a PDF for whoever paid.
 *
 * Guarded by the `/finance/income` nav row's prefix: the same finance readers
 * as the register. Reached from the register's print button and from the toast
 * after recording — each with `?print=1`, which opens the browser's print
 * dialog once the voucher and the letterhead are in, then drops the flag so a
 * reload does not print again. «حفظ كملف PDF» is the browser's own destination
 * in that dialog; nothing here renders a PDF of its own.
 */
export default function IncomeVoucherPrintPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; voucherId: string }>;
}) {
  const { tenant, locale, adminPath, voucherId } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('finance.vouchers');
  const tr = useTranslations('finance.vouchers.receipt');
  const { token } = useStaffSession(tenant, base);
  const [{ print }, setUrl] = useUrlState(URL_STATE);

  const voucher = useStaffQuery({
    queryKey: ['treasury', tenant, 'income-voucher', voucherId],
    queryFn: (accessToken, signal) => getIncomeVoucher(tenant, accessToken, { id: voucherId }, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  const letterhead = useMunicipalLetterhead({ tenant, base, token, locale, errorMessage: t('loadError') });

  const printed = useCallback(() => setUrl({ print: false }), [setUrl]);
  // The letterhead never fails (it falls back to blank), so «settled» is «not loading».
  useAutoPrint(print && Boolean(voucher.data) && !letterhead.loading, printed);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/finance/income`} label={tr('back')} />
      <PageHeader
        icon={FileText}
        title={voucher.data ? tr('pageTitleNumbered', { number: voucher.data.voucherNumber }) : tr('pageTitle')}
        actions={
          voucher.data ? (
            <Button onClick={() => window.print()}>
              <Printer aria-hidden className="size-4" />
              {t('print')}
            </Button>
          ) : null
        }
      />

      {voucher.error ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={voucher.error} onRetry={voucher.refetch} />
          </CardContent>
        </Card>
      ) : !voucher.data ? (
        <Card className="mx-auto max-w-3xl space-y-4 p-4 sm:p-8">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </Card>
      ) : (
        <IncomeVoucherDocument
          voucher={voucher.data}
          letterhead={letterhead.data ?? BLANK_LETTERHEAD}
          locale={locale}
        />
      )}
    </div>
  );
}

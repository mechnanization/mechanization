'use client';

import { use, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { FileCheck, Printer } from 'lucide-react';
import { readView } from '@/lib/read-view';
import { getRequest } from '@/lib/requests-api';
import { param } from '@/lib/url-state';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useUrlState } from '@/lib/use-url-state';
import { BLANK_LETTERHEAD, useAutoPrint, useMunicipalLetterhead } from '@/components/admin/finance/official-document';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { RequestDocument } from '@/components/admin/requests/request-document';
import { Alert } from '@/components/ui/alert';
import { BackLink } from '@/components/ui/back-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';

const URL_STATE = { print: param.flag() };

/** A paper exists once the clerk has written what it certifies: ready, or already handed over. */
const PRINTABLE = new Set(['READY_FOR_PICKUP', 'COMPLETED']);

/**
 * The paper a municipal request is answered with, on an A4 sheet
 * (`RequestDocument`), to print and hand over against the original identity
 * card (open decisions §20 D3, D6).
 *
 * Guarded by «طلبات المعاملات»'s nav row, which owns `/requests`: the request
 * readers. Reached from «طباعة» in the request's panel with `?print=1`, which
 * opens the browser's print dialog once the request and the letterhead are in,
 * then drops the flag so a reload does not print again. A request not yet
 * approved has no statement, so it has no paper: the page says so.
 */
export default function RequestPrintPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; requestId: string }>;
}) {
  const { tenant, locale, adminPath, requestId } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('requests.document');
  const { token } = useStaffSession(tenant, base);
  const [{ print }, setUrl] = useUrlState(URL_STATE);

  const read = useStaffQuery({
    queryKey: ['requests', tenant, 'request', requestId],
    queryFn: (accessToken, signal) => getRequest(tenant, accessToken, { id: requestId }, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  const letterhead = useMunicipalLetterhead({ tenant, base, token, locale, errorMessage: t('loadError') });

  // A failed re-read leaves the paper about to be printed where it is (STA-1).
  const view = readView(read.data, read.error);
  const data = view.state === 'ready' ? view.data : undefined;
  const printable = data ? PRINTABLE.has(data.status) : false;

  const printed = useCallback(() => setUrl({ print: false }), [setUrl]);
  // The letterhead never fails (it falls back to blank), so «settled» is «not loading».
  useAutoPrint(print && printable && !letterhead.loading, printed);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/requests?request=${requestId}`} label={t('back')} />
      <PageHeader
        icon={FileCheck}
        title={data ? t('pageTitleNumbered', { number: data.requestNumber }) : t('pageTitle')}
        actions={
          printable ? (
            <Button onClick={() => window.print()}>
              <Printer aria-hidden className="size-4" />
              {t('print')}
            </Button>
          ) : null
        }
      />

      {view.state === 'failed' ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={view.error} onRetry={read.refetch} />
          </CardContent>
        </Card>
      ) : !data ? (
        <Card className="mx-auto max-w-3xl space-y-4 p-4 sm:p-8">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </Card>
      ) : !printable ? (
        <Alert variant="info" className="mx-auto max-w-3xl">
          {t('notReady')}
        </Alert>
      ) : (
        <>
          {/* Outside the print root, so it never reaches the paper. */}
          {view.state === 'ready' && view.refreshFailed ? (
            <RefreshFailedAlert message={view.refreshFailed} onRetry={read.refetch} />
          ) : null}
          <RequestDocument request={data} letterhead={letterhead.data ?? BLANK_LETTERHEAD} locale={locale} />
        </>
      )}
    </div>
  );
}

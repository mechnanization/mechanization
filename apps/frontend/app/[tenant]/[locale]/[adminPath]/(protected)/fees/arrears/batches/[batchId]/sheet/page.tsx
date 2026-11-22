'use client';

import { use } from 'react';
import { useTranslations } from 'next-intl';
import { Printer, ScrollText } from 'lucide-react';
import { getArrearsBatchSheet } from '@/lib/arrears-api';
import { readView } from '@/lib/read-view';
import { ARREARS_REPORT_ROLES, hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { ArrearsBatchSheetDocument } from '@/components/admin/arrears/arrears-batch-sheet';
import { BLANK_LETTERHEAD, useMunicipalLetterhead } from '@/components/admin/finance/official-document';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';

/**
 * «ورقة دفعة متأخرات سنوات سابقة» — the page the head of the municipality signs for
 * an approved batch (docs/old-debts-plan.md §8, task 11): who prepared and approved
 * it and when, its totals by year and fee, and the lines it dropped with their
 * reasons. A4 portrait through `data-print-root`, the finance documents' rules.
 *
 * `ARREARS_REPORT_ROLES`. The page names no citizen, so it may be printed, filed
 * and shown to an auditor as it is. A batch that is not approved has no sheet: the
 * server refuses it (`ARREARS_BATCH_NOT_APPROVED`) and the page says so.
 */
export default function ArrearsBatchSheetPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; batchId: string }>;
}) {
  const { tenant, locale, adminPath, batchId } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('arrears.sheet');
  const tReport = useTranslations('arrears.report');
  const { token, user } = useStaffSession(tenant, base);
  const allowed = user ? hasRole(ARREARS_REPORT_ROLES, user.role) : false;

  const sheet = useStaffQuery({
    queryKey: ['arrears-sheet', tenant, batchId],
    queryFn: (session, signal) => getArrearsBatchSheet(tenant, session, batchId, signal),
    tenant,
    base,
    token: allowed ? token : null,
    errorMessage: t('loadFailed'),
  });
  const letterhead = useMunicipalLetterhead({ tenant, base, token: allowed ? token : null, locale, errorMessage: t('loadFailed') });

  // A failed re-read leaves the sheet about to be printed where it is (STA-1).
  const view = readView(sheet.data, sheet.error);
  const data = view.state === 'ready' ? view.data : undefined;

  if (!user || !token) return <LoadingState />;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={`${base}/fees/arrears/report`} label={t('back')} />
      <PageHeader
        icon={ScrollText}
        title={t('title')}
        actions={
          data ? (
            <Button onClick={() => window.print()}>
              <Printer aria-hidden className="size-4" />
              {t('print')}
            </Button>
          ) : null
        }
      />

      {!allowed ? (
        <EmptyState icon={ScrollText} title={tReport('notAllowedTitle')} description={tReport('notAllowedBody')} />
      ) : view.state === 'failed' ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={sheet.refusal ?? view.error} onRetry={sheet.refetch} />
          </CardContent>
        </Card>
      ) : !data ? (
        <Card className="space-y-4 p-4 sm:p-6">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-24 w-full" />
        </Card>
      ) : (
        <>
          {/* Outside `#arrears-batch-sheet`, so the print rules leave it off the paper. */}
          {view.state === 'ready' && view.refreshFailed ? (
            <RefreshFailedAlert message={view.refreshFailed} onRetry={sheet.refetch} />
          ) : null}
          <ArrearsBatchSheetDocument sheet={data} letterhead={letterhead.data ?? BLANK_LETTERHEAD} locale={locale} />
        </>
      )}
    </div>
  );
}

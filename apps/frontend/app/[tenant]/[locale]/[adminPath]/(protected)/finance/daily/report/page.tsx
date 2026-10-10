'use client';

import { use } from 'react';
import { useTranslations } from 'next-intl';
import { Printer, ScrollText } from 'lucide-react';
import { municipalToday } from '@mechanization/shared-schemas';
import { getDailyCashReport, getMunicipalitySettings, getTenantConfig, logApiError } from '@/lib/api-client';
import { param } from '@/lib/url-state';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useUrlState } from '@/lib/use-url-state';
import { DailyCashReport, type ReportLetterhead } from '@/components/admin/finance/daily-cash-report';
import { BackLink } from '@/components/ui/back-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';

const URL_STATE = { date: param.date() };

/**
 * «تقرير الصندوق اليومي» — the day's sheet to print and sign.
 *
 * Guarded by the `/finance/daily` nav row's prefix: the same finance readers.
 * Any day since go-live can be printed; while it is still open the copy is
 * marked a draft, on screen and on paper, because its figures can still move.
 * With no `?date=` it shows today, which is always open — a draft by design.
 */
export default function DailyCashReportPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('dailyClosing.report');
  const { token } = useStaffSession(tenant, base);
  const [{ date: asked }] = useUrlState(URL_STATE);
  const date = asked || municipalToday();

  const report = useStaffQuery({
    queryKey: ['treasury', tenant, 'daily-report', date],
    queryFn: (accessToken, signal) => getDailyCashReport(tenant, accessToken, { date }, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });

  /*
    The letterhead: الإعدادات for the governorate, the district and the crest
    (a data URI, so it prints without a host the CSP would refuse), the public
    config for the name when the settings have none. A letterhead that fails
    to load leaves the name blank rather than the report unprintable.
  */
  const letterhead = useStaffQuery({
    queryKey: ['treasury', tenant, 'report-letterhead'],
    queryFn: async (accessToken): Promise<ReportLetterhead> => {
      const [settings, config] = await Promise.allSettled([
        getMunicipalitySettings(tenant, accessToken, { includeLogo: true }),
        getTenantConfig(tenant),
      ]);
      for (const result of [settings, config]) if (result.status === 'rejected') logApiError(result.reason);
      const s = settings.status === 'fulfilled' ? settings.value : null;
      const c = config.status === 'fulfilled' ? config.value : null;
      return {
        name: (locale === 'en' ? s?.nameEn || c?.name : s?.nameAr || c?.nameAr || c?.name) ?? '',
        governorate: s?.governorate ?? null,
        district: s?.district ?? null,
        crest: s?.logoDataUri ?? null,
      };
    },
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
    reference: true,
  });

  const data = report.data;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/finance/daily?date=${date}`} label={t('back')} />
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

      {report.error ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={report.error} onRetry={report.refetch} />
          </CardContent>
        </Card>
      ) : !data ? (
        <Card className="space-y-4 p-4 sm:p-6">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-24 w-full" />
        </Card>
      ) : (
        <DailyCashReport
          report={data}
          letterhead={letterhead.data ?? { name: '', governorate: null, district: null, crest: null }}
          locale={locale}
        />
      )}
    </div>
  );
}

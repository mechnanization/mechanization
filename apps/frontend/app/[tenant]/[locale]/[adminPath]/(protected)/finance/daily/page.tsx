'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CalendarCheck, ChevronLeft, Lock, Printer } from 'lucide-react';
import { TREASURY_ADMIN_ROLES, TREASURY_WORK_ROLES } from '@mechanization/shared-schemas';
import {
  getDailyCountSheet,
  getTreasuryClosures,
  type DailyCountSheet,
  type TreasuryDayClosureView,
} from '@/lib/api-client';
import { hasUnsavedCounts, type CountDraft } from '@/lib/daily-count';
import { formatDateTime, formatDay } from '@/lib/dates';
import { hasRole } from '@/lib/staff-roles';
import { param } from '@/lib/url-state';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useUrlState } from '@/lib/use-url-state';
import { DailyCountCard } from '@/components/admin/finance/daily-count-card';
import { DayClosePanel } from '@/components/admin/finance/day-close-panel';
import { DayStatusBadge } from '@/components/admin/finance/day-status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';

const URL_STATE = { date: param.date() };

/**
 * «جرد وإقفال اليومية» — the end of a municipal day (docs/finance.md §7).
 *
 * Opens on the day that needs closing next unless `?date=` names another: the
 * server works that out (`nextDayToClose`), because it is a question about the
 * whole book — a reopened day, the first day with movement since the last
 * close — that the page cannot answer from one day's sheet.
 *
 * Three roles meet here, each with its own controls, all mirroring
 * `TreasuryClosingController`: every finance reader sees the sheet and the
 * report; `TREASURY_WORK_ROLES` count and close; `TREASURY_ADMIN_ROLES` reopen.
 * The page hides what a role cannot do; the server refuses it regardless.
 */
export default function DailyClosingPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('dailyClosing');
  const { token, user } = useStaffSession(tenant, base);
  const canCount = user ? hasRole(TREASURY_WORK_ROLES, user.role) : false;
  const canReopen = user ? hasRole(TREASURY_ADMIN_ROLES, user.role) : false;
  const [{ date }, setUrl] = useUrlState(URL_STATE);

  const query = useStaffQuery({
    queryKey: ['treasury', tenant, 'daily', date],
    queryFn: (accessToken, signal) => getDailyCountSheet(tenant, accessToken, { date: date || undefined }, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
    keepPrevious: true,
  });
  const sheet = query.data;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={CalendarCheck}
        title={t('title')}
        actions={
          sheet?.goLiveOn ? (
            <Button asChild variant="outline">
              <Link href={`${base}/finance/daily/report?date=${sheet.day.businessDate}`}>
                <Printer aria-hidden className="size-4" />
                {t('printReport')}
              </Link>
            </Button>
          ) : null
        }
      />

      {query.error ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={query.error} onRetry={query.refetch} />
          </CardContent>
        </Card>
      ) : !sheet || !token ? (
        <SheetSkeleton />
      ) : !sheet.goLiveOn ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState icon={Lock} title={t('notActive.title')} description={t('notActive.body')} />
          </CardContent>
        </Card>
      ) : (
        <>
          <DayBar sheet={sheet} locale={locale} onPick={(next) => setUrl({ date: next })} />
          {/* Keyed by the day, so what was typed for one day never shows on another. */}
          <DayWorkspace
            key={sheet.day.businessDate}
            sheet={sheet}
            tenant={tenant}
            token={token}
            locale={locale}
            canCount={canCount}
            canReopen={canReopen}
          />
          <ClosureHistory
            tenant={tenant}
            base={base}
            token={token}
            locale={locale}
            current={sheet.day.businessDate}
            onPick={(next) => setUrl({ date: next })}
          />
        </>
      )}
    </div>
  );
}

/** The shape the sheet leaves, so the page does not jump when it lands. */
function SheetSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <Card className="space-y-3 p-4 sm:p-5">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-10 w-full max-w-xs" />
      </Card>
      <Card className="overflow-hidden">
        <div className="border-b px-4 py-3 sm:px-5">
          <Skeleton className="h-5 w-32" />
        </div>
        <div className="divide-y">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="space-y-3 px-4 py-4 sm:px-5">
              <div className="flex items-center gap-3">
                <Skeleton className="size-10 rounded-lg" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="ms-auto h-6 w-28" />
              </div>
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/**
 * The day being looked at: which one, where it stands, and who put it there —
 * and, when it is not the one in the way, a way to the one that is.
 */
function DayBar({
  sheet,
  locale,
  onPick,
}: {
  sheet: DailyCountSheet;
  locale: string;
  onPick: (day: string) => void;
}): React.JSX.Element {
  const t = useTranslations('dailyClosing.day');
  const { day } = sheet;
  const next = sheet.nextDayToClose;

  return (
    <section aria-labelledby="day-heading">
      <Card className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="day-heading" className="text-base font-semibold">
            {t('heading')}
          </h2>
          <DayStatusBadge status={day.status} locale={locale} />
        </div>

        <div className="grid gap-4 sm:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] sm:items-end">
          <Field htmlFor="day-picker" label={t('pick')} optionalLabel="">
            <DatePicker
              id="day-picker"
              value={day.businessDate}
              min={sheet.goLiveOn ?? undefined}
              max={sheet.today}
              locale={locale === 'en' ? 'en' : 'ar'}
              onChange={(value) => value && onPick(value)}
            />
          </Field>

          <div className="space-y-1 text-sm">
            {day.status === 'OPEN' ? <p className="text-muted-foreground">{t('openNote')}</p> : null}
            {day.status === 'CLOSED' ? (
              day.autoClosed ? (
                <p className="text-muted-foreground">{t('autoClosed')}</p>
              ) : (
                <p className="text-muted-foreground">
                  {t('closedBy', { name: day.closedByName ?? '—', date: formatDateTime(day.closedAt!) })}
                </p>
              )
            ) : null}
            {day.status === 'REOPENED' ? (
              <>
                <p className="text-muted-foreground">
                  {t('reopenedBy', { name: day.reopenedByName ?? '—', date: formatDateTime(day.reopenedAt!) })}
                </p>
                <p>{t('reopenReason', { reason: day.reopenReason ?? '—' })}</p>
              </>
            ) : null}
          </div>
        </div>

        {next && next !== day.businessDate ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
            <p className="text-sm">{t('next', { date: formatDay(next) })}</p>
            <Button variant="outline" size="sm" onClick={() => onPick(next)}>
              {t('goToNext')}
            </Button>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

/**
 * The count and the close, sharing the boxes: the close waits while a typed
 * figure is unsaved (`hasUnsavedCounts`).
 */
function DayWorkspace({
  sheet,
  tenant,
  token,
  locale,
  canCount,
  canReopen,
}: {
  sheet: DailyCountSheet;
  tenant: string;
  token: string;
  locale: string;
  canCount: boolean;
  canReopen: boolean;
}): React.JSX.Element {
  const t = useTranslations('dailyClosing.sheet');
  const [drafts, setDrafts] = useState<Record<string, CountDraft>>({});
  const closed = sheet.day.status === 'CLOSED';
  const editable = canCount && !closed;

  return (
    <>
      <DailyCountCard
        sheet={sheet}
        tenant={tenant}
        token={token}
        locale={locale}
        editable={editable}
        readOnlyNote={closed ? t('locked') : canCount ? null : t('readOnly')}
        drafts={drafts}
        onDraftChange={(accountId, draft) => setDrafts((current) => ({ ...current, [accountId]: draft }))}
        onSaved={() => setDrafts({})}
      />
      <DayClosePanel
        sheet={sheet}
        tenant={tenant}
        token={token}
        locale={locale}
        canClose={canCount}
        canReopen={canReopen}
        unsaved={hasUnsavedCounts(sheet.lines, drafts)}
      />
    </>
  );
}

const HISTORY_LIMIT = 14;

/** The latest closed and reopened days, each a way back to its sheet. */
function ClosureHistory({
  tenant,
  base,
  token,
  locale,
  current,
  onPick,
}: {
  tenant: string;
  base: string;
  token: string;
  locale: string;
  current: string;
  onPick: (day: string) => void;
}): React.JSX.Element {
  const t = useTranslations('dailyClosing.history');
  const query = useStaffQuery({
    queryKey: ['treasury', tenant, 'closures', HISTORY_LIMIT],
    queryFn: (accessToken, signal) => getTreasuryClosures(tenant, accessToken, { limit: HISTORY_LIMIT }, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  const rows: TreasuryDayClosureView[] = query.data ?? [];

  return (
    <section aria-labelledby="closure-history-heading">
      <Card className="overflow-hidden">
        <h2 id="closure-history-heading" className="border-b px-4 py-3 text-base font-semibold sm:px-5">
          {t('heading')}
        </h2>
        {query.error ? (
          <ErrorState title={query.error} onRetry={query.refetch} />
        ) : query.loading ? (
          <div className="space-y-2 p-4 sm:px-5">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={CalendarCheck} title={t('empty')} />
        ) : (
          <ul className="divide-y">
            {rows.map((row) => (
              <li key={row.businessDate}>
                <button
                  type="button"
                  onClick={() => onPick(row.businessDate)}
                  aria-label={t('open', { date: formatDay(row.businessDate) })}
                  aria-current={row.businessDate === current ? 'date' : undefined}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-start transition-colors duration-150 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-[current=date]:bg-primary/5 sm:px-5"
                >
                  <span className="font-medium tabular-nums">{formatDay(row.businessDate)}</span>
                  <DayStatusBadge status={row.status} locale={locale} />
                  {row.autoClosed ? <Badge variant="soft-muted">{t('auto')}</Badge> : null}
                  <span className="ms-auto min-w-0 truncate text-xs text-muted-foreground" title={row.closedByName ?? undefined}>
                    {row.closedByName}
                  </span>
                  <ChevronLeft aria-hidden className="size-4 shrink-0 text-muted-foreground ltr:rotate-180" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

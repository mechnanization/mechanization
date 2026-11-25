'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, FileQuestion } from 'lucide-react';
import { getLabels, qualityLabels } from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError } from '@/lib/api-client';
import { getReviewQueue, type ReviewQueueItem, type ReviewTab } from '@/lib/quality-api';
import { CompleteRecordDialog } from '@/components/admin/complete-record-dialog';
import { useStaffQuery } from '@/lib/use-staff-query';
import { usePagerLabels } from '@/lib/use-pager-labels';
import { param, useUrlPagination, useUrlState } from '@/lib/use-url-state';
import { pageWithRows } from '@/lib/url-state';
import { readView } from '@/lib/read-view';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Pager } from '@/components/ui/pager';
import { Tabs, TabsContent, TabsCount, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { RecordActions } from './review/record-actions';
import { RecordDetails } from './review/record-details';
import { RecordHistory } from './review/record-history';

const ANY = 'ANY';

/** The queue's tabs, in display order — also what `?tab=` may name. */
const REVIEW_TABS = ['TO_REVIEW', 'RETURNED', 'APPROVED'] as const satisfies readonly ReviewTab[];

/**
 * The queue's filters, in the URL so a reload keeps them. `queue` is the state
 * filter (it was `tab` until «الجودة» became one page with `?tab=` of its own,
 * NAV-03). The officer is a staff row id, never a name. Which card has its «إعادة إلى الموظف» form or
 * «استكمال» dialog open is not here: both write.
 */
export const REVIEW_QUEUE_URL = {
  queue: param.oneOf(REVIEW_TABS, 'TO_REVIEW'),
  officer: param.id(),
  flagged: param.flag(),
};

/** Records a page: cards, each a decision, so fewer than a register's rows. */
const REVIEW_PAGE_SIZE = 30;

/**
 * «مراجعة السجلات» — a second pair of eyes on what the field filed.
 *
 * One card per record, carrying what a reviewer decides on: who filed it, what
 * they left «غير مؤكَّد», what property it claims, and the record's own review
 * history. The two answers sit at the foot of the card; «إعادة للموظف» opens
 * its reason inline rather than in a dialog, because the reason is the decision
 * and a modal would hide the record it is about.
 */
export function ReviewQueue({
  tenant,
  base,
  locale,
  token,
  officers,
}: {
  tenant: string;
  base: string;
  locale: string;
  token: string | null;
  officers: Array<{ id: string; name: string }>;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const quality = qualityLabels(locale);
  const toast = useToast();
  const t = useTranslations('recordReview');

  const [filters, setFilters] = useUrlState(REVIEW_QUEUE_URL);
  const { queue: tab, officer: officerId, flagged: flaggedOnly } = filters;
  // `?page=`, reset by every filter below in the same write (`clear: ['page']`).
  const [pagination, setPagination] = useUrlPagination({
    defaultSize: REVIEW_PAGE_SIZE,
    sizes: [REVIEW_PAGE_SIZE],
  });
  const offset = pagination.pageIndex * pagination.pageSize;
  const listTop = useRef<HTMLDivElement | null>(null);
  /** The records a decision is being saved for: their cards' buttons are held. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  /** The same, as of this instant: two presses in one tick see it, where state is a render late (STA-3). */
  const inFlight = useRef(new Set<string>());
  const queryClient = useQueryClient();
  const [returning, setReturning] = useState<string | null>(null);
  /** The row whose «استكمال البيانات الناقصة» dialog is open, or none. */
  const [completing, setCompleting] = useState<ReviewQueueItem | null>(null);

  const pagerLabels = usePagerLabels();
  const query = useStaffQuery({
    queryKey: ['quality-reviews', tenant, tab, officerId, flaggedOnly, pagination.pageSize, offset],
    queryFn: (tok, signal) =>
      getReviewQueue(
        tenant,
        tok,
        { tab, officerId: officerId || undefined, flaggedOnly, limit: pagination.pageSize, offset },
        signal,
      ),
    tenant,
    base,
    token,
    errorMessage: t('loadFailed'),
    keepPrevious: true,
  });

  /*
    A decision moves its record to another tab, so the last decision on the
    last page empties it — and a stale `?page=` can point past the end. Either
    way the reader is stepped back to the last page with records, once the
    answer for this page is in (not the previous page's, kept while it loads).
  */
  const total = query.data?.total ?? 0;
  useEffect(() => {
    if (!query.data || query.fetching) return;
    const page = pageWithRows(pagination.pageIndex, pagination.pageSize, query.data.total);
    if (page !== pagination.pageIndex) setPagination((current) => ({ ...current, pageIndex: page }));
  }, [query.data, query.fetching, pagination.pageIndex, pagination.pageSize, setPagination]);

  const counts = query.data?.counts;
  // Keyed by tab so a tab added to `REVIEW_TABS` without a label fails to compile.
  const tabLabel: Record<ReviewTab, string> = {
    TO_REVIEW: t('tabs.TO_REVIEW'),
    RETURNED: t('tabs.RETURNED'),
    APPROVED: t('tabs.APPROVED'),
  };
  const tabCount: Record<ReviewTab, number | undefined> = {
    TO_REVIEW: counts ? counts.NEW + counts.CORRECTED + counts.CHANGED : undefined,
    RETURNED: counts?.RETURNED,
    APPROVED: counts?.APPROVED,
  };
  const tabs = REVIEW_TABS.map((key) => ({ key, label: tabLabel[key], count: tabCount[key] }));

  /*
    A decision, or a record completed from here, changes which queue the record is in and what
    «حسب الموظف» counts: every page of both is stale, not only the one on screen.
  */
  const reread = (): Promise<unknown> => {
    void queryClient.invalidateQueries({ queryKey: ['quality-officers', tenant] });
    return queryClient.invalidateQueries({ queryKey: ['quality-reviews', tenant] });
  };

  const act = async (registrationId: string, run: () => Promise<unknown>, done: string) => {
    if (!token || inFlight.current.has(registrationId)) return;
    inFlight.current.add(registrationId);
    setBusy(new Set(inFlight.current));
    try {
      await run();
      toast.success(done);
      // Only the form of the record just decided: another may be half written.
      setReturning((current) => (current === registrationId ? null : current));
      // Held until the queue is read again, so the card cannot be decided twice while it is still drawn.
      await reread();
    } catch (caught) {
      logApiError(caught);
      toast.error(caught instanceof ApiRequestError ? caught.message : t('saveFailed'));
    } finally {
      inFlight.current.delete(registrationId);
      setBusy(new Set(inFlight.current));
    }
  };

  const view = readView(query.data, query.error);

  return (
    <Tabs
      ref={listTop}
      value={tab}
      onValueChange={(next) => setFilters({ queue: next as ReviewTab }, { clear: ['page'] })}
      dir={en ? 'ltr' : 'rtl'}
      className="space-y-4"
    >
      <div className="flex flex-wrap items-end gap-3">
        <TabsList variant="pill" aria-label={t('filters.state')}>
          {tabs.map((option) => (
            <TabsTrigger key={option.key} value={option.key}>
              {option.label}
              {option.count !== undefined ? <TabsCount>{option.count}</TabsCount> : null}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="min-w-[12rem] space-y-1">
          <Label htmlFor="review-officer" className="text-xs text-muted-foreground">
            {t('filters.officer')}
          </Label>
          <Select value={officerId || ANY} onValueChange={(value) => setFilters({ officer: value === ANY ? '' : value }, { clear: ['page'] })}>
            <SelectTrigger id="review-officer" className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t('filters.everyone')}</SelectItem>
              {officers.map((officer) => (
                <SelectItem key={officer.id} value={officer.id}>
                  {officer.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          variant={flaggedOnly ? 'default' : 'outline'}
          size="sm"
          className="h-9 gap-1.5"
          aria-pressed={flaggedOnly}
          onClick={() => setFilters((current) => ({ flagged: !current.flagged }), { clear: ['page'] })}
        >
          <FileQuestion className="size-4" aria-hidden />
          {t('filters.flagged')}
        </Button>
      </div>

      <TabsContent value={tab} className="space-y-4">
        {view.state === 'ready' && view.refreshFailed ? (
          <RefreshFailedAlert message={view.refreshFailed} onRetry={query.refetch} />
        ) : null}
        {view.state === 'failed' ? (
          <ErrorState description={view.error} offline={query.offline} onRetry={query.refetch} />
        ) : view.state === 'loading' ? (
          <LoadingState label={t('loading')} />
        ) : view.data.items.length === 0 && total === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title={t(`empty.${tab}`)}
            description={tab === 'TO_REVIEW' ? t('empty.toReviewBody') : undefined}
          />
        ) : (
          <ol className="space-y-3">
            {view.data.items.map((item) => (
                /*
                  Bands, not one run of stacked blocks.

                  A record card carries four different kinds of thing — who and
                  when, the property claimed, the fields left unconfirmed, the
                  review history — and run together with `space-y` they read as
                  one wall of small text a reviewer has to parse before they can
                  decide anything. A coloured rule between them says where each
                  answer stops — heavier than the grey hairline between one fact
                  and the next inside a band, so the two cannot be confused — and
                  every band lays its facts as rows, values on the far edge.
                */
                <li key={item.registrationId} className="overflow-hidden rounded-xl border bg-card">
                  <div className="divide-y-2 divide-primary/30 [&>*]:px-4 [&>*]:py-3">
                    <RecordDetails item={item} base={base} locale={locale} labels={labels} />
                    <RecordHistory item={item} quality={quality} />
                  </div>

                  <RecordActions
                    item={item}
                    tenant={tenant}
                    token={token}
                    locale={locale}
                    busy={busy.has(item.registrationId)}
                    returning={returning}
                    setReturning={setReturning}
                    setCompleting={setCompleting}
                    act={act}
                  />
                </li>
            ))}
          </ol>
        )}

        {view.state === 'ready' ? (
          <Pager
            page={pagination.pageIndex}
            pageSize={pagination.pageSize}
            total={total}
            onPageChange={(page) => setPagination((current) => ({ ...current, pageIndex: page }))}
            labels={pagerLabels}
            disabled={query.fetching}
            label={t('pages')}
            scrollTarget={listTop}
          />
        ) : null}
      </TabsContent>

      {/*
        One dialog for the whole list, keyed by the row it was opened from, so
        it remounts — and therefore refetches — when a reviewer works two
        records in a row. Rendered outside the `<ol>` because a dialog belonging
        to a list item disappears with it when `refetch` replaces the list.
      */}
      {completing ? (
        <CompleteRecordDialog
          key={completing.registrationId}
          open
          onOpenChange={(next) => {
            if (!next) setCompleting(null);
          }}
          tenant={tenant}
          base={base}
          token={token}
          citizenId={completing.citizen.id}
          citizenName={completing.citizen.name}
          locale={locale}
          onSaved={() => {
            setCompleting(null);
            void reread();
          }}
        />
      ) : null}
    </Tabs>
  );
}

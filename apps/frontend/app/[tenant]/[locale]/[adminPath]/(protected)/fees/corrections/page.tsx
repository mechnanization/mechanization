'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileWarning, RefreshCw } from 'lucide-react';
import {
  ApiRequestError,
  billFigureKey,
  getCorrectionAffectedBills,
  logApiError,
  reviewBillBasis,
  type CorrectionAffectedBill,
} from '@/lib/api-client';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { param, useUrlState } from '@/lib/use-url-state';
import { formatLbp } from '@/lib/currency';
import { BillReviewDialog, CorrectionBillCard } from '@/components/admin/correction-bills';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;

const SHOW_VALUES = ['open', 'all'] as const;
type Show = (typeof SHOW_VALUES)[number];

/**
 * Which bills and which page, in the query string so a reload keeps the
 * accountant's place. The review dialog is not: it records a decision, and a
 * reload or a shared link must never reopen a form that writes.
 */
const CORRECTIONS_URL_STATE = {
  status: param.oneOf(SHOW_VALUES, 'open'),
  page: param.page(),
};

/**
 * «فواتير تأثّرت بتصحيحات» — open bills whose basis a correction changed.
 *
 * A correction never changes a bill (the user's decision of 2026-09-27): the
 * bill stays what it was when raised, and it lands here for an accountant to
 * decide. Each card shows the bill's figure, what it would be today, the units
 * behind the difference, and what was recorded on the file since. Recording a
 * decision takes the bill off the list until another correction moves it.
 */
export default function CorrectionBillsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const en = locale === 'en';
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;
  const toast = useToast();

  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<string | undefined>();
  const [{ status: show, page }, setUrlState] = useUrlState(CORRECTIONS_URL_STATE);
  const [reviewing, setReviewing] = useState<CorrectionAffectedBill | null>(null);
  const [saving, setSaving] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setToken(session.accessToken);
    setRole(session.user.role);
  }, [tenant, base, router]);

  // AUDITOR reads the list; recording a decision is the accountant's.
  const canReview = role === 'SUPER_ADMIN' || role === 'ACCOUNTANT';

  const listQuery = useStaffQuery({
    queryKey: ['correction-affected-bills', tenant, show, page],
    queryFn: (accessToken, signal) =>
      getCorrectionAffectedBills(
        tenant,
        accessToken,
        { includeReviewed: show === 'all', limit: PAGE_SIZE, offset: page * PAGE_SIZE },
        signal,
      ),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the bills affected by corrections.' : 'تعذّر تحميل الفواتير التي تأثّرت بتصحيحات.',
    keepPrevious: true,
  });
  const data = listQuery.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  /*
    A page past the end — a reloaded `?page=` after decisions emptied it, or a
    hand-edited one — goes to the last page rather than showing the empty
    state, which would say no bill is waiting.
  */
  useEffect(() => {
    if (data && page > 0 && page >= pages) setUrlState({ page: pages - 1 });
  }, [data, page, pages, setUrlState]);

  const saveReview = async (note: string) => {
    if (!reviewing || !token) return;
    setSaving(true);
    setReviewError(null);
    try {
      await reviewBillBasis(tenant, token, reviewing.paymentId, { note, figure: billFigureKey(reviewing.now) });
      toast.success(en ? 'Decision recorded. The bill is unchanged.' : 'سُجّل القرار. الفاتورة لم تتغيّر.');
      setReviewing(null);
      listQuery.refetch();
    } catch (caught) {
      logApiError(caught);
      if (caught instanceof ApiRequestError) {
        const code = (caught.payload.details as { code?: string } | undefined)?.code;
        if (code === 'FIGURE_CHANGED' || code === 'NOT_OPEN') {
          toast.error(caught.message);
          setReviewing(null);
          listQuery.refetch();
          return;
        }
        setReviewError(caught.message);
        return;
      }
      setReviewError(en ? 'Could not save the decision.' : 'تعذّر حفظ القرار.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={FileWarning}
        title={en ? 'Bills affected by corrections' : 'فواتير تأثّرت بتصحيحات'}
        actions={
          <Button variant="outline" size="sm" onClick={() => listQuery.refetch()} disabled={listQuery.fetching}>
            <RefreshCw className={cn('size-4 rtl:ml-1.5 ltr:mr-1.5', listQuery.fetching && 'animate-spin')} aria-hidden />
            {en ? 'Refresh' : 'تحديث'}
          </Button>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          aria-label={en ? 'Which bills' : 'أي الفواتير'}
          fullWidth={false}
          value={show}
          onChange={(value) => setUrlState({ status: value as Show }, { clear: ['page'] })}
          options={[
            { value: 'open', label: en ? 'Awaiting a decision' : 'بانتظار قرار' },
            { value: 'all', label: en ? 'Including reviewed' : 'مع ما رُوجع' },
          ]}
        />
        {data && data.total > 0 ? (
          <p className="text-sm text-muted-foreground">
            {en ? `${data.total} bill(s)` : `${data.total} فاتورة`}
            {data.totals.billedTooMuch > 0
              ? en
                ? ` · ${formatLbp(data.totals.billedTooMuch, locale)} more than the corrected record supports`
                : ` · ${formatLbp(data.totals.billedTooMuch, locale)} زيادة عمّا يبرّره السجل`
              : ''}
            {data.totals.billedTooLittle > 0
              ? en
                ? ` · ${formatLbp(data.totals.billedTooLittle, locale)} less`
                : ` · ${formatLbp(data.totals.billedTooLittle, locale)} نقصاً`
              : ''}
            {data.totals.unassessable > 0
              ? en
                ? ` · ${data.totals.unassessable} cannot be worked out today`
                : ` · ${data.totals.unassessable} لا يمكن احتسابها اليوم`
              : ''}
          </p>
        ) : null}
      </div>

      {listQuery.loading ? (
        <LoadingState label={en ? 'Comparing open bills with the register…' : 'تُقارَن الفواتير المفتوحة بالسجل…'} />
      ) : listQuery.error ? (
        <ErrorState description={listQuery.error} onRetry={() => listQuery.refetch()} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={FileWarning}
          title={
            show === 'open'
              ? en
                ? 'No bill is waiting for a decision'
                : 'لا فاتورة بانتظار قرار'
              : en
                ? 'No open bill was affected by a correction'
                : 'لم يتأثّر أي فاتورة مفتوحة بتصحيح'
          }
          description={
            en
              ? 'A bill appears here when a correction to the record it was raised on changes what it would be today.'
              : 'تظهر الفاتورة هنا حين يغيّر تصحيحٌ في السجل الذي صدرت عليه ما كانت ستكون عليه اليوم.'
          }
        />
      ) : (
        <>
          <ul className="space-y-3">
            {data.items.map((bill) => (
              <CorrectionBillCard
                key={bill.paymentId}
                bill={bill}
                locale={locale}
                base={base}
                canReview={canReview}
                onReview={(target) => {
                  setReviewError(null);
                  setReviewing(target);
                }}
              />
            ))}
          </ul>
          {pages > 1 ? (
            <nav className="flex items-center justify-between gap-2" aria-label={en ? 'Pages' : 'الصفحات'}>
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setUrlState((current) => ({ page: current.page - 1 }))}>
                {en ? 'Previous' : 'السابق'}
              </Button>
              <span className="text-sm text-muted-foreground">
                {en ? `Page ${page + 1} of ${pages}` : `صفحة ${page + 1} من ${pages}`}
              </span>
              <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setUrlState((current) => ({ page: current.page + 1 }))}>
                {en ? 'Next' : 'التالي'}
              </Button>
            </nav>
          ) : null}
        </>
      )}

      <BillReviewDialog
        key={reviewing?.paymentId ?? 'none'}
        bill={reviewing}
        open={reviewing !== null}
        saving={saving}
        error={reviewError}
        locale={locale}
        onCancel={() => setReviewing(null)}
        onConfirm={(note) => void saveReview(note)}
      />
    </div>
  );
}

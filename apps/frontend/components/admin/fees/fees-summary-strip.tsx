'use client';

import { useTranslations } from 'next-intl';
import { Money } from '@/components/ui/money';
import { Skeleton } from '@/components/ui/skeleton';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import type { FeeSummary } from '@/lib/api-client';

/**
 * The headline figures above «سجل الرسوم والمطالبات», from `GET fees/summary` (PRIM-20).
 *
 * Replaces the page's local `MetricCard` grid, which drew a missing summary as
 * «0 ل.ل»: the page reads the summary inside an `allSettled`, so a failed read
 * left it null with no error anywhere, and a null was drawn as a municipality
 * that had collected nothing. Here a figure is either the server's, a
 * placeholder while it loads, or absent with a note that says so.
 *
 * There is no «إجمالي الرسوم الصادرة». The page used to draw it as collected
 * plus unpaid, but the summary counts unpaid over `UNPAID` bills only, so that
 * sum left out every bill waiting on «قيد المراجعة» — the one figure on the
 * strip that is wrong exactly when the figure beside it is not zero. It comes
 * back when `fees/summary` returns a billed total (FRM-4: the client's
 * arithmetic is not the record).
 */
export function FeesSummaryStrip({
  summary,
  loading,
  onRetry,
  pendingHref,
  locale,
}: {
  summary: FeeSummary | null;
  loading: boolean;
  onRetry: () => void;
  /** The register filtered to «قيد المراجعة»; makes that figure a link while it has something to open. */
  pendingHref?: string;
  locale: string;
}): React.JSX.Element {
  const t = useTranslations('fees.register.summary');

  if (!loading && !summary) {
    return <RefreshFailedAlert title={t('failedTitle')} message={t('failedBody')} onRetry={onRetry} />;
  }

  const figure = (value: (data: FeeSummary) => React.ReactNode) =>
    summary ? value(summary) : <Skeleton className="inline-block h-5 w-16 align-middle" />;
  const money = (amount: number) => <Money amount={amount} exact wrap locale={locale} />;
  const count = (value: number) => value.toLocaleString('en-US');

  return (
    <StatStrip>
      <StatItem label={t('collected')} value={figure((data) => money(data.paidTotal))} />
      <StatItem label={t('paidInFull')} value={figure((data) => count(data.paidCount))} />
      <StatItem label={t('outstanding')} value={figure((data) => money(data.unpaidTotal))} />
      {/*
        «قائمة» rather than «مطلوبة»: this is every unpaid bill, late ones
        included — `summary()` counts the column with no date predicate — and
        the status tabs below split the same set into «غير مدفوعة» and
        «متأخرة». Labelled as one of those tabs, it would be a tab's name over
        a larger number on the same screen.
      */}
      <StatItem label={t('open')} value={figure((data) => count(data.unpaidCount))} />
      <StatItem
        label={t('pendingReview')}
        value={figure((data) => count(data.pendingReviewCount))}
        href={summary && summary.pendingReviewCount > 0 ? pendingHref : undefined}
      />
    </StatStrip>
  );
}

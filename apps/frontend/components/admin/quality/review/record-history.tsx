'use client';

import { useTranslations } from 'next-intl';
import type { qualityLabels } from '@mechanization/shared-schemas';
import { formatDateTime } from '@/lib/dates';
import type { ReviewQueueItem } from '@/lib/quality-api';

/** The record's own review history, and the return an officer still has open. Bands of the card. */
export function RecordHistory({
  item,
  quality,
}: {
  item: ReviewQueueItem;
  quality: ReturnType<typeof qualityLabels>;
}): React.JSX.Element {
  const t = useTranslations('recordReview.history');
  const openReturn = item.history.find((entry) => entry.outcome === 'RETURNED' && !entry.resolvedAt);

  return (
    <>
      {item.history.length > 0 ? (
        <details className="text-xs">
          <summary className="w-fit cursor-pointer text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            {t('title', { count: item.history.length })}
          </summary>
          {/* Divided, not boxed — a rule separates these entries
              without drawing a frame round every value in them. */}
          <ol className="mt-2 divide-y">
            {item.history.map((entry) => (
              <li key={entry.id} className="py-1.5 first:pt-0 last:pb-0">
                <span className="font-medium">
                  {entry.outcome === 'APPROVED' ? t('approved') : t('returned')}
                </span>{' '}
                <span className="text-muted-foreground">
                  — {entry.by ?? t('unknown')} · {formatDateTime(entry.at)}
                </span>
                {entry.reason ? <p className="mt-0.5 text-muted-foreground">{entry.reason}</p> : null}
                {entry.fields.length > 0 ? (
                  <p className="mt-0.5 text-muted-foreground">
                    {entry.fields.map((field) => quality.reviewField[field] ?? field).join('، ')}
                  </p>
                ) : null}
                {entry.resolvedAt ? (
                  <p className="mt-0.5 text-success">
                    {t('corrected')} — {entry.resolvedBy ?? ''} · {formatDateTime(entry.resolvedAt)}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {openReturn ? (
        <div className="space-y-1 bg-warning/5">
          <p className="text-xs font-semibold uppercase tracking-wide text-warning">
            {t('waiting')}
          </p>
          <p className="text-xs leading-relaxed text-warning">{openReturn.reason}</p>
        </div>
      ) : null}
    </>
  );
}

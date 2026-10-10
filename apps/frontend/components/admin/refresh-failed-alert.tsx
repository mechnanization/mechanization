'use client';

import { useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * A read that failed while the page already shows an earlier answer.
 *
 * TanStack keeps the last data when a background re-read fails (a refocus, an
 * invalidation after a write), and `useStaffQuery` passes the error through
 * beside it. A page that answered every error with `ErrorState` therefore threw
 * away a page that was still on screen — and with it whatever was mounted
 * there: a half-filled form, an open dialog. That is how a failed re-read of
 * the treasury after an in-doubt handover recorded the handover twice. So a
 * page shows `ErrorState` only when nothing has loaded, and this note, above
 * the content it leaves in place, when something has (STA-1).
 */
export function RefreshFailedAlert({
  message,
  onRetry,
  title,
}: {
  /** The failed read's own words — the `errorMessage` its `useStaffQuery` was given. */
  message: string;
  onRetry: () => void;
  /** What the failure costs the page, when it is more than a stale figure. Defaults to «the last read is shown». */
  title?: string;
}): React.JSX.Element {
  const t = useTranslations('common');
  return (
    <Alert variant="warning" live="status" title={title ?? t('refreshFailed')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span>{message}</span>
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          <RotateCcw className="size-4" aria-hidden />
          {t('retry')}
        </Button>
      </div>
    </Alert>
  );
}

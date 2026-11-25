'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/*
  «مراجعة حالة الوحدات» — SUPER_ADMIN only, and beside the list it feeds.

  Every screen that changes a flat now settles it, but flats nobody has
  touched since keep what the old rules left. This settles them in one pass
  and opens a «تعارض في حالة الوحدة» case on each one a person must decide;
  until then billing already holds their occupancy fee.
*/
export function UnitStatusReview({
  running,
  ready,
  onRun,
}: {
  running: boolean;
  /** The session is there to run it with. */
  ready: boolean;
  onRun: () => void;
}): React.JSX.Element {
  const t = useTranslations('qualityFindings.unitReview');

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/20 p-3">
      <p className="max-w-3xl text-sm text-muted-foreground">
        {t('body')}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onRun}
        disabled={running || !ready}
      >
        {running ? t('running') : t('run')}
      </Button>
    </section>
  );
}

'use client';

import { Button } from '@/components/ui/button';

/*
  «مراجعة حالة الوحدات» — SUPER_ADMIN only, and beside the list it feeds.

  Every screen that changes a flat now settles it, but flats nobody has
  touched since keep what the old rules left. This settles them in one pass
  and opens a «تعارض في حالة الوحدة» case on each one a person must decide;
  until then billing already holds their occupancy fee.
*/
export function UnitStatusReview({
  locale,
  running,
  ready,
  onRun,
}: {
  locale: string;
  running: boolean;
  /** The session is there to run it with. */
  ready: boolean;
  onRun: () => void;
}): React.JSX.Element {
  const en = locale === 'en';

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/20 p-3">
      <p className="max-w-3xl text-sm text-muted-foreground">
        {en
          ? 'Apply the unit-status rule to every flat: statuses follow who is registered inside, and each flat whose records still disagree gets a review case. Its occupancy fee is held until the case is settled.'
          : 'طبّق قاعدة حالة الوحدة على كل الوحدات: تتبع الحالة من هو مسجَّل فيها، وتُفتح حالة مراجعة لكل وحدة ما زالت سجلاتها متعارضة. يبقى رسم الإشغال عليها معلَّقاً حتى تُسوّى.'}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onRun}
        disabled={running || !ready}
      >
        {running
          ? en
            ? 'Reviewing…'
            : 'جارٍ المراجعة…'
          : en
            ? 'Review unit statuses'
            : 'مراجعة حالة الوحدات'}
      </Button>
    </section>
  );
}

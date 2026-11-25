'use client';

import { CircleCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * A sub-view whose finding is no longer found: the record was corrected, or somebody
 * marked it resolved. Saying so beats an empty grid.
 */
export function FindingGone({ locale, onBack }: { locale: string; onBack: () => void }): React.JSX.Element {
  const en = locale === 'en';

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-6 text-center">
        <CircleCheck className="mx-auto size-8 text-success" aria-hidden />
        <p className="mt-3 text-sm font-medium">
          {en ? 'This finding is no longer in the queue.' : 'لم تعد هذه الملاحظة في القائمة.'}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {en
            ? 'Either the record was corrected, or somebody marked it resolved.'
            : 'إمّا أن السجل صُحِّح، وإمّا أن أحدهم علَّمها «تم الحل».'}
        </p>
        <Button className="mt-4" onClick={onBack}>
          {en ? 'Back to quality findings' : 'رجوع إلى ملاحظات الجودة'}
        </Button>
      </div>
    </div>
  );
}

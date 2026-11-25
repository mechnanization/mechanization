'use client';

import { CircleCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/**
 * A sub-view whose finding is no longer found: the record was corrected, or somebody
 * marked it resolved. Saying so beats an empty grid.
 */
export function FindingGone({ onBack }: { onBack: () => void }): React.JSX.Element {
  const t = useTranslations('qualityFindings');

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-6 text-center">
        <CircleCheck className="mx-auto size-8 text-success" aria-hidden />
        <p className="mt-3 text-sm font-medium">
          {t('gone.title')}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('gone.body')}
        </p>
        <Button className="mt-4" onClick={onBack}>
          {t('back')}
        </Button>
      </div>
    </div>
  );
}

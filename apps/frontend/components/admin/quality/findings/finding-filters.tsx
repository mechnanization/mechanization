'use client';

import { ShieldQuestion } from 'lucide-react';
import type { qualityLabels, QualityFindingKind } from '@mechanization/shared-schemas';
import type { useUrlState } from '@/lib/use-url-state';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { FINDINGS_URL } from './finding-address';

/** The kinds as chips, each with how many are open, and whether the resolved ones are shown. */
export function FindingFilters({
  locale,
  quality,
  total,
  kinds,
  kind,
  includeDismissed,
  setQueue,
}: {
  locale: string;
  quality: ReturnType<typeof qualityLabels>;
  /** Every finding read, whichever kind is picked. */
  total: number;
  kinds: Array<[string, { open: number; dismissed: number } | undefined]>;
  kind: QualityFindingKind | '';
  includeDismissed: boolean;
  setQueue: ReturnType<typeof useUrlState<typeof FINDINGS_URL>>[1];
}): React.JSX.Element {
  const en = locale === 'en';

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        aria-pressed={kind === ''}
        onClick={() => setQueue({ kind: '' }, { clear: ['page'] })}
        className={cn(
          'min-h-9 rounded-md border px-3 text-sm transition-colors',
          kind === '' ? 'border-primary bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
        )}
      >
        {en ? 'All' : 'الكل'}
        <span className="ms-1.5 tabular-nums text-muted-foreground">{total}</span>
      </button>
      {kinds.map(([key, value]) => (
        <button
          key={key}
          type="button"
          aria-pressed={kind === key}
          onClick={() => setQueue({ kind: key as QualityFindingKind }, { clear: ['page'] })}
          className={cn(
            'min-h-9 rounded-md border px-3 text-sm transition-colors',
            kind === key
              ? 'border-primary bg-primary/10 font-medium text-primary'
              : 'hover:bg-accent',
          )}
        >
          {quality.findingKind[key as QualityFindingKind] ?? key}
          <span className="ms-1.5 tabular-nums text-muted-foreground">{value?.open ?? 0}</span>
        </button>
      ))}
      <Button
        variant={includeDismissed ? 'default' : 'ghost'}
        size="sm"
        className="ms-auto h-9 gap-1.5"
        aria-pressed={includeDismissed}
        onClick={() =>
          setQueue((current) => ({ dismissed: !current.dismissed }), { clear: ['page'] })
        }
      >
        <ShieldQuestion className="size-3.5" aria-hidden />
        {en ? 'Show resolved' : 'إظهار المحلولة'}
      </Button>
    </div>
  );
}

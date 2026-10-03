'use client';

import { cn } from '@/lib/utils';
import { CASE_TABS } from './case-queues';

/**
 * The queues, as tabs over the one table under them. Each groups the
 * case types an officer does the same thing about — knock again,
 * escalate, or just read — and its count rides on it, so an empty
 * queue shows before it is opened.
 */
export function CaseQueueTabs({
  locale,
  tab,
  counts,
  onSelect,
}: {
  locale: string;
  /** The open tab's `CASE_TABS` id. */
  tab: string;
  /** How many cases each tab holds, by tab id. */
  counts: Record<string, number>;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={locale === 'en' ? 'Case queues' : 'قوائم الحالات'}
      className="flex gap-1 overflow-x-auto border-b px-2 sm:px-4"
    >
      {CASE_TABS.map((entry) => {
        const active = entry.id === tab;
        return (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(entry.id)}
            className={cn(
              'relative flex min-h-11 shrink-0 items-center gap-2 rounded-t-md px-3 text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:transition-colors after:duration-150',
              active
                ? 'text-primary after:bg-primary'
                : 'text-muted-foreground after:bg-transparent hover:bg-accent/50 hover:text-foreground',
            )}
          >
            {locale === 'en' ? entry.en : entry.ar}
            <span
              className={cn(
                'min-w-6 rounded-full px-1.5 text-center text-xs font-semibold tabular-nums',
                active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
              )}
            >
              {counts[entry.id] ?? 0}
            </span>
          </button>
        );
      })}
    </div>
  );
}

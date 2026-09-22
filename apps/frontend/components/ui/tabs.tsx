'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * One strip of tabs over one view, with the count riding in the label.
 *
 * ## What it unifies
 *
 * Two screens had grown their own tablist, and they did not look alike. «قوائم
 * الحالات» was a row of bordered chips under a hairline, each carrying a count
 * in a pill; «حالة المراجعة» was an enclosed strip with the active tab filled
 * in primary and the count as plain figures beside the label. Same idea, same
 * keyboard needs, two implementations — and a third screen would have had a
 * third.
 *
 * Both survive as variants rather than one being talked out of its look: the
 * queues strip sits over a full-width table where a filled block would shout,
 * and the review strip is a small control in a toolbar row where an enclosed
 * group reads as one object. What is shared is the part that was quietly
 * different — the roles, the touch floor, and the count's treatment.
 *
 * ## Why not `SegmentedControl`
 *
 * That component is a *choice among values* — a filter, a mode. These are tabs
 * over one table, which is a different promise to a screen reader (`tablist`
 * and `tab`, not a radio group) and a different promise to the officer: the
 * rows below change, the question does not.
 *
 * ## The keyboard
 *
 * Arrow keys move between tabs and wrap, which is what `tablist` says will
 * happen. Only the selected tab is in the tab order (`tabIndex`), so Tab moves
 * past the strip to the table rather than through five queues first — the
 * behaviour the pattern specifies and the one nobody writes by hand.
 */
export interface TabItem<Id extends string = string> {
  id: Id;
  label: React.ReactNode;
  /** Shown beside the label — how many rows this queue holds right now. */
  count?: number;
}

export function Tabs<Id extends string>({
  items,
  value,
  onChange,
  label,
  variant = 'underline',
  className,
}: {
  items: readonly TabItem<Id>[];
  value: Id;
  onChange: (next: Id) => void;
  /** What the strip is for — announced, since a row of names does not say. */
  label: string;
  /**
   * `underline` — bordered chips under a hairline, for tabs over a full-width
   * table. `enclosed` — one filled group, for a small control in a toolbar.
   */
  variant?: 'underline' | 'enclosed';
  className?: string;
}): React.JSX.Element {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const move = (from: number, step: number) => {
    const to = (from + step + items.length) % items.length;
    onChange(items[to]!.id);
    refs.current[to]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        variant === 'underline'
          ? 'flex flex-wrap gap-1.5 border-b pb-2'
          : 'flex flex-wrap rounded-lg border p-0.5',
        className,
      )}
    >
      {items.map((item, index) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => {
              // Inline start and end, not left and right: the strip reads in
              // the page's direction, and so should the arrow that walks it.
              if (event.key === 'ArrowRight') move(index, document.dir === 'rtl' ? -1 : 1);
              else if (event.key === 'ArrowLeft') move(index, document.dir === 'rtl' ? 1 : -1);
              else if (event.key === 'Home') move(index, -index);
              else if (event.key === 'End') move(index, items.length - 1 - index);
              else return;
              event.preventDefault();
            }}
            className={cn(
              // 36px, and a full touch target on a coarse pointer: padding
              // alone left these at 30px on a strip tapped with a thumb.
              'flex min-h-9 items-center gap-1.5 whitespace-nowrap text-xs font-medium transition-colors coarse:min-h-touch',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
              variant === 'underline'
                ? cn(
                    'rounded-md border px-3 py-1.5',
                    active ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-accent',
                  )
                : cn(
                    'rounded-md px-3 text-sm',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent',
                  ),
            )}
          >
            {item.label}
            {item.count !== undefined ? (
              <span
                className={cn(
                  'tabular-nums',
                  variant === 'underline'
                    ? cn(
                        'rounded-full px-1.5 text-xs font-bold',
                        active ? 'bg-primary/20' : 'bg-muted text-muted-foreground',
                      )
                    : active
                      ? 'opacity-90'
                      : 'text-muted-foreground',
                )}
              >
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

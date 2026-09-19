'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A titled card that folds away.
 *
 * Built on `<details>/<summary>` rather than a `useState` toggle: the open
 * state then lives in the DOM, so browser find-in-page can open a closed
 * section to reveal a match, the whole thing is keyboard-operable with no
 * `tabIndex`/`role` of ours, and it still renders open with JavaScript
 * disabled. A hand-rolled toggle gets none of that for free and gets the
 * `aria-expanded`/`aria-controls` pairing wrong roughly half the time.
 *
 * The animation is the one thing `<details>` cannot do alone — it snaps. A
 * grid-template-rows transition (0fr → 1fr) is what animates a panel of
 * *unknown* height without measuring it in JavaScript, and it degrades to a
 * snap where it is unsupported rather than breaking.
 */
export function CollapsibleSection({
  title,
  icon: Icon,
  summary,
  defaultOpen = true,
  children,
  className,
  id,
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Shown in the header — the point of a closed section is what it still tells you. */
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <details
      id={id}
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      className={cn('group scroll-mt-24 overflow-hidden rounded-lg border bg-card', className)}
    >
      <summary
        className={cn(
          'flex cursor-pointer list-none items-start gap-2.5 px-4 py-3.5 transition-colors hover:bg-accent/50',
          // Safari still paints its own disclosure triangle without this.
          '[&::-webkit-details-marker]:hidden',
        )}
      >
        {/* `mt-0.5` sits both glyphs on the title's first line, now that the
            row is top-aligned so a title of two lines does not drag them down
            to its middle. */}
        <ChevronDown
          className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180"
          aria-hidden
        />
        {Icon ? (
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : null}

        {/*
          Stacked on a phone, one row from `sm` up.

          Letting the summary wrap as a sibling of the title was wrong: the
          title is its own wrapping paragraph, so the summary landed *beside its
          last line* — «المستأجرون في عقارات هذا / ٠ قائم · ٠ منتهٍ / المالك»,
          reading as though the count were part of the heading. A column on
          narrow screens puts it under the whole title where it belongs, and the
          `sm:justify-between` row restores the original layout the moment there
          is width for it.
        */}
        <div className="flex min-w-0 flex-1 flex-col gap-y-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-x-3">
          <h2 className="min-w-0 break-words text-base font-semibold">{title}</h2>
          {/* Survives the fold: a closed «الرسوم والمدفوعات» that still shows the
              balance is worth closing, one that shows nothing is not. */}
          {summary ? <div className="shrink-0 text-sm">{summary}</div> : null}
        </div>
      </summary>

      {/*
        `grid-rows-[0fr]` → `[1fr]` animates a panel whose height nobody has
        measured. The inner `min-h-0 overflow-hidden` is required: without it
        the child refuses to shrink below its content height and the animation
        does nothing at all.
      */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t p-4">{children}</div>
        </div>
      </div>
    </details>
  );
}

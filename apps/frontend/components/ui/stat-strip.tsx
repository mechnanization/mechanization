import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A row of key figures — «4 وحدات · 7 طوابق · 680 م²» — in one framed bar,
 * split into equal columns, the number over what it counts.
 *
 * ## Why equal columns and not chips
 *
 * Chips size to their text, so «وحدة في المبنى» is twice the width of
 * «طوابق», the row wraps wherever the longest one happens to fall, and the
 * numbers land at a different height and edge on every line. Equal columns put
 * every number on one baseline, so the eye reads across them as a set.
 *
 * ## Phones
 *
 * Four money figures side by side do not fit 360px — they overlapped. Below
 * `sm` the strip is two columns, and an odd last figure takes the full row.
 * The dividers are the token border showing through a 1px gap, so they follow
 * the grid wherever it wraps and need no physical left/right (RTL-1).
 *
 * ## When this and not `FactRow` / `SummaryList`
 *
 * Those are for facts read against a record — a label and its value. This is
 * for a handful of counts taken in at a glance, where the number is the point
 * and the label only says what it counts. More than five stops being a glance;
 * use rows instead.
 */
export function StatStrip({ children, className }: { children: React.ReactNode; className?: string }) {
  const items = React.Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;
  return (
    <dl
      className={cn(
        'grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border',
        'sm:[grid-template-columns:repeat(var(--stat-columns),minmax(0,1fr))]',
        items.length % 2 === 1 && 'max-sm:[&>*:last-child]:col-span-2',
        items.length === 1 && 'grid-cols-1',
        className,
      )}
      // A count known only at render time — the one value a class cannot spell (BAN-12).
      style={{ '--stat-columns': items.length } as React.CSSProperties}
    >
      {items}
    </dl>
  );
}

/** One figure in a `StatStrip`: the number, an optional unit beside it, and what it counts. */
export function StatItem({
  value,
  unit,
  label,
  className,
}: {
  value: React.ReactNode;
  /** «م²», «%» — smaller, beside the number, so the number keeps its size. */
  unit?: string;
  label: string;
  /** Styles the number — a text colour for a tone. */
  className?: string;
}) {
  return (
    // The label first, as a <dl> wants it and a screen reader reads it; drawn under the number.
    <div className="flex min-w-0 flex-col-reverse items-center justify-center bg-card px-2 py-2.5 text-center">
      <dt className="mt-1.5 line-clamp-2 text-xs leading-tight text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'flex max-w-full items-baseline gap-1 text-lg font-bold leading-none tabular-nums',
          className,
        )}
      >
        <bdi className="min-w-0 truncate">{value}</bdi>
        {unit ? <span className="text-xs font-medium text-muted-foreground">{unit}</span> : null}
      </dd>
    </div>
  );
}

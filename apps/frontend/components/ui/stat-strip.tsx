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
 * every number on one line and one baseline, so the eye reads across them as a
 * set.
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
      className={cn('grid divide-x divide-border rounded-xl border bg-muted/20 rtl:divide-x-reverse', className)}
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
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
    <div className="flex min-w-0 flex-col-reverse items-center justify-center px-2 py-2.5 text-center">
      <dt className="mt-1.5 line-clamp-2 text-[11px] leading-tight text-muted-foreground">{label}</dt>
      <dd className={cn('flex items-baseline gap-1 font-mono text-lg font-bold leading-none tabular-nums', className)}>
        <bdi>{value}</bdi>
        {unit ? <span className="font-sans text-xs font-medium text-muted-foreground">{unit}</span> : null}
      </dd>
    </div>
  );
}

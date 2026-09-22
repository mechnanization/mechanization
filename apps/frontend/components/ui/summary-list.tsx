import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A read-back of one record: one fact per row, the label at the start, its
 * value at the far edge, a rule between each row and the next.
 *
 * ## When this and not `FactRow`
 *
 * `FactRow` packs pairs across, label over value, and is right where facts sit
 * inside something else — a table cell, a card in a list. This is for the one
 * record a screen is *about*: «ملخص المنشأة» before saving, the building a
 * matrix belongs to. Those are checked top to bottom against a paper slip or
 * against what was just typed, and a grid of tiles or a row of chips has no top
 * to bottom to read. On a row every value lands on the same edge, so the values
 * read down as one column.
 *
 * ## No chips
 *
 * Values are text. No badge, pill, background or border — a box around a value
 * says «this is a control», and these are facts. Tone, where a value carries
 * one (damage, a finished survey), goes on the text colour through `className`.
 *
 * ## Bidi
 *
 * The value sits in `<bdi>` rather than taking `dir="ltr"` — see `facts.tsx`:
 * a direction on the box sends «Z-3-43-A» to the opposite edge from «مبنى سكني».
 */
export function SummaryList({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return <dl className={cn('divide-y divide-border/60', className)}>{children}</dl>;
}

/** One row of a `SummaryList`. */
export function SummaryRow({
  label,
  className,
  children,
}: {
  label: string;
  /** Styles the value — `font-mono` for a code, a text colour for a tone. */
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-xs font-medium text-muted-foreground">{label}</dt>
      {/* Wraps rather than truncating — a clipped value is one somebody has to open something else to read. */}
      <dd
        className={cn(
          'min-w-0 break-words text-end text-sm font-semibold text-foreground',
          className,
        )}
      >
        <bdi>{children}</bdi>
      </dd>
    </div>
  );
}

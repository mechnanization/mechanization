import * as React from 'react';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Label-and-value pairs, one per row: the label at the inline start, its value
 * at the inline end, a hairline between each pair and the next.
 *
 * ## Why this is a component and not eight hand-written `<dl>`s
 *
 * The audit trail, the daily report, «مراجعة الجودة» and «أرباحي والمسح
 * الميداني» all show the same shape — «الرمز: X-498-A», «رقم العقار: 498»,
 * «نوع المنشأة: مبنى سكني» — and each had written its own, so the values
 * landed somewhere different on every screen. A reader checking a record
 * against a paper slip reads *down* the value column; if that column starts at
 * a different place on each line there is no column to read down.
 *
 * ## Why rows
 *
 * Label-over-value packed across the width was tried and left the far half of
 * every card empty while the near half held two lines per fact. Rows use the
 * whole width, put every value on the same edge, and read the same as
 * «ملخص المنشأة», the building page and the citizen file — one shape for a
 * fact wherever a fact is shown.
 *
 * ## The bidi rule, which is the actual bug this exists to fix
 *
 * The obvious spelling — `dir="auto"` or `dir="ltr"` on the value — is what
 * scattered the values in the first place. Those set the *element's* direction,
 * which also decides which edge its text starts at, so «X-498-A» became LTR and
 * flew to one side while «مبنى سكني» stayed on the other.
 *
 * `<bdi>` is the right tool: it isolates the value's own direction so a Latin
 * code still reads left-to-right internally, without touching the direction of
 * the box that holds it. The box keeps the page's direction and `text-end`
 * puts every value on the same edge, Arabic and Latin alike.
 *
 * If you ever find a number sitting away from its label again, this is almost
 * certainly what happened.
 */
export function FactRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return <dl className={cn('divide-y divide-border/60 text-xs', className)}>{children}</dl>;
}

/**
 * One pair inside a `FactRow`.
 *
 * Values carry no chip, pill, background or border: a border around a value
 * says «this is a control», and these are facts.
 */
export function FactCell({
  label,
  value,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Styles the value — `font-mono` for a code, a colour for a tone. */
  className?: string;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 py-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      {/*
        Wraps rather than truncating. A clipped value in a log is a value
        somebody has to open something else to read.
      */}
      <dd className={cn('min-w-0 break-words text-end text-sm font-medium text-foreground', className)}>
        <bdi>{value}</bdi>
      </dd>
    </div>
  );
}

/**
 * A value that moved: what it was, and what it became.
 *
 * Separate from `FactCell` so a change renders identically wherever it is
 * shown, and so the arrow's direction is decided in one place.
 */
export function ChangeValue({
  before,
  after,
  becameLabel,
}: {
  before: React.ReactNode;
  after: React.ReactNode;
  /** Read out in place of the arrow, which is decorative. */
  becameLabel: string;
}): React.JSX.Element {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5">
      <span className="text-muted-foreground line-through decoration-muted-foreground/50">
        {before}
      </span>
      {/*
        `ltr:rotate-180`: the arrow has to point the way the page reads, or the
        change runs backwards for half the readers.
      */}
      <ArrowLeft
        className="size-3 shrink-0 self-center text-muted-foreground ltr:rotate-180"
        aria-label={becameLabel}
      />
      <span className="font-medium">{after}</span>
    </span>
  );
}

/**
 * The same pairs, laid across instead of down.
 *
 * `FactRow` puts a label at one edge and its value at the other, which reads
 * well in a narrow column and badly at the width of a page: the two halves of
 * one fact end up a hand-span apart with nothing between them. Where the facts
 * have the full width — a summary above an action, a header strip — they go in
 * a grid instead, value under label, and the grid is what reflows.
 *
 * Four across on a desktop, two on a tablet, one on a phone. Put the cells
 * that may be absent last: a grid with a hole in the middle of its first row
 * reads as something failing to load.
 */
export function FactGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <dl className={cn('grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4', className)}>
      {children}
    </dl>
  );
}

/**
 * One pair inside a `FactGrid`.
 *
 * `<bdi>` for the same reason `FactCell` uses it: a Latin code or a phone
 * number reads left-to-right inside itself without dragging the cell around it
 * to the other edge.
 */
export function FactGridCell({
  label,
  value,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Styles the value — `font-mono` for a code, a colour for a tone. */
  className?: string;
}): React.JSX.Element {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-words text-sm font-semibold text-foreground', className)}>
        <bdi>{value}</bdi>
      </dd>
    </div>
  );
}

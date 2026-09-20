import * as React from 'react';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Label-and-value pairs in two aligned columns.
 *
 * ## Why this is a component and not three `<dl>`s
 *
 * The audit trail, the daily report and «مراجعة الجودة» all show the same
 * shape — «الرمز: X-498-A», «رقم العقار: 498», «نوع المنشأة: مبنى سكني» — and
 * each had written its own, so the values landed in a different place on every
 * screen. A reader checking a record against a paper slip reads *down* the
 * value column; if that column starts at a different x on each line there is no
 * column to read down.
 *
 * The label column is `max-content` with a floor, so it grows to the widest
 * label and every value begins at one edge. Values never wrap in a chip, a
 * pill or a border: a border around a value says "this is a control" and these
 * are facts.
 *
 * ## The bidi rule, which is the actual bug this fixes
 *
 * The obvious spelling — `dir="auto"` on the `<dd>` — is what scattered the
 * values in the first place. `dir="auto"` sets the *block's* direction from its
 * first strong character, so «X-498-A» made that one cell LTR and flung it to
 * the left edge of the column while «مبنى سكني» stayed on the right. Two facts
 * in one list, aligned to opposite sides.
 *
 * `<bdi>` is the right tool: it isolates the value's own direction so a Latin
 * code still reads left-to-right internally, without touching the direction of
 * the cell that holds it. The cell keeps the page's direction and `text-start`
 * puts every value on the same edge, Arabic and Latin alike.
 */
export function FactGrid({
  children,
  className,
  /** The label column's floor. Widen it where labels are long sentences. */
  labelWidth = '6rem',
}: {
  children: React.ReactNode;
  className?: string;
  labelWidth?: string;
}): React.JSX.Element {
  return (
    /*
      One column on a phone, two from `sm` up.

      Below that there is no width to align in: a 7rem label column beside a
      long Arabic value leaves the value four words wide and wrapping every
      other one. Stacking is what the audit trail already did, and the label
      still sits directly above the value it names.

      The floor travels as a custom property so the breakpoint can stay a
      static Tailwind class — an inline `gridTemplateColumns` would apply at
      every width, which is the thing being avoided.
    */
    <dl
      className={cn(
        'grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[minmax(var(--fact-label),max-content)_1fr]',
        className,
      )}
      style={{ '--fact-label': labelWidth } as React.CSSProperties}
    >
      {children}
    </dl>
  );
}

/**
 * One row of a `FactGrid`.
 *
 * `display: contents` on the wrapper so the `<dt>` and `<dd>` are laid out by
 * the grid itself rather than by a box between them — without it each pair
 * becomes one cell and the columns collapse.
 */
export function Fact({
  label,
  value,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className="contents">
      <dt className="min-w-0 text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-words text-start text-foreground', className)}>
        <bdi>{value}</bdi>
      </dd>
    </div>
  );
}

/**
 * A fact that moved: what it was, and what it became.
 *
 * The arrow is logical rather than the literal «→» — in an RTL page an arrow
 * drawn left-to-right reads the change backwards.
 */
export function FactChange({
  label,
  before,
  after,
  becameLabel,
}: {
  label: React.ReactNode;
  before: React.ReactNode;
  after: React.ReactNode;
  /** Read out in place of the arrow, which is decorative. */
  becameLabel: string;
}): React.JSX.Element {
  return (
    <Fact
      label={label}
      value={
        <span className="inline-flex flex-wrap items-baseline gap-1.5">
          <span className="text-muted-foreground line-through decoration-muted-foreground/50">
            {before}
          </span>
          {/*
            `ltr:rotate-180`, the same spelling the entry list already uses: the
            arrow has to point the way the page reads, or the change runs
            backwards for half the readers.
          */}
          <ArrowLeft
            className="size-3 shrink-0 self-center text-muted-foreground ltr:rotate-180"
            aria-label={becameLabel}
          />
          <span className="font-medium">{after}</span>
        </span>
      }
    />
  );
}

/**
 * The same pairs laid out across instead of down: label on top, value directly
 * under it, each pair sitting beside the next.
 *
 * For a header strip — who this person is, when they joined — where the facts
 * are few, short, and read at a glance rather than compared against a slip.
 * Stacked as rows they turn a card header into five lines of mostly empty
 * space; across, they read the way the figures table under them already does,
 * every value under the word naming it.
 *
 * Wraps rather than scrolls, so a long email takes a second line with the rest
 * instead of pushing the row off the side of a phone.
 */
export function FactRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <dl className={cn('flex flex-wrap gap-x-8 gap-y-3 text-xs', className)}>{children}</dl>
  );
}

/**
 * One pair inside a `FactRow`.
 *
 * Not a `<div className="contents">` like `Fact`: here the pair *is* the box
 * the flex row lays out, and its two lines have to stay together when the row
 * wraps.
 */
export function FactCell({
  label,
  value,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      {/* `<bdi>` for the same reason as everywhere else in this file: a Latin
          value must not drag its own alignment away from its label. */}
      <dd className={cn('mt-0.5 min-w-0 truncate text-start text-foreground', className)}>
        <bdi>{value}</bdi>
      </dd>
    </div>
  );
}

import * as React from 'react';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Label-and-value pairs, laid out across: the label on top, its value directly
 * under it, each pair sitting beside the next.
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
 * ## Why across and not down
 *
 * Down was the first fix, and it was aligned but tall: five facts about a
 * staff member became five lines of mostly empty space at the top of a card on
 * a page meant to be scanned five inspectors at a time, and an entry with four
 * changed fields made a four-line cell in a table whose other columns are one.
 * Across, the pairs read the way the figures table under them already does.
 *
 * ## The bidi rule, which is the actual bug this exists to fix
 *
 * The obvious spelling — `dir="auto"` or `dir="ltr"` on the value — is what
 * scattered the values in the first place. Those set the *element's* direction,
 * which also decides which edge its text starts at, so «X-498-A» became LTR and
 * flew to one side while «مبنى سكني» stayed on the other. Two facts in one
 * list, aligned to opposite edges, and a `$0.00` sitting nowhere near the
 * heading naming it.
 *
 * `<bdi>` is the right tool: it isolates the value's own direction so a Latin
 * code still reads left-to-right internally, without touching the direction of
 * the box that holds it. The box keeps the page's direction and `text-start`
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
  /*
    Wraps rather than scrolls, so a long email takes a second line with the
    rest instead of pushing the row off the side of a phone.
  */
  return <dl className={cn('flex flex-wrap gap-x-8 gap-y-3 text-xs', className)}>{children}</dl>;
}

/**
 * One pair inside a `FactRow`.
 *
 * The pair is the box the row lays out, so its two lines stay together when
 * the row wraps. Values carry no chip, pill, background or border: a border
 * around a value says «this is a control», and these are facts.
 */
export function FactCell({
  label,
  value,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Cap prose here — `max-w-sm` on a note stops it taking the whole row. */
  className?: string;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      {/*
        Wraps rather than truncating. A clipped value in a log is a value
        somebody has to open something else to read — a caller that genuinely
        wants one line asks for it with `truncate` in `className`.
      */}
      <dd className={cn('mt-0.5 min-w-0 break-words text-start text-foreground', className)}>
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

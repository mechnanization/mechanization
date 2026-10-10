import * as React from 'react';
import Link from 'next/link';
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

/**
 * One figure in a `StatStrip`: the number, an optional unit beside it, and what it counts.
 *
 * ## `icon` and `href`
 *
 * Both optional, and added for the treasury's four wallets (2026-10-08), where
 * each cell is a place money is kept and opens that place's statement.
 *
 * `href` makes the **whole cell** the target through a stretched link: the
 * `<Link>` wraps the label, and its `::after` covers the cell. That keeps one
 * control per cell — the old balance cards were a `div` with `onClick` holding
 * a second button, which the keyboard could not reach and a screen reader
 * announced as nothing — and the link's name is the label, «صندوق النقد —
 * ليرة», which is what the reader is choosing between. The focus ring is drawn
 * on that same `::after`, inset, so it follows the cell and not the text.
 *
 * `icon` is decorative and sits inside the `<dd>` above the number: a `<dl>`'s
 * `<div>` may hold only `<dt>` and `<dd>`, so it cannot be a sibling of them.
 */
export function StatItem({
  value,
  unit,
  label,
  className,
  icon: Icon,
  href,
}: {
  value: React.ReactNode;
  /** «م²», «%» — smaller, beside the number, so the number keeps its size. */
  unit?: string;
  label: string;
  /** Styles the number — a text colour for a tone. */
  className?: string;
  /** Drawn above the number in a tinted circle. Decorative: the label names the cell. */
  icon?: React.ComponentType<{ className?: string }>;
  /** Makes the whole cell a link, named by `label`. */
  href?: string;
}) {
  return (
    // The label first, as a <dl> wants it and a screen reader reads it; drawn under the number.
    <div
      className={cn(
        'relative flex min-w-0 flex-col-reverse items-center justify-center bg-card px-2 py-2.5 text-center',
        Icon && 'px-3 py-4',
        href && 'transition-colors duration-150 hover:bg-muted/50',
      )}
    >
      <dt className="mt-1.5 line-clamp-2 text-xs leading-tight text-muted-foreground">
        {href ? (
          <Link
            href={href}
            className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
          >
            {label}
          </Link>
        ) : (
          label
        )}
      </dt>
      <dd className="flex max-w-full flex-col items-center gap-2.5">
        {Icon ? (
          <span
            aria-hidden
            className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary"
          >
            <Icon className="size-5" />
          </span>
        ) : null}
        <span
          className={cn(
            'flex max-w-full items-baseline gap-1 text-lg font-bold leading-none tabular-nums',
            className,
          )}
        >
          <bdi className="min-w-0 truncate">{value}</bdi>
          {unit ? <span className="text-xs font-medium text-muted-foreground">{unit}</span> : null}
        </span>
      </dd>
    </div>
  );
}

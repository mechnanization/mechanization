import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Ported from the Albazourieh platform's shadcn/ui table, with one deliberate
 * departure: the reference wraps every `<table>` in its own
 * `overflow-auto` div. That is wrong wherever the caller already owns a scroll
 * container — the header's `sticky top-0` resolves against the *nearest*
 * scrolling ancestor, so an inner wrapper that never scrolls vertically
 * silently pins the header to nothing. `DataTable` supplies the single
 * scroll+border container; this stays a bare `<table>`.
 */
const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement>
>(({ className, ...props }, ref) => (
  <table
    ref={ref}
    className={cn('w-full caption-bottom text-sm', className)}
    {...props}
  />
));
Table.displayName = 'Table';

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn('[&_tr]:border-b', className)} {...props} />
));
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn('[&_tr:last-child]:border-0', className)}
    {...props}
  />
));
TableBody.displayName = 'TableBody';

/**
 * Hover is a neutral `muted` wash, matching the sibling Solar system.
 *
 * This carried a primary tint (`hover:bg-primary/10`) for a reason that has
 * since expired: the rows were zebra-striped in `muted`, so a muted hover over
 * a muted stripe was invisible. The striping is gone — nothing in this codebase
 * sets `odd:`/`even:` on a row any more — which leaves the tint painting a blue
 * band across a row on every mouse move, competing with the `bg-primary/10`
 * that actually means something here (the selected state, the KPI icon tiles).
 * A hover is transient feedback and should read as a shadow, not as a status.
 */
const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      'border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted',
      className,
    )}
    {...props}
  />
));
TableRow.displayName = 'TableRow';

/**
 * No `uppercase`/`tracking-wider` here, unlike most shadcn tables: this is an
 * Arabic-first UI, and Arabic is unicameral — the transform does nothing to a
 * header like "الرقم المرجعي" while letter-spacing actively breaks the
 * cursive joins.
 */
const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      'h-10 whitespace-nowrap px-3 text-start align-middle font-medium text-muted-foreground',
      className,
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    /*
     * `whitespace-nowrap`, matching the header above it.
     *
     * Only `<th>` carried it, so headings held their line while values below
     * them broke at every space — at tablet width a phone number rendered as
     * four stacked fragments ("+961 / 70 / 899 / 495"), which is not a phone
     * number any more. The table already lives in a container that scrolls
     * horizontally, and below `sm` it is not a table at all but a stack of
     * cards, so there is nothing left for wrapping to rescue: it only ever
     * mangled the value.
     *
     * A cell that genuinely wants to wrap — a long note, an audit summary —
     * opts out with `meta.cellClassName: 'whitespace-normal'`.
     */
    className={cn('whitespace-nowrap p-3 align-middle', className)}
    {...props}
  />
));
TableCell.displayName = 'TableCell';

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell };

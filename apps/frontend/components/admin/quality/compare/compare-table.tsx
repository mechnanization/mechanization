'use client';

import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Both compare tables read from this shape, whatever kind of record they show. */
export interface CompareRow {
  key: string;
  label: string;
  /** Rendered per side. The dot is drawn by the table, never by the caller. */
  cells: [React.ReactNode, React.ReactNode];
  /** What the two values do to each other. */
  state: 'conflict' | 'gap' | 'same';
}

/** «—» for a value the register does not hold, never an empty cell. */
function shown(value: unknown): { node: React.ReactNode; present: boolean } {
  if (value === null || value === undefined || value === '') {
    return { node: <span className="text-muted-foreground">—</span>, present: false };
  }
  return { node: <bdi>{String(value)}</bdi>, present: true };
}

/**
 * A plain pair of values, compared and rendered.
 *
 * `compare` is what two values are judged by — trimmed text by default, and a
 * caller passes something looser where the raw value is not the fact (a phone
 * written with spaces is the same phone).
 */
export function row(
  key: string,
  label: string,
  a: unknown,
  b: unknown,
  compare: (value: unknown) => string = (value) => String(value ?? '').trim(),
): CompareRow {
  const left = shown(a);
  const right = shown(b);
  const state: CompareRow['state'] =
    !left.present || !right.present
      ? left.present === right.present
        ? 'same'
        : 'gap'
      : compare(a) === compare(b)
        ? 'same'
        : 'conflict';
  return { key, label, cells: [left.node, right.node], state };
}

/**
 * The grid itself: one label column and two value columns that line up.
 *
 * Below `sm` there is no room for three columns, so each row becomes a small
 * block — the label once, then the two values each under the short name of the
 * record it belongs to. The comparison survives a phone, which is what an
 * inspector standing in a street is holding.
 */
export function CompareTable({
  headers,
  shortHeaders,
  rows,
  locale,
}: {
  headers: [React.ReactNode, React.ReactNode];
  shortHeaders: [string, string];
  rows: CompareRow[];
  locale: string;
}): React.JSX.Element {
  const en = locale === 'en';
  const columns = 'grid grid-cols-1 sm:grid-cols-[minmax(7rem,11rem)_1fr_1fr]';

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className={cn(columns, 'border-b bg-muted/40')}>
        <div className="hidden px-4 py-3 sm:block" />
        <div className="px-4 py-3">{headers[0]}</div>
        <div className="border-t px-4 py-3 sm:border-t-0 sm:border-s">{headers[1]}</div>
      </div>

      <dl className="divide-y">
        {rows.map((entry) => (
          <div key={entry.key} className={cn(columns, 'text-sm')}>
            <dt className="bg-muted/20 px-4 py-2 text-xs text-muted-foreground sm:bg-transparent sm:py-2.5">
              {entry.label}
            </dt>
            {([0, 1] as const).map((side) => (
              <dd
                key={side}
                className={cn(
                  'px-4 py-2 sm:py-2.5',
                  side === 1 && 'border-t sm:border-t-0 sm:border-s',
                )}
              >
                <span className="flex min-w-0 items-start gap-2">
                  {/*
                    The mark, at the value's own inline start so the eye finds it
                    on the same edge every row — and carrying its meaning in
                    words for anyone the colour does not reach.
                  */}
                  {entry.state === 'conflict' ? (
                    <>
                      <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-destructive" />
                      <span className="sr-only">{en ? 'Differs: ' : 'قيمتان مختلفتان: '}</span>
                    </>
                  ) : entry.state === 'gap' ? (
                    <>
                      <span
                        aria-hidden
                        className="mt-1.5 size-2 shrink-0 rounded-full border border-muted-foreground/40"
                      />
                      <span className="sr-only">{en ? 'Not asked on one record: ' : 'لم يُسأل في أحد السجلين: '}</span>
                    </>
                  ) : (
                    <span aria-hidden className="mt-1.5 size-2 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 break-words">
                    <span className="me-1.5 text-xs text-muted-foreground sm:hidden">
                      {shortHeaders[side]}:
                    </span>
                    {entry.cells[side]}
                  </span>
                </span>
              </dd>
            ))}
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The card heading for one side: what the record is called, and its way in. */
export function RecordHeading({
  title,
  secondary,
  href,
  openLabel,
}: {
  title: string;
  secondary: string | null;
  href: string;
  openLabel: string;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-semibold">
        <bdi>{title}</bdi>
      </p>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
        {secondary ? (
          <span className="text-muted-foreground">
            <bdi>{secondary}</bdi>
          </span>
        ) : null}
        <Link
          href={href}
          className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
        >
          {openLabel}
          <ExternalLink className="size-3" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

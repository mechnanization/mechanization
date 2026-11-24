'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * «1–10 من 23 · ‹ ›» — previous and next through a list held in memory.
 *
 * Drawn as `DataTable`'s own footer is — the position spelled out, then two
 * square buttons whose names live in `aria-label` and `title` — so a list that
 * is not a `DataTable` (the bills on a citizen's file) pages the same way the
 * registers do. Renders nothing when everything fits on one page.
 *
 * A `<nav>` landmark, so a screen reader can jump to it; the new position is
 * announced as one phrase («صفحة 2 من 3») rather than as loose numbers
 * (A11Y-7). The words come in as `labels` (`usePagerLabels`, from the messages),
 * Arabic or English by `locale` only when a caller passes none; `disabled` holds
 * both buttons while the page's read is in flight, so a second click cannot step
 * past a page that has not arrived. Pass `scrollTarget` and a page change brings the list's top back
 * into view, as DataTable does — otherwise the reader is left looking at the
 * bottom of a list that has just changed under them.
 */
/** The words a `Pager` says — resolved by the caller from the messages (`usePagerLabels`). */
export interface PagerLabels {
  /** The landmark's name, e.g. «صفحات الرسوم». */
  nav: string;
  previous: string;
  next: string;
  /** «صفحة 2 من 3», announced when the page changes. */
  position: (current: number, total: number) => string;
  /** «1–10 من 23». */
  range: (first: number, last: number, total: number) => string;
}

export function Pager({
  page,
  pageSize,
  total,
  onPageChange,
  locale,
  labels,
  label,
  disabled = false,
  scrollTarget,
  className,
}: {
  /** Zero-based. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Only the fallback for a caller that passes no `labels`. */
  locale?: string;
  labels?: PagerLabels;
  /** What is being paged — the landmark's name, e.g. «صفحات الرسوم». Wins over `labels.nav`. */
  label?: string;
  /** Both buttons off while the list's read is in flight. */
  disabled?: boolean;
  /** The top of the list, brought into view after a change. */
  scrollTarget?: React.RefObject<HTMLElement | null>;
  className?: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;

  const en = locale === 'en';
  const first = page * pageSize + 1;
  const last = Math.min(total, first + pageSize - 1);
  const previous = labels?.previous ?? (en ? 'Previous page' : 'الصفحة السابقة');
  const next = labels?.next ?? (en ? 'Next page' : 'الصفحة التالية');
  const position = labels
    ? labels.position(page + 1, pageCount)
    : en
      ? `Page ${page + 1} of ${pageCount}`
      : `صفحة ${page + 1} من ${pageCount}`;
  const range = labels
    ? labels.range(first, last, total)
    : en
      ? `${first}–${last} of ${total}`
      : `${first}–${last} من ${total}`;

  const go = (target: number) => {
    onPageChange(target);
    const node = scrollTarget?.current;
    if (node && node.getBoundingClientRect().top < 0) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      node.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    }
  };

  return (
    <nav
      aria-label={label ?? labels?.nav ?? (en ? 'Pages' : 'الصفحات')}
      aria-busy={disabled || undefined}
      className={cn('flex items-center justify-between gap-3', className)}
    >
      <span className="text-sm tabular-nums text-muted-foreground">{range}</span>
      <div className="flex items-center gap-2">
        <span aria-live="polite" aria-atomic="true" className="text-sm font-medium tabular-nums text-muted-foreground">
          {position}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={previous}
          title={previous}
          disabled={disabled || page <= 0}
          onClick={() => go(page - 1)}
        >
          <ChevronRight className="size-4 ltr:rotate-180" aria-hidden />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={next}
          title={next}
          disabled={disabled || page >= pageCount - 1}
          onClick={() => go(page + 1)}
        >
          <ChevronLeft className="size-4 ltr:rotate-180" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}

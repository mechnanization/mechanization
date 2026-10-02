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
 * (A11Y-7). Pass `scrollTarget` and a page change brings the list's top back
 * into view, as DataTable does — otherwise the reader is left looking at the
 * bottom of a list that has just changed under them.
 */
export function Pager({
  page,
  pageSize,
  total,
  onPageChange,
  locale,
  label,
  scrollTarget,
  className,
}: {
  /** Zero-based. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  locale: string;
  /** What is being paged — the landmark's name, e.g. «صفحات الرسوم». */
  label?: string;
  /** The top of the list, brought into view after a change. */
  scrollTarget?: React.RefObject<HTMLElement | null>;
  className?: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;

  const en = locale === 'en';
  const first = page * pageSize + 1;
  const last = Math.min(total, first + pageSize - 1);
  const previous = en ? 'Previous page' : 'الصفحة السابقة';
  const next = en ? 'Next page' : 'الصفحة التالية';
  const position = en ? `Page ${page + 1} of ${pageCount}` : `صفحة ${page + 1} من ${pageCount}`;

  const go = (target: number) => {
    onPageChange(target);
    const node = scrollTarget?.current;
    if (node && node.getBoundingClientRect().top < 0) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      node.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    }
  };

  return (
    <nav aria-label={label ?? (en ? 'Pages' : 'الصفحات')} className={cn('flex items-center justify-between gap-3', className)}>
      <span className="text-sm tabular-nums text-muted-foreground">
        {en ? `${first}–${last} of ${total}` : `${first}–${last} من ${total}`}
      </span>
      <div className="flex items-center gap-2">
        <span aria-live="polite" aria-atomic="true" className="text-sm font-medium tabular-nums text-muted-foreground">
          {position}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={previous}
          title={previous}
          disabled={page <= 0}
          onClick={() => go(page - 1)}
        >
          <ChevronRight className="size-4 ltr:rotate-180" aria-hidden />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={next}
          title={next}
          disabled={page >= pageCount - 1}
          onClick={() => go(page + 1)}
        >
          <ChevronLeft className="size-4 ltr:rotate-180" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}

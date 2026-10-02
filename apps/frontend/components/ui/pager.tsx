'use client';

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
 */
export function Pager({
  page,
  pageSize,
  total,
  onPageChange,
  locale,
  className,
}: {
  /** Zero-based. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  locale: string;
  className?: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;

  const en = locale === 'en';
  const first = page * pageSize + 1;
  const last = Math.min(total, first + pageSize - 1);
  const previous = en ? 'Previous' : 'السابق';
  const next = en ? 'Next' : 'التالي';

  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <span className="text-sm tabular-nums text-muted-foreground">
        {en ? `${first}–${last} of ${total}` : `${first}–${last} من ${total}`}
      </span>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium tabular-nums text-muted-foreground">
          {en ? `Page ${page + 1} of ${pageCount}` : `صفحة ${page + 1} من ${pageCount}`}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={previous}
          title={previous}
          disabled={page <= 0}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronRight className="size-4 ltr:rotate-180" aria-hidden />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={next}
          title={next}
          disabled={page >= pageCount - 1}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronLeft className="size-4 ltr:rotate-180" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

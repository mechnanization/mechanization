'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * «السابق» / «التالي», and which page of how many.
 *
 * ## Why this exists beside `DataTable`
 *
 * `DataTable` paginates itself and keeps doing so — nothing here changes it.
 * But the tables are not the only long lists: a queue rendered as cards, a
 * history rendered as rows, an audit trail. Those either showed everything or
 * grew their own two buttons, and the two buttons are where the off-by-one
 * lives — a «التالي» still enabled on the last page, a count that says «صفحة ٠».
 *
 * ## Pages are 1-based here and 0-based in the table
 *
 * `pageIndex` in `DataTable` is TanStack's, and TanStack counts from zero.
 * This is the control an officer reads, so it counts from one and says so in
 * its prop names. Translating at the boundary is one line in the caller;
 * having two different meanings for the word "page" in one codebase is a bug
 * waiting for whoever wires the next list.
 *
 * ## Both arrows, and which way they point
 *
 * `rtl:rotate-180` on each: in Arabic «التالي» moves leftward, and an arrow
 * pointing the other way makes a reader stop and work out which is which.
 */
export function Pagination({
  page,
  pageCount,
  onPageChange,
  total,
  locale = 'ar',
  className,
}: {
  /** 1-based. */
  page: number;
  pageCount: number;
  onPageChange: (next: number) => void;
  /** How many rows there are in all, when the caller knows. */
  total?: number;
  locale?: string;
  className?: string;
}): React.JSX.Element | null {
  const en = locale === 'en';
  // One page is not a thing to navigate, and zero is an empty state's job.
  if (pageCount <= 1) return null;

  const first = page <= 1;
  const last = page >= pageCount;

  return (
    <nav
      aria-label={en ? 'Pagination' : 'تنقّل بين الصفحات'}
      className={cn('flex flex-wrap items-center justify-between gap-3', className)}
    >
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {en ? `Page ${page} of ${pageCount}` : `صفحة ${page} من ${pageCount}`}
        {total !== undefined ? (
          <span className="ms-2">
            {en ? `· ${total} rows` : `· ${total} سجلّاً`}
          </span>
        ) : null}
      </p>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={first}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronRight className="size-4 rtl:rotate-180" aria-hidden />
          {en ? 'Previous' : 'السابق'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={last}
          onClick={() => onPageChange(page + 1)}
        >
          {en ? 'Next' : 'التالي'}
          <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}

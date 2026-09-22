import * as React from 'react';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Where this page sits, for the pages deep enough to need saying.
 *
 * ## Read this before reaching for it
 *
 * Most screens here should keep `BackLink` instead. A trail answers "where am
 * I in the structure"; `BackLink` answers "how do I get back to what I was
 * doing", and in an admin tool the second question is the one officers
 * actually ask — which is why `BackLink` jumps through history rather than to
 * a section index. A trail that is two entries long is a back link with extra
 * punctuation.
 *
 * It earns its place at the third level and below, where the parent is not the
 * section index: a unit inside a building inside the register. There, the
 * middle entry is a real destination that nothing else on the page offers.
 *
 * ## The separator points the way the page reads
 *
 * `ChevronLeft` with `rtl:rotate-180`, not a slash: in Arabic the trail runs
 * right to left and a chevron that points the wrong way turns a path into a
 * puzzle. The icon is decorative — the `<ol>` already says these are ordered
 * steps, and a screen reader announcing "chevron" between every pair is noise.
 */
export interface Crumb {
  label: React.ReactNode;
  /** Omitted on the last entry: the page you are already on is not a link. */
  href?: string;
}

export function Breadcrumbs({
  items,
  label,
  className,
}: {
  items: readonly Crumb[];
  /** Names the trail for assistive technology. */
  label?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <nav aria-label={label ?? 'المسار'} className={cn('min-w-0', className)}>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        {items.map((crumb, index) => {
          const last = index === items.length - 1;
          return (
            <li key={index} className="flex min-w-0 items-center gap-1.5">
              {index > 0 ? (
                <ChevronLeft className="size-3.5 shrink-0 opacity-60 rtl:rotate-180" aria-hidden />
              ) : null}
              {crumb.href && !last ? (
                <Link
                  href={crumb.href}
                  className="truncate underline-offset-2 transition-colors hover:text-foreground hover:underline"
                >
                  {crumb.label}
                </Link>
              ) : (
                /*
                  `aria-current="page"` on the last one: without it a screen
                  reader reads the trail as a list of links with one plain
                  entry, and nothing says which is here.
                */
                <span className="truncate font-medium text-foreground" aria-current={last ? 'page' : undefined}>
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

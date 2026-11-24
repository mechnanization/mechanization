import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * One page heading, everywhere.
 *
 * Every admin screen had grown its own header — the same tinted icon tile,
 * title and action row, re-typed with slightly different sizes and gaps each
 * time. Pulling it into one component is what makes «المواطنون» and «إدارة
 * الرسوم» look like the same product rather than two that happen to share a
 * sidebar.
 *
 * ## A title and nothing under it
 *
 * There is no subtitle, on purpose. It was removed from every page at once: a
 * line of description under every title was read once and then skipped forever,
 * and it pushed the content down on every visit. Where a subtitle was carrying
 * something the reader needs — whose bill is being settled — that fact moved
 * into the title or the page body rather than being lost. A page that needs to
 * explain itself does it where the explanation is used: beside the field, in an
 * empty state, in an alert.
 *
 * `actions` is pushed to the far edge with `ms-auto` rather than the row using
 * `justify-between`: the header has two children at some widths and three at
 * others, and only the actions should ever be flung to the end. They wrap onto
 * further lines when they do not fit (LAY-5): a row that scrolled sideways hid
 * the page's main action off-screen at 360px, with nothing to say it was there.
 * The title keeps `sm:min-w-40`, so a long row of actions wraps rather than
 * squeezing it to nothing.
 */
export function PageHeader({
  icon: Icon,
  title,
  actions,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b pb-4',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3 sm:min-w-40">
        <span
          aria-hidden
          className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
        >
          <Icon className="size-5" />
        </span>
        <h1 className="min-w-0 flex-1 text-xl font-bold leading-tight tracking-tight sm:truncate md:text-2xl">
          {title}
        </h1>
      </div>
      {actions ? (
        <div className="flex max-w-full flex-wrap items-center gap-2 sm:ms-auto sm:justify-end">{actions}</div>
      ) : null}
    </div>
  );
}

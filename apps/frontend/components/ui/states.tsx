'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Inbox, Loader2, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The three things a panel can be showing instead of its content: nothing yet,
 * nothing at all, or a failure.
 *
 * `DataTable` already draws all three for the rows it owns, and every screen
 * outside a table re-invented them — usually as a bare `<p>` of grey text, and
 * on the error path usually as nothing, since `logApiError` writes to the
 * console and the page keeps its stale content. These are the same three
 * states as one component so a card, a drawer and a chart panel answer "where
 * is my data" identically.
 */

/**
 * "Still loading", centred in whatever space it is given.
 *
 * Every screen wrote its own — a bare `<p>جارٍ التحميل…</p>` pinned to the
 * top-left of the content area, so a full-page wait looked like a page that had
 * rendered one line of text and stopped. Centring it is most of the fix: the
 * reader's eye is already in the middle of the region that is about to fill.
 *
 * `fullHeight` is for a screen with nothing else on it yet, where the wait
 * should sit in the middle of the viewport rather than the middle of a
 * zero-height container.
 */
export function LoadingState({
  label,
  className,
  compact = false,
  fullHeight = false,
}: {
  label?: string;
  className?: string;
  /** Tighter padding, for a wait inside a card rather than a page. */
  compact?: boolean;
  /** Fills the available height, for a route-level wait. */
  fullHeight?: boolean;
}): React.JSX.Element {
  return (
    <div
      /**
       * `role="status"` with `aria-live="polite"`: a screen reader is
       * otherwise told nothing at all between the click and the content, and
       * the spinner is a purely visual signal.
       */
      role="status"
      aria-live="polite"
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 text-center',
        fullHeight ? 'min-h-[60dvh] py-10' : compact ? 'py-8' : 'py-14',
        className,
      )}
    >
      <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
      {label ? <p className="text-sm text-muted-foreground">{label}</p> : null}
    </div>
  );
}

export function EmptyState({
  icon: Icon = Inbox,
  iconNode,
  title,
  description,
  action,
  className,
  compact = false,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  /**
   * An already-rendered icon, when the caller wants one sized or coloured its
   * own way. Takes precedence over `icon`, and exists because `DataTable`'s
   * `emptyIcon` prop is a node — its callers pass `<Users className="…" />`
   * rather than the component — and turning that into a breaking change to
   * make this signature tidier would be the wrong trade.
   */
  iconNode?: React.ReactNode;
  title: string;
  /** What would put something here — not a restatement of the title. */
  description?: string;
  action?: React.ReactNode;
  className?: string;
  /** Tighter padding, for an empty state inside a card rather than a page. */
  compact?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-6 text-center',
        compact ? 'py-8' : 'py-14',
        className,
      )}
    >
      <span
        aria-hidden
        className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-6"
      >
        {iconNode ?? <Icon className="size-6" />}
      </span>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description ? (
        // `max-w-sm`: a full-width line of centred text across a desktop table
        // is a paragraph the eye cannot track back to the start of.
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title,
  description,
  offline = false,
  onRetry,
  retryLabel,
  className,
  compact = false,
}: {
  /** Defaults to the messages' «could not load», or «no connection» when `offline`. */
  title?: string;
  /** The server's own message, when there is one worth showing. */
  description?: string;
  /**
   * The read never reached the server (`ApiRequestError` with `status === 0`; `useStaffQuery`'s
   * `offline`). Its remedy is the reader's own connection, so it gets its own icon and title.
   */
  offline?: boolean;
  onRetry?: () => void;
  /** Defaults to the messages' «try again». */
  retryLabel?: string;
  className?: string;
  compact?: boolean;
}): React.JSX.Element {
  const t = useTranslations('errorState');
  /*
   * A dropped connection is told apart from a server fault, because the two
   * have different remedies and only one of them is the reader's to apply. The
   * caller says which (`offline`, from the status): matching the Arabic text of
   * the client's message here never worked on an English page (ERR-06).
   */
  const Icon = offline ? WifiOff : TriangleAlert;

  return (
    <div
      // `role="alert"` rather than a plain div: this replaces content the
      // reader was waiting for, and a screen reader gets no other signal that
      // the wait ended in a failure.
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center px-6 text-center',
        compact ? 'py-8' : 'py-14',
        className,
      )}
    >
      <span
        aria-hidden
        className="mb-3 flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive"
      >
        <Icon className="size-6" />
      </span>
      <p className="text-sm font-semibold text-foreground">{title ?? (offline ? t('offlineTitle') : t('title'))}</p>
      {description ? (
        <p className="mt-1.5 max-w-sm break-words text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-4 gap-2" onClick={onRetry}>
          <RefreshCw className="size-4" />
          {retryLabel ?? t('retry')}
        </Button>
      ) : null}
    </div>
  );
}

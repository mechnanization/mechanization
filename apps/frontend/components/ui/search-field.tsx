'use client';

import * as React from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from './input';

/**
 * A list's search box: what `DataTable` drew inline, lifted out so a register
 * that is not a table (the treasury's «الحركات المالية», a list of dated rows)
 * searches the same way rather than hand-rolling a second box (PRIM-24).
 *
 * Two values, deliberately: the box shows every keystroke, while the committed
 * term — the one sent to the API — changes only when the reader asks for it
 * with Enter. Neither a slow backend nor a large in-memory list is touched
 * while someone is still typing a name, and a search costs exactly one query.
 * Emptying the box is the one exception: clearing is unambiguous, and nobody
 * presses Enter to say "show everything again" (it also covers the clear button
 * WebKit draws inside `type="search"`).
 *
 * The end edge holds one control at a time: the key that would run the draft,
 * or, once it has run, the control that clears it. A draft equal to the
 * applied term has nothing left to commit, so the two never compete.
 *
 * Every string is a prop (PRIM-21); the defaults are Arabic.
 */
function SearchField({
  value,
  onCommit,
  placeholder,
  ariaLabel,
  clearLabel = 'مسح البحث',
  hint = 'Enter',
  className,
}: {
  /** The committed term. A change from outside (a «clear filters» elsewhere) resets the box. */
  value: string;
  /** Fires with the trimmed term on Enter, and with `''` when the box is emptied. */
  onCommit: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  clearLabel?: string;
  /** The key shown while the box holds an uncommitted draft. */
  hint?: string;
  className?: string;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState(value);

  React.useEffect(() => {
    setDraft(value);
  }, [value]);

  // Compared trimmed, because that is what a commit sends: «أحمد » against an
  // applied «أحمد» is the same search, and flagging it would prompt for an
  // Enter that has already run.
  const isDraft = draft.trim() !== value.trim();

  return (
    <div className={cn('relative w-full', className)}>
      <Search
        className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        role="searchbox"
        aria-label={ariaLabel}
        className="h-9 ps-9 pe-9 text-xs"
        placeholder={placeholder}
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (next === '' && value !== '') onCommit('');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onCommit(draft.trim());
          }
        }}
      />
      {isDraft ? (
        <kbd
          aria-hidden
          className="pointer-events-none absolute end-2 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-xs font-medium leading-none text-muted-foreground"
        >
          {hint}
        </kbd>
      ) : draft ? (
        <button
          type="button"
          onClick={() => {
            setDraft('');
            onCommit('');
          }}
          aria-label={clearLabel}
          className="absolute end-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export { SearchField };

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CornerDownLeft, Loader2, Search, User, X } from 'lucide-react';
import { listCitizens, type CitizenListItem } from '@/lib/api-client';
import { localizedLabel, visibleGroups, type NavItem } from '@/components/admin/nav';
import { cn } from '@/lib/utils';

export function CommandPalette({
  open,
  onOpenChange,
  base,
  locale = 'ar',
  tenant,
  token,
  role,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  base: string;
  locale?: string;
  tenant: string;
  token: string | undefined;
  role: string | undefined;
}): React.JSX.Element | null {
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const [citizens, setCitizens] = React.useState<CitizenListItem[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [highlight, setHighlight] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const sections = React.useMemo(() => {
    const all = visibleGroups(role).flatMap((group) => group.items);
    const term = query.trim();
    if (!term) return all;
    return all.filter(
      (item) =>
        item.label.includes(term) ||
        (item.keywords ?? []).some((keyword) => keyword.includes(term)),
    );
  }, [query, role]);

  // Reset on every open so the palette never re-opens showing the previous
  // search — a clerk pressing Ctrl+K expects an empty box.
  React.useEffect(() => {
    if (open) {
      setQuery('');
      setCitizens([]);
      setHighlight(0);
    }
  }, [open]);

  /*
   * Citizen lookup is debounced, unlike the register's table search, which
   * commits on Enter.
   *
   * The table's rule is right there: it replaces a full page of results under
   * a reader who is mid-scan. Here there is nothing to disturb — the list is
   * empty until the query returns — and requiring Enter would mean the palette
   * shows only section matches until asked twice, which reads as it not
   * finding people at all.
   */
  React.useEffect(() => {
    const term = query.trim();
    if (!token || term.length < 2) {
      setCitizens([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      listCitizens(tenant, token, { search: term, limit: 6 })
        .then((result) => {
          if (!cancelled) setCitizens(result.items);
        })
        // Silent: a failed lookup leaves the section matches, which is a
        // usable palette. A toast here would fire on every dropped keystroke
        // of a bad connection.
        .catch(() => {
          if (!cancelled) setCitizens([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, tenant, token]);

  type Result =
    | { kind: 'section'; item: NavItem }
    | { kind: 'citizen'; item: CitizenListItem };

  const results = React.useMemo<Result[]>(
    () => [
      ...sections.map((item) => ({ kind: 'section' as const, item })),
      ...citizens.map((item) => ({ kind: 'citizen' as const, item })),
    ],
    [sections, citizens],
  );

  // Clamp rather than reset: as server results arrive the list grows, and
  // resetting to 0 would yank the highlight back to the top under someone
  // already arrowing down it.
  React.useEffect(() => {
    setHighlight((current) => Math.min(current, Math.max(results.length - 1, 0)));
  }, [results.length]);

  const go = React.useCallback(
    (result: Result) => {
      onOpenChange(false);
      router.push(
        result.kind === 'section'
          ? `${base}${result.item.path}`
          : `${base}/citizens/${result.item.id}`,
      );
    },
    [base, onOpenChange, router],
  );

  // Lock the page behind the overlay, and focus the box. Both are undone on
  // close by the cleanup, so a palette opened twice does not stack two locks.
  React.useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    inputRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={locale === 'en' ? 'Global Search' : 'بحث شامل'}
      className="fixed inset-0 z-[60] flex items-start justify-center p-3 sm:p-6"
    >
      <button
        type="button"
        aria-label={locale === 'en' ? 'Close' : 'إغلاق'}
        className="absolute inset-0 cursor-default bg-black/60 animate-in fade-in"
        onClick={() => onOpenChange(false)}
      />
      <div
        className={cn(
          // Sits below the top edge rather than centred: the palette grows
          // downward as results arrive, and a vertically centred panel would
          // shift its own input out from under the cursor while typing.
          'relative mt-[8dvh] flex w-full max-w-xl flex-col overflow-hidden rounded-xl border bg-popover shadow-2xl',
          'max-h-[min(28rem,calc(100dvh-12vh))] animate-in fade-in zoom-in-95 duration-150',
        )}
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b px-3.5">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onOpenChange(false);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setHighlight((current) => (current + 1) % Math.max(results.length, 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setHighlight(
                  (current) =>
                    (current - 1 + Math.max(results.length, 1)) % Math.max(results.length, 1),
                );
              } else if (event.key === 'Enter') {
                event.preventDefault();
                const chosen = results[highlight];
                if (chosen) go(chosen);
              }
            }}
            placeholder={locale === 'en'
              ? 'Search section or citizen — by name, phone, or reference'
              : 'ابحث عن قسم أو مواطن — بالاسم أو الهاتف أو الرقم المرجعي'}
            aria-label={locale === 'en' ? 'Search section or citizen' : 'ابحث عن قسم أو مواطن'}
            style={{ outline: 'none', boxShadow: 'none', border: 'none' }}
            className="h-12 min-w-0 flex-1 border-0 bg-transparent text-sm shadow-none outline-none ring-0 focus:border-0 focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0 placeholder:text-muted-foreground"
          />
          {searching ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
          ) : null}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label={locale === 'en' ? 'Close' : 'إغلاق'}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-muted-foreground">
              {query.trim().length < 2
                ? (locale === 'en' ? 'Type at least 2 characters to search citizens' : 'اكتب حرفين على الأقل للبحث عن مواطن')
                : (locale === 'en' ? 'No matching results' : 'لا نتائج مطابقة')}
            </p>
          ) : (
            <>
              {sections.length > 0 ? (
                <p className="px-2.5 pb-1 pt-2 text-xs font-semibold tracking-wider text-muted-foreground">
                  {locale === 'en' ? 'Sections' : 'الأقسام'}
                </p>
              ) : null}
              {results.map((result, index) => {
                const isHighlighted = index === highlight;
                if (result.kind === 'section') {
                  const Icon = result.item.icon;
                  return (
                    <button
                      key={`section-${result.item.path}`}
                      type="button"
                      onMouseEnter={() => setHighlight(index)}
                      onClick={() => go(result)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2.5 text-start text-sm transition-colors',
                        isHighlighted
                          ? 'bg-accent text-accent-foreground'
                          : 'text-muted-foreground',
                      )}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden />
                      <span className="truncate">{localizedLabel(result.item, locale)}</span>
                      {isHighlighted ? (
                        <CornerDownLeft
                          className="ms-auto size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                      ) : null}
                    </button>
                  );
                }

                const citizen = result.item;
                // The first citizen row carries the group heading, so the
                // heading cannot appear above an empty list.
                const isFirstCitizen = index === sections.length;
                return (
                  <React.Fragment key={`citizen-${citizen.id}`}>
                    {isFirstCitizen ? (
                      <p className="px-2.5 pb-1 pt-3 text-xs font-semibold tracking-wider text-muted-foreground">
                        {locale === 'en' ? 'Citizens' : 'المواطنون'}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      onMouseEnter={() => setHighlight(index)}
                      onClick={() => go(result)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-start text-sm transition-colors',
                        isHighlighted ? 'bg-accent text-accent-foreground' : '',
                      )}
                    >
                      <span
                        aria-hidden
                        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
                      >
                        <User className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-foreground">
                          {citizen.fullName}
                        </span>
                        {/* The two things that disambiguate a common name.
                            `dir="ltr"` on the pair: a phone number and a
                            reference code are Latin-script runs, and left in
                            an RTL paragraph the bidi algorithm reorders their
                            punctuation. */}
                        <span dir="ltr" className="block truncate text-xs text-muted-foreground">
                          {[citizen.referenceNumber, citizen.phone].filter(Boolean).join(' · ') ||
                            '—'}
                        </span>
                      </span>
                      {citizen.overdueTotal > 0 ? (
                        <span className="shrink-0 rounded-md bg-destructive/10 px-1.5 py-0.5 text-xs font-semibold text-destructive">
                          {locale === 'en' ? 'Overdue' : 'متأخرات'}
                        </span>
                      ) : null}
                    </button>
                  </React.Fragment>
                );
              })}
            </>
          )}
        </div>

        <div className="hidden shrink-0 items-center gap-3 border-t px-3.5 py-2 text-xs text-muted-foreground sm:flex">
          <span>{locale === 'en' ? '↑↓ to navigate' : '↑↓ للتنقل'}</span>
          <span>{locale === 'en' ? 'Enter to select' : 'Enter للفتح'}</span>
          <span>{locale === 'en' ? 'Esc to close' : 'Esc للإغلاق'}</span>
        </div>
      </div>
    </div>
  );
}

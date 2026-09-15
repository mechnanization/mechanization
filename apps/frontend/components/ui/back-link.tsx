'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * «رجوع» — back to where you actually came from.
 *
 * Every way out of an action in this portal was a fixed link to a section's
 * index. «تعديل المبنى» from a building's matrix walked you to the edit page,
 * and the only exit offered was «سجل المباني» — the list, not the matrix you
 * were reading a moment earlier. An officer correcting one building had to
 * find it again in a table of every building the municipality owns. The way
 * out of an action should be the way in.
 *
 * Still a real link, and `fallbackHref` is still the destination it names.
 * That matters in three cases the history jump cannot serve:
 *
 *   - a page opened from a pasted URL or a bookmark has nothing behind it,
 *   - «فتح في تبويب جديد» and middle-click expect an href, not a handler,
 *   - a click that lands before hydration is a plain navigation.
 *
 * So the jump is layered onto the click, never a replacement for having
 * somewhere to go. `window.history.length` is what decides: 1 means this
 * document is the first entry in its tab and `back()` would leave the portal
 * (or do nothing at all), anything more means there is a previous page and
 * going back to it is what the officer asked for.
 *
 * The one case this reads wrong is arriving from an external site in the same
 * tab, where `back()` leaves the portal. In an internal tool reached through
 * its own login page that is rare, and landing on the referring page is a mild
 * surprise rather than lost work — which is the trade being made against
 * sending every officer back to a list they were not looking at.
 */
export function BackLink({
  fallbackHref,
  label,
  className,
}: {
  /** Where to go when there is no history to go back to. A real destination. */
  fallbackHref: string;
  label: string;
  className?: string;
}) {
  const router = useRouter();

  return (
    <Link
      href={fallbackHref}
      onClick={(event) => {
        /*
          Modified clicks belong to the browser. Ctrl/⌘/shift open this in a new
          tab or window, and a fresh tab has no history of its own — hijacking
          them would turn «open in new tab» into «go back in this one».
        */
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        ) {
          return;
        }
        if (typeof window === 'undefined' || window.history.length <= 1) return;
        event.preventDefault();
        router.back();
      }}
      className={cn(
        'inline-flex items-center gap-1.5 text-xs sm:text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
        className,
      )}
    >
      <ArrowLeft className="size-3.5 sm:size-4 rtl:rotate-180" aria-hidden />
      <span>{label}</span>
    </Link>
  );
}

/**
 * The same decision as `BackLink`, for the places where the control is a
 * button rather than a link and there is no href to fall back to on its own.
 * Prefer `BackLink` where a link will do — it keeps middle-click working.
 */
export function useGoBack() {
  const router = useRouter();
  return useCallback(
    (fallbackHref: string) => {
      if (typeof window !== 'undefined' && window.history.length > 1) {
        router.back();
        return;
      }
      router.push(fallbackHref);
    },
    [router],
  );
}

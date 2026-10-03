'use client';

import { useCallback, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/**
 * Leaving a form without leaving the form behind in the history.
 *
 * A form's ways out — «رجوع إلى ملف المواطن», «إلغاء», the redirect after a
 * save — used to *push* their destination. Opened from a citizen's file, that
 * left the history as file → form → file, and the file's own «رجوع»
 * (`BackLink`, which steps back one entry) walked straight back into the form.
 * From there the form's link pushed the file again, and the two buttons sent
 * the officer round in a circle with no way back to the list.
 *
 * So a form leaves by one of two moves, neither of which leaves it in the
 * history:
 *
 *   - **back**, when the page before the form *is* the destination — the file
 *     the form was opened from. History is exactly as it was before the form
 *     was opened, so «رجوع» on the file goes where it went before.
 *   - **replace**, otherwise — opened from the review queue, a reload, a
 *     pasted link. The form's entry becomes the destination, and «رجوع» from
 *     there returns to whatever opened the form.
 *
 * "The page before" is tracked here rather than read from the browser, which
 * does not expose it. Pathnames only: the query is filter state
 * (`use-url-state.ts`) that `back()` restores by itself. Kept in this tab's
 * storage so a reload on the form still knows where it was opened from.
 */

const KEY = 'mechanization.nav';

interface Trail {
  current: string | null;
  previous: string | null;
}

function readTrail(): Trail {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Trail;
  } catch {
    /* storage blocked, or a value from an older build — start a new trail */
  }
  return { current: null, previous: null };
}

/** Records a page change. A reload of the same page keeps its "previous". */
export function recordPathname(pathname: string): void {
  const trail = readTrail();
  if (trail.current === pathname) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ current: pathname, previous: trail.current }));
  } catch {
    /* without storage the form falls back to replace, which is still loop-free */
  }
}

export function previousPathname(): string | null {
  return readTrail().previous;
}

/** Mounted once, in the admin shell, so every staff screen is on the trail. */
export function useRecordNavigation(): void {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) recordPathname(pathname);
  }, [pathname]);
}

/**
 * Returns `leave(href)`: back if the page before this one is `href`, replace
 * otherwise — never push. Offline it is a full navigation, as `shellNavigate`
 * does, because a client transition would need an RSC fetch that cannot
 * happen; `location.replace` keeps that loop-free too.
 *
 * Only for an `href` without a query or hash: going back restores the old
 * entry's own query, so a destination that carries one must be loaded, not
 * returned to.
 */
export function useLeaveTo(): (href: string) => void {
  const router = useRouter();
  return useCallback(
    (href: string) => {
      const target = new URL(href, window.location.href);
      const offline = typeof navigator !== 'undefined' && !navigator.onLine;
      if (offline) {
        window.location.replace(href);
        return;
      }
      if (
        !target.search &&
        !target.hash &&
        window.history.length > 1 &&
        previousPathname() === target.pathname
      ) {
        router.back();
        return;
      }
      router.replace(href);
    },
    [router],
  );
}

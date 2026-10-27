'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Asks before a half-filled form is left (S12, the fee wizard's review).
 *
 * While `active`, two ways out are held:
 *
 * - a click on an in-app link — the header's «عودة إلى …», the side nav, the
 *   form's own «إلغاء» — is stopped before Next sees it, and its address is
 *   handed back as `pendingHref` for the caller's `ConfirmDialog`; `leave`
 *   then goes there, `stay` drops it. A click that opens a new tab or window
 *   loses nothing and is let through.
 * - a reload, a closed tab or an address typed in the bar gets the browser's
 *   own «leave site?» prompt (`beforeunload`), which is the only one a page
 *   may show there.
 *
 * Not held: the browser's back button. The app router gives a page no way to
 * refuse a `popstate`, and replaying history to fake one breaks the history.
 *
 * The click listener is on `document` in the capture phase, so it runs before
 * React's own (attached at the root) and `stopPropagation` keeps `Link` from
 * starting the navigation at all. `BackLink`'s `router.back()` is one such
 * click: confirmed, it goes to its `href`, the fallback address.
 */
export function useLeaveGuard(active: boolean): {
  pendingHref: string | null;
  leave: () => void;
  stay: () => void;
} {
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Still required by Chromium-based browsers to show the prompt.
      event.returnValue = '';
    };

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      // Another site is `beforeunload`'s to ask about; a jump within this page leaves nothing.
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingHref(`${url.pathname}${url.search}${url.hash}`);
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [active]);

  const leave = useCallback(() => {
    if (pendingHref) router.push(pendingHref);
    setPendingHref(null);
  }, [pendingHref, router]);
  const stay = useCallback(() => setPendingHref(null), []);

  return { pendingHref, leave, stay };
}

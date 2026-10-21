'use client';

import * as React from 'react';

/** A page's way back, as `BackLink` takes it. */
export interface HeaderBack {
  fallbackHref: string;
  label: string;
}

/** The shell's setter for the link the header draws. Provided by `AdminShell`. */
export const HeaderBackContext = React.createContext<React.Dispatch<
  React.SetStateAction<HeaderBack | null>
> | null>(null);

/*
  A layout effect, so the header's link changes in the same paint as the page
  beneath it rather than one frame after. Pages render on the server too, where
  `useLayoutEffect` only warns, and the header has nothing to draw until hydration.
*/
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

/**
 * «عودة إلى …» in the header bar, beside the breadcrumb.
 *
 * It sat in each page above the `PageHeader`, where it scrolled away with the
 * page and pushed the heading down. The header is sticky, so the way back stays
 * in reach on a long register or form, at the same spot on every screen.
 *
 * Renders nothing where it is placed: it hands its two props to `AdminShell`,
 * and `AdminHeader` draws the `BackLink` with them. Leaving the page takes it
 * away again. Place it once per page, in every branch that shows the page.
 */
export function HeaderBackLink({ fallbackHref, label }: HeaderBack): null {
  const setBack = React.useContext(HeaderBackContext);

  useIsomorphicLayoutEffect(() => {
    if (!setBack) return;
    const mine: HeaderBack = { fallbackHref, label };
    setBack(mine);
    // Clears only its own: the next page's link may already be in place.
    return () => setBack((current) => (current === mine ? null : current));
  }, [setBack, fallbackHref, label]);

  return null;
}

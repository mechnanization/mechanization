'use client';

/**
 * Puts the top of `root` back on screen after the content under it changes.
 *
 * ## Why this is not `window.scrollTo(0, 0)`
 *
 * Because that does nothing on most of this app. The admin shell scrolls an
 * inner `<main className="overflow-y-auto">`, not the document — the window is
 * not the scroller on any screen inside the sidebar, so a window scroll would
 * silently no-op on exactly the pages this exists for. So the nearest scrolling
 * ancestor is found by walking up and asking the computed style, which also
 * covers the citizen-facing pages where the document *is* the scroller.
 *
 * ## Why the element's top and not the page's
 *
 * Whatever sits above `root` — a page header, a filter bar, a step rail — is
 * part of reading what changed, and jumping past it to absolute zero hides the
 * controls that produced the new content. `offset` shifts the landing point for
 * a caller whose target sits under something sticky.
 *
 * ## Where this is needed
 *
 * Anywhere a control at the *bottom* of a long screen replaces the content
 * *above* it: a table's «التالي», a wizard's «التالي». Both leave the reader
 * parked at the foot of something they have never seen, looking at the end of a
 * page whose beginning is a screen and a half above them — which, on a phone,
 * reads as the button having done nothing at all.
 */
export function scrollElementToTop(root: HTMLElement | null, offset = 12): void {
  if (!root || typeof window === 'undefined') return;

  // Respected because this is motion nobody asked for: it happens on a press
  // whose purpose was to change content, not to animate the page.
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const behavior: ScrollBehavior = reduced ? 'auto' : 'smooth';

  let node = root.parentElement;
  while (node) {
    const style = window.getComputedStyle(node);
    const scrollable = /(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`);
    if (scrollable && node.scrollHeight > node.clientHeight) {
      const delta = root.getBoundingClientRect().top - node.getBoundingClientRect().top;
      node.scrollTo({ top: Math.max(node.scrollTop + delta - offset, 0), behavior });
      return;
    }
    node = node.parentElement;
  }

  const doc = document.scrollingElement ?? document.documentElement;
  const top = root.getBoundingClientRect().top + doc.scrollTop;
  doc.scrollTo({ top: Math.max(top - offset, 0), behavior });
}

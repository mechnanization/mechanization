/**
 * Where a list's committed search term is kept so a reload does not lose it.
 *
 * Not the URL. Searches on this portal are names, national ID numbers and phone
 * numbers, and a query string is sent to the frontend host on every reload,
 * written to browser history, and pasted into chats with the rest of the link.
 * `sessionStorage` survives a reload and back/forward inside the tab, and
 * leaves the browser by none of those routes (decided 2026-10-03; the filters
 * beside the box are in the URL — see `url-state.ts`).
 *
 * Cleared with the session (`clearSession`), because municipality computers
 * are shared: the next person to sign in on this tab must not find the last
 * clerk's search for a citizen still applied.
 */

const PREFIX = 'mechanization.search.';

/** Longer than any real search; a cap so a pasted document cannot fill storage. */
const MAX_LENGTH = 200;

const key = (tenant: string, scope: string) => `${PREFIX}${tenant}.${scope}`;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** For `useSyncExternalStore`: same-tab writes do not fire `storage` events. */
export function subscribeTabSearch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readTabSearch(tenant: string, scope: string): string {
  try {
    return sessionStorage.getItem(key(tenant, scope)) ?? '';
  } catch {
    // Storage blocked (private mode, site data disabled): the search simply
    // does not survive a reload, which is how the page behaved before.
    return '';
  }
}

export function writeTabSearch(tenant: string, scope: string, value: string): void {
  const trimmed = value.trim().slice(0, MAX_LENGTH);
  try {
    if (trimmed) sessionStorage.setItem(key(tenant, scope), trimmed);
    else sessionStorage.removeItem(key(tenant, scope));
  } catch {
    /* see readTabSearch */
  }
  notify();
}

/** Forgets every list's search for this municipality. Called on sign-out. */
export function clearTabSearches(tenant: string): void {
  try {
    const prefix = key(tenant, '');
    const doomed: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const name = sessionStorage.key(index);
      if (name?.startsWith(prefix)) doomed.push(name);
    }
    for (const name of doomed) sessionStorage.removeItem(name);
  } catch {
    /* nothing to clean up */
  }
  notify();
}

/**
 * Hands a typed search term to the page a link opens, without putting it in
 * the link.
 *
 * «افتح ملفاً جديداً» on a unit carries what the officer had typed into the
 * occupant search — a name or a phone number — so the registration form does
 * not make them type it again. That used to be `?name=` on the URL, which put
 * a person's name in browser history and in the host's request log on every
 * reload (see the note at the top of this file).
 *
 * Bound to the exact link (path and query) it was stashed for, so opening
 * «تسجيل مواطن» later from the sidebar, or another unit's link, never inherits
 * it. One seed per tenant: stashing replaces the last. Read without being
 * consumed, so a reload of the form still has it; cleared with the session.
 */
const SEED_SCOPE = 'link-seed';

/** Path and query, the part of a link that identifies where it goes. */
function linkTarget(href: string): string {
  const url = new URL(href, 'http://portal.invalid');
  return `${url.pathname}${url.search}`;
}

export function stashLinkSeed(tenant: string, href: string, term: string): void {
  const value = term.trim().slice(0, MAX_LENGTH);
  try {
    if (value) {
      sessionStorage.setItem(
        key(tenant, SEED_SCOPE),
        JSON.stringify({ target: linkTarget(href), term: value }),
      );
    } else {
      sessionStorage.removeItem(key(tenant, SEED_SCOPE));
    }
  } catch {
    /* without storage the form opens with an empty search, as a typed URL does */
  }
}

/** The term stashed for the page at `href`, or `undefined`. */
export function readLinkSeed(tenant: string, href: string): string | undefined {
  try {
    const raw = sessionStorage.getItem(key(tenant, SEED_SCOPE));
    if (!raw) return undefined;
    const seed = JSON.parse(raw) as { target?: unknown; term?: unknown };
    return seed.target === linkTarget(href) && typeof seed.term === 'string' && seed.term
      ? seed.term
      : undefined;
  } catch {
    return undefined;
  }
}

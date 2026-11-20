/**
 * Where a staff password-reset link carries its token, written once for the
 * server that mails the link and the page that reads it (task S14 of the
 * 2026-11-14 security audit).
 *
 * In the fragment, never the query string: a fragment is not sent to any
 * server, so the token stays out of the proxy's access log and out of the
 * `Referer` the page's next request would carry. The link used to put the
 * token in `?token=` while the page looked for a Supabase-style
 * `#type=recovery&access_token=` fragment — so the token leaked, and no reset
 * could ever succeed. One key, one pair of functions, and a test on each
 * side that goes through them.
 */
export const RESET_TOKEN_FRAGMENT_KEY = 'reset_token';

/*
  Plain ECMAScript (`encodeURIComponent`), not `URLSearchParams`: this package
  runs in both apps and uses no browser or Node API (packages/shared-schemas/CLAUDE.md).
*/

/** The fragment to put on the link, without its `#`: `reset_token=…`. */
export function resetTokenFragment(token: string): string {
  return `${RESET_TOKEN_FRAGMENT_KEY}=${encodeURIComponent(token)}`;
}

/** The token a page's `location.hash` carries, or null when it carries none. */
export function resetTokenFromFragment(hash: string): string | null {
  for (const pair of hash.replace(/^#/, '').split('&')) {
    const at = pair.indexOf('=');
    if (at < 0 || pair.slice(0, at) !== RESET_TOKEN_FRAGMENT_KEY) continue;
    try {
      const token = decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' ')).trim();
      return token === '' ? null : token;
    } catch {
      // A mangled escape (`%E0%A4%A`) is no token.
      return null;
    }
  }
  return null;
}

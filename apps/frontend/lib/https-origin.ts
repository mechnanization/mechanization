/**
 * The origin (`https://media.example.test`) of an address meant to be one, or
 * `''` when it is not usable: absent, not a URL, or not https. Used where a
 * single named host is let through a policy (the Content-Security-Policy's
 * `img-src` for Day3ati's media host), so a malformed or plain-http value
 * leaves the policy as strict as it was rather than opening it.
 *
 * Pure and free of any browser or Node API, because the middleware (the edge
 * runtime) and the screens both read it.
 */
export function httpsOrigin(raw: string | undefined | null): string {
  if (!raw) return '';
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

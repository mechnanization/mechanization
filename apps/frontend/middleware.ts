import { NextRequest, NextResponse } from 'next/server';

const LOCALES = ['ar', 'en'] as const;
const DEFAULT_LOCALE = 'ar';

/**
 * Origins this portal is allowed to talk to, beyond itself.
 *
 * Enumerated rather than wildcarded, because the point of the policy is that an
 * injected script has nowhere to send what it reads. A `connect-src *` would
 * leave the citizen register one `fetch` away from anywhere.
 */
const MAPBOX = 'https://api.mapbox.com https://events.mapbox.com https://*.tiles.mapbox.com';

/**
 * The API, which is a *different origin* in every real deployment — the portal
 * and the API are two Vercel projects. Read from the same variable the browser
 * client uses, so the policy cannot drift from what the app actually calls;
 * reduced to an origin because a CSP source accepts no path.
 */
function apiOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
  try {
    return new URL(raw).origin;
  } catch {
    // A malformed value must not silently produce a policy that blocks every
    // API call — that failure would look like the backend being down.
    return '';
  }
}

/**
 * The Content-Security-Policy, per request, carrying a fresh nonce.
 *
 * This is the mitigation that matters most here: staff bearer tokens live in
 * `localStorage`, so one injected script is a month of full access to a
 * municipality's register (a token that, until `tokenVersion`, could not even
 * be revoked). Blocking script injection is what keeps that from being one bug
 * away.
 *
 * Next.js reads the nonce out of this header and stamps it onto its own inline
 * bootstrap and hydration scripts, so `'unsafe-inline'` is not needed for them
 * — but only when the header is set here, in middleware, where a per-request
 * value is possible. A static header in `next.config.mjs` cannot do it.
 */
function contentSecurityPolicy(nonce: string): string {
  const isDev = process.env.NODE_ENV !== 'production';
  const api = apiOrigin();

  const scriptSrc = isDev
    ? `script-src 'self' 'unsafe-eval' 'unsafe-inline' blob: https://api.mapbox.com`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' blob: https://api.mapbox.com`;

  const directives = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com data:',
    `img-src 'self' data: blob: ${MAPBOX}`,
    `connect-src 'self' ${api} ${MAPBOX}`.replace(/\s+/g, ' ').trim(),
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  if (!isDev) {
    directives.push('upgrade-insecure-requests');
  }

  return directives.join('; ');
}

/**
 * Fills in the default locale when a URL omits it, refuses the two reserved
 * segments that would otherwise shadow a municipality slug, and attaches the
 * security policy to every response.
 */
export function middleware(request: NextRequest) {
  /**
   * 128 bits, base64. `crypto` is the Web Crypto global available in the edge
   * runtime — `node:crypto` is not, and importing it here fails the build.
   */
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const csp = contentSecurityPolicy(nonce);

  /**
   * Forwarded on the *request* so the server components rendering this page can
   * read the nonce back (see `layout.tsx`), and so Next's own renderer finds it
   * and stamps its inline scripts with it.
   */
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);

  const { pathname } = request.nextUrl;

  /** Attaches the policy to whatever response this request produces. */
  const withCsp = (response: NextResponse): NextResponse => {
    response.headers.set('content-security-policy', csp);
    return response;
  };

  if (
    pathname.startsWith('/_next') ||
    pathname.includes('.')
  ) {
    return withCsp(NextResponse.next({ request: { headers } }));
  }

  const segments = pathname.split('/').filter(Boolean);

  if (segments.length === 0) {
    // No municipality in the URL: nothing sensible to show.
    return withCsp(NextResponse.rewrite(new URL('/not-found', request.url), { request: { headers } }));
  }

  const [tenant, maybeLocale] = segments;

  if (tenant === 'api' || tenant === '_next' || maybeLocale === 'dashboard' || maybeLocale === 'admin') {
    /**
     * Reserved segments that would otherwise shadow a municipality slug.
     *
     * Rewritten to the app's own 404 rather than answered with a bare
     * `new NextResponse('Not found')`: that produced a plain white page of
     * left-to-right English text, which in an Arabic portal reads as a
     * misconfigured server rather than as a wrong address.
     */
    return withCsp(
      NextResponse.rewrite(new URL('/not-found', request.url), { request: { headers } }),
    );
  }

  if (!maybeLocale || !LOCALES.includes(maybeLocale as (typeof LOCALES)[number])) {
    // 1. Cookie detection
    let targetLocale = DEFAULT_LOCALE;
    const cookieLocale = request.cookies.get('NEXT_LOCALE')?.value;
    if (cookieLocale && LOCALES.includes(cookieLocale as (typeof LOCALES)[number])) {
      targetLocale = cookieLocale as (typeof LOCALES)[number];
    } else {
      // 2. Accept-Language header detection
      const acceptLang = request.headers.get('accept-language');
      if (acceptLang) {
        const preferred = acceptLang
          .split(',')
          .map((lang) => lang.split(';')[0].trim().substring(0, 2).toLowerCase());
        const match = preferred.find((p) => LOCALES.includes(p as (typeof LOCALES)[number]));
        if (match) {
          targetLocale = match as (typeof LOCALES)[number];
        }
      }
    }

    const url = request.nextUrl.clone();
    url.pathname = `/${tenant}/${targetLocale}${maybeLocale ? `/${segments.slice(1).join('/')}` : ''}`;
    return withCsp(NextResponse.redirect(url));
  }

  return withCsp(NextResponse.next({ request: { headers } }));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

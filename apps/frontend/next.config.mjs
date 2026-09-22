import { fileURLToPath } from 'node:url';
import createNextIntlPlugin from 'next-intl/plugin';
// From `/config`, not the package root: the root re-export is deprecated and
// stops working in the SDK's v11.
import { withSentryConfig } from '@sentry/nextjs/config';

/** @type {import('next').NextConfig} */

/**
 * Vercel builds its own serverless output and rejects `standalone`; the Docker
 * runner depends on it. `VERCEL` is set by the platform on every build.
 */
const onVercel = Boolean(process.env.VERCEL);

/**
 * Response headers that do not vary per request.
 *
 * The Content-Security-Policy is deliberately *not* here: it carries a
 * per-request nonce and so has to be built in `middleware.ts`. Everything below
 * is constant, and a constant header belongs in the config where it can be read
 * without following a request through middleware.
 *
 * The portal had none of these. It renders every citizen's national ID number
 * and holds the staff bearer token in `localStorage`, which makes it the more
 * valuable of the two origins in this system — and the API, behind helmet, was
 * the only one with any.
 */
const SECURITY_HEADERS = [
  {
    /**
     * Two years, with subdomains. The portal is HTTPS-only in every deployment
     * and a downgrade would expose the session token in `localStorage` to
     * anyone on the path.
     */
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains',
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  {
    /**
     * `frame-ancestors 'none'` in the CSP is the modern form and is set in
     * middleware; this is the header older browsers read for the same thing.
     * Clickjacking a municipal dashboard means framing it under something that
     * persuades a clerk to click «تأكيد الدفع».
     */
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  {
    // A reference number in a URL must not travel to a third-party site in a
    // Referer header.
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    // Nothing here uses any of them. Geolocation is the notable one: the map
    // takes coordinates from the cadastre, never from the clerk's device.
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
];

const nextConfig = {
  reactStrictMode: true,
  /**
   * Where the compiled output goes — `.next` normally, elsewhere on request.
   *
   * `next build` and `next dev` share `.next` by default, and a build run while
   * the dev server is up rewrites the very chunks that server is mid-way through
   * serving. What comes out the other side is not a build error, it is the dev
   * server failing at *runtime* on a file that no longer exists:
   *
   *   Error: Cannot find module './vendor-chunks/zod@3.25.76.js'
   *   Require stack: … .next/server/webpack-runtime.js
   *
   * — a 500 on a page whose source is fine, repeating on every request, plus
   * "Fast Refresh had to perform a full reload" and a stream of 404s for
   * hot-update chunks. It is unrecoverable without killing the dev server, and
   * it looks exactly like whatever change was made last having broken the app.
   *
   * `pnpm build:check` sets `NEXT_DIST_DIR` so a verification build gets its own
   * directory and cannot touch a running dev server. The backend has the same
   * hazard for the same reason — `nest build` copies Prisma's engine binaries
   * over ones a running server holds open — and `scripts/start.mjs` documents it.
   */
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  transpilePackages: ['@mechanization/shared-schemas'],
  eslint: { ignoreDuringBuilds: false },
  // `poweredByHeader` names the framework and version to anyone scanning.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  ...(onVercel || process.platform === 'win32'
    ? {}
    : {
        // Traced standalone output, so the Docker runner ships only what the app
        // actually imports rather than the whole pnpm workspace.
        output: 'standalone',
        // The workspace root, not apps/frontend — otherwise tracing misses the
        // symlinked shared-schemas package.
        outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
      }),
};

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

/**
 * Sentry's build-time wrapper: source map upload, and the tunnel route.
 *
 * Applied *outside* `withNextIntl` because it rewrites the finished config —
 * the order matters only in that Sentry must see the config next-intl has
 * already produced, not the other way round.
 */
export default withSentryConfig(withNextIntl(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,

  /**
   * The line without which none of this works in production.
   *
   * `middleware.ts` builds a strict `connect-src` that enumerates every origin
   * this portal may talk to — deliberately, because "an injected script has
   * nowhere to send what it reads" is the mitigation standing between one XSS
   * and a month of access to a municipality's register. Sentry's ingest host is
   * not on that list and must not be added: a `connect-src` entry for a
   * third-party collector is precisely the exfiltration channel the policy
   * exists to deny.
   *
   * A tunnel resolves it instead of weakening it. Events are POSTed to
   * `/monitoring` on this origin, which `connect-src 'self'` already covers,
   * and the Next server forwards them. The CSP stays as strict as it was, and
   * as a side effect the events also survive the ad-blockers that block
   * `*.sentry.io` outright — which on a municipal network is not a rare case.
   *
   * A fixed path rather than `true`: `true` generates a fresh random route each
   * build, which is unreviewable and breaks any CDN or firewall rule written
   * against it.
   */
  tunnelRoute: '/monitoring',

  /**
   * Upload source maps but do not serve them.
   *
   * Without them a production stack trace is minified chunk names and column
   * offsets, which is an issue nobody can act on. `hideSourceMaps` keeps them
   * out of the public build output, so the bundle is readable to Sentry and not
   * to anyone who opens devtools against the portal.
   *
   * Uploading needs `SENTRY_AUTH_TOKEN` at *build* time. Without it the build
   * still succeeds — it just ships without maps, which is the right trade: a
   * missing observability token must never fail a deploy.
   */
  sourcemaps: { deleteSourcemapsAfterUpload: true },
  widenClientFileUpload: true,
  hideSourceMaps: true,

  // Nothing useful comes of the plugin narrating itself in CI logs.
  silent: !process.env.CI,
  telemetry: false,

  webpack: {
    /**
     * No automatic cron monitors. The scheduled jobs in this system are the
     * backend's (`vercel.json` in `apps/backend` — OTP cleanup, recurring
     * billing), not this project's, so instrumenting the web project's crons
     * would create check-ins for jobs that do not exist here.
     */
    automaticVercelMonitors: false,
  },
});

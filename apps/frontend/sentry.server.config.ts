import * as Sentry from '@sentry/nextjs';
import { SHARED_SENTRY_OPTIONS } from '@/lib/sentry-options';

/**
 * Sentry for the Next.js **server** runtime — SSR, route handlers, server
 * actions.
 *
 * Distinct from the API's own reporting (`apps/backend`), which is a separate
 * Vercel project with its own DSN. What lands here is the portal's own server
 * work: a page that throws while rendering, a layout that cannot reach the API.
 *
 * Loaded by `instrumentation.ts`, never imported directly.
 */
Sentry.init({
  ...SHARED_SENTRY_OPTIONS,
  // Server-rendered pages read the tenant from the URL, and a server render
  // that throws is usually a whole page down rather than one widget — worth
  // seeing even when it is the same error repeatedly.
  debug: false,
});

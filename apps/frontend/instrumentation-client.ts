import * as Sentry from '@sentry/nextjs';
import { SHARED_SENTRY_OPTIONS } from '@/lib/sentry-options';

/**
 * Sentry in the **browser** — the runtime that matters most here.
 *
 * This is where the officers and citizens actually are: a phone on a
 * municipality's own network, often offline, running the queue in
 * `lib/offline-sync.ts`. It is also the runtime whose failures are currently
 * invisible in every sense — a server error at least reaches a Vercel log, and
 * a browser error reaches nothing at all.
 *
 * Read `lib/sentry-options.ts` for what is deliberately *not* enabled, in
 * particular Session Replay, which would record a screen full of national ID
 * numbers.
 */
Sentry.init({
  ...SHARED_SENTRY_OPTIONS,

  /**
   * The default browser integrations, minus two that send traffic nobody asked
   * for.
   *
   * - `BrowserTracing` instruments navigations and fetches into transactions
   *   named after their URLs. `tracesSampleRate: 0` already stops them being
   *   sampled; removing the integration stops them being *collected*, and a
   *   portal URL carries the citizen row id being viewed.
   * - `BrowserSession` sends a session health ping on load and on unload, for
   *   release-adoption metrics this project does not use. Two extra requests
   *   per page view on a phone connection the offline queue exists because of.
   *
   * The breadcrumbs integration is deliberately *kept*: navigation and
   * lifecycle crumbs are what make an error report reconstructable, and the
   * dangerous categories are dropped individually in `beforeBreadcrumb` rather
   * than by discarding all of them.
   */
  integrations: (defaults) =>
    defaults.filter(
      (integration) =>
        integration.name !== 'BrowserSession' && integration.name !== 'BrowserTracing',
    ),

  /**
   * Explicitly not set: `tunnelRoute` is configured in `next.config.mjs`
   * instead, because it is a build-time route rather than a client option. See
   * the note there — without it the strict `connect-src` in `middleware.ts`
   * blocks every event before it leaves the page.
   */
});

/**
 * Router transition instrumentation.
 *
 * Exported even with tracing off: Sentry's Next.js integration expects the
 * symbol, and a missing one logs a warning on every navigation in development.
 */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

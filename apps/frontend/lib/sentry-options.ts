import type { Breadcrumb, ErrorEvent } from '@sentry/nextjs';
import { scrubEvent } from './sentry-redaction';

/**
 * The Sentry options every runtime of this app shares.
 *
 * Next.js initialises Sentry in three separate places — the browser bundle, the
 * Node server, and the edge runtime — and each one is its own file by the
 * framework's design. Three inits meant three chances for the privacy settings
 * to diverge, and the one that diverges is always the one nobody reads again.
 * So the settings that must not differ live here and are spread into all three.
 *
 * Read `lib/sentry-redaction.ts` alongside this: that module decides what is
 * removed, this one decides what is never collected.
 */
export const SHARED_SENTRY_OPTIONS = {
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  environment:
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
    // Vercel sets this to `production` / `preview` / `development`. Preview and
    // production both run with NODE_ENV=production, so without it the two would
    // be one indistinguishable stream — §8.5's failure mode, relocated to the
    // issue tracker.
    process.env.NEXT_PUBLIC_VERCEL_ENV ??
    process.env.NODE_ENV,

  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,

  /**
   * Off. `true` would attach the client IP and, in the browser, the contents of
   * form fields to breadcrumbs — on a screen that collects national ID numbers
   * and residency status.
   */
  sendDefaultPii: false,

  /**
   * No performance tracing. Transaction names on this app are URLs, and a
   * portal URL carries the citizen row id being viewed. `beforeSendTransaction`
   * could scrub them, but tracing was not what was asked for and every span is
   * another payload leaving the browser.
   */
  tracesSampleRate: 0,

  /**
   * Session Replay is **not** enabled, and this comment is here so that
   * enabling it later is a decision rather than an omission someone corrects.
   *
   * Replay records the DOM. The DOM of this application is a register of
   * people: names, national ID numbers, home addresses, residency and refugee
   * status, rendered as text. Sentry's masking is opt-out per element and
   * defaults to masking inputs but *not* rendered text — so a replay of the
   * citizens table is a copy of the citizens table, sent to a third party and
   * stored there. AGENTS.md §4 forbids citizen data leaving staging at all;
   * this would move it to a SaaS vendor.
   *
   * If it is ever wanted, it needs `maskAllText: true`, `blockAllMedia: true`,
   * and a review of what a masked replay is still worth — which may be nothing.
   */

  /**
   * The categories dropped before a crumb is ever recorded.
   *
   * - `console` — the app logs API failures through `logApiError`, and an API
   *   failure body can quote a record.
   * - `fetch` / `xhr` — the URL of every API call, which carries citizen ids.
   *   `redactUrl` would clean them, but not collecting is stronger than
   *   collecting and cleaning.
   * - `ui.click` — Sentry records the clicked element's text content. On a
   *   table of citizens, that text *is* the citizen's name.
   *
   * What is left is navigation and lifecycle crumbs, which describe where
   * someone was rather than who they were looking at.
   */
  beforeBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
    if (!crumb.category) return crumb;
    if (crumb.category === 'console') return null;
    if (crumb.category === 'fetch' || crumb.category === 'xhr') return null;
    if (crumb.category.startsWith('ui.')) return null;
    return crumb;
  },

  /** The last gate before anything leaves. See `lib/sentry-redaction.ts`. */
  beforeSend(event: ErrorEvent): ErrorEvent {
    return scrubEvent(event);
  },

  /**
   * Noise that is not this application's to fix.
   *
   * Every one of these is a browser or extension artefact that produces issues
   * nobody can act on. Filtering them is not cosmetic here: an issue stream
   * that is 90% `ResizeObserver` warnings is one nobody opens, which is the
   * same outcome as not having installed Sentry at all.
   */
  ignoreErrors: [
    // Fires when a resize handler does work that triggers another resize. Benign,
    // and emitted by several of the Radix primitives this app is built on.
    'ResizeObserver loop limit exceeded',
    'ResizeObserver loop completed with undelivered notifications',
    // A navigation or a tab close during an in-flight request. The offline queue
    // treats these as retryable by design — see `isRetryable` in offline-sync.
    'AbortError',
    'The operation was aborted',
    // A phone that lost signal mid-request. This is the condition the whole
    // offline queue exists for, not a bug to be reported thousands of times.
    'NetworkError when attempting to fetch resource',
    'Failed to fetch',
    'Load failed',
    // Injected scripts and browser extensions, which cannot be debugged from here.
    'Non-Error promise rejection captured',
    /^chrome-extension:\/\//,
    /^moz-extension:\/\//,
  ] as (string | RegExp)[],
};

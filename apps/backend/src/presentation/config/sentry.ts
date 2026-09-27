import * as Sentry from '@sentry/node';
import { scrubEvent } from './sentry-redaction';

/**
 * Error reporting for the API.
 *
 * Reads `process.env` directly rather than `ConfigService`, and that is not an
 * oversight. Sentry has to be initialised *before* `NestFactory.create`, or the
 * exceptions worth catching most — a failed env validation, a registry
 * connection that never opens, a module that throws in its constructor — happen
 * while there is nothing listening. `ConfigService` does not exist yet at that
 * point. `SENTRY_DSN` is still declared in `env.schema.ts` so the variable is
 * documented and typo-checked at boot like every other one; this just reads it
 * a few milliseconds earlier.
 *
 * **Unset DSN means disabled, and that is a supported state**, not a
 * degradation. `pnpm dev` runs against each developer's own local database
 * (AGENTS.md §2) — an SDK that shipped every developer's stack traces into the
 * production issue stream would make the stream unreadable within a week. It is equally deliberate that this does *not* become a boot
 * requirement in production: §8.7 is a whole incident about an env guard that
 * enforced a boot failure rather than a working path, and a municipality whose
 * API refuses to start because an observability vendor is unreachable has been
 * made less available, not more.
 */

let enabled = false;

/** Whether `initSentry` found a DSN and actually started the SDK. */
export function sentryEnabled(): boolean {
  return enabled;
}

/**
 * Starts the SDK, once, if a DSN is configured.
 *
 * Returns whether it did, so the caller can say so in the boot log — an
 * observability tool that is silently off is the failure mode that matters
 * here, and «verify, then report» (§5) applies to this as much as to a
 * migration.
 */
export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return false;
  if (enabled) return true;

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV || 'development',
    release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,

    /**
     * The single most important line in this file.
     *
     * `sendDefaultPii: true` attaches the client IP, the request body and the
     * cookie header to every event. On a municipal register that is a home
     * address, a national ID number and a session token, in one payload, to a
     * third party. `beforeSend` strips all three anyway — this is the belt to
     * its braces, and it is written out rather than left to the default so that
     * flipping it is a visible, arguable change.
     */
    sendDefaultPii: false,

    /**
     * Tracing off.
     *
     * Spans on this API would be named after the URLs they traced, and those
     * URLs carry citizen row ids and `?search=` terms over a register of
     * people's names. `beforeSendTransaction` could scrub them, but the honest
     * accounting is that performance tracing is not what was asked for, and
     * every span is another payload leaving the building. Turn it on
     * deliberately, with the scrubber extended to transactions, or not at all.
     */
    tracesSampleRate: 0,

    /**
     * The default integrations include `requestDataIntegration`, which is what
     * puts the body and headers on the event in the first place. Configuring it
     * down here means the data is never collected rather than collected and
     * then deleted — one fewer place for it to be read from.
     */
    integrations: [
      Sentry.requestDataIntegration({
        include: {
          cookies: false,
          data: false,
          headers: false,
          query_string: false,
          // The route shape is the one part worth having, and `redactUrl`
          // strips the ids out of it before it leaves.
          url: true,
          ip: false,
        },
      }),
    ],

    /**
     * The last gate before anything leaves. Kept as a call into a tested pure
     * function rather than written inline, so the rules can be argued with in
     * `sentry-redaction.spec.ts` instead of being taken on trust.
     */
    beforeSend(event) {
      return scrubEvent(event);
    },

    /**
     * Breadcrumbs are recorded continuously and attached to whatever error
     * happens next, so a crumb laid during a citizen lookup rides along with an
     * unrelated failure ten seconds later. The two noisy sources here are both
     * high-risk: `http` crumbs carry outbound URLs, and `console` crumbs carry
     * whatever any service logged — including the tenant migrator's SQL. Both
     * are dropped rather than scrubbed, because neither is worth the surface.
     */
    beforeBreadcrumb(crumb) {
      if (crumb.category === 'console' || crumb.category === 'http') return null;
      return crumb;
    },
  });

  enabled = true;
  return true;
}

/**
 * Reports one exception, with the request context that survives redaction.
 *
 * The `correlationId` is the point of this signature. It is already in the
 * response body the client sees and in the API's own log line, so it is the one
 * string that ties a citizen saying "it said try again later" to a Sentry issue
 * and to a Vercel log — without any of the three needing to name the citizen.
 */
export function reportException(
  exception: unknown,
  context: { correlationId?: string; method?: string; route?: string; tenant?: string },
): void {
  if (!enabled) return;

  Sentry.withScope((scope) => {
    if (context.correlationId) scope.setTag('correlation_id', context.correlationId);
    if (context.method) scope.setTag('http.method', context.method);
    // The municipality, not the person — see `redactUrl`. This is the tag that
    // makes "is this one tenant or all of them" answerable at a glance.
    if (context.tenant) scope.setTag('tenant', context.tenant);
    if (context.route) scope.setContext('request', { route: context.route });
    Sentry.captureException(exception);
  });
}

/**
 * Flushes buffered events.
 *
 * Serverless only, and required there: Vercel freezes the instance the moment
 * the response is returned, so an event still in the transport queue is simply
 * lost — which looks exactly like an error that never happened. The timeout is
 * short because a slow Sentry must never become a slow API.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Reporting the reporter's failure has nowhere useful to go.
  }
}

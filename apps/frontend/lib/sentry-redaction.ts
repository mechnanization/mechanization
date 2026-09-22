/**
 * What is allowed to leave the browser inside an error report.
 *
 * The portal is the more exposed of the two origins in this system — it renders
 * citizens' national ID numbers on screen and holds the staff bearer token in
 * `localStorage` (see the note in `next.config.mjs`). So the same posture the
 * API takes in `apps/backend/src/presentation/config/sentry-redaction.ts`
 * applies here, for the same reason: Sentry is a third party, and a field that
 * reaches it cannot be recalled.
 *
 * Deliberately a *separate copy* rather than a shared module in
 * `packages/shared-schemas`. Two reasons, and the second is the real one:
 *
 * 1. The two runtimes redact different things. The API's rules are shaped by
 *    Postgres error text; the browser's are shaped by URLs, `localStorage` keys
 *    and React component stacks. A merged module would be the union of both,
 *    carrying rules each side does not need.
 * 2. `shared-schemas` is a build dependency of both apps. A change to a
 *    redaction rule made for the portal would silently alter what the API
 *    reports, and vice versa — coupling the blast radius of the most
 *    safety-critical rules in the repository.
 *
 * The URL rules below are what differ most: a portal URL is
 * `/zahle/ar/admin-x7/citizens/<uuid>` — the tenant and the route shape are
 * what make an issue triageable, and everything else in it identifies a person.
 */

export const REDACTED = '[redacted]';

/** A رقم مرجعي — `BZR-2608-5HLQBM`. A credential, not just an identifier. */
const REFERENCE_NUMBER = /\b[A-Z]{3}-?\d{4}-?[A-Z0-9]{6}\b/gi;

/** Any UUID — a citizen row id, a queued `clientSubmissionId`, a payment id. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Six or more digits: national ID, civil record number, phone number. */
const LONG_DIGIT_RUN = /\d[\d\s./-]{4,}\d/g;

/** A JWT — the staff session token, which `localStorage` holds. */
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** An email address, which in this system means a staff member. */
const EMAIL = /[^\s@,;:<>()[\]{}"]+@[^\s@,;:<>()[\]{}"]+\.[a-z]{2,}/gi;

/** Removes every identifier this portal is responsible for from a string. */
export function redactText(value: string): string {
  return value
    .replace(JWT, REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(REFERENCE_NUMBER, REDACTED)
    .replace(UUID, REDACTED)
    .replace(LONG_DIGIT_RUN, REDACTED);
}

/**
 * Reduces a portal URL to its shape, keeping the municipality and the route.
 *
 * The query string and the hash both go. `?search=` on the citizens register is
 * a person's name, and the admin path segment — which is secret-ish, being the
 * unguessable prefix the staff area lives behind — is left intact on purpose:
 * it is not a citizen, and without it two issues from different municipalities'
 * admin areas are indistinguishable.
 */
export function redactUrl(url: string): string {
  const [withoutHash] = url.split('#');
  const [path] = (withoutHash ?? '').split('?');
  return redactText(path ?? '');
}

interface ScrubbableEvent {
  request?: { url?: string; query_string?: unknown; data?: unknown; headers?: unknown };
  user?: unknown;
  message?: unknown;
  breadcrumbs?: Array<{ message?: string; data?: unknown; [key: string]: unknown }> | null;
  exception?: { values?: Array<{ value?: string; [key: string]: unknown }> };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Contexts the SDK fills in itself, skipped so a browser version string is not
 * mangled by the digit-run rule. Anything else in `contexts` came from our own
 * code and is redacted — the safe default being that a context added later by
 * someone who never read this file is still cleaned.
 */
const SDK_OWNED_CONTEXTS = new Set([
  'runtime',
  'os',
  'device',
  'culture',
  'trace',
  'browser',
  'app',
]);

/**
 * The `beforeSend` body for both the browser and the Next.js server runtime.
 *
 * Mutates and returns the same reference — see the note on the API's copy for
 * why the signature is structural rather than typed against Sentry's
 * `ErrorEvent`.
 */
export function scrubEvent<T extends object>(event: T): T {
  const target = event as ScrubbableEvent;

  if (target.request) {
    const { url } = target.request;
    // `data` is a form submission — on this portal that is a citizen
    // registration. `headers` carries the bearer token. Neither has a redacted
    // form worth keeping.
    target.request = {
      ...(typeof url === 'string' ? { url: redactUrl(url) } : {}),
    };
  }

  delete target.user;

  if (typeof target.message === 'string') target.message = redactText(target.message);

  for (const value of target.exception?.values ?? []) {
    if (typeof value.value === 'string') value.value = redactText(value.value);
  }

  /*
    Breadcrumbs are the browser's biggest leak surface, and the least obvious.

    The default integrations record every `fetch` URL, every `console` call, and
    — the one that matters — every DOM click as a CSS-ish selector plus the
    element's text content. On a register of people, that text content is the
    person. `beforeBreadcrumb` in the init drops the categories wholesale; this
    is the second pass, for whatever survives.
  */
  for (const crumb of target.breadcrumbs ?? []) {
    if (typeof crumb.message === 'string') crumb.message = redactText(crumb.message);
    if (crumb.data) crumb.data = redactDeep(crumb.data);
  }

  if (target.extra) target.extra = redactDeep(target.extra) as Record<string, unknown>;

  // Contexts — see the note on the API's copy. Missed on the first pass and
  // caught by sending a real event through a stubbed transport, not by reading.
  if (target.contexts) {
    for (const [name, value] of Object.entries(target.contexts)) {
      if (SDK_OWNED_CONTEXTS.has(name)) continue;
      target.contexts[name] = redactDeep(value);
    }
  }

  return event;
}

/** Walks a structure and redacts every string in it. Depth-limited, fails closed. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactDeep(entry, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redactDeep(entry, depth + 1);
    return out;
  }
  return undefined;
}

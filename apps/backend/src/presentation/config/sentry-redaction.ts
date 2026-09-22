/**
 * What is allowed to leave this system inside an error report.
 *
 * Sentry is a third party. Every field that reaches it has left the
 * municipality's infrastructure for good — it cannot be unsent, and it lands in
 * an index searchable by everyone with access to the project. The tenant
 * schemas behind this API hold national ID numbers, civil record numbers, home
 * addresses, phone numbers and residency status, so the posture here is the one
 * AGENTS.md §4 takes for moving data between environments: allowlist what goes,
 * never discover it.
 *
 * That is why this is its own module rather than a `beforeSend` closure inside
 * the init. A redaction rule that is not testable is a rule nobody can show
 * works, and §8.7 is about exactly that kind of control — one that looks like
 * coverage and enforces nothing. `sentry-redaction.spec.ts` is the proof.
 *
 * The rules below are deliberately blunt. A redaction that occasionally eats a
 * harmless number costs a triage engineer a few minutes; one that occasionally
 * misses a national ID costs a person their residency status in a SaaS index.
 */

/** The marker left where something was removed, so a reader knows to stop looking. */
export const REDACTED = '[redacted]';

/**
 * A رقم مرجعي — `BZR-2608-5HLQBM`, three groups of 3/4/6.
 *
 * Redacted for a reason that outranks the others: this is not merely an
 * identifier, it is the *credential* a citizen signs into the portal with
 * (AGENTS.md §8.4). One in a Sentry issue title is a password in a Sentry
 * issue title.
 */
const REFERENCE_NUMBER = /\b[A-Z]{3}-?\d{4}-?[A-Z0-9]{6}\b/gi;

/** Any UUID — a row id, a correlation id, a `clientSubmissionId`. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * A run of six or more digits, separators included.
 *
 * Covers national ID numbers, civil record numbers and phone numbers in one
 * rule rather than trying to tell them apart — telling them apart is how a
 * format nobody anticipated gets through. Six is the floor because a Lebanese
 * national ID is longer than that while a year, an HTTP status and a row count
 * are all shorter, so the rule keeps the numbers that help triage and drops the
 * ones that identify people. Separators are inside the class so `03-123-456`
 * and `1990/05/12` are caught as single runs rather than as safe fragments.
 */
const LONG_DIGIT_RUN = /\d[\d\s./-]{4,}\d/g;

/**
 * Postgres' habit of quoting the offending row back at you.
 *
 * `duplicate key value violates unique constraint "users_national_id_key"` is
 * followed by `Key (national_id)=(123456789) already exists.` — the column name
 * is the useful half and the value is a citizen. This keeps the first and drops
 * the second, because a unique violation with the column named is usually
 * enough to find the bug.
 */
const PG_KEY_DETAIL = /Key\s*\(([^)]*)\)\s*=\s*\([^)]*\)/gi;

/** An email address, which in this system means a staff member. */
const EMAIL = /[^\s@,;:<>()[\]{}"]+@[^\s@,;:<>()[\]{}"]+\.[a-z]{2,}/gi;

/**
 * A JWT. Staff tokens open every citizen record in a municipality for eight
 * hours, so one appearing in a URL or a log line is the highest-value string
 * this scrubber will ever see.
 */
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/**
 * Removes every identifier this system is responsible for from a string.
 *
 * Order matters: the structured patterns run before the digit-run sweep, so
 * they are replaced whole and legibly rather than left as half-redacted rubble
 * like `BZR-[redacted]`.
 */
export function redactText(value: string): string {
  return value
    .replace(PG_KEY_DETAIL, (_match, column: string) => `Key (${column})=(${REDACTED})`)
    .replace(JWT, REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(REFERENCE_NUMBER, REDACTED)
    .replace(UUID, REDACTED)
    .replace(LONG_DIGIT_RUN, REDACTED);
}

/**
 * The request headers worth keeping.
 *
 * An allowlist, not a denylist of `cookie` and `authorization`. A denylist is a
 * list of the headers someone thought of, and the next proxy added in front of
 * this API will introduce one nobody did.
 */
const SAFE_HEADERS = new Set([
  'content-type',
  'content-length',
  'user-agent',
  'accept',
  'accept-encoding',
  'accept-language',
  'x-correlation-id',
  'x-vercel-id',
]);

function pickSafeHeaders(headers: Record<string, unknown>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!SAFE_HEADERS.has(name.toLowerCase())) continue;
    if (typeof value === 'string') kept[name] = redactText(value);
  }
  return kept;
}

/**
 * Reduces a URL to its shape.
 *
 * `/api/v1/t/zahle/citizens/3f2a…/documents` becomes
 * `/api/v1/t/zahle/citizens/[redacted]/documents`, which is the thing that
 * actually groups errors and is what a route pattern would have given us if
 * Nest handed one to the filter. The query string goes entirely: it carries
 * `?search=` against a register of people's names, and there is no version of
 * that worth keeping.
 *
 * The tenant slug is deliberately *not* redacted. A municipality is not a
 * person, and knowing which one is failing is the difference between a
 * reproducible bug and an unactionable issue.
 */
export function redactUrl(url: string): string {
  const [path] = url.split('?');
  return redactText(path ?? '');
}

/**
 * Walks an arbitrary structure and redacts every string in it.
 *
 * Depth-limited, because an error reporter that throws while reporting an error
 * is worse than no error reporter. Anything past the limit is dropped rather
 * than passed through — failing closed is the posture of this whole file.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactDeep(entry, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = redactDeep(entry, depth + 1);
    }
    return out;
  }
  return undefined;
}

/** The subset of a Sentry event this module knows how to clean. */
export interface ScrubbableEvent {
  request?: {
    url?: string;
    query_string?: unknown;
    data?: unknown;
    cookies?: unknown;
    headers?: Record<string, unknown>;
    [key: string]: unknown;
  };
  user?: unknown;
  message?: unknown;
  breadcrumbs?: Array<{ message?: string; data?: unknown; [key: string]: unknown }> | null;
  exception?: { values?: Array<{ value?: string; [key: string]: unknown }> };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Contexts the SDK owns and fills itself — never application data.
 *
 * Skipped when scrubbing `contexts` so that a Node version (`22.20.1`) or a
 * Windows build number is not mangled into `[redacted]` by the digit-run rule.
 * Everything *not* on this list was put there by our own code and is redacted,
 * which is the right default: a context named by a future caller should be
 * scrubbed because nobody remembered to add it here, not passed through
 * because nobody remembered to.
 */
const SDK_OWNED_CONTEXTS = new Set([
  'runtime',
  'os',
  'device',
  'culture',
  'trace',
  'cloud_resource',
  'app',
]);

/**
 * The `beforeSend` body, as a pure function.
 *
 * Everything that can carry a citizen is either dropped or rewritten:
 *
 * - **`request.data`** — the body. A citizen registration POST *is* the record:
 *   name, national ID, household composition, residency status. Dropped whole;
 *   there is no redacted version of it worth having.
 * - **`request.cookies` / `query_string`** — dropped for the same reason.
 * - **`request.headers`** — reduced to the allowlist above.
 * - **`request.url`** — reduced to its shape.
 * - **`user`** — dropped. Attributing an error to a staff member is a feature
 *   nobody asked for, and `sendDefaultPii: false` already declines the IP.
 * - **`exception.values[].value`** — redacted in place. This is the field that
 *   carries `Key (national_id)=(…)` into the issue title, where it would be the
 *   most-read string in the entire report.
 * - **`breadcrumbs`** — HTTP breadcrumbs hold outbound URLs and Postgres ones
 *   hold statements. Both go through the same text rules.
 */
export function scrubEvent<T extends object>(event: T): T {
  /*
    Structural, and mutating in place.

    Sentry's own `ErrorEvent` has no index signature, so it does not *extend*
    `ScrubbableEvent` even though it has every field this touches. Narrowing
    through one local alias and returning the original reference keeps the
    caller's type intact — a `beforeSend` that returned a re-typed copy would
    have to satisfy `ErrorEvent` in full, which would mean restating Sentry's
    entire event shape here just to delete four fields from it.
  */
  const target = event as ScrubbableEvent;

  if (target.request) {
    const { data, cookies, query_string, headers, url, ...rest } = target.request;
    void data;
    void cookies;
    void query_string;
    target.request = {
      ...rest,
      ...(typeof url === 'string' ? { url: redactUrl(url) } : {}),
      ...(headers ? { headers: pickSafeHeaders(headers) } : {}),
    };
  }

  delete target.user;

  if (typeof target.message === 'string') {
    target.message = redactText(target.message);
  }

  for (const value of target.exception?.values ?? []) {
    if (typeof value.value === 'string') value.value = redactText(value.value);
  }

  for (const crumb of target.breadcrumbs ?? []) {
    if (typeof crumb.message === 'string') crumb.message = redactText(crumb.message);
    if (crumb.data) crumb.data = redactDeep(crumb.data) as Record<string, unknown>;
  }

  if (target.extra) target.extra = redactDeep(target.extra) as Record<string, unknown>;

  /*
    Contexts, which is where `reportException` puts the route.

    This was missed on the first pass and found by sending a real event through
    a stubbed transport rather than by reading the code — the unit tests all
    exercised `beforeSend` on events that happened not to have a `contexts`, so
    they agreed with each other and with the bug. `DomainExceptionFilter` does
    pass an already-redacted URL, so nothing was leaking in practice, but
    relying on every caller to redact before calling is the "discover, don't
    allowlist" mistake in a different place: the next caller will not.
  */
  if (target.contexts) {
    for (const [name, value] of Object.entries(target.contexts)) {
      if (SDK_OWNED_CONTEXTS.has(name)) continue;
      target.contexts[name] = redactDeep(value);
    }
  }

  return event;
}

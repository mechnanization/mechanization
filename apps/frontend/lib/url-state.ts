/**
 * The pure half of `use-url-state.ts`: how a page's filters are read from and
 * written to the query string.
 *
 * Kept free of React and of `window` so the rules that decide what a URL means
 * — which values are defaults and therefore absent, what a hand-edited or stale
 * value falls back to — are tested without a browser.
 *
 * ## What may go in a URL
 *
 * Structured filters only: enums, dates, page numbers, and row ids that already
 * appear in this portal's paths (`/citizens/<uuid>`). **Never** a value that is
 * or contains a person's identifier — a name, national ID, phone number, رقم
 * مرجعي or document number. A URL is sent to the host on every reload, kept in
 * browser history and pasted into chats; free-text search therefore lives in
 * tab storage instead (`useTabSearch`), by decision on 2026-10-03.
 */

/** One query-string parameter: how to read it, and how to write it back. */
export interface UrlParam<T> {
  /** Never throws: a missing, malformed or stale value yields the default. */
  parse(raw: string | null): T;
  /** `null` means "leave the parameter out" — the default, or empty. */
  serialize(value: T): string | null;
}

export type UrlSchema = Record<string, UrlParam<unknown>>;

export type UrlValues<S extends UrlSchema> = {
  [K in keyof S]: S[K] extends UrlParam<infer T> ? T : never;
};

/** Anything with `get` — `URLSearchParams` and Next's `ReadonlyURLSearchParams`. */
export interface ParamReader {
  get(name: string): string | null;
}

/**
 * The longest value any parameter accepts. Every legitimate value here is an
 * id, an enum or a date; anything longer is a hand-edited URL and is ignored.
 */
const MAX_LENGTH = 128;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Row ids: UUIDs and the slug-like keys some lists use. */
const ID = /^[A-Za-z0-9_:.-]{1,128}$/;

function clean(raw: string | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed === '' || trimmed.length > MAX_LENGTH ? null : trimmed;
}

/** The codecs a page builds its schema from. */
export const param = {
  /**
   * A plain string — for structured inputs such as a parcel number or a
   * building code. Not for free-text search: see the module note.
   */
  string(fallback = ''): UrlParam<string> {
    return {
      parse: (raw) => clean(raw) ?? fallback,
      serialize: (value) => {
        const trimmed = value.trim();
        return trimmed === '' || trimmed === fallback ? null : trimmed;
      },
    };
  },

  /** A row id (zone, staff member, building). Empty means "any". */
  id(): UrlParam<string> {
    return {
      parse: (raw) => {
        const value = clean(raw);
        return value && ID.test(value) ? value : '';
      },
      serialize: (value) => (value && ID.test(value) ? value : null),
    };
  },

  /** One of a fixed set. An unknown value — a renamed enum, a typo — is the default. */
  oneOf<const T extends string>(values: readonly T[], fallback: T): UrlParam<T> {
    return {
      parse: (raw) => {
        const value = clean(raw);
        return value !== null && (values as readonly string[]).includes(value)
          ? (value as T)
          : fallback;
      },
      serialize: (value) =>
        value === fallback || !(values as readonly string[]).includes(value) ? null : value,
    };
  },

  /** A flag, written `=1` and absent when off. Reads `1` and `true`. */
  flag(): UrlParam<boolean> {
    return {
      parse: (raw) => {
        const value = clean(raw);
        return value === '1' || value === 'true';
      },
      serialize: (value) => (value ? '1' : null),
    };
  },

  /** A calendar day, `YYYY-MM-DD`. Anything else — including 2026-02-31 — is empty. */
  date(): UrlParam<string> {
    const valid = (value: string) => {
      if (!DATE.test(value)) return false;
      const parsed = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
    };
    return {
      parse: (raw) => {
        const value = clean(raw);
        return value && valid(value) ? value : '';
      },
      serialize: (value) => (value && valid(value) ? value : null),
    };
  },

  /**
   * A page number: **1-based in the URL, 0-based in code**, because the URL is
   * read by people (`?page=2` is the second page) and `DataTable` counts from 0.
   * The first page is the default and is never written.
   */
  page(): UrlParam<number> {
    return {
      parse: (raw) => {
        const value = clean(raw);
        if (value === null || !/^\d{1,6}$/.test(value)) return 0;
        const page = Number(value);
        return page >= 1 ? page - 1 : 0;
      },
      serialize: (index) =>
        Number.isInteger(index) && index > 0 ? String(index + 1) : null,
    };
  },

  /**
   * A page size, restricted to the sizes the table offers. A free integer
   * would let `?limit=100000` ask the API for the whole register in one call.
   */
  pageSize(sizes: readonly number[], fallback: number): UrlParam<number> {
    return {
      parse: (raw) => {
        const value = clean(raw);
        const size = value !== null && /^\d{1,4}$/.test(value) ? Number(value) : NaN;
        return sizes.includes(size) ? size : fallback;
      },
      serialize: (size) => (size === fallback || !sizes.includes(size) ? null : String(size)),
    };
  },
} as const;

/** Reads every parameter in the schema. Unknown parameters are ignored. */
export function readUrlState<S extends UrlSchema>(schema: S, params: ParamReader): UrlValues<S> {
  const values: Record<string, unknown> = {};
  for (const [name, codec] of Object.entries(schema)) {
    values[name] = codec.parse(params.get(name));
  }
  return values as UrlValues<S>;
}

/**
 * Returns `current` with `patch` written over it.
 *
 * Parameters the schema does not own are kept untouched — `?parcel=` on the
 * map, `?fromCaseId=` on a form — so two hooks on one page, or a page and the
 * link that brought the reader there, never erase each other. `clear` removes
 * named parameters in the same write: a new filter resets the page number
 * without a second history entry or a render at the stale offset.
 */
export function applyUrlPatch<S extends UrlSchema>(
  current: string | URLSearchParams,
  schema: S,
  patch: Partial<UrlValues<S>>,
  clear: readonly string[] = [],
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const name of clear) next.delete(name);
  for (const [name, value] of Object.entries(patch)) {
    const codec = schema[name];
    if (!codec || value === undefined) continue;
    const serialized = codec.serialize(value);
    if (serialized === null) next.delete(name);
    else next.set(name, serialized);
  }
  return next;
}

/** `?a=1` or the empty string — never a lone `?`. */
export function toSearch(params: URLSearchParams): string {
  const query = params.toString();
  return query ? `?${query}` : '';
}

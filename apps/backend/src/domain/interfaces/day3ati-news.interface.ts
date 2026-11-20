import type { Day3atiLanguage, Day3atiVillage } from './day3ati-integration.interface';

/**
 * Where a municipality's News lives on Day3ati: its village.
 *
 * The id is never typed into our code or config. It is read from Day3ati's own
 * list of villages and matched by the municipality's tenant slug.
 */
export const DAY3ATI_VILLAGES = Symbol('DAY3ATI_VILLAGES');

export interface Day3atiVillages {
  /**
   * The village of a municipality, or `null` when Day3ati has none for it.
   *
   * Read once and kept for a day; a municipality that is not in the list asks
   * Day3ati again (at most once a minute), so a village created today is found
   * today. Rejects with `Day3atiApiError` when the list cannot be read.
   */
  villageOf(tenantSlug: string): Promise<Day3atiVillage | null>;

  /** Forget what was read, so the next call asks Day3ati again. */
  refresh(): void;
}

/**
 * Every call a News screen makes goes through this port, as the signed-in user.
 *
 * It adds what every village call needs — the user's staff token, the
 * `X-Village-Id` of their municipality, and the language — and turns what
 * Day3ati refuses with into coded domain errors, so a screen shows «not
 * allowed» and never a crash. Application code never sees a token, a village
 * id or a URL.
 */
export const DAY3ATI_NEWS = Symbol('DAY3ATI_NEWS');

export interface Day3atiNewsCall {
  tenantSlug: string;
  /** The signed-in staff member (our user id, as provisioned in Day3ati). */
  userId: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /**
   * The path on Day3ati, starting with `/`. Letters, digits and `. _ ~ -` in
   * each segment: an id from a request goes through `encodeURIComponent`
   * before it is joined in, and a `..` or an empty segment is refused.
   */
  path: string;
  /** Query values; `undefined` and `null` are left out. `lang` is set by `language`, not here. */
  query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  /** A JSON body. */
  body?: unknown;
  /** The language the answer is written in (ours is `ar` unless the screen says otherwise). */
  language?: Day3atiLanguage;
}

export interface Day3atiNews {
  /** False when the four `DAY3ATI_*` settings are not all set: every call refuses with `NEWS_UNAVAILABLE`. */
  readonly isConfigured: boolean;

  /**
   * One call. Resolves to the parsed JSON, or `undefined` for an answer with no
   * body. Rejects with a coded `DomainError` (`NEWS_*`).
   */
  request<T = unknown>(call: Day3atiNewsCall): Promise<T | undefined>;

  /**
   * Every page of a list. Day3ati pages with a cursor: each answer may carry
   * `nextCursor`, which goes back as `?cursor=`, and an answer without one is
   * the last page. `itemsOf` picks the items out of one page's body.
   *
   * Stops, and refuses with `NEWS_UNAVAILABLE`, rather than loop for ever when
   * Day3ati repeats a cursor or the list is longer than `maxPages` (default 50).
   * A screen that shows one page at a time uses `request` and `nextCursorOf`.
   */
  allPages<T>(
    call: Omit<Day3atiNewsCall, 'method' | 'body'>,
    itemsOf: (page: unknown) => readonly T[],
    options?: { maxPages?: number },
  ): Promise<T[]>;
}

/** The cursor of the next page in one page's body, or `undefined` when it is the last page. */
export function nextCursorOf(page: unknown): string | undefined {
  if (typeof page !== 'object' || page === null) return undefined;
  const cursor = (page as { nextCursor?: unknown }).nextCursor;
  return typeof cursor === 'string' && cursor !== '' ? cursor : undefined;
}

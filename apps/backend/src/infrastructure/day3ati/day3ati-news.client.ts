import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Day3atiLanguage } from '../../domain/interfaces/day3ati-integration.interface';
import {
  DAY3ATI_VILLAGES,
  nextCursorOf,
  type Day3atiNews,
  type Day3atiNewsCall,
  type Day3atiVillages,
} from '../../domain/interfaces/day3ati-news.interface';
import { DAY3ATI_TOKENS, type Day3atiTokens } from '../../domain/interfaces/day3ati-tokens.interface';
import { DAY3ATI_REQUEST_TIMEOUT_MS } from './day3ati-integration.client';
import {
  newsErrorFromAnswer,
  newsErrorFromFailure,
  newsUnavailable,
  newsVillageNotLinked,
  readProblem,
} from './day3ati-news-errors';
import { isDay3atiTenantSlug, isDay3atiUserId } from './day3ati-token.service';

/** `allPages` stops here unless the caller says otherwise. */
export const DAY3ATI_DEFAULT_MAX_PAGES = 50;

/** Each segment of a path: what an id or a word is made of, and never empty or a `..`. */
const PATH = /^(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._~-]+)+$/;

/** The languages Day3ati speaks; Arabic is the one it requires, so it is the one we fall back to. */
const LANGUAGES: readonly Day3atiLanguage[] = ['ar', 'en', 'fr'];

/**
 * The one client every News screen calls Day3ati through, as the signed-in user.
 *
 * Every call carries the user's staff token (`Authorization: Bearer`), their
 * municipality's village (`X-Village-Id`, from Day3ati's own list) and the
 * language, both as `?lang=` and as `Accept-Language`.
 *
 * - A **401** drops that user's cached token and the call is made once more
 *   with a fresh one; a second 401 is Day3ati's problem, not the user's.
 * - A refusal is turned into a coded `NEWS_*` domain error by
 *   `day3ati-news-errors.ts`; a call that fails to be made at all is
 *   `NEWS_UNAVAILABLE`. Nothing here throws a raw `fetch` error, a token or a
 *   URL into a log or a response.
 * - A path or a user id that is not in the form Day3ati accepts is a bug in
 *   the caller, not a refusal: it throws a `TypeError` before anything is sent.
 */
@Injectable()
export class Day3atiNewsClient implements Day3atiNews {
  private readonly logger = new Logger(Day3atiNewsClient.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(DAY3ATI_TOKENS) private readonly tokens: Day3atiTokens,
    @Inject(DAY3ATI_VILLAGES) private readonly villages: Day3atiVillages,
  ) {}

  get isConfigured(): boolean {
    return this.tokens.isConfigured;
  }

  async request<T = unknown>(call: Day3atiNewsCall): Promise<T | undefined> {
    assertWellFormed(call);

    const baseUrl = this.config.get<string>('DAY3ATI_API_BASE_URL');
    if (!this.isConfigured || !baseUrl) throw newsUnavailable('Day3ati is not configured, so News cannot be reached');

    const language = LANGUAGES.includes(call.language as Day3atiLanguage) ? (call.language as Day3atiLanguage) : 'ar';

    let villageId: string;
    try {
      const village = await this.villages.villageOf(call.tenantSlug);
      if (!village) throw newsVillageNotLinked('Day3ati has no village for this municipality');
      villageId = village.villageId;
    } catch (error) {
      throw newsErrorFromFailure(error);
    }

    const url = `${baseUrl.replace(/\/+$/, '')}${call.path}?${queryOf(call, language)}`;

    let response = await this.send(call, url, villageId, language);
    if (response.status === 401) {
      this.tokens.forgetStaffToken(call.tenantSlug, call.userId);
      response = await this.send(call, url, villageId, language);
    }

    if (!response.ok) {
      const status = response.status;
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        // Not JSON (a proxy's error page): the status alone is what we know.
      }
      const error = newsErrorFromAnswer(status, readProblem(body));
      if (status >= 500) this.logger.error(`Day3ati answered ${status} to a News ${call.method} (${error.code})`);
      throw error;
    }

    if (response.status === 204) return undefined;
    const text = await response.text();
    if (text === '') return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      this.logger.error('Day3ati answered a News call with something that is not JSON');
      throw newsUnavailable('Day3ati answered with something that is not JSON');
    }
  }

  async allPages<T>(
    call: Omit<Day3atiNewsCall, 'method' | 'body'>,
    itemsOf: (page: unknown) => readonly T[],
    options: { maxPages?: number } = {},
  ): Promise<T[]> {
    const maxPages = options.maxPages ?? DAY3ATI_DEFAULT_MAX_PAGES;
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;

    for (let pages = 0; pages < maxPages; pages++) {
      const page = await this.request({ ...call, method: 'GET', query: { ...call.query, cursor } });
      items.push(...itemsOf(page));

      cursor = nextCursorOf(page);
      if (cursor === undefined) return items;

      if (seen.has(cursor)) {
        this.logger.error('Day3ati repeated a page cursor; the list was not read to its end');
        throw newsUnavailable('Day3ati repeated a page cursor');
      }
      seen.add(cursor);
    }

    this.logger.error(`A Day3ati list is longer than ${maxPages} pages; it was not read to its end`);
    throw newsUnavailable('A Day3ati list is longer than the page limit');
  }

  private async send(call: Day3atiNewsCall, url: string, villageId: string, language: Day3atiLanguage): Promise<Response> {
    let token: string;
    try {
      token = await this.tokens.staffToken(call.tenantSlug, call.userId);
    } catch (error) {
      throw newsErrorFromFailure(error);
    }

    const hasBody = call.body !== undefined;
    try {
      return await fetch(url, {
        method: call.method,
        headers: {
          authorization: `Bearer ${token}`,
          'x-village-id': villageId,
          'accept-language': language,
          accept: 'application/json',
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(call.body) } : {}),
        signal: AbortSignal.timeout(DAY3ATI_REQUEST_TIMEOUT_MS),
      });
    } catch {
      // The cause can carry the URL and the user's id; say only what an operator can act on.
      this.logger.error(`Day3ati did not answer a News ${call.method} (network error or timeout)`);
      throw newsUnavailable('Day3ati did not answer');
    }
  }
}

function assertWellFormed(call: Day3atiNewsCall): void {
  if (!isDay3atiTenantSlug(call.tenantSlug) || !isDay3atiUserId(call.userId)) {
    throw new TypeError('A News call needs a tenant slug and a user id in the form Day3ati accepts');
  }
  if (!PATH.test(call.path)) {
    throw new TypeError('A News call path must be segments of letters, digits and . _ ~ - after a "/", with no ".." and no query');
  }
}

/** The query string: the caller's values, then `lang`, which is the call's own and cannot be overridden. */
function queryOf(call: Day3atiNewsCall, language: Day3atiLanguage): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(call.query ?? {})) {
    if (key === 'lang' || value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  query.set('lang', language);
  return query.toString();
}

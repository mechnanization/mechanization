import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Day3atiAuthError,
  type Day3atiTokens,
} from '../../domain/interfaces/day3ati-tokens.interface';

/**
 * A cached token is dropped this long before its `expires_in`, so one that is
 * about to lapse is never handed to a request that will land after it.
 */
export const DAY3ATI_TOKEN_SAFETY_MARGIN_SECONDS = 60;

/** One call to the token endpoint. Day3ati is a third party; no call waits on it forever. */
export const DAY3ATI_TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/** Staff tokens kept at once. Far above the staff of two municipalities; it only bounds a leak. */
export const DAY3ATI_MAX_CACHED_STAFF_TOKENS = 500;

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';

/**
 * Both halves of the partner's `{tenant}:{userId}` subject are checked before
 * they are joined: a `:` inside either would move the boundary, and the token
 * would then be issued for a different user than the one asked about. The
 * user id's alphabet is the partner's own (letters, digits, `-`, `_`, `.`);
 * a tenant slug is lower-case letters, digits and `-`.
 */
const TENANT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const USER_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Whether `value` is a tenant slug Day3ati's `{tenant}` can carry. Shared with the integration client's paths. */
export const isDay3atiTenantSlug = (value: string): boolean => TENANT_SLUG.test(value);

/** Whether `value` is a user id in the partner's alphabet (letters, digits, `-`, `_`, `.`). */
export const isDay3atiUserId = (value: string): boolean => USER_ID.test(value);

interface CachedToken {
  token: string;
  /** Epoch milliseconds after which the token is no longer handed out. */
  usableUntil: number;
}

/**
 * Gets and caches Day3ati tokens (`docs`: the partner integration, task
 * «Token service»).
 *
 * - **Cached in memory**, per process. A token is a bearer credential for a
 *   municipality's News; it is never written to Redis, the database or a log,
 *   and a restart simply asks again.
 * - **Reused until a minute before it expires.** Tokens last about 15 minutes
 *   and there is no refresh token, so "refreshing" is asking again with the
 *   secret (or the user's subject) — done automatically once the cached one is
 *   past its usable time, or when a caller reports a 401 with it
 *   (`forgetClientToken`, `forgetStaffToken`).
 * - **One request at a time per token.** Callers that arrive while a token is
 *   being fetched share that fetch rather than each making their own.
 * - **Failures are not cached.** A user not provisioned a second ago may be
 *   provisioned now, and a Day3ati outage must not outlive itself.
 *
 * The secret goes in the form body of `application/x-www-form-urlencoded`, as
 * the partner's guide allows, and is read from `ConfigService` on use: it is
 * not copied into a field of this class, an error message or a log line.
 */
@Injectable()
export class Day3atiTokenService implements Day3atiTokens {
  private readonly logger = new Logger(Day3atiTokenService.name);
  private readonly cache = new Map<string, CachedToken>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(private readonly config: ConfigService) {
    if (!this.isConfigured) {
      this.logger.warn(
        'Day3ati is not configured (DAY3ATI_API_BASE_URL, DAY3ATI_TOKEN_URL, DAY3ATI_CLIENT_ID, ' +
          'DAY3ATI_CLIENT_SECRET): News on Day3ati is switched off.',
      );
    }
  }

  get isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('DAY3ATI_API_BASE_URL') &&
        this.config.get<string>('DAY3ATI_TOKEN_URL') &&
        this.config.get<string>('DAY3ATI_CLIENT_ID') &&
        this.config.get<string>('DAY3ATI_CLIENT_SECRET'),
    );
  }

  clientToken(): Promise<string> {
    return this.obtain('client', { grant_type: 'client_credentials' });
  }

  staffToken(tenantSlug: string, userId: string): Promise<string> {
    if (!TENANT_SLUG.test(tenantSlug) || !USER_ID.test(userId)) {
      // Refused before any request, and without echoing either value.
      return Promise.reject(
        new Day3atiAuthError(
          'day3ati.invalid_subject',
          'The tenant slug or the user id is not in the form Day3ati accepts',
        ),
      );
    }

    return this.obtain(staffKey(tenantSlug, userId), {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: `${tenantSlug}:${userId}`,
    });
  }

  forgetClientToken(): void {
    this.cache.delete('client');
  }

  forgetStaffToken(tenantSlug: string, userId: string): void {
    this.cache.delete(staffKey(tenantSlug, userId));
  }

  private obtain(key: string, grant: Record<string, string>): Promise<string> {
    const cached = this.cache.get(key);
    if (cached && cached.usableUntil > Date.now()) return Promise.resolve(cached.token);

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const request = this.request(key, grant).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private async request(key: string, grant: Record<string, string>): Promise<string> {
    const tokenUrl = this.config.get<string>('DAY3ATI_TOKEN_URL');
    const clientId = this.config.get<string>('DAY3ATI_CLIENT_ID');
    const clientSecret = this.config.get<string>('DAY3ATI_CLIENT_SECRET');

    if (!tokenUrl || !clientId || !clientSecret || !this.config.get<string>('DAY3ATI_API_BASE_URL')) {
      throw new Day3atiAuthError(
        'day3ati.not_configured',
        'Day3ati is not configured, so no token can be requested',
      );
    }

    let response: Response;
    try {
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ ...grant, client_id: clientId, client_secret: clientSecret }),
        signal: AbortSignal.timeout(DAY3ATI_TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch {
      // The cause can carry the URL and is of no use without it; the message
      // says only what the operator can act on.
      this.logger.error('Day3ati token endpoint did not answer (network error or timeout)');
      throw new Day3atiAuthError('day3ati.unavailable', 'Day3ati token endpoint did not answer');
    }

    if (!response.ok) throw await this.refusal(response);

    const { token, expiresInSeconds } = await this.parse(response);
    const lifetimeMs = (expiresInSeconds - DAY3ATI_TOKEN_SAFETY_MARGIN_SECONDS) * 1000;

    // A token that would be dropped the moment it is stored is still returned
    // to this caller; it is just not worth keeping.
    if (lifetimeMs > 0) {
      this.store(key, { token, usableUntil: Date.now() + lifetimeMs });
    } else {
      this.cache.delete(key);
    }

    return token;
  }

  /** A ProblemDetails answer from Day3ati, read for its stable `code` and nothing else. */
  private async refusal(response: Response): Promise<Day3atiAuthError> {
    let code = `day3ati.http_${response.status}`;
    try {
      const body = (await response.json()) as { code?: unknown };
      if (typeof body.code === 'string' && /^[a-z0-9_.]{1,64}$/i.test(body.code)) code = body.code;
    } catch {
      // Not JSON (a proxy's error page): the status alone is what we know.
    }

    if (code === 'oauth.invalid_client') {
      // The only refusal that is ours to fix, and retrying cannot help: wrong
      // secret, or the client is disabled. Said once, loudly, with no value.
      this.logger.error(
        'Day3ati refused the client id or secret (oauth.invalid_client): check DAY3ATI_CLIENT_ID and ' +
          'DAY3ATI_CLIENT_SECRET, or whether the client is disabled.',
      );
    } else if (response.status >= 500) {
      this.logger.error(`Day3ati token endpoint failed (${response.status}, ${code})`);
    }

    return new Day3atiAuthError(code, `Day3ati refused the token request (${code})`, response.status);
  }

  private async parse(response: Response): Promise<{ token: string; expiresInSeconds: number }> {
    let body: { access_token?: unknown; expires_in?: unknown };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new Day3atiAuthError('day3ati.bad_response', 'Day3ati answered with something that is not JSON');
    }

    if (
      typeof body.access_token !== 'string' ||
      body.access_token === '' ||
      typeof body.expires_in !== 'number' ||
      !Number.isFinite(body.expires_in) ||
      body.expires_in <= 0
    ) {
      throw new Day3atiAuthError('day3ati.bad_response', 'Day3ati answered without a usable token or expiry');
    }

    return { token: body.access_token, expiresInSeconds: body.expires_in };
  }

  private store(key: string, entry: CachedToken): void {
    const now = Date.now();
    if (this.cache.size >= DAY3ATI_MAX_CACHED_STAFF_TOKENS) {
      for (const [k, v] of this.cache) if (v.usableUntil <= now) this.cache.delete(k);
      // Still full of live tokens: drop the oldest insertion rather than grow.
      if (this.cache.size >= DAY3ATI_MAX_CACHED_STAFF_TOKENS) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    }
    this.cache.set(key, entry);
  }
}

function staffKey(tenantSlug: string, userId: string): string {
  return `staff:${tenantSlug}:${userId}`;
}

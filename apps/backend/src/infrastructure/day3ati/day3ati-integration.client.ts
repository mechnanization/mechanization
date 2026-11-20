import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Day3atiApiError,
  type Day3atiIntegration,
  type Day3atiStaffAccount,
  type Day3atiVillage,
} from '../../domain/interfaces/day3ati-integration.interface';
import {
  DAY3ATI_TOKENS,
  Day3atiAuthError,
  type Day3atiTokens,
} from '../../domain/interfaces/day3ati-tokens.interface';
import { isDay3atiTenantSlug, isDay3atiUserId } from './day3ati-token.service';

/** One call to Day3ati. It is a third party; no call waits on it forever. */
export const DAY3ATI_REQUEST_TIMEOUT_MS = 10_000;

/** The path of one user's staff account. Both halves are checked first: neither may add a `/` or a `..`. */
function staffPath(tenantSlug: string, userId: string): string {
  if (!isDay3atiTenantSlug(tenantSlug) || !isDay3atiUserId(userId)) {
    throw new Day3atiApiError(
      'day3ati.invalid_subject',
      'The tenant slug or the user id is not in the form Day3ati accepts',
    );
  }
  return `/api/v1/integration/tenants/${tenantSlug}/staff/${encodeURIComponent(userId)}`;
}

/**
 * The staff accounts Day3ati keeps for the users who manage News
 * (`/api/v1/integration/tenants/{tenant}/staff/{userId}`) and the list of
 * villages (`/api/v1/integration/villages`), called with the system's own client
 * token.
 *
 * - A **401** means the cached client token was refused (it lapsed early, or
 *   the secret was rotated): it is dropped and the call is made once more with
 *   a fresh one. A second 401 is reported, never looped on.
 * - A **404 on a removal** is a success: the user is not in the village, which
 *   is what the removal wanted.
 * - Any other refusal is thrown as a `Day3atiApiError` carrying the partner's
 *   own stable `code` and nothing else of the answer: the body may repeat what
 *   we sent, and that is a person's name.
 * - The tenant and the user id are checked before they are put in a path, so
 *   neither can add a `/` or a `..` to it.
 */
@Injectable()
export class Day3atiIntegrationClient implements Day3atiIntegration {
  private readonly logger = new Logger(Day3atiIntegrationClient.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(DAY3ATI_TOKENS) private readonly tokens: Day3atiTokens,
  ) {}

  get isConfigured(): boolean {
    return this.tokens.isConfigured;
  }

  async upsertStaff(tenantSlug: string, userId: string, account: Day3atiStaffAccount): Promise<void> {
    await this.call('PUT', staffPath(tenantSlug, userId), account);
  }

  async removeStaff(tenantSlug: string, userId: string): Promise<void> {
    // A user Day3ati does not know is already removed: a 404 is the answer we wanted.
    await this.call('DELETE', staffPath(tenantSlug, userId), undefined, { notFoundIsFine: true });
  }

  async listVillages(): Promise<Day3atiVillage[]> {
    const response = await this.call('GET', '/api/v1/integration/villages');

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Day3atiApiError('day3ati.bad_response', 'Day3ati answered the village list with something that is not JSON');
    }
    if (!Array.isArray(body)) {
      throw new Day3atiApiError('day3ati.bad_response', 'Day3ati answered the village list with something that is not a list');
    }

    // Only a village we can use is kept: one with an id and the municipality it belongs to.
    const villages: Day3atiVillage[] = [];
    for (const entry of body as Array<Record<string, unknown>>) {
      if (typeof entry?.villageId !== 'string' || typeof entry.externalTenant !== 'string') continue;
      villages.push({
        villageId: entry.villageId,
        externalTenant: entry.externalTenant,
        modules: Array.isArray(entry.modules) ? entry.modules.filter((m): m is string => typeof m === 'string') : [],
      });
    }
    return villages;
  }

  private async call(
    method: 'GET' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    options: { notFoundIsFine?: boolean } = {},
  ): Promise<Response> {
    const baseUrl = this.config.get<string>('DAY3ATI_API_BASE_URL');
    if (!this.isConfigured || !baseUrl) {
      throw new Day3atiApiError('day3ati.not_configured', 'Day3ati is not configured, so nothing can be sent');
    }

    const url = `${baseUrl.replace(/\/+$/, '')}${path}`;

    let response = await this.send(method, url, body);
    if (response.status === 401) {
      // The token we held is no good: ask for a fresh one, once.
      this.tokens.forgetClientToken();
      response = await this.send(method, url, body);
    }

    if (response.ok) return response;
    if (options.notFoundIsFine && response.status === 404) return response;

    throw await this.refusal(response);
  }

  private async send(method: 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<Response> {
    let token: string;
    try {
      token = await this.tokens.clientToken();
    } catch (error) {
      if (error instanceof Day3atiAuthError) {
        throw new Day3atiApiError(error.code, error.message, error.status);
      }
      throw error;
    }

    try {
      return await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(DAY3ATI_REQUEST_TIMEOUT_MS),
      });
    } catch {
      // The cause can carry the URL, which holds a user id; say only what an operator can act on.
      this.logger.error(`Day3ati did not answer a staff ${method} (network error or timeout)`);
      throw new Day3atiApiError('day3ati.unavailable', 'Day3ati did not answer');
    }
  }

  /** A ProblemDetails answer, read for its stable `code` and nothing else. */
  private async refusal(response: Response): Promise<Day3atiApiError> {
    let code = `day3ati.http_${response.status}`;
    try {
      const problem = (await response.json()) as { code?: unknown };
      if (typeof problem.code === 'string' && /^[a-z0-9_.]{1,64}$/i.test(problem.code)) code = problem.code;
    } catch {
      // Not JSON (a proxy's error page): the status alone is what we know.
    }
    return new Day3atiApiError(code, `Day3ati refused the staff call (${code})`, response.status);
  }
}

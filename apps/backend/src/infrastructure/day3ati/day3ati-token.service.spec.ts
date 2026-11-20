import { ConfigService } from '@nestjs/config';
import { Day3atiAuthError } from '../../domain/interfaces/day3ati-tokens.interface';
import {
  DAY3ATI_MAX_CACHED_STAFF_TOKENS,
  Day3atiTokenService,
} from './day3ati-token.service';

/**
 * The token service's job is to ask Day3ati as seldom as it can without ever
 * handing out a token that has lapsed. The two cases pinned hardest are the
 * ones the task names: two calls in a row make one request, and after expiry a
 * new request is made by itself.
 */
describe('Day3atiTokenService', () => {
  const SECRET = 'super-secret-value-that-must-never-leak';
  const settings: Record<string, string> = {
    DAY3ATI_API_BASE_URL: 'https://day3ati.example.test',
    DAY3ATI_TOKEN_URL: 'https://day3ati.example.test/api/v1/oauth/token',
    DAY3ATI_CLIENT_ID: 'mechanization-test',
    DAY3ATI_CLIENT_SECRET: SECRET,
  };

  const make = (overrides: Record<string, string | undefined> = {}) =>
    new Day3atiTokenService({
      get: (name: string) => ({ ...settings, ...overrides })[name],
    } as unknown as ConfigService);

  const tokenAnswer = (token: string, expiresIn = 899) =>
    new Response(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: expiresIn }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const problem = (status: number, code: string) =>
    new Response(JSON.stringify({ title: 'Nope', status, code }), {
      status,
      headers: { 'content-type': 'application/problem+json' },
    });

  let fetchMock: jest.SpyInstance;
  let now: number;

  const bodyOf = (call: number) =>
    new URLSearchParams(String((fetchMock.mock.calls[call][1] as RequestInit).body));

  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => jest.restoreAllMocks());

  describe('the client token', () => {
    it('asks with client_credentials, the id and the secret in a form body', async () => {
      fetchMock.mockResolvedValue(tokenAnswer('client-1'));

      await expect(make().clientToken()).resolves.toBe('client-1');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(settings.DAY3ATI_TOKEN_URL);
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['content-type']).toBe(
        'application/x-www-form-urlencoded',
      );
      expect(bodyOf(0).get('grant_type')).toBe('client_credentials');
      expect(bodyOf(0).get('client_id')).toBe('mechanization-test');
      expect(bodyOf(0).get('client_secret')).toBe(SECRET);
    });

    it('reuses the cached token: two calls in a row make one request', async () => {
      fetchMock.mockResolvedValue(tokenAnswer('client-1'));
      const service = make();

      expect(await service.clientToken()).toBe('client-1');
      expect(await service.clientToken()).toBe('client-1');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('asks again by itself once the token is past its usable time', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenAnswer('client-1', 899))
        .mockResolvedValueOnce(tokenAnswer('client-2', 899));
      const service = make();

      expect(await service.clientToken()).toBe('client-1');

      // Usable until a minute before expires_in: 899 - 60 = 839 seconds.
      now += 838_000;
      expect(await service.clientToken()).toBe('client-1');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      now += 2_000;
      expect(await service.clientToken()).toBe('client-2');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('shares one request between callers that arrive while it is in flight', async () => {
      let release!: (response: Response) => void;
      fetchMock.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
      const service = make();

      const calls = [service.clientToken(), service.clientToken(), service.clientToken()];
      release(tokenAnswer('client-1'));

      expect(await Promise.all(calls)).toEqual(['client-1', 'client-1', 'client-1']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('asks again after the caller reports a 401 with it', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenAnswer('client-1'))
        .mockResolvedValueOnce(tokenAnswer('client-2'));
      const service = make();

      await service.clientToken();
      service.forgetClientToken();

      expect(await service.clientToken()).toBe('client-2');
    });

    it('returns a token that is too short-lived to keep, without caching it', async () => {
      // expires_in at or under the safety margin: usable now, never kept.
      fetchMock
        .mockResolvedValueOnce(tokenAnswer('short-1', 30))
        .mockResolvedValueOnce(tokenAnswer('short-2', 30));
      const service = make();

      expect(await service.clientToken()).toBe('short-1');
      expect(await service.clientToken()).toBe('short-2');
    });
  });

  describe('a staff token', () => {
    it('exchanges the subject {tenant}:{userId} and sends no subject_token_type', async () => {
      fetchMock.mockResolvedValue(tokenAnswer('staff-1'));

      await expect(make().staffToken('albazourieh', 'u-42.a_b')).resolves.toBe('staff-1');

      expect(bodyOf(0).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
      expect(bodyOf(0).get('subject_token')).toBe('albazourieh:u-42.a_b');
      // Day3ati rejects this parameter as an invalid subject (probed on staging).
      expect(bodyOf(0).has('subject_token_type')).toBe(false);
      expect(bodyOf(0).get('client_secret')).toBe(SECRET);
    });

    it('caches per user: one request each, and a user is never given another one’s token', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenAnswer('staff-a'))
        .mockResolvedValueOnce(tokenAnswer('staff-b'))
        .mockResolvedValueOnce(tokenAnswer('staff-c'));
      const service = make();

      expect(await service.staffToken('albazourieh', 'u1')).toBe('staff-a');
      expect(await service.staffToken('albazourieh', 'u1')).toBe('staff-a');
      expect(await service.staffToken('albazourieh', 'u2')).toBe('staff-b');
      // Same user id in the other tenant is another person.
      expect(await service.staffToken('maarakeh', 'u1')).toBe('staff-c');

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('keeps the client token and a staff token apart', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenAnswer('client-1'))
        .mockResolvedValueOnce(tokenAnswer('staff-1'));
      const service = make();

      expect(await service.clientToken()).toBe('client-1');
      expect(await service.staffToken('albazourieh', 'u1')).toBe('staff-1');
    });

    it('forgets one user without touching another', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenAnswer('a-1'))
        .mockResolvedValueOnce(tokenAnswer('b-1'))
        .mockResolvedValueOnce(tokenAnswer('a-2'));
      const service = make();

      await service.staffToken('albazourieh', 'u1');
      await service.staffToken('albazourieh', 'u2');
      service.forgetStaffToken('albazourieh', 'u1');

      expect(await service.staffToken('albazourieh', 'u2')).toBe('b-1');
      expect(await service.staffToken('albazourieh', 'u1')).toBe('a-2');
    });

    it.each([
      ['a colon in the user id', 'albazourieh', 'u1:other'],
      ['a colon in the tenant', 'albazourieh:x', 'u1'],
      ['an empty user id', 'albazourieh', ''],
      ['a space', 'albazourieh', 'u 1'],
      ['an upper-case tenant', 'Albazourieh', 'u1'],
      ['a slash', 'albazourieh', 'u1/../x'],
    ])('refuses %s before any request is made', async (_label, tenant, user) => {
      await expect(make().staffToken(tenant, user)).rejects.toMatchObject({
        code: 'day3ati.invalid_subject',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is bounded: the cache does not grow without limit', async () => {
      fetchMock.mockImplementation(async () => tokenAnswer(`t-${Math.random()}`));
      const service = make();

      for (let i = 0; i < DAY3ATI_MAX_CACHED_STAFF_TOKENS + 25; i++) {
        await service.staffToken('albazourieh', `user-${i}`);
      }
      const calls = fetchMock.mock.calls.length;

      // The newest are still cached; the oldest were evicted and are asked for again.
      await service.staffToken('albazourieh', `user-${DAY3ATI_MAX_CACHED_STAFF_TOKENS + 24}`);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
      await service.staffToken('albazourieh', 'user-0');
      expect(fetchMock).toHaveBeenCalledTimes(calls + 1);
    });
  });

  describe('when Day3ati refuses', () => {
    it('reports a wrong secret as oauth.invalid_client, with the status, and does not cache it', async () => {
      fetchMock
        .mockResolvedValueOnce(problem(401, 'oauth.invalid_client'))
        .mockResolvedValueOnce(tokenAnswer('client-1'));
      const service = make();

      const error = await service.clientToken().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Day3atiAuthError);
      expect(error).toMatchObject({ code: 'oauth.invalid_client', status: 401, isClientRejected: true });
      // A failure is not remembered: the next call asks again.
      expect(await service.clientToken()).toBe('client-1');
    });

    it('reports an unprovisioned or removed user as oauth.invalid_grant', async () => {
      fetchMock.mockResolvedValue(problem(400, 'oauth.invalid_grant'));

      await expect(make().staffToken('albazourieh', 'ghost')).rejects.toMatchObject({
        code: 'oauth.invalid_grant',
        status: 400,
        isUserNotProvisioned: true,
      });
    });

    it('keeps the status as the code when the answer is not ProblemDetails', async () => {
      fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));

      await expect(make().clientToken()).rejects.toMatchObject({
        code: 'day3ati.http_502',
        status: 502,
      });
    });

    it('does not trust a code that is not a plain identifier', async () => {
      fetchMock.mockResolvedValue(problem(400, 'x'.repeat(500)));

      await expect(make().clientToken()).rejects.toMatchObject({ code: 'day3ati.http_400' });
    });

    it('reports a network failure or timeout as day3ati.unavailable', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(make().clientToken()).rejects.toMatchObject({ code: 'day3ati.unavailable' });
    });

    it.each([
      ['no token', { token_type: 'Bearer', expires_in: 899 }],
      ['an empty token', { access_token: '', expires_in: 899 }],
      ['no expiry', { access_token: 'x' }],
      ['a zero expiry', { access_token: 'x', expires_in: 0 }],
      ['an expiry that is a string', { access_token: 'x', expires_in: '899' }],
    ])('rejects an answer with %s', async (_label, body) => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

      await expect(make().clientToken()).rejects.toMatchObject({ code: 'day3ati.bad_response' });
    });

    it('rejects a 200 that is not JSON', async () => {
      fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

      await expect(make().clientToken()).rejects.toMatchObject({ code: 'day3ati.bad_response' });
    });
  });

  describe('configuration', () => {
    it('is configured when all four settings are present', () => {
      expect(make().isConfigured).toBe(true);
    });

    it.each(Object.keys(settings))('is not configured without %s, and never calls out', async (missing) => {
      const service = make({ [missing]: undefined });

      expect(service.isConfigured).toBe(false);
      await expect(service.clientToken()).rejects.toMatchObject({ code: 'day3ati.not_configured' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('secrets', () => {
    it('never puts the secret or a token in an error message', async () => {
      fetchMock.mockResolvedValue(problem(401, 'oauth.invalid_client'));

      const error = (await make().clientToken().catch((e: unknown) => e)) as Error;

      expect(error.message).not.toContain(SECRET);
      expect(JSON.stringify(error)).not.toContain(SECRET);
    });

    it('never logs the secret, a token or the subject', async () => {
      const logged: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
        jest
          .spyOn(require('@nestjs/common').Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
      }
      fetchMock
        .mockResolvedValueOnce(problem(401, 'oauth.invalid_client'))
        .mockResolvedValueOnce(tokenAnswer('a-bearer-token-value'))
        .mockRejectedValueOnce(new TypeError('fetch failed'));
      const service = make();

      await service.clientToken().catch(() => undefined);
      await service.staffToken('albazourieh', 'user-77');
      service.forgetStaffToken('albazourieh', 'user-77');
      await service.staffToken('albazourieh', 'user-77').catch(() => undefined);

      const all = logged.join('\n');
      expect(all).not.toContain(SECRET);
      expect(all).not.toContain('a-bearer-token-value');
      expect(all).not.toContain('user-77');
      expect(all).not.toContain(settings.DAY3ATI_TOKEN_URL);
    });
  });
});

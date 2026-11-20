import { ConfigService } from '@nestjs/config';
import { Day3atiApiError } from '../../domain/interfaces/day3ati-integration.interface';
import { Day3atiAuthError, type Day3atiTokens } from '../../domain/interfaces/day3ati-tokens.interface';
import { Day3atiIntegrationClient } from './day3ati-integration.client';

describe('Day3atiIntegrationClient', () => {
  const account = { displayName: 'Rima Haddad', role: 'news_editor' as const, language: 'ar' as const };

  const tokens = (over: Partial<Day3atiTokens> = {}): jest.Mocked<Day3atiTokens> =>
    ({
      isConfigured: true,
      clientToken: jest.fn().mockResolvedValue('client-token'),
      staffToken: jest.fn(),
      forgetClientToken: jest.fn(),
      forgetStaffToken: jest.fn(),
      ...over,
    }) as jest.Mocked<Day3atiTokens>;

  const make = (t = tokens(), base = 'https://day3ati.example.test/') =>
    new Day3atiIntegrationClient({ get: () => base } as unknown as ConfigService, t);

  const answer = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/problem+json' },
    });

  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => jest.restoreAllMocks());

  it('PUTs the account with the client token, to the user path', async () => {
    fetchMock.mockResolvedValue(answer(204));

    await make().upsertStaff('albazourieh', 'user-1', account);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://day3ati.example.test/api/v1/integration/tenants/albazourieh/staff/user-1');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer client-token');
    expect(JSON.parse(String(init.body))).toEqual(account);
  });

  it('DELETEs with no body', async () => {
    fetchMock.mockResolvedValue(answer(204));

    await make().removeStaff('maarakeh', 'user-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://day3ati.example.test/api/v1/integration/tenants/maarakeh/staff/user-1');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('treats a removal of a user Day3ati does not know as done', async () => {
    fetchMock.mockResolvedValue(answer(404, { code: 'village.not_member' }));
    await expect(make().removeStaff('albazourieh', 'user-1')).resolves.toBeUndefined();
  });

  it('on a 401 drops the client token and tries once with a fresh one', async () => {
    const t = tokens({ clientToken: jest.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new') });
    fetchMock.mockResolvedValueOnce(answer(401, { code: 'auth.unauthorized' })).mockResolvedValueOnce(answer(204));

    await make(t).upsertStaff('albazourieh', 'user-1', account);

    expect(t.forgetClientToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(((fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>).authorization).toBe(
      'Bearer new',
    );
  });

  it('does not loop on a second 401', async () => {
    fetchMock.mockResolvedValue(answer(401, { code: 'auth.unauthorized' }));
    await expect(make().upsertStaff('albazourieh', 'user-1', account)).rejects.toMatchObject({
      code: 'auth.unauthorized',
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("carries the partner's code, and nothing of the answer that may repeat a name", async () => {
    fetchMock.mockResolvedValue(
      answer(400, { code: 'integration.role_not_allowed', detail: 'Rima Haddad may not be a news_editor' }),
    );

    const error = await make()
      .upsertStaff('albazourieh', 'user-1', account)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Day3atiApiError);
    expect(error).toMatchObject({ code: 'integration.role_not_allowed', status: 400 });
    expect(String((error as Error).message)).not.toContain('Rima');
  });

  it('names the status when the answer has no code, and marks a 5xx as worth retrying', async () => {
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    const error = (await make()
      .removeStaff('albazourieh', 'user-1')
      .catch((e: unknown) => e)) as Day3atiApiError;
    expect(error.code).toBe('day3ati.http_502');
    expect(error.isTransient).toBe(true);
  });

  it('reports a Day3ati that does not answer as unavailable, without the URL', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed: https://day3ati.example.test/.../user-1'));
    const error = (await make()
      .removeStaff('albazourieh', 'user-1')
      .catch((e: unknown) => e)) as Day3atiApiError;
    expect(error.code).toBe('day3ati.unavailable');
    expect(error.message).not.toContain('user-1');
    expect(error.isTransient).toBe(true);
  });

  it('passes a token failure on with its own code', async () => {
    const t = tokens({
      clientToken: jest.fn().mockRejectedValue(new Day3atiAuthError('oauth.invalid_client', 'refused', 401)),
    });
    await expect(make(t).upsertStaff('albazourieh', 'user-1', account)).rejects.toMatchObject({
      code: 'oauth.invalid_client',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a tenant or user id that could change the path, before any request', async () => {
    const client = make();
    for (const [tenant, user] of [
      ['albazourieh', '../other'],
      ['albazourieh', 'a/b'],
      ['albazourieh', 'a:b'],
      ['../maarakeh', 'user-1'],
      ['Albazourieh', 'user-1'],
    ]) {
      await expect(client.removeStaff(tenant, user)).rejects.toMatchObject({ code: 'day3ati.invalid_subject' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses while Day3ati is not configured', async () => {
    const off = tokens({ isConfigured: false });
    await expect(make(off).removeStaff('albazourieh', 'user-1')).rejects.toMatchObject({
      code: 'day3ati.not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { ConfigService } from '@nestjs/config';
import { DomainError } from '../../domain/errors/domain-error';
import type { Day3atiVillages } from '../../domain/interfaces/day3ati-news.interface';
import { Day3atiAuthError, type Day3atiTokens } from '../../domain/interfaces/day3ati-tokens.interface';
import { Day3atiNewsClient } from './day3ati-news.client';

describe('Day3atiNewsClient', () => {
  const call = { tenantSlug: 'albazourieh', userId: 'user-1', method: 'GET' as const, path: '/api/v1/news' };

  const tokens = (over: Partial<Day3atiTokens> = {}): jest.Mocked<Day3atiTokens> =>
    ({
      isConfigured: true,
      clientToken: jest.fn(),
      staffToken: jest.fn().mockResolvedValue('staff-token'),
      forgetClientToken: jest.fn(),
      forgetStaffToken: jest.fn(),
      ...over,
    }) as jest.Mocked<Day3atiTokens>;

  const villages = (over: Partial<Day3atiVillages> = {}): jest.Mocked<Day3atiVillages> =>
    ({
      villageOf: jest.fn().mockResolvedValue({ villageId: 'village-9', externalTenant: 'albazourieh', modules: ['news'] }),
      refresh: jest.fn(),
      ...over,
    }) as jest.Mocked<Day3atiVillages>;

  const make = (t = tokens(), v = villages()) =>
    new Day3atiNewsClient({ get: () => 'https://day3ati.example.test/' } as unknown as ConfigService, t, v);

  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => jest.restoreAllMocks());

  const refusalOf = async (promise: Promise<unknown>): Promise<DomainError> => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  };

  describe('what every call carries', () => {
    it("sends the user's staff token, their village, and the language as a header and as ?lang=", async () => {
      fetchMock.mockResolvedValue(json(200, { ok: true }));

      await expect(make().request({ ...call, language: 'en' })).resolves.toEqual({ ok: true });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://day3ati.example.test/api/v1/news?lang=en');
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer staff-token');
      expect(headers['x-village-id']).toBe('village-9');
      expect(headers['accept-language']).toBe('en');
    });

    it('asks for the staff token of that user in that municipality, and the village of that municipality', async () => {
      const t = tokens();
      const v = villages();
      fetchMock.mockResolvedValue(json(200, {}));

      await make(t, v).request({ ...call, tenantSlug: 'maarakeh', userId: 'user-7' });

      expect(t.staffToken).toHaveBeenCalledWith('maarakeh', 'user-7');
      expect(v.villageOf).toHaveBeenCalledWith('maarakeh');
    });

    it('speaks Arabic unless told otherwise, and never a language Day3ati does not speak', async () => {
      fetchMock.mockImplementation(async () => json(200, {}));
      await make().request(call);
      await make().request({ ...call, language: 'de' as never });

      for (const [url, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
        expect(url).toContain('lang=ar');
        expect((init.headers as Record<string, string>)['accept-language']).toBe('ar');
      }
    });

    it("puts the caller's query in, leaves out what is not set, and does not let it choose the language", async () => {
      fetchMock.mockResolvedValue(json(200, {}));

      await make().request({ ...call, query: { status: 'draft', page: 2, q: undefined, mine: null, lang: 'fr' } });

      const url = new URL((fetchMock.mock.calls[0] as [string])[0]);
      expect(Object.fromEntries(url.searchParams)).toEqual({ status: 'draft', page: '2', lang: 'ar' });
    });

    it('sends a JSON body with its type, and no type for a call without one', async () => {
      fetchMock.mockImplementation(async () => json(200, {}));

      await make().request({ ...call, method: 'POST', body: { title: 'عنوان' } });
      await make().request(call);

      const [, withBody] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(withBody.body))).toEqual({ title: 'عنوان' });
      expect((withBody.headers as Record<string, string>)['content-type']).toBe('application/json');
      const [, without] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(without.body).toBeUndefined();
      expect((without.headers as Record<string, string>)['content-type']).toBeUndefined();
    });

    it('answers undefined when Day3ati sends no body', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      await expect(make().request({ ...call, method: 'DELETE' })).resolves.toBeUndefined();
    });
  });

  describe('a wrong role is a clear refusal, not a crash', () => {
    it.each([
      ['auth.forbidden', 403, 'NEWS_FORBIDDEN'],
      ['village.module_disabled', 409, 'NEWS_MODULE_DISABLED'],
      ['integration.village_not_allowed', 403, 'NEWS_VILLAGE_NOT_LINKED'],
      ['village.not_member', 403, 'NEWS_NOT_A_MEMBER'],
    ])('%s becomes %s', async (partnerCode, status, expected) => {
      fetchMock.mockResolvedValue(json(status, { code: partnerCode, title: 'Nope' }));
      const error = await refusalOf(make().request(call));
      expect(error.code).toBe(expected);
    });

    it("hands a refused form's per-field errors to the screen", async () => {
      fetchMock.mockResolvedValue(json(422, { code: 'validation.failed', errors: { Title: ['مطلوب'] } }));
      const error = await refusalOf(make().request({ ...call, method: 'POST', body: {} }));
      expect(error.code).toBe('NEWS_INVALID_INPUT');
      expect(error.details).toEqual([{ path: 'title', message: 'مطلوب' }]);
    });

    it('an answer that is not JSON still gives the refusal its status calls for', async () => {
      fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
      expect((await refusalOf(make().request(call))).code).toBe('NEWS_UNAVAILABLE');
    });

    it('a Day3ati that does not answer is News being unavailable, with no URL or user in what is said', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed: https://day3ati.example.test/api/v1/news user-1'));
      const error = await refusalOf(make().request(call));
      expect(error.code).toBe('NEWS_UNAVAILABLE');
      expect(error.message).not.toContain('user-1');
    });

    it('a 2xx that is not JSON is News being unavailable', async () => {
      fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }));
      expect((await refusalOf(make().request(call))).code).toBe('NEWS_UNAVAILABLE');
    });
  });

  describe('the staff token', () => {
    it('on a 401 drops that user\'s token and tries once with a fresh one', async () => {
      const t = tokens({ staffToken: jest.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new') });
      fetchMock.mockResolvedValueOnce(json(401, { code: 'auth.unauthorized' })).mockResolvedValueOnce(json(200, { ok: 1 }));

      await expect(make(t).request(call)).resolves.toEqual({ ok: 1 });

      expect(t.forgetStaffToken).toHaveBeenCalledWith('albazourieh', 'user-1');
      expect(((fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>).authorization).toBe(
        'Bearer new',
      );
    });

    it('does not loop on a second 401', async () => {
      fetchMock.mockResolvedValue(json(401, {}));
      expect((await refusalOf(make().request(call))).code).toBe('NEWS_UNAVAILABLE');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('a user Day3ati has no account for is not a member, and nothing is sent', async () => {
      const t = tokens({ staffToken: jest.fn().mockRejectedValue(new Day3atiAuthError('oauth.invalid_grant', 'x', 400)) });
      expect((await refusalOf(make(t).request(call))).code).toBe('NEWS_NOT_A_MEMBER');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a secret Day3ati refuses is News being unavailable, never the secret', async () => {
      const t = tokens({
        staffToken: jest.fn().mockRejectedValue(new Day3atiAuthError('oauth.invalid_client', 'token-looking-text', 401)),
      });
      const error = await refusalOf(make(t).request(call));
      expect(error.code).toBe('NEWS_UNAVAILABLE');
      expect(error.message).not.toContain('token-looking-text');
    });
  });

  describe('the village', () => {
    it('a municipality with no village is not linked, and nothing is sent', async () => {
      const v = villages({ villageOf: jest.fn().mockResolvedValue(null) });
      expect((await refusalOf(make(tokens(), v).request(call))).code).toBe('NEWS_VILLAGE_NOT_LINKED');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a village list that cannot be read is News being unavailable', async () => {
      const v = villages({ villageOf: jest.fn().mockRejectedValue(new Error('down')) });
      expect((await refusalOf(make(tokens(), v).request(call))).code).toBe('NEWS_UNAVAILABLE');
    });
  });

  describe('while Day3ati is not configured', () => {
    it('refuses as unavailable without asking for anything', async () => {
      const t = tokens({ isConfigured: false });
      const v = villages();
      expect((await refusalOf(make(t, v).request(call))).code).toBe('NEWS_UNAVAILABLE');
      expect(t.staffToken).not.toHaveBeenCalled();
      expect(v.villageOf).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('a call that is not well formed is a bug, thrown before anything is sent', () => {
    it.each([
      ['a path that climbs', { path: '/api/v1/../integration/villages' }],
      ['a path with a query', { path: '/api/v1/news?x=1' }],
      ['a path with a host', { path: '//evil.example/news' }],
      ['an empty segment', { path: '/api//news' }],
      ['a relative path', { path: 'api/v1/news' }],
      ['a user id that moves the boundary', { userId: 'a:b' }],
      ['a tenant that is not a slug', { tenantSlug: '../maarakeh' }],
    ])('%s', async (_name, over) => {
      await expect(make().request({ ...call, ...over })).rejects.toBeInstanceOf(TypeError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts an id joined into a path the safe way', async () => {
      fetchMock.mockResolvedValue(json(200, {}));
      const id = '3f2a9c1e-0b7d-4e55-9a31-5d6f7a8b9c0d';
      await make().request({ ...call, path: `/api/v1/news/${encodeURIComponent(id)}` });
      expect((fetchMock.mock.calls[0] as [string])[0]).toContain(`/news/${id}?`);
    });
  });

  describe('cursor pages', () => {
    const page = (items: string[], nextCursor?: string) => json(200, { items, ...(nextCursor ? { nextCursor } : {}) });
    const itemsOf = (body: unknown) => (body as { items: string[] }).items;
    const cursorsAsked = () =>
      (fetchMock.mock.calls as Array<[string]>).map(([url]) => new URL(url).searchParams.get('cursor'));

    it('follows nextCursor as ?cursor= until an answer has none', async () => {
      fetchMock
        .mockResolvedValueOnce(page(['a', 'b'], 'c1'))
        .mockResolvedValueOnce(page(['c'], 'c2'))
        .mockResolvedValueOnce(page(['d']));

      await expect(make().allPages(call, itemsOf)).resolves.toEqual(['a', 'b', 'c', 'd']);
      expect(cursorsAsked()).toEqual([null, 'c1', 'c2']);
    });

    it('keeps the list\'s own filters on every page', async () => {
      fetchMock.mockResolvedValueOnce(page(['a'], 'c1')).mockResolvedValueOnce(page(['b']));

      await make().allPages({ ...call, query: { status: 'published' } }, itemsOf);

      for (const [url] of fetchMock.mock.calls as Array<[string]>) {
        expect(new URL(url).searchParams.get('status')).toBe('published');
      }
    });

    it('is done after one page when there is no nextCursor', async () => {
      fetchMock.mockResolvedValue(page(['only']));
      await expect(make().allPages(call, itemsOf)).resolves.toEqual(['only']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refuses rather than loop when Day3ati repeats a cursor', async () => {
      fetchMock.mockImplementation(async () => page(['x'], 'same'));
      expect((await refusalOf(make().allPages(call, itemsOf))).code).toBe('NEWS_UNAVAILABLE');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refuses rather than read a list past the page limit, and never hands back half of it', async () => {
      let n = 0;
      fetchMock.mockImplementation(async () => page(['x'], `c${n++}`));
      expect((await refusalOf(make().allPages(call, itemsOf, { maxPages: 3 }))).code).toBe('NEWS_UNAVAILABLE');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});

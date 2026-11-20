import { ERROR_CODES } from '@mechanization/shared-schemas';
import { Day3atiApiError } from '../../domain/interfaces/day3ati-integration.interface';
import { Day3atiAuthError } from '../../domain/interfaces/day3ati-tokens.interface';
import { newsErrorFromAnswer, newsErrorFromFailure, readProblem } from './day3ati-news-errors';

describe('readProblem', () => {
  it('reads the stable code and the per-field errors, naming fields the way a form does', () => {
    const problem = readProblem({
      code: 'validation.failed',
      errors: { Title: ['Required', 'Too short'], 'Items[0].Name': ['Bad'] },
    });

    expect(problem.code).toBe('validation.failed');
    expect(problem.fields).toEqual([
      { path: 'title', message: 'Required' },
      { path: 'title', message: 'Too short' },
      { path: 'items[0].name', message: 'Bad' },
    ]);
  });

  it('ignores a code or errors it cannot trust, and a body that is not an object', () => {
    expect(readProblem({ code: 'has spaces and <html>' }).code).toBeUndefined();
    expect(readProblem({ errors: ['a', 'b'] }).fields).toEqual([]);
    expect(readProblem({ errors: { Title: [1, null, ''] } }).fields).toEqual([]);
    expect(readProblem(undefined)).toEqual({ fields: [] });
    expect(readProblem('<html>')).toEqual({ fields: [] });
  });

  it('keeps a form-sized amount of text: at most 20 messages, each at most 300 characters', () => {
    const many = readProblem({ errors: { Body: Array.from({ length: 50 }, () => 'x'.repeat(1000)) } });
    expect(many.fields).toHaveLength(20);
    expect(many.fields[0].message).toHaveLength(300);
  });
});

describe('a refusal that names its field by code', () => {
  it.each([
    [409, 'news.category_key_taken', 'key'],
    [400, 'news.invalid_category_key', 'key'],
    [400, 'news.name_required', 'nameAr'],
  ])('%i %s is shown under %s, as a refused form', (status, code, path) => {
    const error = newsErrorFromAnswer(status, { code, title: 'That key is in use', fields: [] });
    expect(error.code).toBe('NEWS_INVALID_INPUT');
    expect(error.kind).toBe('VALIDATION_FAILED');
    expect(error.details).toEqual([{ path, message: 'That key is in use', code }]);
  });

  it('falls back to the code when the partner sent no title', () => {
    const error = newsErrorFromAnswer(409, { code: 'news.category_key_taken', fields: [] });
    expect(error.details).toEqual([{ path: 'key', message: 'news.category_key_taken', code: 'news.category_key_taken' }]);
  });
});

describe('newsErrorFromAnswer', () => {
  const answer = (status: number, code?: string, fields: Array<{ path: string; message: string }> = []) =>
    newsErrorFromAnswer(status, { code, fields });

  it.each([
    [403, 'auth.forbidden', 'NEWS_FORBIDDEN', 'FORBIDDEN'],
    [403, undefined, 'NEWS_FORBIDDEN', 'FORBIDDEN'],
    [403, 'village.not_member', 'NEWS_NOT_A_MEMBER', 'FORBIDDEN'],
    [409, 'village.module_disabled', 'NEWS_MODULE_DISABLED', 'CONFLICT'],
    [409, 'news.already_published', 'NEWS_ARTICLE_ALREADY_PUBLISHED', 'CONFLICT'],
    [403, 'integration.village_not_allowed', 'NEWS_VILLAGE_NOT_LINKED', 'CONFLICT'],
    [404, 'news.not_found', 'NEWS_NOT_FOUND', 'NOT_FOUND'],
    [500, undefined, 'NEWS_UNAVAILABLE', 'CONFLICT'],
    [503, undefined, 'NEWS_UNAVAILABLE', 'CONFLICT'],
    [429, undefined, 'NEWS_UNAVAILABLE', 'CONFLICT'],
    [401, undefined, 'NEWS_UNAVAILABLE', 'CONFLICT'],
    [409, 'news.slug_taken', 'NEWS_REQUEST_REFUSED', 'CONFLICT'],
  ])('%i %s becomes %s', (status, code, expected, kind) => {
    const error = answer(status, code);
    expect(error.code).toBe(expected);
    expect(error.kind).toBe(kind);
  });

  it("gives a refused form its per-field errors, in the shape every validation refusal has", () => {
    const fields = [{ path: 'title', message: 'مطلوب' }];
    for (const status of [400, 422]) {
      const error = answer(status, 'validation.failed', fields);
      expect(error.code).toBe('NEWS_INVALID_INPUT');
      expect(error.kind).toBe('VALIDATION_FAILED');
      expect(error.details).toEqual(fields);
    }
  });

  it("names the partner's code and status on an unrecognised refusal, for the screen to act on", () => {
    expect(answer(409, 'news.slug_taken').details).toEqual({ status: 409, partnerCode: 'news.slug_taken' });
  });

  it('never puts a field message, which may repeat what the user typed, in the log message', () => {
    const error = answer(422, 'validation.failed', [{ path: 'title', message: 'Rima Haddad is not allowed' }]);
    expect(error.message).not.toContain('Rima');
  });

  it('only uses codes the dictionaries translate', () => {
    for (const code of [
      'NEWS_FORBIDDEN',
      'NEWS_NOT_A_MEMBER',
      'NEWS_MODULE_DISABLED',
      'NEWS_VILLAGE_NOT_LINKED',
      'NEWS_UNAVAILABLE',
      'NEWS_INVALID_INPUT',
      'NEWS_NOT_FOUND',
      'NEWS_REQUEST_REFUSED',
      'NEWS_ARTICLE_ALREADY_PUBLISHED',
    ]) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});

describe('newsErrorFromFailure', () => {
  it('a user Day3ati has no account for is not a member', () => {
    expect(newsErrorFromFailure(new Day3atiAuthError('oauth.invalid_grant', 'x', 400)).code).toBe('NEWS_NOT_A_MEMBER');
    expect(newsErrorFromFailure(new Day3atiApiError('oauth.invalid_grant', 'x', 400)).code).toBe('NEWS_NOT_A_MEMBER');
  });

  it('any other token or call failure is News being unavailable, with no cause leaked', () => {
    for (const error of [
      new Day3atiAuthError('oauth.invalid_client', 'secret-looking text', 401),
      new Day3atiAuthError('day3ati.unavailable', 'x'),
      new Day3atiApiError('day3ati.not_configured', 'x'),
      new TypeError('fetch failed: https://day3ati.example.test/user-1'),
    ]) {
      const refusal = newsErrorFromFailure(error);
      expect(refusal.code).toBe('NEWS_UNAVAILABLE');
      expect(refusal.message).not.toContain('secret-looking');
      expect(refusal.message).not.toContain('user-1');
    }
  });

  it('keeps a refusal that is already one of ours', () => {
    const ours = newsErrorFromAnswer(403, { fields: [] });
    expect(newsErrorFromFailure(ours)).toBe(ours);
  });
});

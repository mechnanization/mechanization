import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api-client';
import { newsFieldErrors, newsName, type NewsFieldWording } from './news';

const wording: NewsFieldWording = {
  'news.invalid_category_key': 'Key not valid',
  'news.category_key_taken': 'Key already used',
  'news.name_required': 'Arabic name required',
};

const refusal = (details: unknown) =>
  new ApiRequestError(422, {
    code: 'NEWS_INVALID_INPUT',
    kind: 'VALIDATION_FAILED',
    message: 'Day3ati refused the input',
    details: details as never,
  });

describe('newsName', () => {
  const name = { ar: 'مياه وكهرباء', en: 'Water and power', fr: null };

  it('is the Arabic name on an Arabic page', () => {
    expect(newsName(name, 'ar')).toBe('مياه وكهرباء');
  });

  it('is the English name on an English page, and Arabic where nobody wrote one', () => {
    expect(newsName(name, 'en')).toBe('Water and power');
    expect(newsName({ ar: 'مياه', en: null, fr: null }, 'en')).toBe('مياه');
    expect(newsName({ ar: 'مياه', en: '   ', fr: null }, 'en')).toBe('مياه');
  });

  it('never shows the French name, which the portal has no page for', () => {
    expect(newsName({ ar: 'مياه', en: null, fr: 'Eau' }, 'en')).toBe('مياه');
  });
});

describe('newsFieldErrors', () => {
  it('words a refusal Day3ati named by code, in the page language, under its field', () => {
    const error = refusal([{ path: 'key', message: 'That key is in use', code: 'news.category_key_taken' }]);
    expect(newsFieldErrors(error, wording)).toEqual({ key: 'Key already used' });
  });

  it("shows Day3ati's own sentence for a field it did not name by code", () => {
    const error = refusal([{ path: 'sortOrder', message: 'Must be at most 1000000' }]);
    expect(newsFieldErrors(error, wording)).toEqual({ sortOrder: 'Must be at most 1000000' });
  });

  it('keeps the first message of a field', () => {
    const error = refusal([
      { path: 'nameAr', message: 'first' },
      { path: 'nameAr', message: 'second' },
    ]);
    expect(newsFieldErrors(error, wording)).toEqual({ nameAr: 'first' });
  });

  it('is empty for a refusal that names no field, so the form shows its own alert', () => {
    const notAllowed = new ApiRequestError(403, {
      code: 'NEWS_FORBIDDEN',
      kind: 'FORBIDDEN',
      message: 'Day3ati refused the role',
    });
    expect(newsFieldErrors(notAllowed, wording)).toEqual({});
    expect(newsFieldErrors(refusal({ status: 409 }), wording)).toEqual({});
  });

  it('is empty for anything that is not an API refusal', () => {
    expect(newsFieldErrors(new Error('boom'), wording)).toEqual({});
    expect(newsFieldErrors(undefined, wording)).toEqual({});
  });

  it('skips a malformed entry rather than throw in the handler that shows the error', () => {
    const error = refusal([null, { message: 'no path' }, { path: 'key', message: 'ok' }]);
    expect(newsFieldErrors(error, wording)).toEqual({ key: 'ok' });
  });
});

import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@mechanization/shared-schemas';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { localizeApiError } from './api-errors';
import { argumentNames } from './icu-arguments';
import { ApiRequestError } from './api-client';

/** A value of the right sort for every argument a message names. */
function sampleValues(message: string): Record<string, string | number> {
  return Object.fromEntries(
    argumentNames(message).map((name) => [name, name.startsWith('has') ? 'yes' : name === 'count' ? 2 : 7]),
  );
}

const arErrors = ar.errors as Record<string, string>;
const enErrors = en.errors as Record<string, string>;
const KINDS = new Set(['NOT_FOUND', 'CONFLICT', 'VALIDATION_FAILED', 'UNAUTHORIZED', 'FORBIDDEN', 'HTTP_ERROR']);

describe('the error dictionaries', () => {
  it('translate every error code in both languages, and nothing else', () => {
    const expected = [...ERROR_CODES].filter((code) => !KINDS.has(code)).sort();
    expect(Object.keys(arErrors).sort()).toEqual(expected);
    expect(Object.keys(enErrors).sort()).toEqual(expected);
  });

  it('use the same placeholders in Arabic and English', () => {
    for (const code of Object.keys(arErrors)) {
      expect({ code, args: argumentNames(enErrors[code]) }).toEqual({ code, args: argumentNames(arErrors[code]) });
    }
  });

  it('render every message once its values are filled in', () => {
    for (const locale of ['ar', 'en'] as const) {
      const dictionary = locale === 'ar' ? arErrors : enErrors;
      for (const [code, message] of Object.entries(dictionary)) {
        const text = localizeApiError({ code, message: 'SERVER', params: sampleValues(message) }, locale);
        expect({ code, locale, text }).not.toEqual({ code, locale, text: 'SERVER' });
        expect(text).not.toMatch(/[{}]/);
      }
    }
  });
});

describe('localizeApiError', () => {
  it('translates a code into the page language, with Latin digits in Arabic', () => {
    const payload = {
      code: 'PAYMENT_EXCEEDS_BALANCE',
      message: 'Amount 1500000 exceeds the balance 1000000',
      params: { amount: 1_500_000, outstanding: 1_000_000 },
    };
    expect(localizeApiError(payload, 'ar')).toBe('المبلغ المستلم (1,500,000) أكبر من الرصيد المستحق (1,000,000)');
    expect(localizeApiError(payload, 'en')).toBe(
      'The amount received (1,500,000) is more than the balance due (1,000,000).',
    );
  });

  it('picks the right plural and select branches', () => {
    const one = { code: 'OWNER_HAS_LINKED_TENANTS', message: 'x', params: { names: 'سامي', count: 1 } };
    expect(localizeApiError(one, 'en')).toMatch(/^سامي is linked .* the tenant’s card first/);
    const two = { ...one, params: { names: 'سامي، رنا', count: 2 } };
    expect(localizeApiError(two, 'en')).toMatch(/are linked .* the tenants’ cards first/);

    const withOwner = { code: 'TENANT_CARD_LINKED_TO_OTHER_OWNER', message: 'x', params: { unitCode: '0102', hasCurrent: 'yes', current: 'ندى' } };
    expect(localizeApiError(withOwner, 'en')).toContain('another owner (ندى).');
    expect(localizeApiError({ ...withOwner, params: { unitCode: '0102', hasCurrent: 'no', current: '' } }, 'en')).toContain(
      'another owner.',
    );
  });

  it('shows the server message for a refusal that has no code yet', () => {
    expect(localizeApiError({ code: 'CONFLICT', message: 'نص من الخادم' }, 'en')).toBe('نص من الخادم');
  });

  it('shows the server message for a code this build does not know', () => {
    expect(localizeApiError({ code: 'SOMETHING_NEW', message: 'fallback' }, 'ar')).toBe('fallback');
  });

  it('shows the server message rather than a broken sentence when params are missing', () => {
    expect(localizeApiError({ code: 'PAYMENT_EXCEEDS_BALANCE', message: 'fallback' }, 'ar')).toBe('fallback');
  });
});

describe('ApiRequestError', () => {
  it('carries the translated text as its message and exposes code and kind', () => {
    const error = new ApiRequestError(409, {
      code: 'PAYMENT_ALREADY_PAID',
      kind: 'CONFLICT',
      message: 'This payment has already been settled.',
    });
    // No document in this environment, so the page language falls back to Arabic.
    expect(error.message).toBe('هذه الدفعة مسدّدة بالفعل');
    expect(error.code).toBe('PAYMENT_ALREADY_PAID');
    expect(error.kind).toBe('CONFLICT');
  });

  it('reads the kind from the code when the API predates kinds', () => {
    const error = new ApiRequestError(409, { code: 'CONFLICT', message: 'نص' });
    expect(error.kind).toBe('CONFLICT');
    expect(error.message).toBe('نص');
  });
});

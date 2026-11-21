import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api-client';
import { refusalOf } from './use-staff-query';

const refusal = (status: number, code: string, kind: string) =>
  new ApiRequestError(status, { code, kind, message: 'raw server text that must not reach a screen' });

describe('refusalOf', () => {
  it('is the words we have for a refusal the API gave a specific code for', () => {
    const error = refusal(403, 'NEWS_NOT_A_MEMBER', 'FORBIDDEN');
    expect(refusalOf(error)).toBe(error.message);
    // The translated text, not the server's own sentence.
    expect(refusalOf(error)).not.toContain('raw server text');
    expect(refusalOf(error)?.length).toBeGreaterThan(10);
  });

  it('tells a missing News account, a role that may not, a module that is off and a service that is down apart', () => {
    const words = ['NEWS_NOT_A_MEMBER', 'NEWS_FORBIDDEN', 'NEWS_MODULE_DISABLED', 'NEWS_UNAVAILABLE'].map((code) =>
      refusalOf(refusal(403, code, 'FORBIDDEN')),
    );
    expect(new Set(words).size).toBe(4);
  });

  it('is null for a refusal with no code of ours, which may carry raw server text', () => {
    // A code this build has no words for (an API deployed ahead of the portal)...
    expect(refusalOf(refusal(400, 'SOMETHING_THE_SERVER_INVENTED', 'VALIDATION_FAILED'))).toBeNull();
    // ...and an older throw site that sends only its kind as the code, with prose of its own.
    expect(refusalOf(refusal(409, 'CONFLICT', 'CONFLICT'))).toBeNull();
  });

  it('says the generic fault in our own words, never the servers, for the one code that stands for any 500', () => {
    const error = refusal(500, 'INTERNAL_ERROR', 'INTERNAL_ERROR');
    expect(refusalOf(error)).toBe(error.message);
    expect(refusalOf(error)).not.toContain('raw server text');
  });

  it('is null for anything that is not an API refusal', () => {
    expect(refusalOf(new Error('boom'))).toBeNull();
    expect(refusalOf(undefined)).toBeNull();
    expect(refusalOf(null)).toBeNull();
  });
});

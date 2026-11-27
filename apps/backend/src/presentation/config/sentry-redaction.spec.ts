import {
  REDACTED,
  redactDeep,
  redactText,
  redactUrl,
  scrubEvent,
  type ScrubbableEvent,
} from '@mechanization/shared-schemas';

/**
 * These tests are the control, not a description of one.
 *
 * §8.7 is an incident about a guard that enforced a boot failure instead of the
 * property anyone wanted. The property wanted here is narrow and stateable: no
 * field a citizen appears in reaches Sentry. Each case below is a real shape
 * this system produces — a Postgres unique violation, a tenant-scoped URL, a
 * registration body — rather than a synthetic string chosen because it matches
 * the regex.
 */
describe('sentry redaction', () => {
  describe('redactText', () => {
    it('removes a national ID quoted back by a Postgres unique violation', () => {
      const detail =
        'duplicate key value violates unique constraint "users_national_id_key" ' +
        'Key (national_id)=(123456789) already exists.';

      const cleaned = redactText(detail);

      // The column name survives — it is what identifies the bug.
      expect(cleaned).toContain('users_national_id_key');
      expect(cleaned).toContain('Key (national_id)=');
      expect(cleaned).not.toContain('123456789');
    });

    it('removes a رقم مرجعي, which is a login credential', () => {
      expect(redactText('reference BZR-2608-5HLQBM not found')).toBe(
        `reference ${REDACTED} not found`,
      );
      // Also in its unseparated storage form.
      expect(redactText('BZR26085HLQBM')).toBe(REDACTED);
    });

    it('removes phone numbers however they are punctuated', () => {
      expect(redactText('phone 03-123-456 unreachable')).not.toContain('123');
      expect(redactText('+961 71 234 567')).not.toContain('234');
    });

    it('removes UUIDs, JWTs and staff email addresses', () => {
      expect(redactText('citizen 3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b')).toBe(
        `citizen ${REDACTED}`,
      );
      expect(redactText('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-123_x')).toContain(
        REDACTED,
      );
      expect(redactText('clerk a.srour@zahle.gov.lb failed')).toBe(`clerk ${REDACTED} failed`);
    });

    it('keeps the short numbers that make an error triageable', () => {
      // Status codes, counts, years and ports are all under the six-digit floor.
      expect(redactText('request failed with status 500 after 3 retries')).toBe(
        'request failed with status 500 after 3 retries',
      );
      expect(redactText('migration 0026 applied')).toBe('migration 0026 applied');
    });
  });

  describe('redactUrl', () => {
    it('keeps the route shape and the municipality, drops the row id', () => {
      const url =
        'https://api.example.com/api/v1/t/zahle/citizens/' +
        '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b/documents';

      const cleaned = redactUrl(url);

      // The tenant is the whole point of keeping any of it: it answers
      // "one municipality or all of them".
      expect(cleaned).toBe(`https://api.example.com/api/v1/t/zahle/citizens/${REDACTED}/documents`);
    });

    it('drops the query string entirely, because search terms are people', () => {
      expect(redactUrl('/api/v1/t/zahle/citizens?search=%D8%A3%D8%AD%D9%85%D8%AF&limit=25')).toBe(
        '/api/v1/t/zahle/citizens',
      );
    });
  });

  describe('redactDeep', () => {
    it('reaches strings nested inside objects and arrays', () => {
      const cleaned = redactDeep({
        rows: [{ nationalId: '123456789', note: 'fine' }],
        count: 1,
      }) as { rows: Array<{ nationalId: string; note: string }>; count: number };

      expect(cleaned.rows[0]!.nationalId).toBe(REDACTED);
      expect(cleaned.rows[0]!.note).toBe('fine');
      expect(cleaned.count).toBe(1);
    });

    it('fails closed past its depth limit rather than passing data through', () => {
      let deep: unknown = 'national id 123456789';
      for (let level = 0; level < 12; level += 1) deep = { next: deep };

      expect(JSON.stringify(redactDeep(deep))).not.toContain('123456789');
    });

    it('survives a cyclic object instead of throwing while reporting an error', () => {
      const cyclic: Record<string, unknown> = { name: 'x' };
      cyclic.self = cyclic;

      expect(() => redactDeep(cyclic)).not.toThrow();
    });
  });

  describe('scrubEvent', () => {
    /** A registration POST that failed — the worst-case payload in this system. */
    function citizenRegistrationEvent(): ScrubbableEvent {
      return {
        request: {
          url: 'https://api.example.com/api/v1/t/zahle/citizens?search=ahmad',
          method: 'POST',
          query_string: 'search=ahmad',
          data: {
            fullName: 'أحمد محمد',
            nationalId: '123456789',
            residentStatus: 'REFUGEE',
            phone: '03123456',
          },
          cookies: { session: 'abc' },
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
            cookie: 'session=abc',
            'x-correlation-id': 'req-42',
          },
        },
        user: { id: 'staff-1', email: 'clerk@zahle.gov.lb', ip_address: '10.0.0.4' },
        exception: {
          values: [
            {
              type: 'PrismaClientKnownRequestError',
              value: 'Unique constraint failed. Key (national_id)=(123456789) already exists.',
            },
          ],
        },
        breadcrumbs: [
          { message: 'loaded citizen 3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b' },
          { message: 'query', data: { sql: 'select * from users where national_id = 123456789' } },
        ],
        extra: { attemptedNationalId: '123456789' },
        contexts: {
          // What `reportException` attaches.
          request: { route: '/api/v1/t/zahle/citizens/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b' },
          // What the SDK attaches, which must survive intact.
          runtime: { name: 'node', version: '22.20.1' },
        },
      };
    }

    it('drops the request body, cookies and query string outright', () => {
      const scrubbed = scrubEvent(citizenRegistrationEvent());

      expect(scrubbed.request?.data).toBeUndefined();
      expect(scrubbed.request?.cookies).toBeUndefined();
      expect(scrubbed.request?.query_string).toBeUndefined();
      // The parts that describe the request rather than the person stay.
      expect(scrubbed.request?.method).toBe('POST');
    });

    it('reduces headers to the allowlist, so a token cannot ride along', () => {
      const headers = scrubEvent(citizenRegistrationEvent()).request?.headers ?? {};

      expect(headers['x-correlation-id']).toBe('req-42');
      expect(headers['content-type']).toBe('application/json');
      expect(headers.authorization).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
    });

    it('drops the user, who is a named staff member', () => {
      expect(scrubEvent(citizenRegistrationEvent()).user).toBeUndefined();
    });

    it('redacts the exception value, which becomes the issue title', () => {
      const scrubbed = scrubEvent(citizenRegistrationEvent());
      const value = scrubbed.exception?.values?.[0]?.value ?? '';

      expect(value).toContain('Unique constraint failed');
      expect(value).not.toContain('123456789');
    });

    it('leaves no citizen anywhere in the serialised event', () => {
      const serialised = JSON.stringify(scrubEvent(citizenRegistrationEvent()));

      // The single assertion this whole module exists for.
      for (const secret of [
        '123456789',
        '03123456',
        'أحمد محمد',
        'REFUGEE',
        'clerk@zahle.gov.lb',
        '10.0.0.4',
        'eyJhbGciOiJIUzI1NiJ9',
        'search=ahmad',
      ]) {
        expect(serialised).not.toContain(secret);
      }

      // And the municipality still is, or the report is untriageable.
      expect(serialised).toContain('zahle');
    });

    it('redacts an application-supplied context', () => {
      /*
        The gap the unit tests originally agreed with.

        Every fixture here happened to have no `contexts`, so `scrubEvent` never
        touched it and the tests passed while a row id attached by
        `reportException` went out untouched. Found by pushing a real event
        through a stubbed transport, which is the only check that sees what
        would actually have been on the wire.
      */
      const scrubbed = scrubEvent(citizenRegistrationEvent());
      const request = scrubbed.contexts?.request as { route: string };

      expect(request.route).toBe(`/api/v1/t/zahle/citizens/${REDACTED}`);
    });

    it('leaves the SDK-owned contexts alone, so a version stays readable', () => {
      // `22.20.1` would otherwise be eaten by the digit-run rule, costing
      // triage information for no privacy gain.
      const scrubbed = scrubEvent(citizenRegistrationEvent());

      expect(scrubbed.contexts?.runtime).toEqual({ name: 'node', version: '22.20.1' });
    });

    it('handles an event with no request, user or breadcrumbs', () => {
      expect(() => scrubEvent({})).not.toThrow();
      expect(scrubEvent({ breadcrumbs: null })).toEqual({ breadcrumbs: null });
    });
  });

  /*
    The portal's call (`apps/frontend/lib/sentry-options.ts`): the same module,
    asked to keep only the URL of a request. Before DRY-05 the portal ran its own
    untested copy; these pin what it relies on.
  */
  describe('the portal', () => {
    /** A browser event on the staff register: a search typed into the URL, the token beside it. */
    function portalEvent(): ScrubbableEvent {
      return {
        request: {
          url: 'https://baladyia.com/zahle/ar/admin-x7/citizens/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b?search=ahmad#BZR-2608-5HLQBM',
          method: 'GET',
          headers: {
            'user-agent': 'Mozilla/5.0',
            referer: 'https://baladyia.com/zahle/ar/admin-x7/citizens?search=ahmad',
            authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
          },
          data: { fullName: 'أحمد محمد', nationalId: '123456789' },
        },
        user: { id: 'staff-1' },
        breadcrumbs: [{ message: 'navigated to /zahle/ar/track/BZR-2608-5HLQBM' }],
        contexts: {
          browser: { name: 'Chrome', version: '131.0.6778.86' },
          route: { path: '/zahle/ar/track/BZR-2608-5HLQBM' },
        },
      };
    }

    it('keeps only the redacted URL of a request: no headers, no method, no body', () => {
      const scrubbed = scrubEvent(portalEvent(), { request: 'url-only' });

      expect(scrubbed.request).toEqual({ url: `https://baladyia.com/zahle/ar/admin-x7/citizens/${REDACTED}` });
    });

    it('drops the hash as well as the query string, wherever a رقم مرجعي might sit', () => {
      expect(redactUrl('/zahle/ar/track#BZR-2608-5HLQBM')).toBe('/zahle/ar/track');
      expect(redactUrl('/zahle/ar/citizens?search=ahmad#top')).toBe('/zahle/ar/citizens');
    });

    it('redacts a رقم مرجعي in a breadcrumb and an application context, and keeps the browser version', () => {
      const scrubbed = scrubEvent(portalEvent(), { request: 'url-only' });
      const serialised = JSON.stringify(scrubbed);

      expect(serialised).not.toContain('BZR-2608-5HLQBM');
      expect(serialised).not.toContain('123456789');
      expect(serialised).not.toContain('eyJ');
      expect(serialised).not.toContain('search=');
      expect(scrubbed.user).toBeUndefined();
      expect(scrubbed.contexts?.browser).toEqual({ name: 'Chrome', version: '131.0.6778.86' });
    });

    it('never keeps the referer, which is a URL with its query string, on the API side either', () => {
      const headers = scrubEvent(portalEvent()).request?.headers ?? {};

      expect(headers.referer).toBeUndefined();
      expect(headers['user-agent']).toBe('Mozilla/5.0');
    });
  });
});

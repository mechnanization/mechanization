import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ForbiddenError } from '../../application/common/exceptions';
import { TrustedOriginGuard } from './trusted-origin.guard';

/**
 * The origin check on sign-in, refresh and sign-out.
 *
 * CORS decides whether page script may read a response, not whether the
 * request is made: a plain cross-site form POST reaches the handler, and
 * whatever it does there happens. This guard is what stops another site from
 * signing a clerk's browser into an attacker's account, or quietly signing a
 * clerk out. The list it trusts is `CORS_ORIGINS`, already parsed into an
 * array by `env.schema.ts` — the same value `bootstrap.ts` hands to CORS.
 */

const PORTAL = 'https://baladyia.com';

function guardTrusting(origins: string[] | undefined) {
  const config = { get: jest.fn().mockReturnValue(origins) } as unknown as ConfigService;
  return new TrustedOriginGuard(config);
}

function requestFrom(origin: string | undefined): ExecutionContext {
  const request = {
    header: (name: string) => (name.toLowerCase() === 'origin' ? origin : undefined),
  };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('TrustedOriginGuard', () => {
  it('admits the portal', () => {
    const guard = guardTrusting([PORTAL, 'http://localhost:3000']);

    expect(guard.canActivate(requestFrom(PORTAL))).toBe(true);
    expect(guard.canActivate(requestFrom('http://localhost:3000'))).toBe(true);
  });

  it('refuses any other origin before the handler reads or sets a cookie', () => {
    const guard = guardTrusting([PORTAL]);

    expect(() => guard.canActivate(requestFrom('https://evil.example'))).toThrow(ForbiddenError);
  });

  it.each([
    ['a lookalike host', 'https://baladyia.com.evil.example'],
    ['another subdomain', 'https://api.baladyia.com'],
    ['the portal over plain http', 'http://baladyia.com'],
    ['the portal on another port', 'https://baladyia.com:8443'],
    ['a trailing slash', 'https://baladyia.com/'],
    ['the opaque "null" origin of a sandboxed frame', 'null'],
    ['an empty header', ''],
  ])('compares whole origins exactly — refusing %s', (_label, origin) => {
    // A prefix or substring comparison is the classic mistake here, and each
    // row is a way it would let a hostile page through.
    const guard = guardTrusting([PORTAL]);

    expect(() => guard.canActivate(requestFrom(origin))).toThrow(ForbiddenError);
  });

  it('admits a request with no Origin at all', () => {
    // Browsers send one on every POST and every cross-origin request, so its
    // absence is a client that is not a browser — a script, a health probe —
    // and such a client carries no ambient cookie to abuse.
    const guard = guardTrusting([PORTAL]);

    expect(guard.canActivate(requestFrom(undefined))).toBe(true);
  });

  it('falls back to the local portal when CORS_ORIGINS is unset, as bootstrap does', () => {
    const guard = guardTrusting(undefined);

    expect(guard.canActivate(requestFrom('http://localhost:3000'))).toBe(true);
    expect(() => guard.canActivate(requestFrom(PORTAL))).toThrow(ForbiddenError);
  });

  it('reads the list the bootstrap reads', () => {
    const config = { get: jest.fn().mockReturnValue([PORTAL]) };
    new TrustedOriginGuard(config as unknown as ConfigService).canActivate(requestFrom(PORTAL));

    expect(config.get).toHaveBeenCalledWith('CORS_ORIGINS');
  });
});

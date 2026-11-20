import { JwtService } from '@nestjs/jwt';
import {
  SESSION_TOKEN_AUDIENCE,
  SESSION_TOKEN_CLAIMS_REQUIRED,
  SESSION_TOKEN_ISSUER,
  sessionClaimsProblem,
  sessionSignOptions,
  verifySessionToken,
} from './session-token';

/**
 * How a session token is signed and read (task S18): HS256 only, and the
 * issuer and audience, with phase 1 of the rollout still reading the tokens
 * minted before the deploy, which carry neither.
 */
const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const jwt = new JwtService({ secret: SECRET });
const claims = { sub: 'staff-1', kind: 'STAFF', tenantSlug: 'albazourieh', tokenVersion: 0 };

describe('session tokens', () => {
  it('are signed with HS256, the issuer and the audience, and read back', () => {
    const token = jwt.sign(claims, sessionSignOptions('15m'));
    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());
    expect(header.alg).toBe('HS256');

    const read = verifySessionToken<typeof claims & { iss: string; aud: string }>(jwt, token);
    expect(read).toMatchObject({ ...claims, iss: SESSION_TOKEN_ISSUER, aud: SESSION_TOKEN_AUDIENCE });
  });

  it('refuses another HMAC algorithm with the same secret: the pin leaves none to choose', () => {
    const hs512 = jwt.sign(claims, { ...sessionSignOptions('15m'), algorithm: 'HS512' });
    expect(() => verifySessionToken(jwt, hs512)).toThrow(/invalid algorithm/);
  });

  it('refuses a token from another issuer or for another audience', () => {
    const elsewhere = jwt.sign(claims, { ...sessionSignOptions('15m'), issuer: 'another-service' });
    const forReset = jwt.sign(claims, { ...sessionSignOptions('15m'), audience: 'password-reset' });
    expect(() => verifySessionToken(jwt, elsewhere)).toThrow(/wrong issuer/);
    expect(() => verifySessionToken(jwt, forReset)).toThrow(/wrong audience/);
  });

  it('reads a token minted before the deploy, which carries neither claim, while the rollout is in phase 1', () => {
    const before = jwt.sign(claims, { algorithm: 'HS256', expiresIn: '15m' });
    expect(SESSION_TOKEN_CLAIMS_REQUIRED).toBe(false);
    expect(verifySessionToken(jwt, before)).toMatchObject(claims);
  });

  it('reads an expired token only when asked to, for the tab a refresh binds', () => {
    const expired = jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 }, {
      algorithm: 'HS256',
      issuer: SESSION_TOKEN_ISSUER,
      audience: SESSION_TOKEN_AUDIENCE,
    });
    expect(() => verifySessionToken(jwt, expired)).toThrow(/expired/);
    expect(verifySessionToken(jwt, expired, { ignoreExpiration: true })).toMatchObject(claims);
  });

  it('refuses a signature from another secret whatever the claims', () => {
    const foreign = new JwtService({ secret: 'a-completely-different-secret-value-xx' });
    expect(() => verifySessionToken(jwt, foreign.sign(claims, sessionSignOptions('15m')))).toThrow(/signature/);
  });
});

describe('sessionClaimsProblem — the rollout rule', () => {
  it('lets a token with neither claim through in phase 1 and refuses it in phase 2', () => {
    expect(sessionClaimsProblem({}, false)).toBeNull();
    expect(sessionClaimsProblem({}, true)).toBe('no issuer or audience');
  });

  it('refuses one claim without the other in either phase: this service never wrote that', () => {
    for (const required of [false, true]) {
      expect(sessionClaimsProblem({ iss: SESSION_TOKEN_ISSUER }, required)).toMatch(/together/);
      expect(sessionClaimsProblem({ aud: SESSION_TOKEN_AUDIENCE }, required)).toMatch(/together/);
    }
  });

  it('accepts the audience in a list', () => {
    expect(sessionClaimsProblem({ iss: SESSION_TOKEN_ISSUER, aud: ['other', SESSION_TOKEN_AUDIENCE] }, true)).toBeNull();
    expect(sessionClaimsProblem({ iss: SESSION_TOKEN_ISSUER, aud: ['other'] }, true)).toBe('wrong audience');
  });
});

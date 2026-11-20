import type { JwtService, JwtSignOptions } from '@nestjs/jwt';

/**
 * How a session token — a staff or a citizen access token — is signed and
 * read: the one home of its algorithm, issuer and audience (security gap
 * closed by task S18, 2026-11-16).
 *
 * `jsonwebtoken` already refuses `none` when it is handed a string secret, but
 * it accepts every HMAC algorithm it knows and checks no issuer or audience.
 * Pinning HS256 leaves an attacker no algorithm to choose, and the issuer and
 * audience say a token was minted by this API as a session, not by anything
 * else that might one day sign with `JWT_SECRET`. The password-reset token is
 * not a session: it is signed with a key derived from the secret
 * (`IdentityService.resetSigningKey`) and carries its own `purpose`.
 */
export const SESSION_TOKEN_ALGORITHM = 'HS256' as const;
export const SESSION_TOKEN_ISSUER = 'mechanization-api';
export const SESSION_TOKEN_AUDIENCE = 'mechanization-session';

/**
 * The rollout, so the sessions alive at the deploy survive it.
 *
 * Phase 1 (this value, `false`): every token is signed with the issuer and
 * audience, and a token that carries either must carry both, with these
 * values. A token minted before the deploy carries neither and is still
 * accepted until it expires. A staff tab refreshes through its expired access
 * token (`IdentityService.bindTab`), so requiring the claims at once would
 * sign out every staff member at the deploy.
 *
 * Phase 2 (`true`): the claims are required. Flip it once the deploy that
 * signs them is older than the longest session the host allows: the largest
 * of `JWT_CITIZEN_TTL`, `JWT_STAFF_REMEMBER_TTL` and `JWT_STAFF_TTL` (7 days
 * by default). docs/security.md keeps the gap row open until then.
 */
export const SESSION_TOKEN_CLAIMS_REQUIRED = false;

/** Sign options for a session token that lives `expiresIn` (a duration string or seconds). */
export function sessionSignOptions(expiresIn: string | number): JwtSignOptions {
  return {
    algorithm: SESSION_TOKEN_ALGORITHM,
    issuer: SESSION_TOKEN_ISSUER,
    audience: SESSION_TOKEN_AUDIENCE,
    expiresIn,
  };
}

/**
 * Verifies a session token and returns its claims, or throws. HS256 only, and
 * the issuer and audience per the rollout above. `ignoreExpiration` is for
 * `bindTab` alone, which reads an expired staff token to find whose refresh
 * cookie a tab holds; the signature is still checked.
 */
export function verifySessionToken<T extends object>(
  jwt: JwtService,
  token: string,
  options: { ignoreExpiration?: boolean } = {},
): T {
  const payload = jwt.verify<T & { iss?: unknown; aud?: unknown }>(token, {
    algorithms: [SESSION_TOKEN_ALGORITHM],
    ...(options.ignoreExpiration ? { ignoreExpiration: true } : {}),
  });
  const problem = sessionClaimsProblem(payload, SESSION_TOKEN_CLAIMS_REQUIRED);
  if (problem) throw new Error(`Session token refused: ${problem}`);
  return payload;
}

/** Why a verified payload's issuer and audience are refused, or null. Exported for its tests. */
export function sessionClaimsProblem(
  payload: { iss?: unknown; aud?: unknown },
  required: boolean,
): string | null {
  const hasIssuer = payload.iss !== undefined;
  const hasAudience = payload.aud !== undefined;
  if (!hasIssuer && !hasAudience) return required ? 'no issuer or audience' : null;
  // This service writes both or, before the deploy, neither: one alone was never minted here.
  if (!hasIssuer || !hasAudience) return 'issuer and audience must travel together';
  if (payload.iss !== SESSION_TOKEN_ISSUER) return 'wrong issuer';
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(SESSION_TOKEN_AUDIENCE)) return 'wrong audience';
  return null;
}

import { resetTokenFromFragment } from '@mechanization/shared-schemas';

/** What the reset page opened with: a token to set a password with, or nothing usable. */
export type ResetLink = { kind: 'recovery'; accessToken: string } | { kind: 'invalid' };

/**
 * Reads the reset page's `location.hash`, by the shared rule the server wrote
 * the link with (`resetTokenFromFragment`; task S14 of the 2026-11-14 security
 * audit). The token travels in the fragment so it never reaches a server log
 * or a `Referer`.
 *
 * It replaces the Supabase-style parsing (`#type=recovery&access_token=`) the
 * page kept after Supabase stopped sending these mails: the server mailed
 * `?token=`, the page looked for something else, and no reset could succeed.
 * The email-change notice it also handled was Supabase's own, and nothing
 * sends it any more.
 */
export function parseResetLink(hash: string): ResetLink {
  const token = resetTokenFromFragment(hash);
  return token ? { kind: 'recovery', accessToken: token } : { kind: 'invalid' };
}

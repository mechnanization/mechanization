import { describe, expect, it } from 'vitest';
import { resetTokenFragment } from '@mechanization/shared-schemas';
import { parseResetLink } from './reset-link';

/**
 * The page reads what the server writes (task S14): the link is built with
 * `resetTokenFragment` (the server's `resetLink`, its own spec) and read here
 * with `parseResetLink`, through one shared key. Before, the server wrote
 * `?token=` and the page looked for a Supabase fragment.
 */
describe('parseResetLink', () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzMSJ9.c2ln';

  it('reads the token the server put in the fragment', () => {
    expect(parseResetLink(`#${resetTokenFragment(token)}`)).toEqual({ kind: 'recovery', accessToken: token });
  });

  it('keeps a token whose characters the fragment had to escape', () => {
    const odd = 'a+b/c=d&e';
    expect(parseResetLink(`#${resetTokenFragment(odd)}`)).toEqual({ kind: 'recovery', accessToken: odd });
  });

  it('finds nothing in the old shapes: a Supabase fragment, or an empty one', () => {
    expect(parseResetLink(`#type=recovery&access_token=${token}`)).toEqual({ kind: 'invalid' });
    expect(parseResetLink('#type=email_change')).toEqual({ kind: 'invalid' });
    expect(parseResetLink('')).toEqual({ kind: 'invalid' });
    expect(parseResetLink('#reset_token=')).toEqual({ kind: 'invalid' });
  });

  it('refuses a mangled escape rather than throwing', () => {
    expect(parseResetLink('#reset_token=%E0%A4%A')).toEqual({ kind: 'invalid' });
  });
});

import { bearerMatches } from './bearer-secret';

/**
 * The shared-secret check of `/metrics` and the cron routes (task S18: the cron
 * secret was compared with `!==`). What it must refuse matters as much as what
 * it admits, and a header of another length must not throw.
 */
describe('bearerMatches', () => {
  const secret = 's'.repeat(32);

  it('admits exactly `Bearer <secret>`', () => {
    expect(bearerMatches(`Bearer ${secret}`, secret)).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['the bare secret', secret],
    ['another scheme', `Basic ${secret}`],
    ['a prefix of the secret', `Bearer ${secret.slice(0, 31)}`],
    ['the secret and more', `Bearer ${secret}x`],
    ['another secret', `Bearer ${'t'.repeat(32)}`],
  ])('refuses %s, without throwing', (_label, header) => {
    expect(bearerMatches(header, secret)).toBe(false);
  });
});

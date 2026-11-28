import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { APP_CONFIG } from '../../application/common/app.config';
import { AuthController } from '../controllers/auth.controller';
import { THROTTLERS, staffAccountTracker } from './throttlers';

/**
 * The throttlers `AppModule` counts with (audit SEC-04, decision U-6 of
 * 2026-11-28): per address everywhere, and per staff account on the sign-in
 * alone. What fails silently here is a throttler that counts every route, or a
 * bucket that two spellings of one email escape.
 */
describe('THROTTLERS', () => {
  const byName = (name: string) => THROTTLERS.find((throttler) => throttler.name === name)!;
  const contextOf = (handler: (...args: never[]) => unknown) =>
    ({ getHandler: () => handler, getClass: () => AuthController }) as unknown as ExecutionContext;
  const signIn = (email: unknown, slug = 'albazourieh') => ({ body: { email, password: 'x' }, tenant: { slug } });

  it('counts per address at the default, and per account at the sign-in bar', () => {
    expect(THROTTLERS.map((throttler) => throttler.name)).toEqual(['default', 'staffAccount']);
    expect(byName('default')).toMatchObject({
      limit: APP_CONFIG.throttle.default.limit,
      ttl: APP_CONFIG.throttle.default.ttlSeconds * 1000,
    });
    expect(byName('staffAccount')).toMatchObject({
      limit: APP_CONFIG.throttle.staffLoginAccount.limit,
      ttl: APP_CONFIG.throttle.staffLoginAccount.ttlSeconds * 1000,
    });
  });

  it('counts the account only on a route marked @CountPerStaffAccount — the staff sign-in', () => {
    const skipIf = byName('staffAccount').skipIf!;
    expect(skipIf(contextOf(AuthController.prototype.loginStaff))).toBe(false);
    for (const other of [
      AuthController.prototype.refreshStaff,
      AuthController.prototype.loginByReference,
      AuthController.prototype.confirmPasswordReset,
    ]) {
      expect(skipIf(contextOf(other))).toBe(true);
    }
    expect(byName('default').skipIf).toBeUndefined();
  });

  it('keys one account whatever case or spacing the email was typed in, as the sign-in folds it', () => {
    expect(staffAccountTracker(signIn('  Clerk@Example.org '))).toBe(staffAccountTracker(signIn('clerk@example.org')));
  });

  it('keeps accounts, and the same email in two municipalities, apart', () => {
    const base = staffAccountTracker(signIn('clerk@example.org'));
    expect(staffAccountTracker(signIn('other@example.org'))).not.toBe(base);
    expect(staffAccountTracker(signIn('clerk@example.org', 'maarakeh'))).not.toBe(base);
  });

  it('never holds the address in the key, and puts a body without one in one bucket', () => {
    expect(staffAccountTracker(signIn('clerk@example.org'))).not.toContain('clerk');
    expect(staffAccountTracker(signIn(undefined))).toBe(staffAccountTracker(signIn({ $ne: '' })));
    expect(staffAccountTracker({ tenant: { slug: 'albazourieh' } })).toBe(staffAccountTracker(signIn(42)));
  });
});

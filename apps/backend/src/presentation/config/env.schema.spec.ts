import { isSchedulerEnabled, validateEnv } from './env.schema';

/**
 * Who owns the `@Cron` schedule.
 *
 * This used to be `!process.env.VERCEL` inline in `AppModule` — a decision made
 * by a variable the platform injects and this repository never sets, which
 * meant that on any host that is not Vercel the answer was "every process that
 * boots, including a developer's laptop pointed at staging" and there was
 * nowhere to look it up.
 *
 * The tests that matter here are the *defaults*. A flag like this is introduced
 * to stop something from running in one place, and the way that goes wrong is
 * that it stops running everywhere — so the unset case is pinned first and
 * hardest.
 */
describe('isSchedulerEnabled', () => {
  it('runs the schedule when nothing is set — the pre-flag behaviour', () => {
    expect(isSchedulerEnabled({})).toBe(true);
  });

  it('still skips it on Vercel when nothing is set', () => {
    expect(isSchedulerEnabled({ VERCEL: '1' })).toBe(false);
  });

  it('treats an empty string as unset rather than as false', () => {
    // A blank value in a dotenv file (`SCHEDULER_ENABLED=`) is someone who
    // has not decided, not someone who decided "no".
    expect(isSchedulerEnabled({ SCHEDULER_ENABLED: '' })).toBe(true);
    expect(isSchedulerEnabled({ SCHEDULER_ENABLED: '   ' })).toBe(true);
  });

  it('lets an explicit value override the platform in both directions', () => {
    expect(isSchedulerEnabled({ VERCEL: '1', SCHEDULER_ENABLED: 'true' })).toBe(true);
    expect(isSchedulerEnabled({ SCHEDULER_ENABLED: 'false' })).toBe(false);
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    [' 1 ', true],
    ['yes', true],
    ['on', true],
    ['false', false],
    ['0', false],
    ['no', false],
    ['OFF', false],
  ])('reads %s as %s', (raw, expected) => {
    expect(isSchedulerEnabled({ SCHEDULER_ENABLED: raw as string })).toBe(expected);
  });

  it('throws on a value it does not recognise instead of guessing', () => {
    /*
      Neither default is safe on a typo. Guessing `true` gives a second
      scheduler nobody asked for; guessing `false` stops billing. Both are
      invisible, so the boot fails and names the variable.
    */
    expect(() => isSchedulerEnabled({ SCHEDULER_ENABLED: 'ture' })).toThrow(
      /SCHEDULER_ENABLED/,
    );
  });
});

describe('validateEnv — SCHEDULER_ENABLED', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
    DIRECT_URL: 'postgresql://u:p@localhost:5432/db',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40),
    JWT_SECRET: 'y'.repeat(40),
  };

  it('accepts the variable being absent', () => {
    expect(validateEnv({ ...base }).SCHEDULER_ENABLED).toBeUndefined();
  });

  it('rejects a misspelt value at boot, alongside every other problem', () => {
    expect(() => validateEnv({ ...base, SCHEDULER_ENABLED: 'ture' })).toThrow(
      /SCHEDULER_ENABLED/,
    );
  });
});

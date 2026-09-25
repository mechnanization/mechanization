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

describe('validateEnv — METRICS_TOKEN', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
    DIRECT_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_SECRET: 'y'.repeat(40),
  };

  it('accepts the variable being absent — that is metrics switched off', () => {
    expect(validateEnv({ ...base }).METRICS_TOKEN).toBeUndefined();
  });

  it('rejects a token short enough to have been typed rather than generated', () => {
    expect(() => validateEnv({ ...base, METRICS_TOKEN: 'prometheus' })).toThrow(/METRICS_TOKEN/);
  });

  it('accepts a generated one', () => {
    const token = 'a1'.repeat(32);
    expect(validateEnv({ ...base, METRICS_TOKEN: token }).METRICS_TOKEN).toBe(token);
  });
});

/**
 * The S3 configuration.
 *
 * Two different claims are under test here and they are worth keeping apart.
 * The production requirements are about *absence*: a deploy that reaches
 * production without a documents bucket cannot serve a citizen's identity
 * documents at all, and the only place left to catch that is boot. The
 * credential-pair rule is about *silence*: with one half of the pair the AWS
 * SDK does not fail, it signs as whatever identity the default provider chain
 * hands it — so that one is asserted in development too, where the early
 * return would otherwise have skipped it.
 *
 * The case pinned hardest is the one that must keep working: a laptop and CI
 * with no AWS configuration at all still boot.
 */
describe('validateEnv — S3', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
    DIRECT_URL: 'postgresql://u:p@localhost:5432/db',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40),
    JWT_SECRET: 'y'.repeat(40),
  };

  const s3 = {
    AWS_REGION: 'eu-west-3',
    S3_DOCUMENTS_BUCKET: 'municipality-documents',
    S3_CADASTRE_BUCKET: 'municipality-cadastre',
  };

  const credentials = {
    AWS_ACCESS_KEY_ID: 'A'.repeat(20),
    AWS_SECRET_ACCESS_KEY: 'z'.repeat(40),
  };

  describe('in development', () => {
    it('boots with no AWS configuration at all', () => {
      // The whole reason these are optional at the base level. A developer
      // machine and the test suite never call S3; making them carry
      // credentials to start the process is how a guard gets worked around.
      const env = validateEnv({ ...base });

      expect(env.AWS_REGION).toBeUndefined();
      expect(env.S3_DOCUMENTS_BUCKET).toBeUndefined();
      expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    });

    it('accepts a complete configuration', () => {
      const env = validateEnv({ ...base, ...s3, ...credentials });

      expect(env.AWS_REGION).toBe('eu-west-3');
      expect(env.S3_DOCUMENTS_BUCKET).toBe('municipality-documents');
      expect(env.S3_CADASTRE_BUCKET).toBe('municipality-cadastre');
    });

    it('does not require the buckets outside production', () => {
      expect(() => validateEnv({ ...base, AWS_REGION: 'eu-west-3' })).not.toThrow();
    });

    it('still rejects a half-set credential pair — the early return is below this check', () => {
      expect(() => validateEnv({ ...base, AWS_ACCESS_KEY_ID: 'A'.repeat(20) })).toThrow(
        /AWS_SECRET_ACCESS_KEY/,
      );
      expect(() => validateEnv({ ...base, AWS_SECRET_ACCESS_KEY: 'z'.repeat(40) })).toThrow(
        /AWS_ACCESS_KEY_ID/,
      );
    });

    it('rejects a truncated access key id before it becomes an AccessDenied', () => {
      // An access key id is 20 characters; four is half a paste, and the SDK
      // would report it as a permissions problem rather than a typo.
      expect(() => validateEnv({ ...base, ...credentials, AWS_ACCESS_KEY_ID: 'AKIA' })).toThrow(
        /AWS_ACCESS_KEY_ID/,
      );
    });
  });

  describe('in production', () => {
    const productionBase = { ...base, NODE_ENV: 'production' };

    it('names all three missing variables in one failure, not one per deploy', () => {
      let message = '';
      try {
        validateEnv({ ...productionBase });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toMatch(/AWS_REGION/);
      expect(message).toMatch(/S3_DOCUMENTS_BUCKET/);
      expect(message).toMatch(/S3_CADASTRE_BUCKET/);
    });

    it.each(['AWS_REGION', 'S3_DOCUMENTS_BUCKET', 'S3_CADASTRE_BUCKET'])(
      'refuses to boot when %s alone is missing',
      (missing) => {
        const partial: Record<string, unknown> = { ...productionBase, ...s3 };
        delete partial[missing];

        expect(() => validateEnv(partial)).toThrow(new RegExp(missing));
      },
    );

    it('says what breaks rather than that a variable is unset', () => {
      // The message is the only thing the person reading a failed deploy has.
      expect(() => validateEnv({ ...productionBase, AWS_REGION: 'eu-west-3' })).toThrow(
        /identity documents/,
      );
    });

    it('passes once region and both buckets are set', () => {
      expect(() => validateEnv({ ...productionBase, ...s3 })).not.toThrow();
    });

    it('does not demand the credential pair — an instance role supplies neither variable', () => {
      const env = validateEnv({ ...productionBase, ...s3 });

      expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    });

    it('rejects a half-set credential pair here too', () => {
      expect(() =>
        validateEnv({ ...productionBase, ...s3, AWS_ACCESS_KEY_ID: 'A'.repeat(20) }),
      ).toThrow(/AWS_SECRET_ACCESS_KEY/);
    });
  });
});

import { z } from 'zod';

/**
 * Accepted spellings for `SCHEDULER_ENABLED`. Anything outside this set is a
 * typo, and a typo here must not be *interpreted* — see `isSchedulerEnabled`.
 */
const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

/**
 * Does this process own the in-process `@Cron` schedule?
 *
 * Read directly from the environment rather than through `ConfigService`
 * because `AppModule`'s `imports` array is evaluated when the module file is
 * loaded — before Nest has built an injector, and therefore before any
 * provider exists to ask.
 *
 * **Unset means "decide the way this repository always has":** run the
 * schedule unless `VERCEL` is set. That default is deliberate — shipping the
 * flag must not be the reason a municipality's billing quietly stops. Set it
 * explicitly the moment more than one long-lived backend process exists,
 * because two processes with in-process timers are two schedulers, and the
 * second one is not idempotent for free (OTP pruning is; billing is only
 * idempotent *per period*, not against a concurrent run of itself).
 *
 * An unrecognised value throws rather than defaulting either way. Defaulting
 * to `true` on a typo gives you a second scheduler you did not intend;
 * defaulting to `false` silently stops billing. Neither is a failure anyone
 * would notice, so the boot fails instead.
 */
export function isSchedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SCHEDULER_ENABLED;

  if (raw === undefined || raw.trim() === '') return !env.VERCEL;

  const value = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(value)) return true;
  if (FALSE_WORDS.has(value)) return false;

  throw new Error(
    `Invalid environment configuration:\n  SCHEDULER_ENABLED: expected one of ${[
      ...TRUE_WORDS,
      ...FALSE_WORDS,
    ].join(', ')} (got '${raw}')`,
  );
}

/**
 * Boot fails on a missing or malformed secret rather than surfacing it as a 500
 * on the first request that needs it — a JWT secret that is silently `undefined`
 * produces tokens anyone can forge.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),

    /** Pooled connection (pgbouncer) for application queries. */
    DATABASE_URL: z.string().url(),
    /** Session-mode connection — migrations and DDL only. */
    DIRECT_URL: z.string().url(),

    /**
     * Nothing in a running backend reads these any more.
     *
     * Storage moved to S3 and staff authentication moved to `users.passwordHash`
     * with bcrypt, so the three adapters that call `getOrThrow` on them are no
     * longer bound in `InfrastructureModule` and are never constructed. They are
     * optional rather than deleted because `pnpm seed` still uses them when
     * present (it guards on them itself), and because the files are due to be
     * removed outright once the cutover has been watched in production.
     *
     * Required until now, which meant a boot could fail for want of a credential
     * to a service the process no longer talks to. That is the shape of guard
     * §8.7 is about, so it goes rather than lingering as reassurance.
     */
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
    SUPABASE_STORAGE_BUCKET: z.string().min(1).optional(),

    /**
     * S3. Citizen identity documents live here now, and the cadastre geojson
     * with them — two buckets with deliberately opposite access postures:
     * documents has "Block all public access" on and is read through presigned
     * URLs only, cadastre is public-read because a parcel outline is a map, not
     * a person. Nowhere else may name a bucket or a region in a literal —
     * every caller reads them from here through `ConfigService` — because a
     * hardcoded name that drifts from the configuration is how a scanned ID
     * card ends up in the world-readable bucket instead of the private one.
     *
     * Optional at this level so a developer machine and the test suite still
     * boot without AWS credentials — neither touches S3, and demanding keys
     * from a laptop that will never call the API is the kind of guard people
     * learn to route around. Production is a different claim, and it is made
     * below: region and both buckets are required there, and unlike the SMS
     * rule that used to sit at the bottom of this file, these *can* fail for
     * the right reason — the S3 path works, and it is about to be the only one.
     */
    AWS_REGION: z.string().min(1).optional(),
    /**
     * `min(16)` is a shape check, not a strength one: an AWS access key id is
     * 20 characters, so anything shorter is a truncated paste rather than a
     * credential — and a truncated paste is much better caught at boot than as
     * an AccessDenied on the first document an officer tries to open.
     */
    AWS_ACCESS_KEY_ID: z.string().min(16).optional(),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /**
     * Only present with *temporary* credentials — SSO, an assumed role, an STS
     * export — which always arrive as a triple. The server signs with a
     * long-lived IAM user today, so this is unset there and that is correct.
     *
     * Declared rather than ignored because the adapters pass it through when it
     * is set: carrying two thirds of a temporary credential produces requests
     * without `x-amz-security-token`, which S3 rejects as InvalidAccessKeyId —
     * an error naming the access key, which is the one part that was right.
     */
    AWS_SESSION_TOKEN: z.string().min(1).optional(),
    /** Private bucket: identity documents. Presigned reads only, never a public URL. */
    S3_DOCUMENTS_BUCKET: z.string().min(1).optional(),
    /** Public-read bucket: cadastre geojson. Nothing that identifies a person goes here. */
    S3_CADASTRE_BUCKET: z.string().min(1).optional(),

    /**
     * Transactional mail — one message exists, the staff password reset.
     *
     * All optional, and unset is a supported state: the municipality has no
     * domain yet, and every provider wants one verified before it will deliver.
     * Until these are set, `sendStaffPasswordResetEmail` **refuses** rather than
     * falling back — an administrator sets the password directly instead. The
     * fallback that used to sit there went through Supabase Auth, whose token
     * check accepts any access token the project ever issued, and that was only
     * safe while local password writes were mirrored into it. They are not any
     * more, so the fallback would have been a standing way to rewrite a staff
     * password with a credential the app can no longer revoke.
     *
     * No production requirement, which is the §8.7 rule rather than a quote of
     * it: refusing the boot would take the whole register offline over a
     * feature that has a working manual substitute.
     */
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().positive().max(65535).optional(),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    /** RFC 5322 from-address, e.g. `بلدية البازورية <noreply@example.lb>`. */
    MAIL_FROM: z.string().min(1).optional(),
    /**
     * How long a password-reset link works. Short on purpose: it is a
     * bearer credential sitting in a mailbox, and the only thing standing
     * between it and a staff account is that it expires.
     */
    PASSWORD_RESET_TTL: z.string().default('30m'),

    /**
     * One secret for both citizen and staff tokens — v2 unified the two auth
     * systems precisely so there is one verification path to get right.
     */
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    /**
     * Shortened from 12h once `tokenVersion` made a session revocable.
     *
     * The two settings trade against each other: while nothing could revoke a
     * token, its lifetime *was* the security boundary, and 12h was already
     * generous for a credential that opens every citizen record in the
     * municipality. Now that a dismissal or a demotion takes effect within
     * seconds, expiry is about limiting a stolen token rather than about
     * revocation — and 8h is a municipal working day, so a clerk still signs in
     * once each morning.
     */
    JWT_STAFF_TTL: z.string().default('8h'),
    /**
     * How long one staff **token** is accepted before it must be exchanged.
     *
     * Not the same thing as `JWT_STAFF_TTL`, which is now the *session's* cap —
     * the wall-clock moment a clerk signs in again, unchanged at 8h. This is
     * the sliding window in between: the portal swaps the token for a fresh one
     * whenever a request meets an expired one, so the officer never sees the
     * hard 401 mid-form that the single-token design produced at hour eight.
     *
     * The exchange accepts an expired token up to the session cap, so shortening
     * this does **not** shorten how long a stolen token is useful — the cap
     * does, and it has not moved. This is a UX bound, not a security one, and
     * reading it as the latter is the mistake to avoid. Real theft-window
     * reduction needs a separately stored refresh credential.
     */
    JWT_STAFF_IDLE_TTL: z.string().default('30m'),
    /**
     * Issued instead of JWT_STAFF_TTL when a staff member checks
     * "تذكّرني على هذا الجهاز".
     *
     * Still long, and now defensible: a 30-day token that could not be revoked
     * meant a dismissed staff member kept access for a month. It is revocable
     * now, so the remaining exposure is a device left signed in — which is what
     * the `sessionStorage` default and this being an explicit opt-in address.
     */
    JWT_STAFF_REMEMBER_TTL: z.string().default('30d'),
    JWT_CITIZEN_TTL: z.string().default('7d'),

    SMS_PROVIDER_API_KEY: z.string().optional(),
    /** Second delivery route. See the OTP fallback requirement below. */
    SMS_PROVIDER_FALLBACK_API_KEY: z.string().optional(),

    /**
     * Citizen one-time-password verification.
     *
     * Off means a phone number alone signs someone in. That is a development
     * convenience while no SMS provider is wired up — it is refused in
     * production below, because the records behind this login include national
     * ID numbers, home addresses and refugee status.
     *
     * Anything unrecognised parses as *enabled*: a typo in an environment
     * variable must not silently unlock the citizen portal.
     */
    OTP_ENABLED: z
      .string()
      .default('true')
      .transform((value) => !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase())),

    /**
     * Optional: the dashboard cache runs in read-through mode when unset (every
     * read falls straight to Postgres), so a dev environment without Redis
     * still works — it just does not get the cached fast path.
     */
    REDIS_URL: z.string().url().optional(),
    DASHBOARD_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
    /**
     * Tenant registry rows change only at onboarding time, but resolving one is
     * on the hot path of every tenant-scoped request (TenantMiddleware runs it
     * first) — so this is cached far longer than the dashboard data.
     */
    TENANT_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    /**
     * Short on purpose: the audit trail is appended to on nearly every action in
     * the system (every login included), so this exists to absorb repeated reads
     * of the same page within a few seconds — not to survive writes without
     * looking stale, which a historical log tolerates fine.
     */
    AUDIT_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(20),
    /**
     * «مراجعة الجودة» — the eight data-quality scans, the per-officer roll-up
     * built on them, and the review queue.
     *
     * Far longer than the audit trail's because the cost is the other way
     * round: one open of that screen reads every active citizen and compares
     * them pairwise inside each name block, then reads every building to
     * measure distances between them. The staleness this buys back is bounded
     * by invalidation, not by the clock — `DataQualityService` and
     * `RecordReviewService` clear it on every write that can change an answer
     * (a decision, a correcting edit, a new filing, a dismissal), so this is
     * the backstop for a write some *other* process made.
     *
     * `nonnegative` rather than `positive`: zero is the documented way to turn
     * caching off for a municipality that would rather pay the scan every time,
     * and both services branch on it because `EX 0` is an error in Redis.
     */
    QUALITY_CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(180),

    /**
     * Shared secret for the Vercel Cron endpoints. Optional so a local or
     * Docker deployment — where `ScheduleModule` still runs the jobs in
     * process — does not need it; `InternalCronController` refuses to run
     * anything when it is unset, so leaving it out closes the route rather
     * than opening it.
     */
    CRON_SECRET: z.string().min(16).optional(),

    /**
     * Whether this process runs the `@Cron` schedule in memory.
     *
     * Until this existed the answer was inferred from `process.env.VERCEL`,
     * which made "who owns the schedule" a side effect of which platform
     * happened to inject a variable — invisible on any host that does not, and
     * unanswerable from the repository. It is now stated.
     *
     * Leaving it unset keeps the old behaviour exactly (`!VERCEL`), so nothing
     * stops running the day this ships. `isSchedulerEnabled` above is the one
     * place that reads it; the entry here exists so a misspelt value fails the
     * boot with every other environment problem rather than on its own.
     */
    SCHEDULER_ENABLED: z
      .string()
      .optional()
      .refine(
        (value) =>
          value === undefined ||
          value.trim() === '' ||
          TRUE_WORDS.has(value.trim().toLowerCase()) ||
          FALSE_WORDS.has(value.trim().toLowerCase()),
        {
          message: `must be one of ${[...TRUE_WORDS, ...FALSE_WORDS].join(', ')}`,
        },
      ),

    /**
     * Pinned to `UTC` in every deployment artefact, and asserted here.
     *
     * Billing period keys are built with `getUTCFullYear` / `getUTCMonth`
     * (`periodKeyFor`), while `@Cron` fires on the process's clock. Those two
     * agree only when the process is in UTC — on Asia/Beirut the 02:00 run on
     * the 1st of a month is still 23:00 on the last day of the previous month
     * in UTC, so it computes the *previous* period's key. The jobs also name
     * `timeZone: 'UTC'` on the decorator, which makes the *schedule* correct
     * whatever `TZ` says — but every other date the process builds still moves
     * with `TZ`, so it is pinned as well.
     *
     * Not enforced here on purpose: refusing to boot on a non-UTC `TZ` would
     * take a running deployment down over a variable this repository cannot
     * see being set. `main.ts` logs a warning instead, which is visible without
     * being an outage.
     */
    TZ: z.string().optional(),

    /**
     * Absolute URLs this service hands to third parties (the Whish callback and
     * the browser return URL). Localhost defaults are fine on a developer's
     * machine and useless in a deployment, where the API and the portal are on
     * separate origins.
     */
    PUBLIC_API_URL: z.string().url().optional(),
    PUBLIC_PORTAL_URL: z.string().url().optional(),

    CORS_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),

    /**
     * Error reporting. Declared here so the variable is documented and
     * typo-checked with the rest, though `config/sentry.ts` reads
     * `process.env` directly — the SDK has to start before `ConfigService`
     * exists, or it misses every boot failure.
     *
     * **Optional in production, deliberately.** Not demanding it here is the
     * §8.7 lesson applied rather than quoted: that incident was an env guard
     * that could only ever produce a boot failure, never a working path, and
     * `SENTRY_DSN` is the same shape of temptation. A municipality's API
     * refusing to start because an observability vendor's DSN is absent would
     * make the register less available in exchange for nothing — the API runs
     * fine without it, it just runs unobserved. What catches an unset DSN is
     * the boot log line in `main.ts`, which says which of the two states it is
     * in on every start.
     *
     * Not `.url()`: a DSN is URL-shaped but it is the SDK's to parse, and a
     * schema that rejects a valid DSN format we did not anticipate would fail
     * the boot for the exact reason above.
     */
    SENTRY_DSN: z.string().min(1).optional(),
    /**
     * Overrides the `NODE_ENV`-derived environment tag. Worth setting on
     * Vercel, where preview and production deployments both run with
     * `NODE_ENV=production` and would otherwise be one indistinguishable
     * stream — the §8.5 failure mode, in the issue tracker instead of the
     * database.
     */
    SENTRY_ENVIRONMENT: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    /**
     * Deliberately above the production early-return: a half-set credential
     * pair is wrong in every environment.
     *
     * With only one of the two, the AWS SDK does not fail. It falls through to
     * the default credential provider chain — an instance role, a shared
     * profile, whatever the host happens to carry — and signs as some other
     * identity entirely. The typo then arrives as an AccessDenied against an
     * account nobody meant to use, or, if that identity does have access, as a
     * write into a bucket nobody meant to touch. Neither reads as "a variable
     * is missing", which is what it actually is, and boot is the one cheap
     * moment to say so.
     *
     * Both unset is fine and stays fine: that is the developer machine, and it
     * is the case the checks below let through.
     */
    const hasAccessKeyId = env.AWS_ACCESS_KEY_ID !== undefined;
    const hasSecretAccessKey = env.AWS_SECRET_ACCESS_KEY !== undefined;

    if (hasAccessKeyId !== hasSecretAccessKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasAccessKeyId ? 'AWS_SECRET_ACCESS_KEY' : 'AWS_ACCESS_KEY_ID'],
        message:
          'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together — with only one of them the SDK falls back to the default credential chain and signs as a different identity instead of failing',
      });
    }

    /**
     * The two buckets are two buckets for one reason: the documents bucket has
     * "block all public access" on, and the cadastre bucket is world-readable.
     * That split is enforced nowhere in the code — it is two strings in a file.
     *
     * Naming the same bucket twice is a copy-paste away and breaks nothing
     * visible: both adapters construct, every upload succeeds, presigning a
     * public object still returns a working URL, and no test or log notices.
     * What changes is that scans of national ID cards start landing in a bucket
     * anyone with the key can read. Checked in every environment, because a
     * developer pointed at the wrong pair is the same mistake.
     */
    if (
      env.S3_DOCUMENTS_BUCKET &&
      env.S3_CADASTRE_BUCKET &&
      env.S3_DOCUMENTS_BUCKET === env.S3_CADASTRE_BUCKET
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_DOCUMENTS_BUCKET'],
        message:
          'S3_DOCUMENTS_BUCKET and S3_CADASTRE_BUCKET must name different buckets — the cadastre bucket is public-read, so pointing both at it publishes every citizen identity document',
      });
    }

    /**
     * `SMTP_HOST` without `MAIL_FROM` (or the reverse) reads as "configured" to
     * anyone looking at the file and as "not configured" to `SmtpEmailSender`,
     * so password reset keeps refusing and the operator who just set one of
     * them has no way to see why. Refused the way the AWS credential pair
     * above is, and for the same reason.
     */
    if (Boolean(env.SMTP_HOST) !== Boolean(env.MAIL_FROM)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [env.SMTP_HOST ? 'MAIL_FROM' : 'SMTP_HOST'],
        message:
          'SMTP_HOST and MAIL_FROM must be set together — with only one of them the mail sender stays disabled and password resets silently keep going through Supabase',
      });
    }

    if (env.NODE_ENV !== 'production') return;

    /**
     * The one guardrail on the flag above. Citizen records hold identity
     * document numbers, home coordinates and residency status; without OTP the
     * only thing standing between those and anyone at all is knowing a phone
     * number, which is not a secret. A deploy that reaches production with this
     * off is a mistake, and boot is the last place it can still be caught.
     */
    if (!env.OTP_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OTP_ENABLED'],
        message:
          'OTP cannot be disabled in production — a phone number alone would open a citizen record',
      });
    }

    /**
     * S3 in production. Three separate issues rather than one combined
     * message, each with its own `path`, for the reason `validateEnv` exists at
     * all: a deploy that learns about one missing variable per restart spends
     * three deploys finding out what it needed.
     *
     * The credentials themselves are not demanded here — an EC2 instance role
     * supplies them without either variable being set, and refusing to boot in
     * that case would be a guard enforcing a spelling rather than an outcome.
     * What is demanded is the configuration that has no fallback: the SDK
     * cannot invent a region, and it certainly cannot invent a bucket name.
     */
    if (!env.AWS_REGION) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AWS_REGION'],
        message:
          'AWS_REGION is required in production — the S3 client has no region to sign against, so every document read and every cadastre fetch fails at the first request',
      });
    }

    if (!env.S3_DOCUMENTS_BUCKET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_DOCUMENTS_BUCKET'],
        message:
          "S3_DOCUMENTS_BUCKET is required in production — without it the backend cannot store or retrieve a citizen's identity documents at all",
      });
    }

    if (!env.S3_CADASTRE_BUCKET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_CADASTRE_BUCKET'],
        message:
          'S3_CADASTRE_BUCKET is required in production — the parcel layer has nowhere to load its geojson from, so every map renders without a single boundary',
      });
    }

    /**
     * SMS_PROVIDER_API_KEY and SMS_PROVIDER_FALLBACK_API_KEY used to be demanded
     * here. They are not any more, and the reason is worth writing down so the
     * check is restored for the right reason rather than reflexively.
     *
     * The original rule — two routes required, because Lebanese SMS delivery
     * fails often enough that one provider makes the login page a coin flip —
     * is still the right rule. What it was not is *true*. No provider has been
     * chosen (docs/open-decisions.md #2), and `SmsProviderService.deliver()`
     * throws unconditionally: with both keys set, an OTP is no more deliverable
     * than with neither. The check demanded credentials for a route that cannot
     * carry a message, so all it actually enforced was that production refused
     * to boot — which is not the property anyone wanted from it.
     *
     * What that leaves, deliberately, is a system that fails closed: OTP is
     * still mandatory in production (above), so a citizen sign-in attempt errors
     * instead of succeeding without verification. Citizen login does not work in
     * production until a provider exists. Staff login is unaffected — it is
     * password + TOTP and never touches this path.
     *
     * Restore both checks in the same change that implements `deliver()`. At
     * that point the keys mean something, and a deploy without them is once
     * again a mistake worth refusing to start over.
     */
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parses the environment or throws with every problem listed at once —
 * a boot that fails on one missing variable at a time wastes a deploy each.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}

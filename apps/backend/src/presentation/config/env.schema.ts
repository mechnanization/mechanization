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

    SUPABASE_URL: z.string().url(),
    /** Server-side only. Never sent to a browser; storage access, not auth. */
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
    SUPABASE_STORAGE_BUCKET: z.string().min(1).default('documents'),

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
  })
  .superRefine((env, ctx) => {
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

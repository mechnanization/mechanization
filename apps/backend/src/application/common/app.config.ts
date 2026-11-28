/** Values that are policy rather than environment — kept out of .env so they are
 *  reviewed in code rather than drifting per-deployment.
 *
 *  In `application/common` so a service may read it without importing presentation
 *  (ARCH-07). Infrastructure may not import it: `runInTenantTransaction`'s own
 *  default stays in `infrastructure/context/tenant-transaction.ts`. */
export const APP_CONFIG = {
  /** Path prefix every tenant-scoped route sits under. */
  apiPrefix: 'api/v1',

  /**
   * The Prometheus scrape path — the one route *outside* `apiPrefix`
   * (`bootstrap.ts` excludes it).
   *
   * Outside, because `/metrics` is the path Prometheus requests by default, and
   * the path an nginx deny rule on the Lightsail box would name. Under the
   * prefix it would be `/api/v1/metrics`, which such a rule would not match
   * while reading as though it did. The control is `METRICS_TOKEN`, not nginx;
   * see `MetricsController`.
   */
  metricsPath: 'metrics',

  /**
   * Absolute URLs this service hands to a third party.
   *
   * Whish is told where to send its confirmation and where to return the
   * citizen's browser. Both are built from configuration and never from the
   * request: a caller-supplied return URL is an open redirect, and a
   * caller-supplied callback URL would let anyone aim the provider's
   * "payment succeeded" message at a server they control.
   */
  publicApiUrl:
    process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}/api/v1`,
  publicPortalUrl: process.env.PUBLIC_PORTAL_URL ?? 'http://localhost:3000',
  tenantRoutePattern: 'api/v1/t/:tenantSlug/*',

  otp: {
    codeLength: 6,
    ttlSeconds: 300,
    /** Wrong guesses before the challenge is burned. */
    maxAttempts: 5,
    /** A citizen may not request a new code faster than this. */
    resendCooldownSeconds: 30,
    /** Codes per phone per hour, counted in Postgres since there is no Redis. */
    maxPerHour: 6,
    /** Attempt number at which delivery switches to the fallback route. */
    fallbackAfterAttempt: 2,
  },

  /**
   * A staff account's second factor (migration 0101).
   *
   * Counted per account, in Postgres, because the sign-in throttle is per
   * address and per process: it does not follow someone who holds the
   * password and tries codes from several addresses. A code is checked only
   * after the password matched, so only that person can lock the account.
   */
  totp: {
    /** Wrong codes in a row before the account stops checking codes. */
    maxFailures: 5,
    /** How long it stops. */
    lockSeconds: 15 * 60,
  },

  throttle: {
    /**
     * Every route without its own `@Throttle` (`ThrottlerModule.forRoot` in `AppModule`).
     * Per process: under pm2 with N instances a client gets N times this.
     */
    default: { ttlSeconds: 60, limit: 120 },
    /** Staff login — credential stuffing is the threat here. */
    staffLogin: { ttlSeconds: 60, limit: 5 },
    /**
     * Staff refresh and sign-out — load control, not a guessing defence.
     *
     * A refresh token is 256 random bits, so no rate is slow enough to matter
     * to someone guessing and none needs to be. What this bounds is a tab
     * stuck in a loop, or a flood aimed at the database work a refresh costs.
     * Counted per `Authorization` header rather than per IP (see
     * `AuthController`): behind nginx every clerk shares one IP, and a per-IP
     * bucket would let one noisy client spend the whole municipality's
     * refreshes. Thirty a minute is far above what one tab needs — one refresh
     * per idle window, plus the retries a bad connection costs.
     */
    staffSession: { ttlSeconds: 60, limit: 30 },
    /**
     * A staff member's own-account writes that check the current password —
     * «تغيير كلمة المرور», the email, turning off 2FA. What it bounds is a
     * stolen session guessing the password to take the account over: without
     * it the default (120 a minute) applied. Five a minute is room to mistype
     * it twice.
     */
    ownAccount: { ttlSeconds: 60, limit: 5 },
    /**
     * Citizen sign-in by رقم مرجعي alone.
     *
     * Tighter than every other bar because the reference *is* the whole
     * credential on that route. Five a minute is room to mistype your own
     * number twice; it is not room to work through a list.
     */
    referenceOnlyLogin: { ttlSeconds: 60, limit: 5 },
    /** OTP request — SMS costs money and texts are a nuisance vector. */
    otpRequest: { ttlSeconds: 60, limit: 3 },
    /**
     * OTP verify — the code check itself, so the route worth guessing at. The
     * challenge burns after `otp.maxAttempts` wrong codes; this bounds how fast
     * new challenges can be worked through, as the staff sign-in's bar does.
     */
    otpVerify: { ttlSeconds: 60, limit: 5 },
    /** Submission — generous; a citizen retrying a flaky upload is not an attack. */
    submission: { ttlSeconds: 60, limit: 10 },
    /**
     * Old debts' export and import (docs/old-debts-plan.md §4): a template's
     * export picks citizens under a municipality-wide lock, and an import reads
     * and checks up to `ARREARS_IMPORT_MAX_ROWS` lines. Load control per session,
     * counted per `Authorization` header as the staff session's bar is: twenty a
     * minute is far more than an accountant correcting a file and previewing it
     * again needs, and bounds a stuck loop.
     */
    arrearsBulk: { ttlSeconds: 60, limit: 20 },
  },

  /**
   * Old debts (docs/old-debts-plan.md). `approverMustDifferFromPreparer`: whoever prepared a batch
   * does not approve it (maker ≠ checker). **Off:** open-decisions §23.3 has not decided it, and with
   * one manager it would make an accountant prepare every batch. The one place it is turned on.
   */
  arrears: { approverMustDifferFromPreparer: false },

  /** The JSON body parser's cap (`createApiApp`). Uploads are multipart and capped per route. */
  http: { bodyLimit: '1mb' },

  /** How long a cached answer is served before it is read again. */
  cache: {
    /**
     * `FeesService.getSettings`. Contact details and office hours change a few times a year, and a
     * write drops the entry outright, so this only bounds how long a change made *outside* the
     * service could go unseen.
     */
    feeSettingsTtlSeconds: 300,
    /** `FeesService.summary`, the fees page's headline figures. */
    feeSummaryTtlSeconds: 30,
    /**
     * `SessionRevocationService`: how long a revoked session can still pass the guard
     * in another process. Its own process forgets at once.
     */
    tokenVersionTtlSeconds: 30,
  },

  /**
   * Prisma's interactive-transaction bounds (`maxWait` to start, `timeout` to finish) where a
   * write needs other than `runInTenantTransaction`'s default (15 s / 60 s, in
   * `tenant-transaction.ts`). Prisma's own default, 2 s / 5 s, is too short for a town-wide write.
   */
  transactions: {
    /** `BuildingsService.atomic`: a tenancy, a vacancy and their cards. */
    buildingWrite: { maxWait: 15_000, timeout: 30_000 },
    /** `BackupService.restore`: every table of a snapshot, rewritten in one transaction. */
    backupRestore: { maxWait: 15_000, timeout: 120_000 },
  },

  /**
   * How long a write waits for a row another write holds before it is refused
   * (`setLocalLockTimeout`: the corrections, «قائمة الإعفاء», the co-owner billing mode).
   */
  locks: { rowLockTimeout: '5s' },

  /**
   * Page sizes, one pair per register (audit PAG-07): `default` when a request names none, `max` the
   * most one request may ask for. The controller reads a page through `queryLimit(limit, page.default,
   * page.max)` and the service clamps to the same pair, so the two cannot disagree: «مراجعة السجلات»
   * admitted 200 at the door and served 100. A register whose query a shared zod schema bounds keeps
   * its pair beside that schema instead, where the frontend reads it too: `BUILDINGS_PAGE_*` and
   * `WORKLIST_PAGE_*` (`building.schema.ts`), `TRANSFERS_PAGE_*` (`transfer.schema.ts`),
   * `CASES_PAGE_*`, `FEE_NOTICES_PAGE_*`, `ARREARS_*_PAGE_*`, and `MAX_LIST_PAGE`.
   */
  pagination: {
    /** «سجل المواطنين», `GET citizens`. */
    citizens: { default: 200, max: 500 },
    /** «سجل التعديلات» of a citizen file or a building (`AuditService.history`). */
    history: { default: 30, max: 100 },
    /** The audit log and its daily report, `GET audit` and `GET audit/daily`. */
    audit: { default: 50, max: 200 },
    /** «روابط المالكين», the owner-link queue (`LandlordLinkQueueService.proposals`). */
    ownerLinks: { default: 20, max: 100 },
    /** «فواتير تأثّرت بتصحيحات», `GET fees/correction-affected`. */
    correctionBills: { default: 20, max: 100 },
    /** «مراجعة السجلات», `GET quality/reviews` (`RecordReviewService.queue`). */
    recordReviews: { default: 20, max: 100 },
    /** «فحوص الجودة», `GET quality/checks` (`RecordReviewService.listChecks`). */
    qualityChecks: { default: 200, max: 500 },
    /** What one collector collected, `GET treasury/transfers/custody/:collectorId/collections`. */
    collectorCollections: { default: 200, max: 500 },
    /**
     * Not a page: the most files one duplicate check reads (`CitizenDuplicatesService.duplicateLookup`),
     * which is the bound on a scan by name or phone, never shown as a list.
     */
    duplicateLookupRows: 1000,
  },

  documents: {
    signedUrlTtlSeconds: 300,
    maxFilesPerSubmission: 40,
  },

  cadastre: {
    maxFileSizeBytes: 15 * 1024 * 1024,
  },
} as const;

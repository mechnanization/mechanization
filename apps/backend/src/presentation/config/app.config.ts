/** Values that are policy rather than environment — kept out of .env so they are
 *  reviewed in code rather than drifting per-deployment. */
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

  throttle: {
    /** Staff login — credential stuffing is the threat here. */
    staffLogin: { ttlSeconds: 60, limit: 5 },
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
    /** Submission — generous; a citizen retrying a flaky upload is not an attack. */
    submission: { ttlSeconds: 60, limit: 10 },
  },

  documents: {
    signedUrlTtlSeconds: 300,
    maxFilesPerSubmission: 40,
  },

  cadastre: {
    maxFileSizeBytes: 15 * 1024 * 1024,
  },
} as const;

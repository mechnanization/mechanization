/**
 * Day3ati — the partner API this backend calls to manage a municipality's News.
 *
 * Two kinds of token, both short-lived (about 15 minutes) and neither with a
 * refresh token — when one expires the answer is to ask again:
 *
 * - the **client token** is the system itself (`client_credentials`). It may
 *   only call `/api/v1/integration`, which is where users are provisioned;
 * - a **staff token** is one of our users acting in one village
 *   (`token-exchange`, subject `{tenant}:{userId}`). Every News call carries one.
 *
 * Application code asks this port for a token and never sees the credentials.
 */
export const DAY3ATI_TOKENS = Symbol('DAY3ATI_TOKENS');

export interface Day3atiTokens {
  /** False when the four `DAY3ATI_*` settings are not all set: the integration is off. */
  readonly isConfigured: boolean;

  /** The system's own token. Cached; two calls in a row make one request. */
  clientToken(): Promise<string>;

  /**
   * The token one of our users acts with in Day3ati. Cached per user.
   *
   * `tenantSlug` and `userId` are validated before they are joined into the
   * partner's `{tenant}:{userId}` subject, so neither can smuggle in a `:`.
   */
  staffToken(tenantSlug: string, userId: string): Promise<string>;

  /** Drop the cached client token — the caller got a 401 with it. */
  forgetClientToken(): void;

  /** Drop one user's cached token — the caller got a 401 with it, or the user was removed. */
  forgetStaffToken(tenantSlug: string, userId: string): void;
}

/**
 * Why Day3ati would not give a token, or could not be asked.
 *
 * `code` is the partner's own stable code when it answered
 * (`oauth.invalid_client`, `oauth.invalid_grant`, `oauth.invalid_subject`, …)
 * and one of ours when it did not:
 * `day3ati.not_configured`, `day3ati.unavailable`, `day3ati.bad_response`,
 * `day3ati.invalid_subject`.
 *
 * Not a `DomainError` on purpose: nothing here is a refusal a person can fix
 * from a screen. The HTTP client that calls Day3ati on a user's behalf turns
 * the ones a screen has to explain into coded domain errors. `message` is
 * English, for logs, and never carries a secret, a token or the subject.
 */
export class Day3atiAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The HTTP status Day3ati answered with, when it did. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'Day3atiAuthError';
  }

  /** Wrong secret, or the client is disabled — retrying cannot help. */
  get isClientRejected(): boolean {
    return this.code === 'oauth.invalid_client';
  }

  /** The user is not provisioned in Day3ati, or was removed. */
  get isUserNotProvisioned(): boolean {
    return this.code === 'oauth.invalid_grant';
  }
}

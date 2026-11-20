export type OtpChannel = 'PRIMARY' | 'FALLBACK';

export interface OtpChallengeRow {
  id: string;
  phone: string;
  codeHash: string;
  channel: OtpChannel;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface OtpRepository {
  create(input: {
    phone: string;
    codeHash: string;
    channel: OtpChannel;
    expiresAt: Date;
  }): Promise<string>;

  /** Most recent unconsumed challenge for a phone, or null. */
  findActive(phone: string): Promise<OtpChallengeRow | null>;

  incrementAttempts(id: string): Promise<number>;
  consume(id: string): Promise<void>;

  /** How many challenges were issued to this phone since `since` — the resend
   *  throttle, kept in Postgres because there is no Redis to hold it. */
  countRecent(phone: string, since: Date): Promise<number>;

  deleteExpired(before: Date): Promise<number>;
}

/** Delivery adapter. Two routes so a single provider outage is not a login outage. */
export interface SmsSender {
  send(input: { phone: string; message: string; channel: OtpChannel }): Promise<void>;
  /** Whether a fallback route is configured at all — surfaced at boot, not on first failure. */
  readonly hasFallback: boolean;
  /**
   * Whether a text can reach a phone at all: a provider is wired and its key
   * set. While it is false the phone-code sign-in is refused before anything
   * is written (`CITIZEN_OTP_UNAVAILABLE`), as online payment is while the
   * Whish gateway is not live.
   */
  readonly isLive: boolean;
}

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}

export interface TotpService {
  generateSecret(): string;
  /** otpauth:// URI for the enrolment QR code. */
  keyUri(secret: string, accountName: string, issuer: string): string;
  /**
   * The TOTP step the code was generated in, or `null` when it is not valid now.
   *
   * The step of the *code*, not of the clock. Codes are accepted one step
   * either side of now, so the same six digits verify for about ninety
   * seconds; burning the clock's step let a code accepted at step S be
   * presented again at S+1, whose step was still unburned (security audit
   * N-1). Burning the code's own step refuses it for as long as it verifies.
   */
  matchStep(token: string, secret: string, now?: Date): number | null;
}

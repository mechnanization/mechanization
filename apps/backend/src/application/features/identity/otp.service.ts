import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'node:crypto';
import {
  OTP_REPOSITORY,
  PASSWORD_HASHER,
  SMS_SENDER,
} from '../../../domain/interfaces/base-repository.interface';
import {
  OtpChannel,
  OtpRepository,
  PasswordHasher,
  SmsSender,
} from '../../../domain/interfaces/otp-repository.interface';
import { PhoneNumber } from '../../../domain/value-objects/phone-number.vo';
import { ConflictError, UnauthorizedError, ValidationError } from '../../common/exceptions';
import { APP_CONFIG } from '../../common/app.config';

export interface OtpIssueResult {
  channel: OtpChannel;
  expiresAt: Date;
  resendAvailableAt: Date;
  /** Development only — lets a developer without SMS credentials finish login. */
  devCode?: string;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @Inject(OTP_REPOSITORY) private readonly challenges: OtpRepository,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    private readonly config: ConfigService,
  ) {}

  /** Through `ConfigService` like every other setting (audit SEC-12); `NODE_ENV` is required by `envSchema`. */
  private get isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  /**
   * Whether a code is actually demanded of the citizen.
   *
   * Off, everything below still exists and is still reachable — this is a
   * switch, not a removal — but `issue` writes no challenge and `verify`
   * accepts anything. `env.schema.ts` refuses to boot production in this
   * state; see the note on OTP_ENABLED there for why.
   */
  get enabled(): boolean {
    return this.config.get<boolean>('OTP_ENABLED') !== false;
  }

  /**
   * Refuses the phone-code sign-in, first and in every environment, while no
   * text can reach a phone (`SmsSender.isLive`; security audit N-2).
   *
   * Without it a request wrote a challenge and sent nothing, and wherever
   * `NODE_ENV` was not `production` the code came back in the response as
   * `devCode`: knowing a citizen's phone was enough to open their file. With
   * `OTP_ENABLED` off, `verify` accepted the phone alone. Both close here,
   * before the number is parsed or a row is read or written, as online payment
   * is refused while the Whish gateway is not live. The portal offers no
   * phone-code sign-in (open-decisions §21); a citizen signs in by رقم مرجعي.
   */
  private assertAvailable(): void {
    if (!this.sms.isLive) {
      throw new ConflictError({
        code: 'CITIZEN_OTP_UNAVAILABLE',
        message: 'Phone-code sign-in is unavailable: no SMS provider is live',
      });
    }
  }

  /**
   * Issues a code and sends it.
   *
   * `attempt` is the citizen's resend count for this session. From
   * `fallbackAfterAttempt` onward, delivery switches to the second route: if the
   * first provider is the reason the code never arrived, retrying it is not a
   * fallback, it is the same failure again.
   */
  async issue(rawPhone: string, attempt = 1): Promise<OtpIssueResult> {
    this.assertAvailable();
    const phone = PhoneNumber.parse(rawPhone);

    // The number is still parsed above, so a malformed one is still rejected
    // here rather than at the next step. Nothing else runs: no challenge row
    // to verify against, no SMS, no rate-limit budget spent on a code that
    // will never be asked for.
    if (!this.enabled) {
      this.logger.warn(
        `OTP disabled — issuing no code for ${phone.masked}. Set OTP_ENABLED=true to restore.`,
      );
      const now = Date.now();
      return {
        channel: 'PRIMARY',
        expiresAt: new Date(now + APP_CONFIG.otp.ttlSeconds * 1000),
        resendAvailableAt: new Date(now),
      };
    }

    const hourAgo = new Date(Date.now() - 3_600_000);
    const recent = await this.challenges.countRecent(phone.e164, hourAgo);
    if (recent >= APP_CONFIG.otp.maxPerHour) {
      // Protects the citizen from SMS-bombing and the municipality from the bill.
      throw new ConflictError({
        code: 'OTP_TOO_MANY_SENT',
        message: 'Too many codes sent in the last hour',
      });
    }

    const code = String(randomInt(0, 10 ** APP_CONFIG.otp.codeLength)).padStart(
      APP_CONFIG.otp.codeLength,
      '0',
    );
    const codeHash = await this.hasher.hash(code);
    const expiresAt = new Date(Date.now() + APP_CONFIG.otp.ttlSeconds * 1000);

    const channel: OtpChannel =
      attempt >= APP_CONFIG.otp.fallbackAfterAttempt && this.sms.hasFallback
        ? 'FALLBACK'
        : 'PRIMARY';

    await this.challenges.create({ phone: phone.e164, codeHash, channel, expiresAt });

    try {
      await this.sms.send({
        phone: phone.e164,
        message: `رمز الدخول: ${code}\nصالح لمدة ${APP_CONFIG.otp.ttlSeconds / 60} دقائق.`,
        channel,
      });
    } catch (error) {
      // The challenge row stays: a delivery failure must not also invalidate a
      // code that may yet arrive late. The citizen can resend, which will take
      // the other route.
      this.logger.error(
        `OTP delivery failed on ${channel} for ${phone.masked}: ${
          error instanceof Error ? error.message : error
        }`,
      );

      /**
       * Outside production, a delivery failure is the *expected* state rather
       * than an incident: no provider has been chosen yet, so
       * `SmsProviderService.deliver()` throws by design (see
       * docs/open-decisions.md #2). Rethrowing here made citizen login
       * impossible to exercise locally — every request died on this line, and
       * the `devCode` returned below, which exists precisely so a developer
       * without SMS credentials can finish signing in, was unreachable.
       *
       * The challenge row is already written, so the code returned below is a
       * real, verifiable one. Production still fails loudly: there, a code
       * nobody received is a citizen locked out, not a convenience.
       */
      if (this.isProduction) {
        throw new ConflictError({
          code: 'OTP_SEND_FAILED',
          message: 'The code could not be sent',
        });
      }

      this.logger.warn(
        `Continuing without SMS delivery (NODE_ENV=${String(this.config.get<string>('NODE_ENV'))}) — ` +
          'the code is returned in the response as devCode.',
      );
    }

    return {
      channel,
      expiresAt,
      resendAvailableAt: new Date(Date.now() + APP_CONFIG.otp.resendCooldownSeconds * 1000),
      devCode: this.isProduction ? undefined : code,
    };
  }

  /**
   * Verifies a submitted code. Returns the phone in canonical form so the caller
   * looks up citizens by exactly what was stored.
   */
  async verify(rawPhone: string, code: string): Promise<string> {
    this.assertAvailable();
    const phone = PhoneNumber.parse(rawPhone);

    // Returns the canonical number without checking anything — there is no
    // challenge to check against, because `issue` wrote none.
    if (!this.enabled) return phone.e164;

    const challenge = await this.challenges.findActive(phone.e164);

    if (!challenge) {
      throw new UnauthorizedError({
        code: 'OTP_CODE_EXPIRED',
        message: 'No live code for this phone',
      });
    }

    if (challenge.attempts >= APP_CONFIG.otp.maxAttempts) {
      await this.challenges.consume(challenge.id);
      throw new UnauthorizedError({
        code: 'OTP_TOO_MANY_ATTEMPTS',
        message: 'Too many attempts on this code',
      });
    }

    const matches = await this.hasher.verify(code.trim(), challenge.codeHash);
    if (!matches) {
      const attempts = await this.challenges.incrementAttempts(challenge.id);
      if (attempts >= APP_CONFIG.otp.maxAttempts) {
        await this.challenges.consume(challenge.id);
      }
      throw new UnauthorizedError({
        code: 'OTP_CODE_INCORRECT',
        message: 'Wrong code',
      });
    }

    // Single-use: a code that still works after login is a code worth stealing.
    await this.challenges.consume(challenge.id);
    return phone.e164;
  }

  /** Scheduled cleanup — see application/background-jobs/. */
  async pruneExpired(): Promise<number> {
    return this.challenges.deleteExpired(new Date());
  }

  assertDeliverable(): void {
    if (!this.sms.hasFallback && this.isProduction) {
      throw new ValidationError({
        code: 'SMS_FALLBACK_NOT_CONFIGURED',
        message: 'No fallback SMS route configured',
      });
    }
  }
}

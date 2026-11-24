import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtpChannel, SmsSender } from '../../domain/interfaces/otp-repository.interface';

/**
 * OTP delivery with two independent routes.
 *
 * Section 10 of the v2 spec makes this non-optional, and it is the requirement
 * most likely to be quietly dropped: SMS delivery to Lebanese networks fails or
 * stalls often enough that a single provider makes the login page a coin flip.
 * A citizen who never receives a code has no other way in — so the resend path
 * switches routes rather than retrying the one that just failed.
 *
 * The HTTP calls are left as a single `deliver()` seam because the provider is
 * not chosen yet (see docs/open-decisions.md). Everything around it — channel
 * selection, failover, logging — is real and does not change with the provider.
 */
@Injectable()
export class SmsProviderService implements SmsSender {
  /**
   * Whether `deliver()` calls a real provider. It does not: it throws for
   * every message (docs/open-decisions.md #2). Set it true in the change that
   * writes `deliver()`, and only then does a key make the route live.
   */
  private static readonly providerWired: boolean = false;

  private readonly logger = new Logger(SmsProviderService.name);
  private readonly primaryKey?: string;
  private readonly fallbackKey?: string;
  private readonly isProduction: boolean;

  constructor(private readonly config: ConfigService) {
    this.primaryKey = this.config.get<string>('SMS_PROVIDER_API_KEY');
    this.fallbackKey = this.config.get<string>('SMS_PROVIDER_FALLBACK_API_KEY');
    this.isProduction = this.config.get<string>('NODE_ENV') === 'production';

    if (this.isProduction && !this.primaryKey) {
      // `env.schema.ts` no longer refuses to boot over a missing provider — the
      // keys guaranteed nothing while `deliver()` is unimplemented — so this
      // line is now the only thing that says it out loud. Logged at error level
      // on purpose: the system is running with citizen sign-in non-functional,
      // and that should be visible in the first page of production logs rather
      // than discovered by a citizen who never receives a code.
      this.logger.error(
        'No SMS provider configured in production — every citizen OTP sign-in will fail. ' +
          'Staff login is unaffected.',
      );
    } else if (!this.hasFallback) {
      // Warn at boot, not at 2am on the first outage.
      this.logger.warn(
        'No fallback SMS route configured — a primary-provider outage will block citizen login entirely.',
      );
    }
  }

  get hasFallback(): boolean {
    return Boolean(this.fallbackKey && this.fallbackKey !== this.primaryKey);
  }

  /**
   * A provider is wired and the primary key is set. A key alone is not
   * enough: with `deliver()` unwritten it carries no message, which is how a
   * phone-code request came to write a challenge, send nothing and, wherever
   * `NODE_ENV` was not `production`, hand the code back in the response.
   */
  get isLive(): boolean {
    return SmsProviderService.providerWired && Boolean(this.primaryKey);
  }

  async send(input: { phone: string; message: string; channel: OtpChannel }): Promise<void> {
    const key = input.channel === 'FALLBACK' ? (this.fallbackKey ?? this.primaryKey) : this.primaryKey;

    if (!key) {
      if (this.isProduction) {
        throw new Error('No SMS provider configured');
      }
      // In development the code is also returned by the API response, so a
      // developer without provider credentials can still complete the flow.
      // Never the number in full nor the body, which carries the sign-in code
      // (audit SEC-05; non-negotiable 7): the same mask `deliver` logs with.
      this.logger.debug(
        `[dev] SMS to ${this.mask(input.phone)} via ${input.channel} (${input.message.length} characters, not sent)`,
      );
      return;
    }

    await this.deliver({ ...input, apiKey: key });
  }

  /**
   * The provider-specific call. Replace the body when the provider is chosen;
   * nothing above this method needs to change.
   */
  private async deliver(input: {
    phone: string;
    message: string;
    channel: OtpChannel;
    apiKey: string;
  }): Promise<void> {
    this.logger.log(`Dispatching SMS to ${this.mask(input.phone)} via ${input.channel}`);

    throw new Error(
      'SMS provider not yet wired. Choose a provider (see docs/open-decisions.md), ' +
        'implement SmsProviderService.deliver(), and set SMS_PROVIDER_API_KEY.',
    );
  }

  /** Phone numbers are personal data; logs are the easiest place to leak them. */
  private mask(phone: string): string {
    return `${phone.slice(0, 5)}•••${phone.slice(-2)}`;
  }
}

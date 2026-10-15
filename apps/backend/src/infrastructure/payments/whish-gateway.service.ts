import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  WhishCallback,
  WhishCheckout,
  WhishGateway,
} from '../../domain/interfaces/whish-gateway.interface';

/**
 * Whish Money, with the provider call left as one seam.
 *
 * Shaped after `SmsProviderService`: everything that does not depend on the
 * provider — reference generation, signature verification, sandbox behaviour,
 * masking in logs — is real and tested, and `postCheckout()` is the single
 * method to fill in when the API contract arrives.
 *
 * **Sandbox is not a fake payment.** With no credentials configured,
 * `createCheckout` does not pretend money moved: it returns to the portal with a
 * reference of our own. No caller reaches it that way today: online payment is
 * paused (open-decisions §21), and `FeesService.startWhishCheckout` refuses with
 * `ONLINE_PAYMENT_UNAVAILABLE` while `isLive` is false. Nothing in this file can
 * move an invoice to PAID without a signature that verifies — see `parseCallback`.
 */
@Injectable()
export class WhishGatewayService implements WhishGateway {
  private readonly logger = new Logger(WhishGatewayService.name);
  private readonly apiUrl?: string;
  private readonly apiKey?: string;
  private readonly webhookSecret?: string;

  constructor(private readonly config: ConfigService) {
    this.apiUrl = this.config.get<string>('WHISH_API_URL');
    this.apiKey = this.config.get<string>('WHISH_API_KEY');
    this.webhookSecret = this.config.get<string>('WHISH_WEBHOOK_SECRET');

    if (!this.isLive) {
      this.logger.warn(
        'Whish is not configured: online checkout is refused (ONLINE_PAYMENT_UNAVAILABLE, ' +
          'open-decisions §21). Write postCheckout first, then set WHISH_API_URL, ' +
          'WHISH_API_KEY and WHISH_WEBHOOK_SECRET.',
      );
    } else if (!this.webhookSecret) {
      // Credentials without a secret is the dangerous half-configuration: the
      // portal would look live while accepting unsigned "payment succeeded"
      // callbacks from anyone who found the URL.
      this.logger.error(
        'WHISH_API_KEY is set but WHISH_WEBHOOK_SECRET is not — callbacks cannot ' +
          'be verified and will all be rejected.',
      );
    }
  }

  get isLive(): boolean {
    return Boolean(this.apiUrl && this.apiKey);
  }

  async createCheckout(input: {
    paymentId: string;
    amount: number;
    currency: string;
    citizenName: string;
    callbackUrl: string;
    returnUrl: string;
  }): Promise<WhishCheckout> {
    // Ours, not the provider's, in sandbox — and still ours in live mode until
    // `postCheckout` overwrites it, so a row always has something to match on.
    const externalRef = `WSH-${randomBytes(9).toString('base64url').toUpperCase()}`;

    if (!this.isLive) {
      this.logger.log(
        `[sandbox] Whish checkout for payment ${input.paymentId} (${input.amount} ${input.currency})`,
      );
      // Straight back to the portal. The caller has already marked the invoice
      // as awaiting confirmation, so the citizen lands on a page that says so.
      return { redirectUrl: input.returnUrl, externalRef };
    }

    return this.postCheckout({ ...input, externalRef });
  }

  /**
   * The provider-specific call. Replace the body when the contract arrives;
   * nothing above or below this method needs to change.
   *
   * Expected to return the hosted-checkout URL to redirect the citizen to, and
   * whatever identifier Whish will quote back in its callback — substitute
   * theirs for `externalRef` if they issue their own.
   */
  private async postCheckout(input: {
    paymentId: string;
    amount: number;
    currency: string;
    citizenName: string;
    callbackUrl: string;
    returnUrl: string;
    externalRef: string;
  }): Promise<WhishCheckout> {
    this.logger.log(`Opening Whish checkout for payment ${input.paymentId}`);

    throw new Error(
      'Whish provider not yet wired. Implement WhishGatewayService.postCheckout() ' +
        'against the provider contract and set WHISH_API_URL / WHISH_API_KEY.',
    );
  }

  /**
   * Verifies a callback and returns its contents, or `null`.
   *
   * HMAC-SHA256 over the **raw** body — not the parsed object — because any
   * re-serialisation changes key order and whitespace and would fail against a
   * signature computed over the bytes actually sent. Compared with
   * `timingSafeEqual` so a wrong signature cannot be narrowed down byte by byte
   * from response timings.
   *
   * A sandbox deployment has no secret and therefore rejects every callback.
   * That is the intended behaviour: the only way to reach PAID through this
   * class is a signature that verifies against a configured secret.
   */
  parseCallback(input: { rawBody: string; signature?: string }): WhishCallback | null {
    if (!this.webhookSecret || !input.signature) return null;

    const expected = createHmac('sha256', this.webhookSecret)
      .update(input.rawBody, 'utf8')
      .digest();

    let provided: Buffer;
    try {
      provided = Buffer.from(input.signature, 'hex');
    } catch {
      return null;
    }
    // `timingSafeEqual` throws on a length mismatch rather than returning false.
    if (provided.length !== expected.length) return null;
    if (!timingSafeEqual(provided, expected)) return null;

    try {
      const body = JSON.parse(input.rawBody) as Record<string, unknown>;
      const externalRef = typeof body.externalRef === 'string' ? body.externalRef : null;
      const transactionRef =
        typeof body.transactionRef === 'string' ? body.transactionRef : null;
      const amount = typeof body.amount === 'number' ? body.amount : null;

      if (!externalRef || !transactionRef || amount === null) return null;

      return {
        externalRef,
        transactionRef,
        amount,
        succeeded: body.status === 'SUCCESS' || body.succeeded === true,
      };
    } catch {
      return null;
    }
  }
}

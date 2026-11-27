import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { EmailMessage, EmailSender } from '../../domain/interfaces/email-sender.interface';

/**
 * SMTP, deliberately, rather than a vendor SDK.
 *
 * The municipality has no domain yet, which is what every provider wants
 * verified before it will deliver — so which provider this ends up being is a
 * question that cannot be answered today. SES, Postmark, Resend and a
 * municipality's own mail server all speak SMTP, so the choice becomes five
 * environment variables rather than a second adapter and another dependency.
 *
 * Unconfigured is a supported state, not a failure. `IdentityService` falls
 * back to Supabase's reset mail while `SMTP_HOST` is unset, which is what makes
 * it possible to ship this before anyone has an account to put in it.
 */
@Injectable()
export class SmtpEmailSender implements EmailSender {
  private readonly logger = new Logger(SmtpEmailSender.name);
  private readonly host?: string;
  private readonly from?: string;
  private transporter?: Transporter;

  constructor(private readonly config: ConfigService) {
    this.host = config.get<string>('SMTP_HOST');
    this.from = config.get<string>('MAIL_FROM');
  }

  get isConfigured(): boolean {
    return Boolean(this.host && this.from);
  }

  async send(message: EmailMessage): Promise<void> {
    if (!this.isConfigured) {
      // A caller that reached here without checking has a bug, and a silent
      // resolve would present as "the mail was sent" to the person waiting for
      // it. Loud, and never reaching a browser: the one caller catches this.
      throw new Error('SMTP is not configured — set SMTP_HOST and MAIL_FROM');
    }

    try {
      await this.connection().sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      });
    } catch (error) {
      /*
        Neither the recipient nor the subject is logged in full. This sender's
        only message is a password reset, and a log line saying who was sent
        one is a list of accounts worth attacking (audit SEC-05). The address is
        masked, and taken out of the server's own text too, which often quotes
        it back («<x@y>: Recipient address rejected»).
      */
      const masked = maskEmail(message.to);
      const reason = String((error as Error)?.message ?? error).split(message.to).join(masked);
      this.logger.error(`SMTP delivery failed for ${masked}: ${reason}`);
      throw error;
    }
  }

  /**
   * Built on first send rather than in the constructor, and held afterwards.
   *
   * Nodemailer pools connections, so rebuilding per message would open a new
   * TCP+TLS session for every reset; building it at construction time would
   * make an unconfigured deployment fail at boot for a feature it is not using.
   */
  private connection(): Transporter {
    if (!this.transporter) {
      const port = this.config.getOrThrow<number>('SMTP_PORT');
      const user = this.config.get<string>('SMTP_USER');
      const pass = this.config.get<string>('SMTP_PASSWORD');

      this.transporter = createTransport({
        host: this.host,
        port,
        // 465 is implicit TLS; 587 and 25 start in the clear and STARTTLS up.
        // `requireTLS` is what stops the second case from silently staying in
        // the clear when a server declines to upgrade — these messages carry a
        // link that sets a password.
        secure: port === 465,
        requireTLS: port !== 465,
        ...(user && pass ? { auth: { user, pass } } : {}),
        pool: true,
        maxConnections: 2,
      });
    }

    return this.transporter;
  }
}

/**
 * `s•••@example.com`: enough to tell two failing staff accounts apart in a log,
 * not enough to list them. The domain stays, since a failing domain is the
 * usual finding. Something with no `@` keeps only its first character.
 */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return `${address.slice(0, 1)}•••`;
  return `${address.slice(0, 1)}•••${address.slice(at)}`;
}

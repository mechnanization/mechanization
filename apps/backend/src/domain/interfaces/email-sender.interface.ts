/** One transactional message. No templating, no attachments, no bulk. */
export interface EmailMessage {
  to: string;
  subject: string;
  /** Always required. An HTML-only mail is unreadable wherever HTML is stripped. */
  text: string;
  html?: string;
}

export interface EmailSender {
  /**
   * Whether a provider is actually configured.
   *
   * Callers branch on this rather than discovering the answer from a thrown
   * error, because the alternative path is a working one: password reset falls
   * back to Supabase's mail until SMTP credentials exist. A sender that cannot
   * send has to be able to say so before it is asked.
   */
  readonly isConfigured: boolean;

  /**
   * Throws when delivery fails. Deliberately not fire-and-forget: the one
   * caller is a password reset, and telling someone "check your inbox" when
   * nothing was sent leaves them waiting for a mail that will never arrive.
   */
  send(message: EmailMessage): Promise<void>;
}

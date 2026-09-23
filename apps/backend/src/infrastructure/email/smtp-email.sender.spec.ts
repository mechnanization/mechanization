import type { ConfigService } from '@nestjs/config';

/**
 * What matters here is not that nodemailer works — it is that an
 * *unconfigured* deployment behaves like one.
 *
 * `IdentityService` branches on `isConfigured` to decide whether a password
 * reset goes out through SMTP or stays on Supabase's mail. If this class ever
 * reported itself configured while it was not, resets would stop arriving and
 * the only symptom would be staff saying the email never came. The other half
 * is the transport: these messages carry a link that sets a password, so a
 * connection that silently stays in the clear is the failure worth a test.
 */

const mockSendMail = jest.fn();
const mockCreateTransport = jest.fn((_options: Record<string, unknown>) => ({
  sendMail: mockSendMail,
}));

jest.mock('nodemailer', () => ({
  createTransport: (options: Record<string, unknown>) => mockCreateTransport(options),
}));

const { SmtpEmailSender } = require('./smtp-email.sender') as typeof import('./smtp-email.sender');

const CONFIGURED = {
  SMTP_HOST: 'smtp.example.invalid',
  SMTP_PORT: '587',
  SMTP_USER: 'apikey',
  SMTP_PASSWORD: 'secret',
  MAIL_FROM: 'بلدية البازورية <noreply@example.invalid>',
};

function sender(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = { ...CONFIGURED, ...overrides };
  return new SmtpEmailSender({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
}

const MESSAGE = {
  to: 'clerk@albazourieh.gov.lb',
  subject: 'إعادة تعيين كلمة المرور',
  text: 'https://portal.example.invalid/reset?token=abc',
};

/** The options handed to nodemailer's createTransport. */
function transportOptions(): Record<string, unknown> {
  const call = mockCreateTransport.mock.calls[0];
  if (!call) throw new Error('createTransport was never called');
  return call[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateTransport.mockImplementation(() => ({ sendMail: mockSendMail }));
  mockSendMail.mockResolvedValue({ messageId: 'x' });
});

describe('SmtpEmailSender.isConfigured', () => {
  it('is true only when both the host and the from-address are present', () => {
    expect(sender().isConfigured).toBe(true);
  });

  /**
   * Each half alone is the dangerous state, which is why `env.schema.ts` also
   * refuses it: the file looks configured to whoever set one variable, and this
   * class reports `false`, so resets keep silently going through Supabase.
   */
  it.each([
    ['SMTP_HOST', { SMTP_HOST: undefined }],
    ['MAIL_FROM', { MAIL_FROM: undefined }],
  ])('is false when %s is missing', (_name, overrides) => {
    expect(sender(overrides).isConfigured).toBe(false);
  });

  it('is false when nothing at all is configured', () => {
    expect(
      sender({ SMTP_HOST: undefined, MAIL_FROM: undefined, SMTP_USER: undefined }).isConfigured,
    ).toBe(false);
  });

  it('does not build a transport merely by existing', () => {
    sender();
    // Constructing must not open anything: this provider is built at boot in
    // every environment, including the ones with no mail server to reach.
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });
});

describe('SmtpEmailSender.send', () => {
  it('refuses rather than silently resolving when unconfigured', async () => {
    const attempt = sender({ SMTP_HOST: undefined }).send(MESSAGE);

    await expect(attempt).rejects.toThrow(/SMTP_HOST/);
    // The important half: nothing was handed to a transport, so nobody is left
    // waiting for a message that was reported as sent.
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('sends the message with the configured from-address', async () => {
    await sender().send(MESSAGE);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSendMail.mock.calls[0][0]).toEqual({
      from: CONFIGURED.MAIL_FROM,
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
    });
  });

  it('omits html entirely rather than sending it as undefined', async () => {
    await sender().send(MESSAGE);

    expect('html' in (mockSendMail.mock.calls[0][0] as object)).toBe(false);
  });

  it('includes html when the caller supplies it', async () => {
    await sender().send({ ...MESSAGE, html: '<a href="#">reset</a>' });

    expect((mockSendMail.mock.calls[0][0] as { html?: string }).html).toBe('<a href="#">reset</a>');
  });

  /**
   * 587 and 25 begin unencrypted and upgrade with STARTTLS; `requireTLS` is
   * what turns "upgrade if offered" into "upgrade or fail". Without it a server
   * that declines the upgrade gets a password-reset link in plaintext, and
   * nodemailer reports success.
   */
  it('demands STARTTLS on the submission port', async () => {
    await sender({ SMTP_PORT: '587' }).send(MESSAGE);

    expect(transportOptions()).toMatchObject({ port: 587, secure: false, requireTLS: true });
  });

  it('uses implicit TLS on 465 instead of demanding an upgrade', async () => {
    await sender({ SMTP_PORT: '465' }).send(MESSAGE);

    expect(transportOptions()).toMatchObject({ port: 465, secure: true, requireTLS: false });
  });

  it('defaults to the submission port when none is configured', async () => {
    await sender({ SMTP_PORT: undefined }).send(MESSAGE);

    expect(transportOptions()).toMatchObject({ port: 587, requireTLS: true });
  });

  it('omits auth entirely when no credentials are configured', async () => {
    await sender({ SMTP_USER: undefined, SMTP_PASSWORD: undefined }).send(MESSAGE);

    // A relay that authenticates by IP is a real deployment; handing nodemailer
    // `auth: { user: undefined }` makes it try to authenticate and fail.
    expect('auth' in transportOptions()).toBe(false);
  });

  it('reuses one transport across sends rather than reconnecting each time', async () => {
    const instance = sender();
    await instance.send(MESSAGE);
    await instance.send(MESSAGE);

    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });

  it('rethrows a delivery failure instead of reporting success', async () => {
    mockSendMail.mockRejectedValue(new Error('550 mailbox unavailable'));

    await expect(sender().send(MESSAGE)).rejects.toThrow(/550/);
  });
});

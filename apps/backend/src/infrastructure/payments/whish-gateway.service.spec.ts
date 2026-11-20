import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { WHISH_PROVIDER_WIRED, WhishGatewayService } from './whish-gateway.service';

/**
 * `parseCallback` is the only path in this system that can move an invoice to
 * PAID without a person deciding, so what these tests assert is mostly what it
 * *refuses*. A verifier that accepts a good signature is easy; one that also
 * accepts an unsigned body, or a body edited after signing, silently converts
 * "someone found the webhook URL" into "the municipality was paid".
 */

const SECRET = 'test-webhook-secret';

/** Stands in for Nest's ConfigService — only `get` is ever called. */
function configWith(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const live = () =>
  new WhishGatewayService(
    configWith({
      WHISH_API_URL: 'https://whish.example.invalid',
      WHISH_API_KEY: 'key',
      WHISH_WEBHOOK_SECRET: SECRET,
    }),
  );

/** No credentials at all — how a development or half-configured deploy runs. */
const sandbox = () => new WhishGatewayService(configWith({}));

/** Credentials but no secret: the dangerous half-configuration. */
const liveWithoutSecret = () =>
  new WhishGatewayService(
    configWith({ WHISH_API_URL: 'https://whish.example.invalid', WHISH_API_KEY: 'key' }),
  );

const body = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    externalRef: 'WSH-ABC123',
    transactionRef: 'TRX-99',
    amount: 500_000,
    status: 'SUCCESS',
    ...overrides,
  });

const sign = (raw: string, secret = SECRET) =>
  createHmac('sha256', secret).update(raw, 'utf8').digest('hex');

describe('WhishGatewayService.parseCallback', () => {
  it('accepts a correctly signed callback and returns its contents intact', () => {
    const raw = body();
    const result = live().parseCallback({ rawBody: raw, signature: sign(raw) });

    expect(result).toEqual({
      externalRef: 'WSH-ABC123',
      transactionRef: 'TRX-99',
      amount: 500_000,
      succeeded: true,
    });
  });

  it('reports a failed payment as failed rather than dropping it', () => {
    const raw = body({ status: 'FAILED', amount: 0 });
    expect(live().parseCallback({ rawBody: raw, signature: sign(raw) })?.succeeded).toBe(false);
  });

  /**
   * The signature covers the raw bytes, so a payload edited in transit must
   * fail even though it is still valid JSON with every field present. This is
   * the case that would otherwise let an attacker change the amount.
   */
  it('rejects a body altered after signing', () => {
    const original = body();
    const tampered = body({ amount: 1 });
    expect(live().parseCallback({ rawBody: tampered, signature: sign(original) })).toBeNull();
  });

  it.each([
    ['no signature header', undefined],
    ['an empty signature', ''],
    ['a non-hex signature', 'zzzz'],
    ['a truncated signature', sign(body()).slice(0, 20)],
    ['a signature from a different secret', sign(body(), 'not-the-secret')],
    ['a signature over a different body', sign('{}')],
  ])('rejects %s', (_label, signature) => {
    expect(live().parseCallback({ rawBody: body(), signature })).toBeNull();
  });

  it('rejects a valid signature over malformed JSON', () => {
    const raw = 'not json';
    expect(live().parseCallback({ rawBody: raw, signature: sign(raw) })).toBeNull();
  });

  it.each([
    ['externalRef', { externalRef: undefined }],
    ['transactionRef', { transactionRef: undefined }],
    ['amount', { amount: undefined }],
  ])('rejects a signed payload missing %s', (_field, overrides) => {
    const raw = body(overrides);
    expect(live().parseCallback({ rawBody: raw, signature: sign(raw) })).toBeNull();
  });

  it('rejects a non-numeric amount, which would reach the ledger as NaN', () => {
    const raw = body({ amount: '500000' });
    expect(live().parseCallback({ rawBody: raw, signature: sign(raw) })).toBeNull();
  });

  /**
   * The property that matters most: with no secret configured there is no way
   * to reach PAID at all, so a sandbox or half-configured deployment cannot be
   * talked into banking money by anyone who guesses the callback URL.
   */
  it('rejects everything in sandbox, however well-formed', () => {
    const raw = body();
    expect(sandbox().parseCallback({ rawBody: raw, signature: sign(raw) })).toBeNull();
    expect(sandbox().parseCallback({ rawBody: raw, signature: undefined })).toBeNull();
  });

  it('rejects everything when credentials are set but the secret is missing', () => {
    const raw = body();
    expect(liveWithoutSecret().parseCallback({ rawBody: raw, signature: sign(raw) })).toBeNull();
  });
});

describe('WhishGatewayService.createCheckout', () => {
  const input = {
    paymentId: 'payment-1',
    amount: 500_000,
    currency: 'LBP',
    citizenName: 'باسكال جميّل',
    callbackUrl: 'https://api.example.invalid/callback',
    returnUrl: 'https://portal.example.invalid/albazourieh/ar/my-file',
  };

  it('reports sandbox and live correctly', () => {
    expect(sandbox().isLive).toBe(false);
    // Credentials alone are not live while `postCheckout` is not written (S18): since
    // `WHISH_*` reach the gateway, a value left in a deployed `.env` must not lift
    // ONLINE_PAYMENT_UNAVAILABLE into a 500.
    expect(live().isLive).toBe(WHISH_PROVIDER_WIRED);
  });

  /**
   * Sandbox must not invent a payment. It returns the citizen to the portal
   * with a reference to match a later callback against — the caller is what
   * marks the invoice as awaiting confirmation, and nothing here claims money
   * moved.
   */
  it('returns the portal URL and a matchable reference in sandbox', async () => {
    const checkout = await sandbox().createCheckout(input);

    expect(checkout.redirectUrl).toBe(input.returnUrl);
    expect(checkout.externalRef).toMatch(/^WSH-/);
  });

  it('mints a distinct reference per attempt, so callbacks cannot collide', async () => {
    const gateway = sandbox();
    const first = await gateway.createCheckout(input);
    const second = await gateway.createCheckout(input);

    expect(first.externalRef).not.toBe(second.externalRef);
  });

  /**
   * Live mode has nowhere to go until the provider contract is implemented, and
   * it says so loudly rather than falling back to sandbox — a silent downgrade
   * would leave a configured municipality taking declarations it believes are
   * confirmed payments.
   */
  it('refuses in live mode until the provider call is implemented', async () => {
    await expect(live().createCheckout(input)).rejects.toThrow(/not yet wired/i);
  });
});

import { randomInt as cryptoRandomInt } from 'node:crypto';
import { ValidationError } from '../errors/domain-error';

/**
 * رقم مرجعي — the fallback identifier a citizen keeps when a phone is lost or
 * shared between a household. Format: <PREFIX>-<YY><MM>-<6 chars>, e.g.
 * "BZR-2607-4K9QX2".
 *
 * The alphabet deliberately excludes I, O, 0 and 1 so the code survives being
 * read aloud over the phone or copied by hand from an SMS by an elderly user —
 * the exact population this system exists to serve.
 *
 * **This is a credential.** `POST /auth/citizen/reference/open` accepts it
 * alone and returns a session over the holder's national ID number, civil
 * record number, residency status and fee ledger — so the suffix is the whole
 * secret, and it must be unguessable rather than merely unique.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PATTERN = /^[A-Z]{3}-\d{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

export class ReferenceNumber {
  private constructor(readonly value: string) {}

  /**
   * @param randomInt injectable only so tests can make a reference
   *   deterministic. The default is `crypto.randomInt`, and it must stay a
   *   CSPRNG: this used to default to `Math.floor(Math.random() * max)`, which
   *   is V8's xorshift128+ — an algorithm whose internal state is recoverable
   *   from a handful of observed outputs, after which every other value it has
   *   produced or will produce is computable. Reference numbers are printed on
   *   every وصل جباية and read aloud at the counter, so outputs are public by
   *   design; and the bulk citizen import draws them in a tight loop from one
   *   PRNG state, which made a single leaked receipt enough to derive the rest
   *   of its import batch.
   */
  static generate(
    tenantPrefix: string,
    now: Date = new Date(),
    randomInt: (max: number) => number = (max) => cryptoRandomInt(max),
  ): ReferenceNumber {
    const prefix = tenantPrefix
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .slice(0, 3)
      .padEnd(3, 'X');
    const yy = String(now.getUTCFullYear()).slice(-2);
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');

    let suffix = '';
    for (let i = 0; i < 6; i += 1) {
      suffix += ALPHABET[randomInt(ALPHABET.length)];
    }

    return new ReferenceNumber(`${prefix}-${yy}${mm}-${suffix}`);
  }

  /** Accepts what a citizen actually types: spaces, lowercase, missing dashes. */
  static parse(raw: string): ReferenceNumber {
    const normalised = raw.trim().toUpperCase().replace(/\s/g, '');
    if (!PATTERN.test(normalised)) {
      throw new ValidationError('الرقم المرجعي غير صالح');
    }
    return new ReferenceNumber(normalised);
  }

  static isValid(raw: string): boolean {
    return PATTERN.test(raw.trim().toUpperCase().replace(/\s/g, ''));
  }

  /**
   * The reference with its secret hidden — for audit rows and audit screens.
   *
   * Only the parts that are not secret survive: the municipality prefix and
   * the issue month, so «BZR-2607-4K9QX2» becomes «BZR-2607-••••••». Not the
   * last four, as tax and card numbers are often shown: the six-character
   * suffix *is* the credential, and four of its characters leave 32² = 1,024
   * candidates, which a guesser exhausts in minutes. A person is identified in
   * the trail by their id; this is only a hint a human can recognise.
   *
   * `null` for no reference; a value that is not a reference is hidden whole.
   */
  static mask(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const normalised = raw.trim().toUpperCase().replace(/\s/g, '');
    if (!PATTERN.test(normalised)) return '••••••';
    return `${normalised.slice(0, 8)}-••••••`;
  }

  toString(): string {
    return this.value;
  }
}

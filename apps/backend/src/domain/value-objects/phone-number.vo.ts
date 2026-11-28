import { ValidationError } from '../errors/domain-error';

/**
 * Lebanese mobile number, stored E.164 (+961XXXXXXXX).
 *
 * Normalising on the way in matters more than usual here: the same person will
 * type 03 123456, 3123456, +961 3 123 456 and 0096171234567 across visits, and
 * OTP login looks the person up *by phone*. Without a canonical form a citizen
 * silently fails to find their own account.
 */
const MOBILE_PATTERN = /^(3|7[0-9]|8[1])\d{6}$/;

export class PhoneNumber {
  private constructor(readonly e164: string) {}

  static parse(raw: string): PhoneNumber {
    const stripped = raw.trim().replace(/[\s\-()]/g, '');
    const national = stripped.replace(/^(\+961|00961|0)/, '');

    if (!MOBILE_PATTERN.test(national)) {
      throw new ValidationError({
        code: 'PHONE_NUMBER_INVALID',
        message: 'The phone number is not valid',
      });
    }

    return new PhoneNumber(`+961${national}`);
  }

  static isValid(raw: string): boolean {
    try {
      PhoneNumber.parse(raw);
      return true;
    } catch {
      return false;
    }
  }

  /** Last 4 digits, for "is this your number?" confirmations without echoing it whole. */
  get masked(): string {
    return `••• ${this.e164.slice(-4)}`;
  }

  equals(other: PhoneNumber): boolean {
    return this.e164 === other.e164;
  }

  toString(): string {
    return this.e164;
  }
}

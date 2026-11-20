import { Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import { TotpService } from '../../domain/interfaces/otp-repository.interface';

/**
 * TOTP for SUPER_ADMIN, which v2 made mandatory rather than "worth considering".
 *
 * A SUPER_ADMIN can read every citizen's national ID number, residency status
 * and scanned documents for their municipality, and can export the lot to CSV.
 * A single reused password should not be all that stands in front of that.
 */
const STEP_SECONDS = 30;

/**
 * One step either side of now: 30s of phone clock drift each way, and a code
 * typed just as it rolled over still counts. Two steps (until 2026-11-15)
 * kept a code valid for two and a half minutes, which is room for a code read
 * over a shoulder or relayed by a phishing page to be used (security.md: «The
 * verifier SHOULD accept one step either side»).
 */
const WINDOW_STEPS = 1;

@Injectable()
export class OtplibTotpService implements TotpService {
  generateSecret(): string {
    return authenticator.generateSecret();
  }

  keyUri(secret: string, accountName: string, issuer: string): string {
    return authenticator.keyuri(accountName, issuer, secret);
  }

  /**
   * The step the code belongs to: the clock's step plus otplib's delta.
   *
   * The checker is cloned with the instant pinned, so the delta and the step
   * it is added to are read from the same moment; read apart, a check that
   * straddled a step boundary would name the neighbouring step. The shared
   * `authenticator`'s own options are never changed. They are set on the
   * clone rather than passed to `clone()`: otplib lays the source instance's
   * `options` over whatever `clone()` is given, so a `window` set on the
   * shared instance anywhere in the process would otherwise win.
   */
  matchStep(token: string, secret: string, now: Date = new Date()): number | null {
    try {
      const cleanToken = token.replace(/[\s-]/g, '');
      const cleanSecret = secret.replace(/\s/g, '');
      const epoch = now.getTime();
      const checker = authenticator.clone();
      checker.options = { step: STEP_SECONDS, window: WINDOW_STEPS, epoch };
      const delta = checker.checkDelta(cleanToken, cleanSecret);
      if (delta === null) return null;
      return Math.floor(epoch / 1000 / STEP_SECONDS) + delta;
    } catch {
      // A malformed token or secret is a failed check, not a 500.
      return null;
    }
  }
}

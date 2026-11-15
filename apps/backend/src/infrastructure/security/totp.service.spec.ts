import { authenticator } from 'otplib';
import { OtplibTotpService } from './totp.service';

/**
 * The adapter against the real otplib: which step a code is said to belong
 * to, and how far either side of now a code is still accepted.
 *
 * The step is what the replay guard burns, so it has to be the code's own.
 * Security audit N-1: the step burned was the clock's, so a code accepted at
 * step S burned S, verified again at S+1 and burned S+1 — accepted twice.
 */
const SECRET = authenticator.generateSecret();
const STEP_MS = 30_000;
const S = 59_000_000;

/** Ten seconds into a step, well clear of either edge. */
const atStep = (step: number, intoStepMs = 10_000) => new Date(step * STEP_MS + intoStepMs);

/** The code an authenticator app shows at `at`. */
function codeAt(at: Date): string {
  const app = authenticator.clone();
  app.options = { epoch: at.getTime(), step: 30 };
  return app.generate(SECRET);
}

describe('OtplibTotpService.matchStep', () => {
  const totp = new OtplibTotpService();

  it("names the step a code was generated in, wherever in the window it is checked", () => {
    const code = codeAt(atStep(S));

    expect(totp.matchStep(code, SECRET, atStep(S))).toBe(S);
    // A step later the code still verifies, and still names S — so a guard that
    // has burned S refuses it. Naming S+1 here is the defect N-1 described.
    expect(totp.matchStep(code, SECRET, atStep(S + 1))).toBe(S);
    expect(totp.matchStep(code, SECRET, atStep(S - 1))).toBe(S);
  });

  it('accepts one step either side of now and no more', () => {
    const code = codeAt(atStep(S));

    expect(totp.matchStep(code, SECRET, atStep(S + 2))).toBeNull();
    expect(totp.matchStep(code, SECRET, atStep(S - 2))).toBeNull();
  });

  it('reads the step from the instant it is given, at the very edge of a step', () => {
    // The last millisecond of S and the first of S+1: the delta and the step it
    // is added to come from the same instant, so neither names a neighbour.
    const code = codeAt(atStep(S));
    expect(totp.matchStep(code, SECRET, atStep(S, STEP_MS - 1))).toBe(S);
    expect(totp.matchStep(code, SECRET, atStep(S + 1, 0))).toBe(S);
  });

  it('is not widened by a window set on the shared authenticator', () => {
    // Nothing in the process sets them, so resetting restores what was there.
    authenticator.options = { window: 5 };
    try {
      expect(totp.matchStep(codeAt(atStep(S)), SECRET, atStep(S + 3))).toBeNull();
    } finally {
      authenticator.resetOptions();
    }
  });

  it('takes the code as people type it, with a space or a dash', () => {
    const code = codeAt(atStep(S));
    expect(totp.matchStep(`${code.slice(0, 3)} ${code.slice(3)}`, SECRET, atStep(S))).toBe(S);
    expect(totp.matchStep(`${code.slice(0, 3)}-${code.slice(3)}`, SECRET, atStep(S))).toBe(S);
  });

  it('answers null, not a throw, for a malformed code or secret', () => {
    expect(totp.matchStep('abcdef', SECRET, atStep(S))).toBeNull();
    expect(totp.matchStep('', SECRET, atStep(S))).toBeNull();
    expect(totp.matchStep(codeAt(atStep(S)), '!!not base32!!', atStep(S))).toBeNull();
  });
});

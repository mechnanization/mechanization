import { ConfigService } from '@nestjs/config';
import {
  OtpRepository,
  PasswordHasher,
  SmsSender,
} from '../../../domain/interfaces/otp-repository.interface';
import { OtpService } from './otp.service';

/**
 * The phone-code sign-in while no SMS provider is live (security audit N-2).
 *
 * A request used to write a challenge, send nothing and, wherever `NODE_ENV`
 * was not `production`, return the code as `devCode`: knowing a citizen's
 * phone opened their file. With `OTP_ENABLED` off, `verify` took the phone
 * alone. Both are refused now, before anything is read or written — every
 * port below throws if it is touched.
 */
const PHONE = '+96170123456';

function unreachable(name: string) {
  return jest.fn(() => {
    throw new Error(`${name} must not be reached while SMS is not live`);
  });
}

function build({ isLive, otpEnabled = true }: { isLive: boolean; otpEnabled?: boolean }) {
  const challenges = {
    create: unreachable('OtpRepository.create'),
    findActive: unreachable('OtpRepository.findActive'),
    incrementAttempts: unreachable('OtpRepository.incrementAttempts'),
    consume: unreachable('OtpRepository.consume'),
    countRecent: unreachable('OtpRepository.countRecent'),
    deleteExpired: unreachable('OtpRepository.deleteExpired'),
  } satisfies OtpRepository;
  const sms = { send: unreachable('SmsSender.send'), hasFallback: false, isLive } satisfies SmsSender;
  const hasher = { hash: unreachable('hash'), verify: unreachable('verify') } satisfies PasswordHasher;
  const config = { get: jest.fn().mockReturnValue(otpEnabled) } as unknown as ConfigService;

  return { service: new OtpService(challenges, sms, hasher, config), challenges, sms };
}

describe('OtpService while no SMS provider is live', () => {
  it('refuses a code request before writing a challenge or sending anything', async () => {
    const { service, challenges, sms } = build({ isLive: false });

    await expect(service.issue(PHONE)).rejects.toMatchObject({
      code: 'CITIZEN_OTP_UNAVAILABLE',
      kind: 'CONFLICT',
    });
    expect(challenges.countRecent).not.toHaveBeenCalled();
    expect(challenges.create).not.toHaveBeenCalled();
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('refuses a verify before reading a challenge', async () => {
    const { service, challenges } = build({ isLive: false });

    await expect(service.verify(PHONE, '123456')).rejects.toMatchObject({
      code: 'CITIZEN_OTP_UNAVAILABLE',
    });
    expect(challenges.findActive).not.toHaveBeenCalled();
  });

  it('refuses a verify with OTP switched off, which used to take the phone alone', async () => {
    const { service } = build({ isLive: false, otpEnabled: false });

    await expect(service.verify(PHONE, '')).rejects.toMatchObject({
      code: 'CITIZEN_OTP_UNAVAILABLE',
    });
  });

  it('refuses before the number is even parsed, so a malformed one learns nothing either', async () => {
    const { service } = build({ isLive: false });

    await expect(service.issue('not a phone')).rejects.toMatchObject({
      code: 'CITIZEN_OTP_UNAVAILABLE',
    });
  });
});

describe('OtpService once a provider is live', () => {
  it('goes on to the challenge', async () => {
    const { service, challenges } = build({ isLive: true });
    (challenges.findActive as jest.Mock).mockResolvedValue(null);

    // No challenge on file: the ordinary refusal, past the guard.
    await expect(service.verify(PHONE, '123456')).rejects.toMatchObject({ kind: 'UNAUTHORIZED' });
    expect(challenges.findActive).toHaveBeenCalled();
  });
});

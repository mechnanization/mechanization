import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { StaffProps, User } from '../../../domain/entities/user.entity';
import { PasswordHasher, TotpService } from '../../../domain/interfaces/otp-repository.interface';
import { UserRepository } from '../../../domain/interfaces/user-repository.interface';
import { DomainError } from '../../../domain/errors/domain-error';
import { IdentityService } from './identity.service';
import { OtpService } from './otp.service';
import { StaffRefreshTokenService } from './staff-refresh-token.service';

/**
 * A staff member's own second factor (audit SEC-02, migration 0116).
 *
 * Before: starting an enrolment needed the session alone and wrote the new
 * secret over the confirmed one at once, and switching 2FA off checked the
 * password only when one was sent. A stolen session could remove the factor and
 * enrol its own. These tests hold the three rules that close it: re-authenticate
 * (the password, and the current code while a factor is confirmed), keep the
 * confirmed factor until a code from the new app confirms its replacement, and
 * end every session once the factor in force changes.
 */

const CODE_STEP = 58_000_000;

const STAFF: StaffProps = {
  id: 'staff-1',
  tenantSlug: 'albazourieh',
  email: 'admin@albazourieh.gov.lb',
  passwordHash: '$2b$12$u1Qn7bDPQ0v0sQJ0T8yR8eKZ9m2gq5gEr0CqJ0Lz7Yb6aW1nHc2Vu',
  role: 'SUPER_ADMIN',
  firstName: 'مدير',
  lastName: 'النظام',
  isActive: true,
  totpSecret: 'OLD-SECRET',
  totpConfirmedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const enrolled = (overrides: Partial<StaffProps> = {}) => User.staff({ ...STAFF, ...overrides });
const unenrolled = (overrides: Partial<StaffProps> = {}) =>
  enrolled({ totpSecret: null, totpConfirmedAt: null, ...overrides });

function build(user: User | null, options: { password?: boolean; code?: boolean; promoted?: boolean } = {}) {
  const { password = true, code = true, promoted = true } = options;
  const users = {
    findById: jest.fn().mockResolvedValue(user),
    recordTotpStep: jest.fn().mockResolvedValue({ accepted: true }),
    recordTotpFailure: jest.fn().mockResolvedValue({ lockedUntil: null }),
    saveTotpSecret: jest.fn(),
    confirmTotp: jest.fn(),
    savePendingTotpSecret: jest.fn().mockResolvedValue(undefined),
    promotePendingTotp: jest.fn().mockResolvedValue(promoted),
    disableTotp: jest.fn().mockResolvedValue(undefined),
  };
  const totp = {
    generateSecret: jest.fn().mockReturnValue('NEW-SECRET'),
    keyUri: jest.fn().mockReturnValue('otpauth://x'),
    matchStep: jest.fn().mockReturnValue(code ? CODE_STEP : null),
  } satisfies TotpService;
  const hasher = { hash: jest.fn(), verify: jest.fn().mockResolvedValue(password) };
  const revocation = { forget: jest.fn().mockResolvedValue(undefined), forgetFamily: jest.fn() };
  const events = { emit: jest.fn() };

  const service = new IdentityService(
    users as unknown as UserRepository,
    hasher as unknown as PasswordHasher,
    totp,
    {} as never,
    {} as OtpService,
    revocation as unknown as never,
    {} as JwtService,
    { get: jest.fn() } as unknown as ConfigService,
    events as unknown as EventEmitter2,
    {} as StaffRefreshTokenService,
  );
  return { service, users, totp, hasher, revocation, events };
}

async function codeOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return error instanceof DomainError ? error.code : `not a domain error: ${String(error)}`;
  }
  throw new Error('expected a refusal, but the call resolved');
}

describe.each([
  ['beginTotpEnrolment', (service: IdentityService, body: { currentPassword: string; totpToken?: string }) =>
    service.beginTotpEnrolment('staff-1', 'albazourieh', body)],
  ['disableTotp', (service: IdentityService, body: { currentPassword: string; totpToken?: string }) =>
    service.disableTotp('staff-1', 'albazourieh', body)],
])('%s re-authenticates', (_name, call) => {
  it('refuses a wrong password, and writes nothing', async () => {
    const { service, users, totp } = build(enrolled(), { password: false });

    expect(await codeOf(call(service, { currentPassword: 'wrong', totpToken: '123456' }))).toBe(
      'STAFF_CURRENT_PASSWORD_INCORRECT',
    );
    // The password is judged first: no code is checked or counted for a caller without it.
    expect(totp.matchStep).not.toHaveBeenCalled();
    expect(users.recordTotpFailure).not.toHaveBeenCalled();
    expect(users.savePendingTotpSecret).not.toHaveBeenCalled();
    expect(users.disableTotp).not.toHaveBeenCalled();
  });

  it('asks for the current code while a factor is confirmed', async () => {
    const { service, users } = build(enrolled());

    expect(await codeOf(call(service, { currentPassword: 'right' }))).toBe('TOTP_CODE_REQUIRED');
    expect(users.savePendingTotpSecret).not.toHaveBeenCalled();
    expect(users.disableTotp).not.toHaveBeenCalled();
  });

  it('refuses a wrong code and counts it toward the lockout', async () => {
    const { service, users } = build(enrolled(), { code: false });

    expect(await codeOf(call(service, { currentPassword: 'right', totpToken: '000000' }))).toBe(
      'TOTP_CODE_INVALID',
    );
    expect(users.recordTotpFailure).toHaveBeenCalledTimes(1);
    expect(users.savePendingTotpSecret).not.toHaveBeenCalled();
    expect(users.disableTotp).not.toHaveBeenCalled();
  });

  it('checks the code against the confirmed factor and burns its step', async () => {
    const { service, totp, users } = build(enrolled());

    await call(service, { currentPassword: 'right', totpToken: '123456' });

    expect(totp.matchStep).toHaveBeenCalledWith('123456', 'OLD-SECRET', expect.any(Date));
    expect(users.recordTotpStep).toHaveBeenCalledWith('staff-1', CODE_STEP, expect.any(Date));
  });

  it('asks only for the password when no factor is confirmed', async () => {
    const { service, totp } = build(unenrolled());

    await call(service, { currentPassword: 'right' });

    expect(totp.matchStep).not.toHaveBeenCalled();
  });

  it('refuses a session that names no staff account', async () => {
    const { service } = build(null);

    expect(await codeOf(call(service, { currentPassword: 'right' }))).toBe('SESSION_INVALID');
  });
});

describe('beginTotpEnrolment keeps the confirmed factor', () => {
  it('writes the new secret as pending, never over the one in force', async () => {
    const { service, users, events } = build(enrolled());

    const result = await service.beginTotpEnrolment('staff-1', 'albazourieh', {
      currentPassword: 'right',
      totpToken: '123456',
    });

    expect(result).toEqual({ secret: 'NEW-SECRET', keyUri: 'otpauth://x' });
    expect(users.savePendingTotpSecret).toHaveBeenCalledWith('staff-1', 'NEW-SECRET');
    expect(users.saveTotpSecret).not.toHaveBeenCalled();
    expect(users.disableTotp).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith('staff.changed', expect.objectContaining({ action: 'TOTP_ENROLLED' }));
  });
});

describe('confirmTotpEnrolment', () => {
  it('checks the code against the pending secret, promotes it and ends every session', async () => {
    const { service, users, totp, revocation, events } = build(enrolled({ totpPendingSecret: 'NEW-SECRET' }));

    await service.confirmTotpEnrolment('staff-1', '654321');

    expect(totp.matchStep).toHaveBeenCalledWith('654321', 'NEW-SECRET', expect.any(Date));
    expect(users.promotePendingTotp).toHaveBeenCalledWith('staff-1', 'NEW-SECRET');
    expect(revocation.forget).toHaveBeenCalledWith('staff-1');
    expect(events.emit).toHaveBeenCalledWith('staff.changed', expect.objectContaining({ action: 'TOTP_CONFIRMED' }));
  });

  it('confirms an unconfirmed secret an enrolment left before 0116', async () => {
    const { service, users } = build(unenrolled({ totpSecret: 'LEGACY' }));

    await service.confirmTotpEnrolment('staff-1', '654321');

    expect(users.promotePendingTotp).toHaveBeenCalledWith('staff-1', 'LEGACY');
  });

  it('refuses when no enrolment is waiting, and never re-confirms the factor in force', async () => {
    const { service, users, totp } = build(enrolled());

    expect(await codeOf(service.confirmTotpEnrolment('staff-1', '654321'))).toBe('TOTP_ENROLMENT_NOT_STARTED');
    expect(totp.matchStep).not.toHaveBeenCalled();
    expect(users.promotePendingTotp).not.toHaveBeenCalled();
  });

  it('refuses when another enrolment replaced this one, and ends no session', async () => {
    const { service, revocation } = build(enrolled({ totpPendingSecret: 'NEW-SECRET' }), { promoted: false });

    expect(await codeOf(service.confirmTotpEnrolment('staff-1', '654321'))).toBe('TOTP_ENROLMENT_CHANGED');
    expect(revocation.forget).not.toHaveBeenCalled();
  });

  it('leaves the confirmed factor alone on a wrong code', async () => {
    const { service, users } = build(enrolled({ totpPendingSecret: 'NEW-SECRET' }), { code: false });

    expect(await codeOf(service.confirmTotpEnrolment('staff-1', '000000'))).toBe('TOTP_CODE_INVALID');
    expect(users.promotePendingTotp).not.toHaveBeenCalled();
  });
});

describe('disableTotp', () => {
  it('clears the factor and ends every session once re-authenticated', async () => {
    const { service, users, revocation, events } = build(enrolled());

    await service.disableTotp('staff-1', 'albazourieh', { currentPassword: 'right', totpToken: '123456' });

    expect(users.disableTotp).toHaveBeenCalledWith('staff-1');
    expect(revocation.forget).toHaveBeenCalledWith('staff-1');
    expect(events.emit).toHaveBeenCalledWith('staff.changed', expect.objectContaining({ action: 'TOTP_DISABLED' }));
  });
});

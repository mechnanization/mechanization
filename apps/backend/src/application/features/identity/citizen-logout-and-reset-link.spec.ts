import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { resetTokenFromFragment } from '@mechanization/shared-schemas';
import { User } from '../../../domain/entities/user.entity';
import { UserRepository } from '../../../domain/interfaces/user-repository.interface';
import { IdentityService } from './identity.service';
import { OtpService } from './otp.service';
import { SessionRevocationService } from './session-revocation.service';
import { StaffRefreshTokenService } from './staff-refresh-token.service';

/**
 * Task S14 of the 2026-11-14 security audit, the server's half:
 *
 *  - the password-reset link carries its token in the fragment, read back by
 *    the same shared function the reset page uses (`resetTokenFromFragment`),
 *    and never in `?token=`, which reached access logs and `Referer`s while
 *    the page looked for a Supabase fragment, so no reset could succeed;
 *  - a citizen's sign-out ends their sessions on the server.
 */
const PORTAL = 'https://portal.example.invalid';
const TOKEN = 'header.payload.signature';

function build(users: Partial<UserRepository> = {}, portal: string | undefined = PORTAL) {
  const send = jest.fn().mockResolvedValue(undefined);
  const revocation = { forget: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => (key === 'PUBLIC_PORTAL_URL' ? portal : fallback)),
    getOrThrow: jest.fn().mockReturnValue('test-secret-at-least-32-characters-long-xx'),
  } as unknown as ConfigService;
  const service = new IdentityService(
    users as UserRepository,
    {} as never,
    {} as never,
    { isConfigured: true, send } as never,
    {} as OtpService,
    revocation as unknown as SessionRevocationService,
    { sign: jest.fn().mockReturnValue(TOKEN) } as unknown as JwtService,
    config,
    { emit: jest.fn() } as unknown as EventEmitter2,
    {} as StaffRefreshTokenService,
  );
  return { service, send, revocation };
}

const staff = User.staff({
  id: 'staff-1',
  tenantSlug: 'albazourieh',
  email: 'admin@albazourieh.gov.lb',
  passwordHash: 'hash',
  role: 'SUPER_ADMIN',
  firstName: 'مدير',
  lastName: 'النظام',
  isActive: true,
});

/** The link the mail carried: the line that is a URL. */
const mailedLink = (send: jest.Mock): string =>
  String((send.mock.calls[0]![0] as { text: string }).text)
    .split('\n')
    .find((line) => line.startsWith('http'))!;

describe('the password-reset link (S14)', () => {
  it('carries the token in the fragment, where the page reads it, and not in the query', async () => {
    const { service, send } = build({ findById: jest.fn().mockResolvedValue(staff) });

    await service.sendStaffPasswordResetEmail('staff-1');

    const link = new URL(mailedLink(send));
    expect(link.search).toBe('');
    expect(resetTokenFromFragment(link.hash)).toBe(TOKEN);
  });

  it('drops a token a caller left in the redirect’s query string', async () => {
    const { service, send } = build({ findById: jest.fn().mockResolvedValue(staff) });

    await service.sendStaffPasswordResetEmail('staff-1', `${PORTAL}/albazourieh/ar/admin/reset-password?token=old`);

    const link = new URL(mailedLink(send));
    expect(link.pathname).toBe('/albazourieh/ar/admin/reset-password');
    expect(link.searchParams.has('token')).toBe(false);
    expect(resetTokenFromFragment(link.hash)).toBe(TOKEN);
  });
});

describe('a citizen’s sign-out (S14)', () => {
  it('ends every session the citizen holds, and stops the guard trusting its cache', async () => {
    const endCitizenSessions = jest.fn().mockResolvedValue(true);
    const { service, revocation } = build({ endCitizenSessions });

    await service.logoutCitizen('citizen-1');

    expect(endCitizenSessions).toHaveBeenCalledWith('citizen-1');
    expect(revocation.forget).toHaveBeenCalledWith('citizen-1');
    // The version is bumped before the cache forgets it, so the next read sees the new one.
    expect(endCitizenSessions.mock.invocationCallOrder[0]).toBeLessThan(revocation.forget.mock.invocationCallOrder[0]!);
  });
});

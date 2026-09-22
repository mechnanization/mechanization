import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { StaffProps, User } from '../../../domain/entities/user.entity';
import { PasswordHasher, TotpService } from '../../../domain/interfaces/otp-repository.interface';
import { UserRepository } from '../../../domain/interfaces/user-repository.interface';
import { UnauthorizedError } from '../../common/exceptions';
import { IdentityService, SessionResult } from './identity.service';
import { OtpService } from './otp.service';

/**
 * The staff sign-in path, which carried two defects that a single test each
 * would have made impossible, and has since been moved off Supabase entirely.
 *
 * The first defect was a provisioning branch: a login against a municipality
 * the account had no row in *created* that row, reading its role and its
 * municipality from Supabase `user_metadata` and defaulting them to
 * `SUPER_ADMIN` and the slug in the request URL. `user_metadata` is writable by
 * the account holder, and a tenant check whose fallback is the request's own
 * slug compares a value to itself — so any account in the shared Supabase
 * project was one login away from administering any municipality.
 *
 * The second was quieter: `totpToken` reached this service and was never read.
 * `staffLoginResponseSchema` has always described a `TOTP_REQUIRED` challenge,
 * `beginTotpEnrolment` has always worked, and none of it was ever enforced —
 * so an administrator who set up an authenticator gained nothing at all.
 *
 * The third thing these tests now hold down is not a past defect but a present
 * claim: the password is verified here, against this schema's own
 * `users.passwordHash`, and `loginStaff` does not call Supabase at all. Three
 * properties of that move are easy to lose and expensive to lose quietly, so
 * each has a test of its own below — a row with no hash is refused rather than
 * waved through, every outcome spends exactly one bcrypt comparison (including
 * the unknown-email one, or the refusal message stops hiding anything), and no
 * method on `SupabaseAuthService` is reached.
 *
 * `PasswordHasher` is a mock throughout. That is deliberate — a real cost-12
 * comparison is ~250ms and there are enough tests here to make that felt — but
 * it does bound what this file proves: it proves what `loginStaff` *does with*
 * a verdict and how many times it asks for one, not that bcrypt is correct.
 */

/**
 * Shape-accurate, value-meaningless: it is not a digest of `LOGIN.password`,
 * because the hasher that would compare them is mocked. What the shape buys is
 * that "the row's own hash reached the hasher" is an assertion about something
 * recognisable — and that `passwordHash: ''`, which this fixture used to hold,
 * can no longer pass for a credential.
 */
const PASSWORD_HASH = '$2b$12$u1Qn7bDPQ0v0sQJ0T8yR8eKZ9m2gq5gEr0CqJ0Lz7Yb6aW1nHc2Vu';

/** `$2<variant>$12$` followed by 53 characters of salt and digest. */
const BCRYPT_COST_12 = /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/;

const STAFF: StaffProps = {
  id: 'staff-1',
  tenantSlug: 'albazourieh',
  email: 'admin@albazourieh.gov.lb',
  passwordHash: PASSWORD_HASH,
  role: 'SUPER_ADMIN',
  firstName: 'مدير',
  lastName: 'النظام',
  isActive: true,
  totpSecret: 'SECRET',
  totpConfirmedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function staff(overrides: Partial<StaffProps> = {}): User {
  return User.staff({ ...STAFF, ...overrides });
}

/** The same account with no authenticator, for tests about the password alone. */
function unenrolled(overrides: Partial<StaffProps> = {}): User {
  return staff({ totpSecret: null, totpConfirmedAt: null, ...overrides });
}

/**
 * Every method on the port, so a test can assert the *object* went untouched
 * rather than the one method it thought to name — and so adding a method to
 * `SupabaseAuthService` without deciding whether login may call it stops
 * compiling here.
 *
 * Each one throws, because reaching Supabase from the login path is itself the
 * failure and a thrown error names the method. The call counts are checked as
 * well rather than instead: `changeStaffPassword` and `StaffService` wrap their
 * Supabase calls in best-effort `try/catch`, so a throw is not guaranteed to
 * surface anywhere a test can see it.
 */
/**
 * `IdentityService` no longer takes a `SupabaseAuthService` at all.
 *
 * These tests used to assert that login reached no method on it. That
 * assertion is now made by the constructor signature instead, which is
 * strictly stronger: a dependency that is not injected cannot be called, and
 * re-adding it would not compile against this file. What remains to stub is
 * the mail sender, which login must also never touch — a login that sends
 * email is a login doing something nobody asked it to.
 */
function unreachableEmail(): { isConfigured: boolean; send: jest.Mock } {
  return {
    isConfigured: false,
    send: jest.fn(() => {
      throw new Error('EmailSender.send must not be reached from loginStaff');
    }),
  };
}


/** The error a call was refused with, so two refusals can be compared. */
async function rejection(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (error) {
    return error as Error;
  }

  throw new Error('expected this call to be refused, but it resolved');
}

interface BuildOptions {
  /** Whether the six digits are accepted. */
  totpVerifies?: boolean;
  /** What `PasswordHasher.verify` resolves to — "the submitted password was right". */
  passwordVerifies?: boolean;
}

function build(repository: Partial<UserRepository> = {}, options: BuildOptions = {}) {
  const { totpVerifies = true, passwordVerifies = true } = options;

  const createStaff = jest.fn().mockResolvedValue('should-never-be-called');

  const users = {
    findStaffByEmail: jest.fn().mockResolvedValue(null),
    findById: jest.fn().mockResolvedValue(null),
    markLoggedIn: jest.fn().mockResolvedValue(undefined),
    recordTotpStep: jest.fn().mockResolvedValue(undefined),
    createStaff,
    ...repository,
  } as unknown as UserRepository;

  const hasher = {
    hash: jest.fn().mockResolvedValue(PASSWORD_HASH),
    verify: jest.fn().mockResolvedValue(passwordVerifies),
  };

  const email = unreachableEmail();
  const revocation = { forget: jest.fn().mockResolvedValue(undefined) };

  const service = new IdentityService(
    users,
    hasher as unknown as PasswordHasher,
    {
      generateSecret: jest.fn().mockReturnValue('SECRET'),
      keyUri: jest.fn().mockReturnValue('otpauth://x'),
      verify: jest.fn().mockReturnValue(totpVerifies),
      currentStep: jest.fn().mockReturnValue(58_000_000),
    } as unknown as TotpService,
    email as unknown as never,
    {} as OtpService,
    revocation as unknown as never,
    { sign: jest.fn().mockReturnValue('jwt-token') } as unknown as JwtService,
    { get: jest.fn().mockReturnValue('12h') } as unknown as ConfigService,
    { emit: jest.fn() } as unknown as EventEmitter2,
  );

  return { service, createStaff, hasher, email };
}

const LOGIN = {
  tenantSlug: 'albazourieh',
  email: STAFF.email,
  password: 'correct-horse-battery-staple',
  context: {},
};

const GENERIC_REFUSAL = 'بيانات الدخول غير صحيحة';

describe('loginStaff — the password is checked here, against this schema’s row', () => {
  it('hands the row’s own hash to the hasher and issues a session on a match', async () => {
    const { service, hasher } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(unenrolled()),
    });

    const result = (await service.loginStaff(LOGIN)) as SessionResult;

    expect(hasher.verify).toHaveBeenCalledWith(LOGIN.password, PASSWORD_HASH);
    expect(result.accessToken).toBe('jwt-token');
  });

  it('refuses a wrong password with the generic sentence', async () => {
    const { service } = build(
      { findStaffByEmail: jest.fn().mockResolvedValue(unenrolled()) },
      { passwordVerifies: false },
    );

    await expect(service.loginStaff(LOGIN)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(service.loginStaff(LOGIN)).rejects.toThrow(GENERIC_REFUSAL);
  });

  const ABSENT_HASHES: ReadonlyArray<[string, string | null | undefined]> = [
    ['null', null],
    ['undefined', undefined],
    ['the empty string', ''],
  ];

  it.each(ABSENT_HASHES)(
    'refuses a row whose passwordHash is %s, whatever the hasher answers',
    async (_label, absent) => {
      /*
        `passwordHash` is nullable, so a row written before the column existed,
        or by a path that skipped it, has no credential. "No hash" must mean
        "cannot sign in" and never "no password required" — and the hasher here
        is left at its default of resolving *true*, so this only passes if
        `loginStaff` refuses on the absence itself rather than on the verdict.
      */
      const markLoggedIn = jest.fn();
      const { service } = build({
        findStaffByEmail: jest.fn().mockResolvedValue(
          staff({ passwordHash: absent as unknown as string }),
        ),
        markLoggedIn,
      });

      await expect(service.loginStaff(LOGIN)).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(service.loginStaff(LOGIN)).rejects.toThrow(GENERIC_REFUSAL);
      expect(markLoggedIn).not.toHaveBeenCalled();
    },
  );

  it('spends exactly one comparison on every outcome, including an unknown email', async () => {
    /*
      The timing-oracle defence. The row is now looked up *before* the password
      is checked, so a `return` on a missing row would make "no such account"
      the fast path and "wrong password" the slow one — and a ~250ms gap is a
      perfectly usable way to enumerate which emails hold municipal accounts,
      which is the whole point of the shared message below.
    */
    const unknown = build({ findStaffByEmail: jest.fn().mockResolvedValue(null) });
    await expect(unknown.service.loginStaff(LOGIN)).rejects.toThrow(GENERIC_REFUSAL);

    const wrong = build(
      { findStaffByEmail: jest.fn().mockResolvedValue(unenrolled()) },
      { passwordVerifies: false },
    );
    await expect(wrong.service.loginStaff(LOGIN)).rejects.toThrow(GENERIC_REFUSAL);

    const accepted = build({ findStaffByEmail: jest.fn().mockResolvedValue(unenrolled()) });
    await accepted.service.loginStaff(LOGIN);

    expect(unknown.hasher.verify).toHaveBeenCalledTimes(1);
    expect(wrong.hasher.verify).toHaveBeenCalledTimes(1);
    expect(accepted.hasher.verify).toHaveBeenCalledTimes(1);
  });

  it('compares an unknown email against a well-formed cost-12 placeholder', async () => {
    /*
      Counting the comparison is not enough: bcrypt returns early on a malformed
      hash, so a placeholder that were not a real cost-12 digest would cost
      nothing and hand the gap straight back. The shape is the work.
    */
    const { service, hasher } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(null),
    });

    await expect(service.loginStaff(LOGIN)).rejects.toThrow(GENERIC_REFUSAL);

    const [plain, hash] = hasher.verify.mock.calls[0] as [string, string];
    expect(plain).toBe(LOGIN.password);
    expect(hash).toMatch(BCRYPT_COST_12);
    // …and it is a placeholder, not some account's real hash.
    expect(hash).not.toBe(PASSWORD_HASH);
  });

  it('gives an unknown email and a wrong password the identical sentence', async () => {
    // Equal cost is worth nothing if the text differs. Compared rather than
    // asserted twice, so the two cannot drift apart one edit at a time.
    const unknown = build({ findStaffByEmail: jest.fn().mockResolvedValue(null) });
    const wrong = build(
      { findStaffByEmail: jest.fn().mockResolvedValue(unenrolled()) },
      { passwordVerifies: false },
    );

    const noSuchAccount = await rejection(unknown.service.loginStaff(LOGIN));
    const badPassword = await rejection(wrong.service.loginStaff(LOGIN));

    expect(noSuchAccount.message).toBe(badPassword.message);
    expect(noSuchAccount.message).toBe(GENERIC_REFUSAL);
    expect(noSuchAccount).toBeInstanceOf(UnauthorizedError);
    expect(badPassword).toBeInstanceOf(UnauthorizedError);
  });

  it('completes a login without sending mail or reaching a removed dependency', async () => {
    // The claim in one assertion: the sign-in path no longer depends on
    // Supabase Auth being reachable, or existing.
    const { service, email } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(unenrolled()),
    });

    await service.loginStaff(LOGIN);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('returns a session carrying no supabaseAccessToken', async () => {
    /*
      `loginStaff` was the only producer of that field. It never entered the JWT
      claims — it rode in the response body, and nothing in the monorepo read
      it. A key reappearing here would mean a Supabase token had started leaving
      the backend again with no consumer to justify it.
    */
    const { service } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(unenrolled()),
    });

    const result = (await service.loginStaff(LOGIN)) as SessionResult;

    expect(result).not.toHaveProperty('supabaseAccessToken');
    expect(JSON.stringify(result)).not.toMatch(/supabase/i);
  });
});

describe('loginStaff — a missing profile is a refusal, not a provisioning trigger', () => {
  it('refuses an account with no staff row in this municipality', async () => {
    const { service, createStaff } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(null),
    });

    await expect(service.loginStaff(LOGIN)).rejects.toBeInstanceOf(UnauthorizedError);
    // The whole finding in one assertion: no row is created for a caller who
    // simply asked for a municipality they have no account in.
    expect(createStaff).not.toHaveBeenCalled();
  });

  it('has no Supabase dependency left, so there is no user_metadata to trust', async () => {
    /*
      This used to be "does not read role or tenant from Supabase
      user_metadata", and it was asserted against a deliberately hostile
      fixture: a Supabase result claiming `{ role: 'SUPER_ADMIN', tenantSlug:
      'some-other-tenant' }`, which is what an attacker would put on their own
      account through `auth.updateUser()`.

      That fixture is gone because there is no longer a Supabase result to make
      hostile. The successor assertion is strictly stronger and the reason is
      the same one: metadata you never fetch is metadata you cannot act on. A
      login for an unknown account must end in a refusal having consulted no
      remote claim and written no row.
    */
    const { service, createStaff, email } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(null),
    });

    await expect(service.loginStaff(LOGIN)).rejects.toThrow(GENERIC_REFUSAL);
    expect(createStaff).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('refuses a staff row belonging to another municipality', async () => {
    const { service } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(staff({ tenantSlug: 'zahle' })),
    });

    await expect(service.loginStaff(LOGIN)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a deactivated account', async () => {
    const { service } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(staff({ isActive: false })),
    });

    await expect(service.loginStaff(LOGIN)).rejects.toThrow(/deactivated/i);
  });
});

describe('loginStaff — the second factor is actually checked', () => {
  it('challenges rather than signing in when a code is owed', async () => {
    const { service } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(staff()),
    });

    const result = await service.loginStaff(LOGIN);

    expect(result).toEqual({ status: 'TOTP_REQUIRED' });
    // Not a session: the defect was that this branch returned one.
    expect(result).not.toHaveProperty('accessToken');
  });

  it('does not challenge on a wrong password — the factors are checked in order', async () => {
    // A challenge is a statement that the password was right. Issuing one
    // before checking it would confirm an account exists to anyone who asked.
    const { service } = build(
      { findStaffByEmail: jest.fn().mockResolvedValue(staff()) },
      { passwordVerifies: false },
    );

    await expect(service.loginStaff(LOGIN)).rejects.toThrow(GENERIC_REFUSAL);
  });

  it('does not mark a login that never completed', async () => {
    const markLoggedIn = jest.fn();
    const { service } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(staff()),
      markLoggedIn,
    });

    await service.loginStaff(LOGIN);

    expect(markLoggedIn).not.toHaveBeenCalled();
  });

  it('refuses a wrong code', async () => {
    const { service } = build(
      { findStaffByEmail: jest.fn().mockResolvedValue(staff()) },
      { totpVerifies: false },
    );

    await expect(
      service.loginStaff({ ...LOGIN, totpToken: '000000' }),
    ).rejects.toThrow('رمز التحقق غير صحيح');
  });

  it('issues a session for a correct code', async () => {
    const { service } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(staff()),
    });

    const result = (await service.loginStaff({
      ...LOGIN,
      totpToken: '123456',
    })) as SessionResult;

    expect(result.accessToken).toBe('jwt-token');
    expect(result.user.role).toBe('SUPER_ADMIN');
  });

  it('asks an enrolled AUDITOR for a code too', async () => {
    // Enforcement follows enrolment, not role: having set an authenticator up,
    // being able to sign in without it is the defect.
    const { service } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(staff({ role: 'AUDITOR' })),
    });

    await expect(service.loginStaff(LOGIN)).resolves.toEqual({ status: 'TOTP_REQUIRED' });
  });

  it('lets an unenrolled AUDITOR sign in', async () => {
    const { service } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(unenrolled({ role: 'AUDITOR' })),
    });

    const result = (await service.loginStaff(LOGIN)) as SessionResult;
    expect(result.accessToken).toBe('jwt-token');
  });

  it('allows a SUPER_ADMIN whose enrolment is not yet complete to sign in to set it up', async () => {
    const { service } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(unenrolled()),
    });

    const result = (await service.loginStaff(LOGIN)) as SessionResult;
    expect(result.accessToken).toBe('jwt-token');
  });

  it('allows a SUPER_ADMIN whose secret was issued but unconfirmed to sign in to finish setup', async () => {
    const { service } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(staff({ totpConfirmedAt: null })),
    });

    const result = (await service.loginStaff(LOGIN)) as SessionResult;
    expect(result.accessToken).toBe('jwt-token');
  });
});

describe('loginStaff — a TOTP code is single-use', () => {
  it('burns the step so the same code cannot be replayed', async () => {
    const recordTotpStep = jest.fn().mockResolvedValue(undefined);
    const { service } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(staff()),
      recordTotpStep,
    });

    await service.loginStaff({ ...LOGIN, totpToken: '123456' });

    // Verified is not accepted: with otplib's one-step window the same digits
    // stay valid for about ninety seconds, so the step has to be spent.
    expect(recordTotpStep).toHaveBeenCalledWith('staff-1', 58_000_000);
  });

  it('refuses a code whose step has already been spent', async () => {
    // What a second login with the same digits looks like: the conditional
    // write in the repository matches no row and raises.
    const { service } = build({
      findStaffByEmail: jest.fn().mockResolvedValue(staff()),
      recordTotpStep: jest.fn().mockRejectedValue(new Error('تم استخدام هذا الرمز بالفعل')),
    });

    await expect(
      service.loginStaff({ ...LOGIN, totpToken: '123456' }),
    ).rejects.toThrow(/تم استخدام هذا الرمز/);
  });

  it('does not burn a step when the code was wrong', async () => {
    const recordTotpStep = jest.fn();
    const { service } = build(
      { findStaffByEmail: jest.fn().mockResolvedValue(staff()), recordTotpStep },
      { totpVerifies: false },
    );

    await expect(service.loginStaff({ ...LOGIN, totpToken: '000000' })).rejects.toThrow();
    expect(recordTotpStep).not.toHaveBeenCalled();
  });
});

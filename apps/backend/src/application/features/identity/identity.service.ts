import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import {
  EMAIL_SENDER,
  PASSWORD_HASHER,
  TOTP_SERVICE,
  USER_REPOSITORY,
} from '../../../domain/interfaces/base-repository.interface';
import { EmailSender } from '../../../domain/interfaces/email-sender.interface';
import {
  PasswordHasher,
  TotpService,
} from '../../../domain/interfaces/otp-repository.interface';
import {
  CitizenChoice,
  UserRepository,
} from '../../../domain/interfaces/user-repository.interface';
import { StaffRole, User } from '../../../domain/entities/user.entity';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../common/exceptions';
import { OtpService } from './otp.service';
import { SessionRevocationService } from './session-revocation.service';
import { IssuedRefreshToken, StaffRefreshTokenService } from './staff-refresh-token.service';

/**
 * Compared against when a staff row has no `passwordHash`, so that a sign-in
 * attempt for an account that cannot have one costs the same ~250ms as a real
 * wrong password. A cost-12 bcrypt hash of a value nobody holds — it is never
 * matched, and the only properties that matter are that it is well-formed and
 * carries the same cost as the hashes `BcryptPasswordHasher` writes.
 */
/**
 * The `purpose` every password-reset token carries, and the label its signing
 * key is derived under. Bump the suffix to invalidate every outstanding link.
 */
const RESET_PURPOSE = 'PASSWORD_RESET';
const RESET_KEY_LABEL = 'password-reset.v1';

const ABSENT_PASSWORD_HASH = '$2b$12$0TQq.TFqu6SjurFnnRd/3eWT5wd9BsdSSqeoT8tSlia7rBFo8Pm6i';

/**
 * The two sentences a refused refresh answers with. The first for a request
 * that does not add up — no binding, no cookie, a cookie nobody issued; the
 * second for a session that did exist and is over, which is the one a clerk
 * can act on.
 */
/** The single token shape. Both citizens and staff carry exactly this. */
export interface SessionClaims {
  sub: string;
  tenantSlug: string;
  kind: 'STAFF' | 'CITIZEN';
  role?: StaffRole;
  /**
   * The account's `tokenVersion` when this token was minted.
   *
   * `JwtAuthGuard` compares it against the row on every request, which is what
   * makes a session revocable at all — role travels in this token and is
   * authorised from here, so without the comparison a dismissal or a demotion
   * waited for expiry.
   *
   * Optional on the type because tokens minted before the column existed do
   * not carry it; `SessionRevocationService` reads a missing value as 0, which
   * is every account's starting version.
   */
  tokenVersion?: number;
  /**
   * When this **session** ends for good, epoch seconds — STAFF only.
   *
   * Distinct from the token's own `exp`. `exp` is short, and every refresh
   * mints a token with a later one; this does not move. It is fixed once at
   * login from `JWT_STAFF_TTL` (or `JWT_STAFF_REMEMBER_TTL`), so a clerk who
   * works through the day still signs in again at the same wall-clock moment
   * they always have. Without a fixed cap a rotating refresh token is a
   * session that never ends.
   *
   * The authoritative copy is not this claim but the `expiresAt` of the
   * session's refresh-token family, which every token in the family inherits
   * and `refreshStaffSession` reads. The claim carries the same value so the
   * portal can show when the session ends, and so `issueSession` can clamp
   * `exp` to it; nothing on the server trusts it in place of the row.
   *
   * Optional because tokens minted before this existed do not carry it.
   */
  sessionExpiresAt?: number;
  /**
   * The refresh-token family this token was minted from — STAFF only.
   *
   * `JwtAuthGuard` asks on every request whether that family is still alive,
   * which is what lets a logout, or a refresh token presented after its chain
   * moved on, end the access token as well instead of leaving it to expire.
   * Absent from citizen tokens and from staff tokens minted before refresh
   * families existed; the guard skips the check for those.
   */
  sid?: string;
}

export interface SessionResult {
  accessToken: string;
  expiresIn: string;
  /**
   * When `accessToken` stops being accepted, ISO. The portal refreshes on the
   * 401 that follows rather than by this clock; it is carried so a proactive
   * refresh can be added without changing what a session is.
   */
  expiresAt?: string;
  /** When the session ends for good, ISO — STAFF only. No refresh past it. */
  sessionExpiresAt?: string;
  user: { id: string; name: string; kind: 'STAFF' | 'CITIZEN'; role?: StaffRole };
}

/** OTP succeeded, but the phone belongs to several household members. */
export interface DisambiguationRequired {
  status: 'CHOOSE_PROFILE';
  phone: string;
  choices: CitizenChoice[];
}

/**
 * The password was right and a second factor is still owed.
 *
 * Carries nothing else on purpose. Returning the account's name, role or
 * enrolment state here would hand a correct-password-wrong-device caller a
 * confirmation they had found a real administrator, which is most of what the
 * generic login error exists to withhold.
 */
export interface TotpChallengeRequired {
  status: 'TOTP_REQUIRED';
}

/**
 * A staff sign-in or refresh that succeeded: the access token for the response
 * body, and the refresh token for the cookie.
 *
 * Two fields rather than one flat object on purpose. The refresh token must
 * never reach a JSON body, so the controller has to pick out what it returns;
 * a handler that returned the grant whole would break the portal's sign-in
 * outright — noticed in minutes — rather than working while also handing page
 * script the one credential the cookie exists to keep from it.
 */
export interface StaffSessionGrant {
  session: SessionResult;
  refresh: IssuedRefreshToken;
}

export type StaffLoginResult = StaffSessionGrant | TotpChallengeRequired;

/**
 * A refresh is answered, not thrown. A refusal may also have to clear the
 * cookie, and controllers here hold no try/catch (see `DomainExceptionFilter`),
 * so the controller needs the refusal as a value to act on before it throws
 * it. `clearCookie` is the name of the cookie to clear, when there is one.
 */
export type StaffRefreshOutcome =
  | { ok: true; grant: StaffSessionGrant }
  | { ok: false; error: DomainError; clearCookie?: string };

@Injectable()
export class IdentityService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(TOTP_SERVICE) private readonly totp: TotpService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    private readonly otp: OtpService,
    private readonly revocation: SessionRevocationService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
    private readonly refreshTokens: StaffRefreshTokenService,
  ) {}

  // ────────────────────────────  Staff  ────────────────────────────

  /**
   * Email + password, verified against this municipality's own `users` row.
   *
   * Supabase Auth used to be the first call in this method, and it is now the
   * only staff path that no longer touches it. Nothing was lost in the move:
   * the session that comes back has always been this app's own JWT, signed with
   * `JWT_SECRET` and checked by `JwtAuthGuard` — Supabase's access token was
   * passed back to the caller and never read again, by anything. The hash is
   * already local and already authoritative: `changeStaffPassword`,
   * `StaffService.create` and `pnpm staff:create` all write `passwordHash` and
   * every other password check in this file already verifies against it. The
   * one remaining question Supabase answered here — "is this the right
   * password" — is the one it answered from a copy.
   *
   * A successful sign-in starts a refresh-token family and returns its first
   * token beside the access token, for the controller to set as a cookie.
   * Whatever refresh cookie the request already carried is neither read nor
   * revoked: the cookie is named per account, so this account's old one is
   * simply overwritten, and the family it belonged to can no longer be reached
   * from this browser and lapses at its own cap.
   */
  async loginStaff(input: {
    tenantSlug: string;
    email: string;
    password: string;
    totpToken?: string;
    /**
     * "تذكّرني على هذا الجهاز" — caps the session at JWT_STAFF_REMEMBER_TTL
     * instead of JWT_STAFF_TTL, and lets the refresh cookie outlive the browser
     * session.
     */
    remember?: boolean;
    context: { ip?: string; userAgent?: string };
  }): Promise<StaffLoginResult> {
    /**
     * 1. Resolve the staff profile that must already exist in this schema.
     *
     * A missing profile is a refusal, never a provisioning trigger. This block
     * used to create the row on the spot, taking the role and the municipality
     * from `supabaseResult.user.userMetadata` and defaulting them to
     * `SUPER_ADMIN` and *the slug in the request URL* — which meant any account
     * in the shared Supabase project could sign in at any municipality it had
     * no row in and be created as its administrator. `user_metadata` is
     * writable by the account holder through `auth.updateUser()`, so it is not
     * a claim this service may act on; and a fallback that compares the request
     * URL's slug to itself is not a tenant check.
     *
     * Staff accounts are created deliberately, in one of two places: a
     * SUPER_ADMIN inviting a colleague through `StaffService.create`, or
     * `pnpm staff:create` for the first account in a freshly provisioned
     * municipality. Both record who did it.
     */
    const user = await this.users.findStaffByEmail(input.email.toLowerCase());

    /**
     * 2. Verify the password against this schema's own hash.
     *
     * Deliberately not short-circuited on a missing row. The lookup now happens
     * *before* the password is checked, which it did not when Supabase answered
     * first, and returning early here would make "no such account" the fast
     * path and "wrong password" the slow one — a ~250ms bcrypt gap is a
     * perfectly usable oracle for enumerating which emails hold accounts, which
     * is the very thing the shared error message below exists to prevent.
     * `verifyStaffPassword` spends the same work either way.
     */
    const passwordMatches = await this.verifyStaffPassword(user?.passwordHash, input.password);

    if (!user || !passwordMatches) {
      // Same sentence as a wrong password, deliberately: distinguishing them
      // turns this route into a way to enumerate which emails hold accounts.
      throw new UnauthorizedError('بيانات الدخول غير صحيحة');
    }

    // Refuses a deactivated account
    user.assertMayStartSession();

    if (user.tenantSlug !== input.tenantSlug) {
      // A staff row from another municipality reaching this schema means the
      // factory handed out the wrong client. Refuse rather than proceed.
      throw new UnauthorizedError('بيانات الدخول غير صحيحة');
    }

    /**
     * The second factor, before any session exists.
     *
     * Returns a challenge rather than a session when a code is owed, which is
     * the contract `staffLoginResponseSchema` has always described and the
     * server has never honoured — `totpToken` arrived here and was dropped,
     * so enrolling an authenticator bought exactly nothing.
     */
    const challenge = await this.challengeTotp(user, input.totpToken);
    if (challenge) return challenge;

    /**
     * The refresh family first, before anything records that a sign-in happened.
     *
     * It is the one write here that can fail for a reason the rest cannot see
     * — above all, this code reaching a schema that migration 0059 has not
     * been applied to. Written first, that failure is a clean 5xx, with no
     * `lastLoginAt` and no «logged in» audit row for a session that was never
     * handed out.
     */
    const sessionExpiresAt = this.staffSessionCap(input.remember, Math.floor(Date.now() / 1000));
    const refresh = await this.refreshTokens.issueFamily({
      userId: user.id,
      tokenVersion: user.tokenVersion,
      persistent: input.remember === true,
      expiresAt: new Date(sessionExpiresAt * 1000),
    });

    await this.users.markLoggedIn(user.id);
    user.recordLogin(input.context);
    this.publish(user.pullEvents(), input.tenantSlug);

    const session = this.issueSession({
      id: user.id,
      name: user.fullName,
      kind: 'STAFF',
      role: user.role,
      tenantSlug: input.tenantSlug,
      tokenVersion: user.tokenVersion,
      sessionExpiresAt,
      sid: refresh.familyId,
    });

    return { session, refresh };
  }

  /**
   * The key password-reset tokens are signed with: HMAC(JWT_SECRET, label).
   *
   * Deliberately **not** `JWT_SECRET` itself. `JwtAuthGuard` authenticates any
   * token that verifies against that secret, names the right tenant and carries
   * a live `tokenVersion` — it never inspects `kind`, and `RolesGuard`
   * authorises from whatever `role` claim it finds. A reset token signed with
   * the session key would therefore *be* a session, and adding a `purpose`
   * check to the guard would only work for as long as everyone remembers it.
   * A separate key means a reset token fails at the signature, which is a
   * property of the crypto rather than of anyone's diligence.
   *
   * Derived rather than configured so there is no second secret to distribute,
   * and so an operator rotating `JWT_SECRET` rotates this with it.
   */
  private resetSigningKey(): string {
    return createHmac('sha256', this.config.getOrThrow<string>('JWT_SECRET'))
      .update(RESET_KEY_LABEL)
      .digest('hex');
  }

  private signResetToken(user: User): string {
    return this.jwt.sign(
      {
        sub: user.id,
        tenantSlug: user.tenantSlug,
        purpose: RESET_PURPOSE,
        tokenVersion: user.tokenVersion ?? 0,
      },
      {
        secret: this.resetSigningKey(),
        expiresIn: this.config.get<string>('PASSWORD_RESET_TTL', '30m'),
      },
    );
  }

  private verifyResetToken(token: string): {
    sub: string;
    tenantSlug: string;
    tokenVersion: number;
  } {
    let claims: { sub?: string; tenantSlug?: string; purpose?: string; tokenVersion?: number };
    try {
      claims = this.jwt.verify(token, { secret: this.resetSigningKey() });
    } catch {
      throw new UnauthorizedError('رابط إعادة التعيين غير صالح أو منتهي الصلاحية');
    }

    // Belt and braces. Nothing else is signed with this key today, so this can
    // only fire if something later starts using it — at which point a token
    // minted for that purpose must not be spendable here.
    if (claims.purpose !== RESET_PURPOSE || !claims.sub || typeof claims.tokenVersion !== 'number') {
      throw new UnauthorizedError('رابط إعادة التعيين غير صالح أو منتهي الصلاحية');
    }

    return {
      sub: claims.sub,
      tenantSlug: claims.tenantSlug ?? '',
      tokenVersion: claims.tokenVersion,
    };
  }

  /**
   * Where the emailed link points.
   *
   * `redirectTo` is caller-supplied, and this mail carries a credential — an
   * unchecked value here mails a working reset token to whatever host the
   * caller names. Supabase enforced an allow-list of redirect URLs for exactly
   * this reason; nothing would have enforced it once Supabase stopped being
   * involved. Anything that is not same-origin with `PUBLIC_PORTAL_URL` is
   * discarded rather than rejected, so a misconfigured client still produces a
   * working link to the right place instead of an error.
   */
  private resetLink(token: string, redirectTo?: string): string {
    const portal = this.config.get<string>('PUBLIC_PORTAL_URL');
    const base = (() => {
      if (!redirectTo || !portal) return portal;
      try {
        return new URL(redirectTo).origin === new URL(portal).origin ? redirectTo : portal;
      } catch {
        return portal;
      }
    })();

    if (!base) {
      // No portal URL configured: hand back the bare token rather than a link
      // to nowhere, so the message is still actionable by someone who knows
      // where the page lives.
      return token;
    }

    const url = new URL(base);
    url.searchParams.set('token', token);
    return url.toString();
  }

  /**
   * One bcrypt comparison, whatever the caller found.
   *
   * A staff row with no `passwordHash` cannot sign in — that is the whole
   * answer, and it is the safe one: the column is nullable, so a row written
   * before the hash existed, or by a path that skipped it, must not be treated
   * as "no password required". It still costs a comparison, for the timing
   * reason in `loginStaff`; the placeholder is a real cost-12 hash of a value
   * nobody holds, because comparing against a malformed one returns early and
   * would reintroduce the gap this exists to close.
   */
  private async verifyStaffPassword(
    passwordHash: string | undefined,
    password: string,
  ): Promise<boolean> {
    if (!passwordHash) {
      await this.hasher.verify(password, ABSENT_PASSWORD_HASH);
      return false;
    }

    return this.hasher.verify(password, passwordHash);
  }

  /**
   * Decides what the second factor owes this login, and enforces it.
   *
   * Returns a challenge when a code is required and none was sent, `null` when
   * the login may proceed, and throws when a code was sent and is wrong. The
   * three outcomes are deliberately distinct: a challenge is not a failure, and
   * answering it with the same `UnauthorizedError` a wrong code gets would
   * leave the client unable to tell "ask for a code" from "you got it wrong".
   *
   * Enforcement follows enrolment rather than role for everyone except
   * SUPER_ADMIN. An AUDITOR who has set up an authenticator is asked for it —
   * having enrolled, being able to sign in without it is precisely the defect
   * this closes.
   */
  private async challengeTotp(
    user: User,
    token?: string,
  ): Promise<TotpChallengeRequired | null> {
    const secret = user.totpSecret;

    if (!user.hasConfirmedTotp || !secret) {
      return null;
    }

    if (!token) return { status: 'TOTP_REQUIRED' };

    if (!this.totp.verify(token, secret)) {
      throw new UnauthorizedError('رمز التحقق غير صحيح');
    }

    /**
     * Verified is not yet accepted: the code must also be one this account has
     * not already used.
     *
     * `otplib` runs with a one-step window, so a given six digits verify for
     * roughly ninety seconds. That window is exactly long enough for a code
     * observed over a shoulder, relayed through a phishing page, or left on a
     * shared municipal screen to be replayed. Burning the step closes it.
     *
     * The write is conditional inside the repository, so two logins racing
     * with the same code cannot both win; the loser lands here as a replay.
     */
    await this.users.recordTotpStep(user.id, this.totp.currentStep());

    return null;
  }

  /** Enrolment: hands back the otpauth:// URI for the authenticator app. */
  async beginTotpEnrolment(
    userId: string,
    tenantSlug: string,
  ): Promise<{ secret: string; keyUri: string }> {
    const user = await this.users.findById(userId);
    if (!user || user.kind !== 'STAFF') {
      throw new NotFoundError('Staff user', userId);
    }

    const secret = this.totp.generateSecret();
    await this.users.saveTotpSecret(user.id, secret);

    // Recorded because issuing a new second factor is exactly the step an
    // account takeover needs, and the trail is the only place that would show
    // it happening. The secret itself is never part of the payload.
    this.events.emit('staff.changed', {
      action: 'TOTP_ENROLLED',
      tenantSlug,
      staffId: user.id,
      actorId: user.id,
      actorRole: user.role ?? '',
    });

    return {
      secret,
      keyUri: this.totp.keyUri(secret, user.email ?? user.id, `Baladiya ${tenantSlug}`),
    };
  }

  /** Confirms enrolment only after the admin proves the app produces valid codes. */
  async confirmTotpEnrolment(userId: string, token: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user || !user.totpSecret) {
      throw new NotFoundError('TOTP enrolment', userId);
    }
    if (!this.totp.verify(token, user.totpSecret)) {
      throw new UnauthorizedError('رمز التحقق غير صحيح');
    }

    await this.users.confirmTotp(user.id);

    this.events.emit('staff.changed', {
      action: 'TOTP_CONFIRMED',
      tenantSlug: user.tenantSlug,
      staffId: user.id,
      actorId: user.id,
      actorRole: user.role ?? '',
    });
  }

  /**
   * Disable TOTP enrolment for a staff user.
   */
  async disableTotp(
    userId: string,
    tenantSlug: string,
    currentPassword?: string,
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user || user.kind !== 'STAFF') {
      throw new NotFoundError('Staff user', userId);
    }

    if (currentPassword && user.passwordHash) {
      const match = await this.hasher.verify(currentPassword, user.passwordHash);
      if (!match) {
        throw new UnauthorizedError('كلمة المرور الحالية غير صحيحة');
      }
    }

    await this.users.disableTotp(user.id);

    this.events.emit('staff.changed', {
      action: 'TOTP_DISABLED',
      tenantSlug,
      staffId: user.id,
      actorId: user.id,
      actorRole: user.role ?? '',
    });
  }

  /**
   * Change own password. Verifies the current one, rewrites `passwordHash`,
   * and drops the cached token version so live sessions end immediately.
   */
  async changeStaffPassword(
    userId: string,
    tenantSlug: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user || user.kind !== 'STAFF' || !user.passwordHash) {
      throw new NotFoundError('Staff user', userId);
    }

    const match = await this.hasher.verify(currentPassword, user.passwordHash);
    if (!match) {
      throw new UnauthorizedError('كلمة المرور الحالية غير صحيحة');
    }

    const passwordHash = await this.hasher.hash(newPassword);
    await this.users.updateStaff(user.id, { passwordHash });
    // `updateStaff` bumps tokenVersion, but the guard reads that through a
    // cached copy — without this the old sessions keep working for the rest of
    // the cache window, which is exactly the window that matters when someone
    // changes their password because they think it leaked.
    // `StaffService` has always done this; this path never did.
    await this.revocation.forget(user.id);

    this.events.emit('staff.changed', {
      action: 'STAFF_PASSWORD_CHANGED',
      tenantSlug,
      staffId: user.id,
      actorId: user.id,
      actorRole: user.role ?? '',
    });
  }

  /**
   * Change own email. Verifies the current password first, then checks the new
   * address is not already taken in this municipality.
   */
  async changeStaffEmail(
    userId: string,
    tenantSlug: string,
    newEmail: string,
    currentPassword: string,
  ): Promise<{ email: string }> {
    const user = await this.users.findById(userId);
    if (!user || user.kind !== 'STAFF' || !user.passwordHash) {
      throw new NotFoundError('Staff user', userId);
    }

    const match = await this.hasher.verify(currentPassword, user.passwordHash);
    if (!match) {
      throw new UnauthorizedError('كلمة المرور الحالية غير صحيحة');
    }

    const nextEmail = newEmail.trim().toLowerCase();
    if (nextEmail === user.email?.toLowerCase()) {
      return { email: nextEmail };
    }

    const existing = await this.users.findStaffByEmail(nextEmail);
    if (existing) {
      throw new ConflictError('البريد الإلكتروني مستخدم بالفعل من قبل موظف آخر');
    }

    await this.users.updateStaff(user.id, { email: nextEmail });

    this.events.emit('staff.changed', {
      action: 'STAFF_EMAIL_CHANGED',
      tenantSlug,
      staffId: user.id,
      actorId: user.id,
      actorRole: user.role ?? '',
    });

    return { email: nextEmail };
  }

  /**
   * Mints a reset link and mails it.
   *
   * Supabase used to do both halves of this, and the token it minted was
   * verified with `auth.getUser()` — which accepts **any** access token the
   * project ever issued, not only one from a recovery link. That was survivable
   * only while every local password write also rewrote the Supabase copy, so a
   * rotated password invalidated both. Once that mirror stopped (the account
   * methods are no-ops now), a password leaked before the cutover would have
   * stayed a permanent key to this endpoint: sign in to Supabase with the old
   * password, hand the resulting token to `confirm-password-reset`, and set the
   * current one. The token below is ours, so that class of confusion is gone.
   *
   * Fails closed when no mail provider is configured. The tempting alternative
   * — keep falling back to Supabase until SMTP exists — is the vulnerability
   * above with a longer deadline. An administrator can still set a password
   * directly through `StaffService.update`, which is the path to use until
   * `SMTP_HOST` and `MAIL_FROM` are set.
   */
  async sendStaffPasswordResetEmail(
    userId: string,
    redirectTo?: string,
  ): Promise<{ message: string }> {
    const user = await this.users.findById(userId);
    if (!user || user.kind !== 'STAFF' || !user.email) {
      throw new NotFoundError('Staff user', userId);
    }

    if (!this.email.isConfigured) {
      throw new ConflictError(
        'إعادة تعيين كلمة المرور بالبريد غير مُفعّلة — يرجى مراجعة مسؤول النظام لتعيين كلمة مرور جديدة',
      );
    }

    const link = this.resetLink(this.signResetToken(user), redirectTo);

    await this.email.send({
      to: user.email,
      subject: 'إعادة تعيين كلمة المرور',
      text: [
        `مرحباً ${user.fullName}،`,
        '',
        'لتعيين كلمة مرور جديدة، افتح الرابط التالي:',
        link,
        '',
        'ينتهي هذا الرابط خلال وقت قصير ويُستخدم مرة واحدة فقط.',
        'إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة — لن يتغيّر شيء.',
      ].join('\n'),
    });

    return { message: 'تم إرسال بريد إعادة تعيين كلمة المرور بنجاح' };
  }

  /**
   * Sets a new password from the reset-password landing page.
   *
   * The token is this service's own, signed with a key derived from
   * `JWT_SECRET` rather than `JWT_SECRET` itself — see `resetSigningKey`. It
   * names the account, so nothing here is resolved from caller-supplied input,
   * and it carries the `tokenVersion` current when it was minted. Writing the
   * new password bumps that version, which is what makes the link single-use
   * without a table to store it in: the second attempt fails the comparison.
   */
  async confirmStaffPasswordReset(accessToken: string, newPassword: string): Promise<void> {
    const claims = this.verifyResetToken(accessToken);

    const user = await this.users.findById(claims.sub);
    // Every failure past this point answers with the same sentence as an
    // expired link. Saying "no such account" or "this account is deactivated"
    // turns a public endpoint into a way to ask questions about staff.
    if (!user || user.kind !== 'STAFF' || !user.isActive) {
      throw new UnauthorizedError('رابط إعادة التعيين غير صالح أو منتهي الصلاحية');
    }

    /**
     * Single use, and revoked by anything else that touched the account.
     *
     * A link mailed an hour ago is void if the password has since been changed,
     * the role edited, or the account deactivated — every one of those bumps
     * `tokenVersion`. That is the property a reset link needs and the reason
     * this needs no storage: the account itself remembers.
     */
    if ((user.tokenVersion ?? 0) !== claims.tokenVersion) {
      throw new UnauthorizedError('رابط إعادة التعيين غير صالح أو منتهي الصلاحية');
    }

    const passwordHash = await this.hasher.hash(newPassword);
    await this.users.updateStaff(user.id, { passwordHash });
    // Reset is the case where a stale cache is least acceptable: it is the
    // button someone presses when they believe an attacker holds their
    // password, and that attacker's session is live right now.
    await this.revocation.forget(user.id);

    this.events.emit('staff.changed', {
      action: 'STAFF_PASSWORD_CHANGED',
      tenantSlug: user.tenantSlug,
      staffId: user.id,
      actorId: user.id,
      actorRole: user.role ?? '',
    });
  }

  // ───────────────────────────  Citizens  ───────────────────────────

  async requestOtp(phone: string, attempt = 1) {
    return this.otp.issue(phone, attempt);
  }

  /** Whether the citizen login page should collect a code. See `OtpService`. */
  get otpRequired(): boolean {
    return this.otp.enabled;
  }

  /**
   * Citizen sign-in by رقم مرجعي **and** phone number.
   *
   * The reference number alone is not accepted, and that is deliberate: it is
   * printed on a receipt and read aloud at a counter, so treating it as a lone
   * credential would make a citizen's national ID and residency status
   * readable by anyone who glanced at a slip of paper. Requiring the phone on
   * file alongside it is the weakest bar this data can defensibly sit behind.
   *
   * Both failures return the same message for the same reason every other
   * login path here does — a distinct "no such reference" turns this endpoint
   * into a way to enumerate which references exist.
   */
  async loginByReference(input: {
    tenantSlug: string;
    referenceNumber: string;
    phone: string;
    context: { ip?: string; userAgent?: string };
  }): Promise<SessionResult> {
    const citizen = await this.users.findCitizenByReference(input.referenceNumber);

    // Compared here rather than in the query so a wrong phone costs the same
    // work as a wrong reference.
    const phoneMatches =
      citizen?.phone != null && normalisePhone(citizen.phone) === normalisePhone(input.phone);

    if (!citizen || !phoneMatches) {
      throw new UnauthorizedError('الرقم المرجعي أو رقم الهاتف غير صحيح');
    }

    citizen.assertMayStartSession();

    await this.users.markLoggedIn(citizen.id);
    citizen.recordLogin(input.context);
    this.publish(citizen.pullEvents(), input.tenantSlug);

    return this.issueSession({
      id: citizen.id,
      name: citizen.fullName,
      kind: 'CITIZEN',
      tenantSlug: input.tenantSlug,
      tokenVersion: citizen.tokenVersion,
    });
  }

  /**
   * Citizen sign-in by رقم مرجعي alone — the portal's front door.
   *
   * Separate from `loginByReference` rather than a flag on it, so that neither
   * caller can drift into the other's security posture by accident: the
   * payments portal keeps demanding a phone, and only the route that opted into
   * the single-factor bar gets it. See `referenceOnlyLoginSchema` for why the
   * municipality accepts that bar and what actually protects it.
   *
   * The error is the same sentence a wrong-format entry gets, and deliberately
   * does not distinguish "no such reference" from "that citizen is blocked" —
   * a distinct message would turn this into a way to test which references
   * exist.
   */
  async loginByReferenceOnly(input: {
    tenantSlug: string;
    referenceNumber: string;
    context: { ip?: string; userAgent?: string };
  }): Promise<SessionResult> {
    const citizen = await this.users.findCitizenByReference(input.referenceNumber);

    if (!citizen) {
      throw new UnauthorizedError('الرقم المرجعي غير صحيح');
    }

    citizen.assertMayStartSession();

    await this.users.markLoggedIn(citizen.id);
    citizen.recordLogin(input.context);
    this.publish(citizen.pullEvents(), input.tenantSlug);

    return this.issueSession({
      id: citizen.id,
      name: citizen.fullName,
      kind: 'CITIZEN',
      tenantSlug: input.tenantSlug,
      tokenVersion: citizen.tokenVersion,
    });
  }

  /**
   * Verifies the code, then resolves *which person* is logging in.
   *
   * A household sharing one phone is the normal case, not an edge case, so a
   * phone matching several profiles returns a choice rather than guessing — and
   * the choice is only offered after the code proved the caller holds the phone.
   */
  async verifyOtp(input: {
    tenantSlug: string;
    phone: string;
    /** Absent only when OTP is switched off — `otp.verify` enforces it. */
    code?: string;
    citizenId?: string;
    context: { ip?: string; userAgent?: string };
  }): Promise<SessionResult | DisambiguationRequired> {
    // `?? ''` rather than a guard: an empty code fails the hash compare inside
    // `verify` exactly like a wrong one, so a client omitting it while OTP is
    // on is refused by the same path as a client sending six wrong digits.
    const phone = await this.otp.verify(input.phone, input.code ?? '');
    const candidates = await this.users.findCitizensByPhone(phone);

    if (candidates.length === 0) {
      throw new NotFoundError('لا يوجد طلب مسجّل بهذا الرقم');
    }

    if (candidates.length > 1 && !input.citizenId) {
      return { status: 'CHOOSE_PROFILE', phone, choices: candidates };
    }

    const chosenId = input.citizenId ?? candidates[0].id;

    // The chosen id must be one the OTP actually covered — otherwise a valid
    // code for one phone would authenticate any citizen whose id was guessed.
    if (!candidates.some((candidate) => candidate.id === chosenId)) {
      throw new UnauthorizedError('اختيار غير صالح');
    }

    const user = await this.users.findById(chosenId);
    if (!user) {
      throw new NotFoundError('Citizen', chosenId);
    }

    user.assertMayStartSession();

    await this.users.markLoggedIn(user.id);
    user.recordLogin(input.context);
    this.publish(user.pullEvents(), input.tenantSlug);

    return this.issueSession({
      id: user.id,
      name: user.fullName,
      kind: 'CITIZEN',
      tenantSlug: input.tenantSlug,
      tokenVersion: user.tokenVersion,
    });
  }

  // ────────────────────────────  Shared  ────────────────────────────

  /**
   * Renews a staff session from its refresh cookie, without a new sign-in.
   *
   * Two things are needed, and neither is enough alone:
   *
   * 1. **The refresh token**, from the httpOnly cookie — the credential. It is
   *    opaque, stored only as a keyed hash, and consumed by the exchange: each
   *    refresh returns its successor, and `StaffRefreshTokenService` decides
   *    whether a token presented a second time is a client whose answer was
   *    lost or a copy being replayed.
   * 2. **The tab's own access token**, as `Authorization: Bearer` — the
   *    binding (see `bindTab`). It is read with its expiry ignored, because a
   *    tab usually refreshes precisely because its token has expired, and for
   *    that reason it is never accepted as the renewal credential: nothing is
   *    minted from it. It says only which account this tab belongs to, so the
   *    right cookie is read and a tab can never be handed another account's
   *    session. It is also what ends a session without «تذكّرني» when the tab
   *    closes: the access token lived in that tab's sessionStorage, and the
   *    cookie is useless without it.
   *
   * Then, on every exchange, everything neither token can speak for:
   *
   * - **The family** — its root not revoked (logout, reuse) and not past its
   *   `expiresAt`. That is the session cap, fixed at login and inherited by
   *   every token in the family, so however often a session is refreshed it
   *   ends at the wall-clock moment the sign-in set.
   * - **The account** — still staff, still this municipality, still active, and
   *   at the `tokenVersion` the family began at. A password change, a role
   *   edit or a deactivation ends the family here, not only in the guard.
   * - **The role** — re-read from the row rather than carried over, so a
   *   promotion or demotion reaches the session at the next refresh rather
   *   than the next sign-in. `RolesGuard` authorises from the token's claim, so
   *   a stale one is an authorisation decision made on old information.
   *
   * Refusals come back as values so the controller can clear the cookie before
   * it throws. One about the binding leaves the cookie alone and writes
   * nothing: the cookie may be serving a healthy tab of the same account, and a
   * request that cannot say whose session it is must not be able to end one.
   * An infrastructure error is not a refusal — it propagates as a 5xx, cookie
   * untouched, and the portal treats it as a connection problem.
   */
  async refreshStaffSession(input: {
    accessToken?: string;
    tenantSlug: string;
    readCookie: (name: string) => string | undefined;
  }): Promise<StaffRefreshOutcome> {
    const claims = this.bindTab(input.accessToken, input.tenantSlug);
    if (!claims) return refused('SESSION_INVALID');

    const cookieName = this.refreshTokens.cookieNameFor(claims.sub);
    const presented = input.readCookie(cookieName);
    if (!presented) return refused('SESSION_INVALID');

    const row = await this.refreshTokens.find(presented);
    if (!row) return refused('SESSION_INVALID', cookieName);

    // The cookie's name is this account's, so a row belonging to anyone else
    // was put there by something other than this service. Refuse, and neither
    // write nor clear on the strength of it.
    if (row.userId !== claims.sub) return refused('SESSION_INVALID');

    const now = new Date();

    const root = await this.refreshTokens.familyRoot(row.familyId);
    if (!root || root.revokedAt) return refused('SESSION_ENDED', cookieName);
    if (root.expiresAt <= now) return refused('SESSION_ENDED', cookieName);

    const user = await this.users.findById(row.userId);
    if (!user || user.kind !== 'STAFF' || user.tenantSlug !== input.tenantSlug) {
      await this.refreshTokens.revokeFamily(row.familyId, now);
      return refused('SESSION_INVALID', cookieName);
    }

    // The guard does not run on this route — the access token is usually
    // expired — so a deactivated account is refused here, and its family ended
    // so the cookie is not tried again on every page load.
    try {
      user.assertMayStartSession();
    } catch (error) {
      if (!(error instanceof ForbiddenError)) throw error;
      await this.refreshTokens.revokeFamily(row.familyId, now);
      return { ok: false, error, clearCookie: cookieName };
    }

    if (user.tokenVersion !== row.tokenVersion) {
      await this.refreshTokens.revokeFamily(row.familyId, now);
      return refused('SESSION_ENDED', cookieName);
    }

    const exchanged = await this.refreshTokens.exchange(row, now);

    if (exchanged.outcome === 'reused') {
      // Recorded only when this request is the one that ended the family. Its
      // other copies arriving afterwards find it revoked and change nothing,
      // and a trail with one row per replay would bury the one that matters.
      if (exchanged.revoked > 0) {
        this.auditSession('STAFF_SESSION_REUSE_DETECTED', user, input.tenantSlug);
      }
      return refused('SESSION_ENDED', cookieName);
    }

    if (exchanged.outcome === 'ended') return refused('SESSION_ENDED', cookieName);

    const session = this.issueSession({
      id: user.id,
      name: user.fullName,
      kind: 'STAFF',
      role: user.role,
      tenantSlug: input.tenantSlug,
      tokenVersion: user.tokenVersion,
      sessionExpiresAt: Math.floor(root.expiresAt.getTime() / 1000),
      sid: row.familyId,
    });

    return { ok: true, grant: { session, refresh: exchanged.next } };
  }

  /**
   * Ends this tab's sign-in on the server.
   *
   * The family is revoked, so the cookie cannot be exchanged again and —
   * through `sid` in `JwtAuthGuard` — the access token stops working as well,
   * instead of living out its idle window in whatever copied it.
   *
   * It needs the tab's binding, as a refresh does and for the same reason: the
   * cookie to read is named per account, and only the tab can say which
   * account. Without a binding this is a no-op rather than an error. The portal
   * clears its own storage whatever the answer, and a request that cannot say
   * whose session it is must not be able to end one.
   *
   * The family comes from the cookie when it resolves to this account, and
   * from the access token's `sid` when it does not (the cookie already gone,
   * or blocked). When both resolve and differ — the same account signed in
   * again in another tab, which replaced the cookie — both end: the cookie's
   * because it is this browser's credential for the account, and the `sid`'s
   * because it is the access token this tab is holding.
   *
   * No transaction around the revocations: each is idempotent, and a failure
   * between them leaves a family the next attempt ends.
   */
  async logoutStaff(input: {
    accessToken?: string;
    tenantSlug: string;
    readCookie: (name: string) => string | undefined;
  }): Promise<{ clearCookie?: string }> {
    const claims = this.bindTab(input.accessToken, input.tenantSlug);
    if (!claims) return {};

    const cookieName = this.refreshTokens.cookieNameFor(claims.sub);
    const presented = input.readCookie(cookieName);

    const families = new Set<string>();
    if (presented) {
      const row = await this.refreshTokens.find(presented);
      if (row && row.userId === claims.sub) families.add(row.familyId);
    }
    if (claims.sid) {
      const root = await this.refreshTokens.familyRoot(claims.sid);
      if (root && root.userId === claims.sub) families.add(root.familyId);
    }

    let revoked = 0;
    for (const familyId of families) {
      revoked += await this.refreshTokens.revokeFamily(familyId);
    }

    // Only a logout that ended something is one worth recording; a second
    // click, or a tab whose session had already lapsed, is not an event.
    if (revoked > 0) {
      const user = await this.users.findById(claims.sub);
      if (user) this.auditSession('STAFF_LOGOUT', user, input.tenantSlug);
    }

    // Cleared only when the request carried it: a clear for a cookie the
    // browser does not hold is noise, and the name is this account's alone.
    return presented ? { clearCookie: cookieName } : {};
  }

  /**
   * Which staff account this tab belongs to — the binding a refresh and a
   * logout need beside the cookie.
   *
   * `ignoreExpiration`, and nothing else relaxed: the signature is verified,
   * so only tokens this service minted are read at all. What comes back is
   * never a credential. Nothing is minted from it and nothing is authorised by
   * it; it names the account whose cookie to read, and the row that cookie
   * resolves to must then belong to that same account.
   *
   * Citizens have no refresh path — see `issueSession` — so a citizen token
   * binds nothing, and neither does one from another municipality.
   */
  private bindTab(accessToken: string | undefined, tenantSlug: string): SessionClaims | null {
    if (!accessToken) return null;

    let claims: SessionClaims;
    try {
      claims = this.jwt.verify<SessionClaims>(accessToken, { ignoreExpiration: true });
    } catch {
      return null;
    }

    if (claims.kind !== 'STAFF' || claims.tenantSlug !== tenantSlug) return null;
    if (typeof claims.sub !== 'string' || claims.sub === '') return null;

    return claims;
  }

  /**
   * Session events on the audit trail, through the `staff.changed` listener
   * every other account event already uses.
   *
   * Only for a staff account that has a role: `actorRole` is an enum column,
   * and an insert it refuses is an audit row lost to a log line.
   */
  private auditSession(
    action: 'STAFF_LOGOUT' | 'STAFF_SESSION_REUSE_DETECTED',
    user: User,
    tenantSlug: string,
  ): void {
    if (user.kind !== 'STAFF' || !user.role) return;

    this.events.emit('staff.changed', {
      action,
      tenantSlug,
      staffId: user.id,
      actorId: user.id,
      actorRole: user.role,
    });
  }

  /**
   * The session's hard deadline, epoch seconds — fixed once, at sign-in.
   *
   * `JWT_STAFF_TTL` and `JWT_STAFF_REMEMBER_TTL` keep the values they have
   * always had and keep meaning the same thing to an operator — how long a
   * sign-in lasts. What changed is which expiry they name: they used to be the
   * token's, and are now the session's. A clerk still signs in again after
   * eight hours; they no longer get thrown out mid-form at hour eight and lose
   * what was on screen.
   */
  private staffSessionCap(remember: boolean | undefined, nowSeconds: number): number {
    return (
      nowSeconds +
      durationToSeconds(
        this.config.get<string>(
          remember ? 'JWT_STAFF_REMEMBER_TTL' : 'JWT_STAFF_TTL',
          remember ? '30d' : '8h',
        ),
        remember ? 30 * 24 * 3600 : 8 * 3600,
      )
    );
  }

  /**
   * One issuer, one signing key, one claim shape for both kinds of user — which
   * is the entire reason v2 merged the two auth systems.
   */
  private issueSession(input: {
    id: string;
    name: string;
    kind: 'STAFF' | 'CITIZEN';
    role?: StaffRole;
    tenantSlug: string;
    /** STAFF only, and only read when no `sessionExpiresAt` is passed — see `staffSessionCap`. */
    remember?: boolean;
    /** Stamped into the token and compared on every request thereafter. */
    tokenVersion: number;
    /**
     * STAFF only: the session cap. Computed once by `loginStaff`, and read back
     * from the family's root row by `refreshStaffSession`.
     *
     * Passed in rather than recomputed, which is what stops a refreshed session
     * from walking its own deadline forward every time it is renewed.
     */
    sessionExpiresAt?: number;
    /** STAFF only: the refresh-token family this token belongs to — see `SessionClaims.sid`. */
    sid?: string;
  }): SessionResult {
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (input.kind !== 'STAFF') {
      // Citizens are unchanged: one token, one lifetime, no refresh. They open
      // the portal to check a fee and close it, so a mid-session expiry costs
      // them a sign-in they were about to do anyway.
      const expiresIn = this.config.get<string>('JWT_CITIZEN_TTL', '7d');
      const claims: SessionClaims = {
        sub: input.id,
        tenantSlug: input.tenantSlug,
        kind: input.kind,
        tokenVersion: input.tokenVersion,
      };

      return {
        accessToken: this.jwt.sign(claims, { expiresIn }),
        expiresIn,
        user: { id: input.id, name: input.name, kind: input.kind, role: input.role },
      };
    }

    const sessionExpiresAt =
      input.sessionExpiresAt ?? this.staffSessionCap(input.remember, nowSeconds);

    /**
     * The token's own life: the idle window, clamped to the cap.
     *
     * Clamping is what makes the last token of a session expire exactly at the
     * deadline instead of a half-hour past it. Without it the final refresh
     * before the cap would mint a token outliving the session it belongs to,
     * and the guard's family check (`isFamilyLive` reads the root's
     * `expiresAt`) would be the only thing refusing it — one check standing
     * where two should.
     */
    const idleSeconds = durationToSeconds(
      this.config.get<string>('JWT_STAFF_IDLE_TTL', '30m'),
      30 * 60,
    );
    const expiresIn = Math.max(1, Math.min(idleSeconds, sessionExpiresAt - nowSeconds));

    const claims: SessionClaims = {
      sub: input.id,
      tenantSlug: input.tenantSlug,
      kind: input.kind,
      ...(input.role ? { role: input.role } : {}),
      tokenVersion: input.tokenVersion,
      sessionExpiresAt,
      ...(input.sid ? { sid: input.sid } : {}),
    };

    return {
      accessToken: this.jwt.sign(claims, { expiresIn }),
      expiresIn: `${expiresIn}s`,
      expiresAt: new Date((nowSeconds + expiresIn) * 1000).toISOString(),
      sessionExpiresAt: new Date(sessionExpiresAt * 1000).toISOString(),
      user: { id: input.id, name: input.name, kind: input.kind, role: input.role },
    };
  }

  private publish(events: ReturnType<typeof Array.prototype.slice>, tenantSlug: string): void {
    for (const event of events as Array<{ name: string; payload: Record<string, unknown> }>) {
      this.events.emit(event.name, { ...event.payload, tenantSlug });
    }
  }
}

/**
 * Reads the duration strings the JWT options already use — `8h`, `30d`, `30m`.
 *
 * This exists because the session cap has to be a *number* the claim can carry
 * and the refresh can compare, while `JWT_STAFF_TTL` has always been a string
 * handed straight to `jsonwebtoken`. Rather than change the variable's format —
 * which would break every existing deployment's configuration for no gain —
 * the same string is parsed here.
 *
 * Accepts the subset `ms` supports that these settings have ever used, and
 * falls back rather than throwing: a typo in a TTL must not take the login
 * route down with it, and the default is the documented value.
 */
function durationToSeconds(value: string, fallbackSeconds: number): number {
  const match = /^(\d+)\s*(s|m|h|d)?$/.exec(value.trim());
  if (!match) return fallbackSeconds;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return fallbackSeconds;

  // A bare number is seconds, which is what `jsonwebtoken` does with one too.
  const unit = match[2] ?? 's';
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1;
  return amount * multiplier;
}

/** A 401 refresh refusal, clearing the named cookie when there is one to clear. */
function refused(code: 'SESSION_INVALID' | 'SESSION_ENDED', clearCookie?: string): StaffRefreshOutcome {
  return {
    ok: false,
    error: new UnauthorizedError({
      code,
      message: code === 'SESSION_ENDED' ? 'The staff session has ended' : 'Invalid or expired session',
    }),
    ...(clearCookie ? { clearCookie } : {}),
  };
}

/**
 * Strips formatting so `03 123456`, `+96103123456` and `0096103123456` all
 * compare equal. Not `PhoneNumber.parse` — that throws on a malformed input,
 * and a citizen mistyping their number at the login box should be told their
 * details do not match, not handed a validation error that reveals the
 * reference number itself was fine.
 */
function normalisePhone(value: string): string {
  return value.replace(/[\s-()]/g, '').replace(/^(\+961|00961|0)/, '');
}

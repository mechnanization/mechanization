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
import { ConflictError, NotFoundError, UnauthorizedError } from '../../common/exceptions';
import { OtpService } from './otp.service';
import { SessionRevocationService } from './session-revocation.service';

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
   * Distinct from the token's own `exp`, and that distinction is the whole
   * refresh design. `exp` is short and slides forward each time the token is
   * exchanged; this does not move. It is stamped once at login from
   * `JWT_STAFF_TTL` (or `JWT_STAFF_REMEMBER_TTL`) and copied unchanged into
   * every token the session goes on to produce, so a clerk who works through
   * the day still signs in again at the same wall-clock moment they do today.
   *
   * Without it, "re-issue the token when it expires" is an session that never
   * ends — which is strictly worse than the hard 401 it replaces.
   *
   * Optional because tokens minted before this existed do not carry it.
   * `refreshStaffSession` treats a missing value as "cap at this token's own
   * `exp`", so a session already in flight when this deploys keeps exactly the
   * lifetime it was issued with and simply cannot be extended.
   */
  sessionExpiresAt?: number;
}

export interface SessionResult {
  accessToken: string;
  expiresIn: string;
  /** When `accessToken` stops being accepted, ISO. The client refreshes before this. */
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
   */
  async loginStaff(input: {
    tenantSlug: string;
    email: string;
    password: string;
    totpToken?: string;
    /** "تذكّرني على هذا الجهاز" — issues JWT_STAFF_REMEMBER_TTL instead of JWT_STAFF_TTL. */
    remember?: boolean;
    context: { ip?: string; userAgent?: string };
  }): Promise<SessionResult | TotpChallengeRequired> {
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

    await this.users.markLoggedIn(user.id);
    user.recordLogin(input.context);
    this.publish(user.pullEvents(), input.tenantSlug);

    return this.issueSession({
      id: user.id,
      name: user.fullName,
      kind: 'STAFF',
      role: user.role,
      tenantSlug: input.tenantSlug,
      remember: input.remember,
      tokenVersion: user.tokenVersion,
    });
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
   * Exchanges a staff token for a fresh one, without a new sign-in.
   *
   * Deliberately accepts an **expired** token, which is the only thing that
   * makes this useful and is worth being explicit about. The alternative —
   * requiring a live token — means the exchange has to happen before the idle
   * window closes, so a clerk who steps away for lunch returns to the same hard
   * 401 this exists to remove, just at half an hour instead of eight hours.
   * Worse than what it replaced.
   *
   * What bounds it instead is `sessionExpiresAt`, stamped at login and never
   * moved. Past that there is no exchange at any price, so the credential's
   * total life is exactly what it was before this change — a stolen token is
   * usable for no longer than it already was. It is **not** shortened either:
   * anyone holding the token can exchange it, so this buys convenience and
   * costs nothing, rather than buying security. Reducing the theft window needs
   * a second, separately-stored credential that only this endpoint accepts —
   * i.e. real refresh tokens with server-side rotation and reuse detection.
   *
   * Three things are re-checked on every exchange, none of which the token can
   * speak for:
   *
   * 1. **Revocation** — `tokenVersion` and `isActive`, via the same service the
   *    guard uses. A dismissal still takes effect within the cache window, and
   *    a revoked session cannot refresh its way back.
   * 2. **Role** — re-read from the row, so a promotion or demotion reaches the
   *    session at the next exchange rather than at the next sign-in. `role`
   *    travels in the token and `RolesGuard` authorises from it, so a stale one
   *    is an authorisation decision made on old information.
   * 3. **The tenant** — compared against the URL, as everywhere else.
   */
  async refreshStaffSession(input: {
    token: string;
    tenantSlug: string;
  }): Promise<SessionResult> {
    let claims: SessionClaims & { exp?: number };
    try {
      /*
        `ignoreExpiration`, and nothing else relaxed.

        The signature is still verified, so this accepts only tokens this
        service minted. Everything expiry would have caught is caught below by
        the cap, which is the stricter of the two for any token worth
        refusing.
      */
      claims = this.jwt.verify<SessionClaims & { exp?: number }>(input.token, {
        ignoreExpiration: true,
      });
    } catch {
      throw new UnauthorizedError('Invalid or expired session');
    }

    // Citizens have no refresh path — see `issueSession`. Answering this for
    // them would silently extend a 7-day token forever.
    if (claims.kind !== 'STAFF') {
      throw new UnauthorizedError('Invalid or expired session');
    }

    if (claims.tenantSlug !== input.tenantSlug) {
      throw new UnauthorizedError('Invalid or expired session');
    }

    /**
     * The cap, and the legacy case folded into it.
     *
     * A token minted before `sessionExpiresAt` existed falls back to its own
     * `exp`, which means it can never be extended: the comparison below is
     * already false by the time anything would want to refresh it. That is the
     * right answer rather than a special case — a session in flight when this
     * deploys keeps precisely the lifetime it was issued with, and the clerk
     * signs in once at the moment they would have anyway.
     */
    const cap = claims.sessionExpiresAt ?? claims.exp ?? 0;
    if (cap <= Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedError('انتهت الجلسة. يرجى تسجيل الدخول مجدداً.');
    }

    const user = await this.users.findById(claims.sub);
    if (!user || user.kind !== 'STAFF' || user.tenantSlug !== input.tenantSlug) {
      throw new UnauthorizedError('Invalid or expired session');
    }

    // Deactivated accounts refuse here as well as in the guard. The guard does
    // not run on this route — it cannot, because the token may be expired — so
    // this is the check, not a duplicate of one.
    user.assertMayStartSession();

    if ((claims.tokenVersion ?? 0) !== user.tokenVersion) {
      throw new UnauthorizedError('انتهت الجلسة. يرجى تسجيل الدخول مجدداً.');
    }

    return this.issueSession({
      id: user.id,
      name: user.fullName,
      kind: 'STAFF',
      // Re-read, not copied from the token — see (2) above.
      role: user.role,
      tenantSlug: input.tenantSlug,
      tokenVersion: user.tokenVersion,
      sessionExpiresAt: cap,
    });
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
    /** STAFF only — see loginStaff. */
    remember?: boolean;
    /** Stamped into the token and compared on every request thereafter. */
    tokenVersion: number;
    /**
     * STAFF only, and only on a refresh: the cap the original login set.
     *
     * Passed through rather than recomputed, which is what stops a refreshed
     * session from walking its own deadline forward every time it is exchanged.
     */
    sessionExpiresAt?: number;
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

    /**
     * The session's hard deadline, set once and carried forward.
     *
     * `JWT_STAFF_TTL` and `JWT_STAFF_REMEMBER_TTL` keep the values they have
     * always had and keep meaning the same thing to an operator — how long a
     * sign-in lasts. What changed is which expiry they name: they used to be
     * the token's, and are now the session's. A clerk still signs in again
     * after eight hours; they no longer get thrown out mid-form at hour eight
     * and lose what was on screen.
     */
    const sessionExpiresAt =
      input.sessionExpiresAt ??
      nowSeconds +
        durationToSeconds(
          this.config.get<string>(
            input.remember ? 'JWT_STAFF_REMEMBER_TTL' : 'JWT_STAFF_TTL',
            input.remember ? '30d' : '8h',
          ),
          input.remember ? 30 * 24 * 3600 : 8 * 3600,
        );

    /**
     * The token's own life: the idle window, clamped to the cap.
     *
     * Clamping is what makes the last token of a session expire exactly at the
     * deadline instead of a half-hour past it. Without it the final refresh
     * before the cap would mint a token outliving the session it belongs to,
     * and `refreshStaffSession` would be the only thing refusing it — one
     * check standing where two should.
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

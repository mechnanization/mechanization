import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient, createClient } from '@supabase/supabase-js';
import {
  SupabaseAuthResult,
  SupabaseAuthService,
  SupabaseAuthUser,
} from '../../../domain/interfaces/supabase-auth.interface';

/**
 * What is left of Supabase Auth: the password-reset round trip, and nothing
 * else.
 *
 * Staff sign-in no longer comes through here — `IdentityService.loginStaff`
 * verifies `users.passwordHash` with bcrypt against this municipality's own
 * schema, which is where every other password check in this system already
 * looked. The account-mirroring methods below are therefore no longer mirroring
 * anything anyone reads, and they have been emptied rather than deleted so the
 * port and its seven call sites stay still while the database cutover settles.
 *
 * `verifyToken` and `sendPasswordResetEmail` are deliberately **not** empty.
 * They are the two halves of one flow: Supabase sends the recovery email, and
 * the token that comes back through the link is the only evidence
 * `confirmStaffPasswordReset` ever has that the caller owns the inbox. Emptying
 * `verifyToken` the way the others were emptied would not disable a mirror — it
 * would hand anyone who posts to the reset endpoint the ability to set any
 * staff member's password. It keeps calling Supabase until a real mail provider
 * replaces both halves together.
 */
@Injectable()
export class SupabaseAuthServiceImpl implements SupabaseAuthService {
  private readonly logger = new Logger(SupabaseAuthServiceImpl.name);
  private readonly client: SupabaseClient;

  constructor(config: ConfigService) {
    this.client = createClient(
      config.getOrThrow<string>('SUPABASE_URL'),
      config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY'),
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );
  }

  /**
   * Refuses, always.
   *
   * Staff authentication moved to `IdentityService.loginStaff`, which is the
   * only caller this ever had. Left throwing rather than deleted from the port
   * so that a future caller wiring itself back to Supabase for a password check
   * fails loudly instead of silently authenticating against a copy of the hash
   * that nothing keeps up to date any more.
   */
  async authenticateStaff(_email: string, _password: string): Promise<SupabaseAuthResult> {
    throw new Error(
      'authenticateStaff is no longer available — staff passwords are verified against users.passwordHash in IdentityService.loginStaff',
    );
  }

  /**
   * No-op. The staff row in the tenant schema is the account; there is no
   * second copy to create.
   *
   * Returns an empty id because the only caller discards it
   * (`StaffService.create`, inside a try/catch it already treats as
   * best-effort). **Consequence worth knowing:** staff created from here on
   * have no Supabase Auth user, so `sendPasswordResetEmail` cannot reach them
   * until a real mail provider lands. An administrator setting their password
   * directly through `StaffService.update` is the interim path.
   */
  async createStaffUser(_input: {
    email: string;
    password: string;
    tenantSlug: string;
    role: string;
    firstName: string;
    lastName: string;
  }): Promise<{ id: string }> {
    return { id: '' };
  }

  /**
   * No-op. Every caller already wrote the change to `users` first and treated
   * this as a best-effort mirror; the mirror is what has been removed, not the
   * write.
   */
  async updateStaffUser(_input: {
    email: string;
    newEmail?: string;
    password?: string;
    firstName?: string;
    lastName?: string;
    role?: string;
    isActive?: boolean;
  }): Promise<void> {
    return;
  }

  /**
   * No-op. Deactivation is `users.isActive` plus a `tokenVersion` bump, both
   * already done by the caller, and both are what actually end a session.
   */
  async deleteStaffUser(_email: string): Promise<void> {
    return;
  }

  /**
   * Still real, and it has to be — see the note on this class.
   *
   * This verifies the short-lived recovery token minted by the link in a
   * password-reset email. It is not a session check: staff sessions are this
   * app's own JWT and never come near it. It is the sole proof that whoever is
   * setting a new password reached the inbox the email went to.
   */
  async verifyToken(token: string): Promise<SupabaseAuthUser | null> {
    try {
      const { data, error } = await this.client.auth.getUser(token);
      if (error || !data.user) {
        return null;
      }
      return {
        id: data.user.id,
        email: data.user.email,
        userMetadata: data.user.user_metadata,
        appMetadata: data.user.app_metadata,
      };
    } catch {
      return null;
    }
  }

  /**
   * Still real: Path 1 of the migration plan. Supabase keeps delivering reset
   * mail until SES/Postmark/Resend replaces it, at which point this and
   * `verifyToken` are rewritten in the same change — a token issued by one
   * system and checked by another verifies nothing.
   */
  async sendPasswordResetEmail(email: string, redirectTo?: string): Promise<void> {
    const { error } = await this.client.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo,
    });
    if (error) {
      this.logger.error(`Failed to send password reset email to ${email}: ${error.message}`);
      throw new Error(`تعذّر إرسال بريد إعادة تعيين كلمة المرور: ${error.message}`);
    }
  }
}

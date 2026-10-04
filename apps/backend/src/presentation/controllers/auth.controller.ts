import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import {
  changeEmailSchema,
  changePasswordSchema,
  confirmPasswordResetSchema,
  referenceLoginSchema,
  referenceOnlyLoginSchema,
  requestOtpSchema,
  staffLoginSchema,
  totpEnrolmentSchema,
  verifyOtpSchema,
} from '@mechanization/shared-schemas';
import { IdentityService } from '../../application/features/identity/identity.service';
import { ZodValidationPipe } from '../../application/common/pipes/zod-validation.pipe';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Public } from '../decorators/public.decorator';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { APP_CONFIG } from '../config/app.config';
import { TrustedOriginGuard } from '../guards/trusted-origin.guard';
import {
  clearStaffRefreshCookie,
  readCookie,
  setStaffRefreshCookie,
} from '../http/staff-refresh-cookie';

/**
 * The throttle on refresh and sign-out, counted per `Authorization` header.
 *
 * The API sits behind nginx without `trust proxy`, so every request arrives
 * from nginx's address and the default per-IP bucket is one bucket for
 * everyone: one tab stuck in a refresh loop — or one anonymous flood — would
 * spend every clerk's refreshes. The header is what tells tabs apart. Hashed
 * so the bucket key never holds a bearer token.
 *
 * A caller can mint new buckets by varying the header, and that is acceptable
 * for what this protects: a header that is not a token this service signed is
 * refused before any database work, so the requests it lets through are only
 * as expensive as a signature check. Anything costlier needs a real staff
 * token, and each real token has exactly one bucket. The limit is
 * `APP_CONFIG.throttle.staffSession`; each route has its own count.
 */
const STAFF_SESSION_THROTTLE = {
  default: {
    limit: APP_CONFIG.throttle.staffSession.limit,
    ttl: APP_CONFIG.throttle.staffSession.ttlSeconds * 1000,
    getTracker: (request: Record<string, unknown>) => {
      const headers = request.headers as Record<string, string | string[] | undefined>;
      const authorization = headers.authorization;
      const key = typeof authorization === 'string' ? authorization : `ip:${String(request.ip)}`;
      return `staff-session:${createHash('sha256').update(key).digest('hex')}`;
    },
  },
};

/** The bearer token on the request, if there is one. Absent is not an error here. */
function bearer(request: Request): string | undefined {
  const [scheme, value] = (request.header('authorization') ?? '').split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
}

/**
 * One controller for both kinds of sign-in — the routes differ, the token they
 * produce does not.
 */
@Controller('t/:tenantSlug/auth')
export class AuthController {
  constructor(private readonly identity: IdentityService) {}

  // ────────────────────────────  Staff  ────────────────────────────

  @Public()
  @Post('staff/login')
  @UseGuards(TrustedOriginGuard)
  @Throttle({
    default: {
      limit: APP_CONFIG.throttle.staffLogin.limit,
      ttl: APP_CONFIG.throttle.staffLogin.ttlSeconds * 1000,
    },
  })
  /**
   * The pipe sits on `@Body()` specifically rather than on `@UsePipes()` at the
   * method: a method-level pipe runs against every parameter of the handler,
   * so `staffLoginSchema` would also validate `tenantSlug` — a plain string —
   * and fail every login with "Expected object, received string" before the
   * password was ever checked.
   *
   * The body is the access token exactly as before; the refresh token goes
   * only into the cookie. A TOTP challenge is not a sign-in, so it sets
   * nothing. `passthrough` keeps Nest serialising the return value — the
   * response object is used for the header and nothing else.
   */
  async loginStaff(
    @Param('tenantSlug') tenantSlug: string,
    @Body(new ZodValidationPipe(staffLoginSchema))
    body: { email: string; password: string; totpToken?: string; remember?: boolean },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.identity.loginStaff({
      tenantSlug,
      email: body.email,
      password: body.password,
      totpToken: body.totpToken,
      remember: body.remember,
      context: { ip: request.ip, userAgent: request.header('user-agent') },
    });

    if ('status' in result) return result;

    setStaffRefreshCookie(response, result.refresh.cookieName, result.refresh);
    return result.session;
  }

  /**
   * Renews a staff session: the refresh cookie is the credential, the tab's own
   * access token (usually expired) says which account it is for. See
   * `IdentityService.refreshStaffSession` for why both are needed.
   *
   * `@Public()` is load-bearing and is *not* a hole. The guard cannot run here
   * for the reason the route exists: the access token presented is usually
   * expired, and the guard rejects expired tokens by design. Every check that
   * matters — the cookie, the family, the account, its `tokenVersion` and
   * whether it is still active — happens inside the service.
   *
   * A refusal is returned rather than thrown so the cookie can be cleared
   * first; the `Set-Cookie` survives the throw because `DomainExceptionFilter`
   * only sets the status and the body. An unexpected error is thrown straight
   * through and leaves the cookie alone, so a database blip does not sign
   * anyone out.
   *
   * The access token travels in the `Authorization` header rather than the
   * body, so a refresh looks like every other authenticated call to anything
   * sitting in front of this — a proxy log, a WAF rule, the browser's own
   * devtools.
   */
  @Public()
  @Post('staff/refresh')
  @UseGuards(TrustedOriginGuard)
  @Throttle(STAFF_SESSION_THROTTLE)
  async refreshStaff(
    @Param('tenantSlug') tenantSlug: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.identity.refreshStaffSession({
      accessToken: bearer(request),
      tenantSlug,
      readCookie: (name) => readCookie(request, name),
    });

    if (!outcome.ok) {
      if (outcome.clearCookie) clearStaffRefreshCookie(response, outcome.clearCookie);
      throw outcome.error;
    }

    setStaffRefreshCookie(response, outcome.grant.refresh.cookieName, outcome.grant.refresh);
    return outcome.grant.session;
  }

  /**
   * Ends this tab's sign-in on the server: the refresh family is revoked, which
   * stops both the cookie and — through `sid` in the guard — the access token.
   *
   * `@Public()` for the same reason as refresh: a clerk signing out after lunch
   * holds an expired token, and must still be able to end the session behind
   * it. Answers 200 with the same body whether or not there was anything to
   * end — no binding, no cookie, a family already revoked — because the portal
   * clears its own storage either way, and a sign-out that reports failure for
   * a session that is already over is one the user cannot finish.
   */
  @Public()
  @Post('staff/logout')
  @HttpCode(200)
  @UseGuards(TrustedOriginGuard)
  @Throttle(STAFF_SESSION_THROTTLE)
  async logoutStaff(
    @Param('tenantSlug') tenantSlug: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.identity.logoutStaff({
      accessToken: bearer(request),
      tenantSlug,
      readCookie: (name) => readCookie(request, name),
    });

    if (result.clearCookie) clearStaffRefreshCookie(response, result.clearCookie);
    return { signedOut: true };
  }

  /**
   * Enrolment is authenticated: an admin who has not yet set up TOTP can still
   * sign in only if their role does not require it, and a SUPER_ADMIN's first
   * secret is issued by a colleague who already has access (see seed.ts).
   */
  @Post('staff/totp/enrol')
  async beginTotpEnrolment(
    @Param('tenantSlug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.identity.beginTotpEnrolment(user.sub, tenantSlug);
  }

  @Post('staff/totp/confirm')
  async confirmTotpEnrolment(
    @CurrentUser() user: SessionClaims,
    @Body(new ZodValidationPipe(totpEnrolmentSchema)) body: { token: string },
  ) {
    await this.identity.confirmTotpEnrolment(user.sub, body.token);
    return { confirmed: true };
  }

  @Post('staff/totp/disable')
  async disableTotp(
    @Param('tenantSlug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Body() body: { currentPassword?: string },
  ) {
    await this.identity.disableTotp(user.sub, tenantSlug, body?.currentPassword);
    return { disabled: true };
  }

  @Post('staff/change-password')
  async changePassword(
    @Param('tenantSlug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Body(new ZodValidationPipe(changePasswordSchema))
    body: { currentPassword: string; newPassword: string },
  ) {
    await this.identity.changeStaffPassword(user.sub, tenantSlug, body.currentPassword, body.newPassword);
    return { changed: true };
  }

  @Post('staff/change-email')
  async changeEmail(
    @Param('tenantSlug') tenantSlug: string,
    @CurrentUser() user: SessionClaims,
    @Body(new ZodValidationPipe(changeEmailSchema))
    body: { newEmail: string; currentPassword: string },
  ) {
    const result = await this.identity.changeStaffEmail(user.sub, tenantSlug, body.newEmail, body.currentPassword);
    return result;
  }

  @Post('staff/send-reset-password-email')
  async sendResetPasswordEmail(
    @CurrentUser() user: SessionClaims,
    @Body() body?: { redirectTo?: string },
  ) {
    return this.identity.sendStaffPasswordResetEmail(user.sub, body?.redirectTo);
  }

  /**
   * Public: reached from the reset-password landing page, before any session
   * exists. `accessToken` is the token this service signed into the reset
   * link it mailed — not a session, and not a third party's. It names the
   * account and carries the `tokenVersion` current when it was minted, so it
   * expires, it is single-use, and nothing here is resolved from anything the
   * caller chose; see `IdentityService.confirmStaffPasswordReset`.
   */
  @Public()
  @Post('staff/confirm-password-reset')
  @Throttle({
    default: {
      limit: APP_CONFIG.throttle.staffLogin.limit,
      ttl: APP_CONFIG.throttle.staffLogin.ttlSeconds * 1000,
    },
  })
  async confirmPasswordReset(
    @Body(new ZodValidationPipe(confirmPasswordResetSchema))
    body: { accessToken: string; newPassword: string },
  ) {
    await this.identity.confirmStaffPasswordReset(body.accessToken, body.newPassword);
    return { confirmed: true };
  }

  // ───────────────────────────  Citizens  ───────────────────────────

  @Public()
  @Post('citizen/otp/request')
  @Throttle({
    default: {
      limit: APP_CONFIG.throttle.otpRequest.limit,
      ttl: APP_CONFIG.throttle.otpRequest.ttlSeconds * 1000,
    },
  })
  async requestOtp(
    @Body(new ZodValidationPipe(requestOtpSchema)) body: { phone: string; attempt: number },
  ) {
    const result = await this.identity.requestOtp(body.phone, body.attempt);

    return {
      // Never echo whether the phone is known — that would turn this endpoint
      // into a way to test which numbers have registered with the municipality.
      sent: true,
      /**
       * Whether the login page should ask for a code at all. Reported rather
       * than assumed by the client: the switch lives in the server's
       * environment, and a page guessing wrong either strands the citizen on a
       * code screen no SMS will ever answer, or skips a step that is still
       * enforced.
       */
      otpRequired: this.identity.otpRequired,
      channel: result.channel,
      expiresAt: result.expiresAt.toISOString(),
      resendAvailableAt: result.resendAvailableAt.toISOString(),
      ...(result.devCode ? { devCode: result.devCode } : {}),
    };
  }

  @Public()
  @Post('citizen/otp/verify')
  async verifyOtp(
    @Param('tenantSlug') tenantSlug: string,
    @Body(new ZodValidationPipe(verifyOtpSchema))
    body: { phone: string; code?: string; citizenId?: string },
    @Req() request: Request,
  ) {
    return this.identity.verifyOtp({
      tenantSlug,
      phone: body.phone,
      code: body.code,
      citizenId: body.citizenId,
      context: { ip: request.ip, userAgent: request.header('user-agent') },
    });
  }

  /**
   * Sign-in by رقم مرجعي + phone, for the payments portal.
   *
   * Rate-limited like the staff login rather than like the OTP request: this
   * one *is* the credential check, so it is the endpoint worth guessing at.
   */
  @Public()
  @Post('citizen/reference/login')
  @Throttle({
    default: {
      limit: APP_CONFIG.throttle.staffLogin.limit,
      ttl: APP_CONFIG.throttle.staffLogin.ttlSeconds * 1000,
    },
  })
  async loginByReference(
    @Param('tenantSlug') tenantSlug: string,
    @Body(new ZodValidationPipe(referenceLoginSchema))
    body: { referenceNumber: string; phone: string },
    @Req() request: Request,
  ) {
    return this.identity.loginByReference({
      tenantSlug,
      referenceNumber: body.referenceNumber,
      phone: body.phone,
      context: { ip: request.ip, userAgent: request.header('user-agent') },
    });
  }

  /**
   * Sign-in by رقم مرجعي alone — the citizen landing page.
   *
   * Throttled harder than any other route here: 5 attempts a minute, as the
   * two-factor version gets, is sized for someone mistyping their own number.
   * This one is the whole credential, so it is the only endpoint where a
   * patient attacker with a list is a realistic shape of attack — and at this
   * rate, the reference's 2³⁰ suffix space is unreachable by orders of
   * magnitude.
   */
  @Public()
  @Post('citizen/reference/open')
  @Throttle({
    default: {
      limit: APP_CONFIG.throttle.referenceOnlyLogin.limit,
      ttl: APP_CONFIG.throttle.referenceOnlyLogin.ttlSeconds * 1000,
    },
  })
  async openByReference(
    @Param('tenantSlug') tenantSlug: string,
    @Body(new ZodValidationPipe(referenceOnlyLoginSchema))
    body: { referenceNumber: string },
    @Req() request: Request,
  ) {
    return this.identity.loginByReferenceOnly({
      tenantSlug,
      referenceNumber: body.referenceNumber,
      context: { ip: request.ip, userAgent: request.header('user-agent') },
    });
  }

  // ────────────────────────────  Shared  ────────────────────────────

  /** Lets the frontend confirm a stored token is still valid on page load. */
  @Get('me')
  me(@CurrentUser() user: SessionClaims) {
    return { id: user.sub, kind: user.kind, role: user.role, tenantSlug: user.tenantSlug };
  }
}

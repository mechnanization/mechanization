import { z } from 'zod';
import { staffRoleSchema } from './enums';
import { internationalPhone } from './primitives';

/**
 * One auth vocabulary for both citizens and staff.
 *
 * v1 had `staff.schema.ts` (NestJS JWT) and `citizen-auth.schema.ts` (Supabase
 * Auth) describing two different token shapes. Unifying them here is what lets
 * the frontend keep one session store and the backend one guard.
 */

// ─────────────────────────────  Staff  ─────────────────────────────

export const staffLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email('البريد الإلكتروني غير صالح'),
  password: z.string().min(8, 'كلمة المرور قصيرة جداً'),
  /**
   * Absent on the first request. A SUPER_ADMIN gets `TOTP_REQUIRED` back and
   * resubmits with the code — 2FA is mandatory for that role, not opt-in.
   */
  totpToken: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'رمز التحقق مكوّن من 6 أرقام')
    .optional(),
  /** "تذكّرني على هذا الجهاز" — extends the issued token's lifetime; see JWT_STAFF_REMEMBER_TTL. */
  remember: z.boolean().optional(),
});
export type StaffLogin = z.infer<typeof staffLoginSchema>;

/** The six-digit code proving an authenticator app is set up correctly. */
export const totpEnrolmentSchema = z.object({
  token: z.string().trim().regex(/^\d{6}$/, 'رمز التحقق مكوّن من 6 أرقام'),
});

// ────────────────────────────  Citizens  ────────────────────────────

/*
  The same phone rule the registration form uses, and it has to be.

  A citizen registered on a foreign number — an owner abroad, a family that
  kept the number they lived on — would otherwise exist in the register and be
  unable to type their own number into the login box. A field that accepts a
  value on the way in and refuses it on the way back is a person locked out of
  their own record, which is the outcome the رقم مرجعي counter fallback exists
  to rescue and should not have to.

  It widens what may be *asked for*, not what can be delivered:
  `SmsProviderService` still routes to Lebanese networks, and a code for a
  foreign number will fail to arrive until a provider that can reach one is
  chosen (see open-decisions #2). Failing at delivery, visibly, is the better
  of the two failures — the alternative refuses the number before anyone has
  found out whether it could have been reached.
*/
export const requestOtpSchema = z.object({
  phone: internationalPhone,
  /**
   * Resend counter. From the second attempt the server switches SMS route, so a
   * provider that is silently dropping messages is not simply retried.
   */
  attempt: z.coerce.number().int().min(1).max(6).default(1),
});

/**
 * `citizenId` is set only on the second call, after a shared phone matched
 * several household members.
 */
export const verifyOtpSchema = z.object({
  phone: internationalPhone,
  /**
   * Optional on the wire, required in practice whenever OTP is switched on —
   * `OtpService.verify` is what refuses a missing or wrong code. Optional here
   * only so a deployment running with `OTP_ENABLED=false` does not have to
   * invent a fake six digits to satisfy a schema that will not check them.
   */
  code: z.string().trim().regex(/^\d{6}$/, 'الرمز مكوّن من 6 أرقام').optional(),
  /** Set on the second call when a shared phone matched several people. */
  citizenId: z.string().uuid().optional(),
});

/** Returned when one phone belongs to several household members. */
export const citizenChoiceSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  identityDocLastDigits: z.string(),
});

/** Returned instead of a session when one phone belongs to several people. */
export const disambiguationSchema = z.object({
  status: z.literal('CHOOSE_PROFILE'),
  phone: z.string(),
  choices: z.array(citizenChoiceSchema),
});

// ────────────────────────────  Shared  ────────────────────────────

/** The single session shape, whichever way the user signed in. */
export const sessionSchema = z.object({
  accessToken: z.string(),
  supabaseAccessToken: z.string().optional(),
  expiresIn: z.string(),
  user: z.object({
    id: z.string().uuid(),
    name: z.string(),
    kind: z.enum(['STAFF', 'CITIZEN']),
    role: staffRoleSchema.optional(),
  }),
});
export type Session = z.infer<typeof sessionSchema>;

/** Password was right; the second factor is still outstanding. */
export const totpRequiredSchema = z.object({ status: z.literal('TOTP_REQUIRED') });

/** Either a session or the TOTP challenge — `status` is the discriminant. */
export const staffLoginResponseSchema = z.union([sessionSchema, totpRequiredSchema]);
/** Either a session or the household profile choice. */
export const verifyOtpResponseSchema = z.union([sessionSchema, disambiguationSchema]);

const staffPassword = z
  .string()
  .min(10, 'استخدم 10 أحرف على الأقل لحسابات الموظفين')
  .max(200);

/**
 * A new staff account. Passwords are longer here than for citizens: these
 * credentials open every citizen record in the municipality.
 */
export const createStaffUserSchema = z.object({
  email: z.string().trim().toLowerCase().email('البريد الإلكتروني غير صالح'),
  password: staffPassword,
  firstName: z.string().trim().min(2, 'الاسم قصير جداً').max(60),
  lastName: z.string().trim().min(2, 'الشهرة قصيرة جداً').max(60),
  role: staffRoleSchema,
});

/**
 * Editing an existing account. Every field optional — a rename should not
 * require re-entering a password, and `password` absent means "leave the
 * current one alone" rather than "clear it".
 */
export const updateStaffUserSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('البريد الإلكتروني غير صالح').optional(),
    password: staffPassword.optional(),
    firstName: z.string().trim().min(2, 'الاسم قصير جداً').max(60).optional(),
    lastName: z.string().trim().min(2, 'الشهرة قصيرة جداً').max(60).optional(),
    role: staffRoleSchema.optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'لا يوجد ما يتم تحديثه',
  });

/**
 * The confirm-password check, shared so the form and any future server-side
 * form handler agree on it. Deliberately *not* part of the wire schemas above:
 * a confirmation field is a typo guard for whoever is typing, and sending it
 * to the server would only ask the server to trust the same value twice.
 */
export const staffPasswordPairSchema = z
  .object({ password: staffPassword, confirmPassword: z.string() })
  .refine((data) => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'كلمتا المرور غير متطابقتين',
  });

/** The soft-delete toggle, and its undo. */
export const staffActiveSchema = z.object({ isActive: z.boolean() });

/** Changing own password in Security Settings. */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'يرجى إدخال كلمة المرور الحالية'),
  newPassword: staffPassword,
});
export type ChangePassword = z.infer<typeof changePasswordSchema>;

/** Changing own email in Security Settings. */
export const changeEmailSchema = z.object({
  newEmail: z.string().trim().toLowerCase().email('البريد الإلكتروني الجديد غير صالح'),
  currentPassword: z.string().min(1, 'يرجى إدخال كلمة المرور الحالية للتأكيد'),
});
export type ChangeEmail = z.infer<typeof changeEmailSchema>;

/**
 * Setting a new password from the link in a "send-reset-password-email".
 *
 * `accessToken` is the Supabase recovery session token Supabase's own
 * `/auth/v1/verify` redirect appends to the landing page's URL fragment —
 * proof the link's owner passed Supabase's own OTP check, not a password the
 * server can verify on its own the way `changePasswordSchema` does.
 */
export const confirmPasswordResetSchema = z.object({
  accessToken: z.string().min(1, 'رابط إعادة التعيين غير صالح أو منتهي الصلاحية'),
  newPassword: staffPassword,
});
export type ConfirmPasswordReset = z.infer<typeof confirmPasswordResetSchema>;


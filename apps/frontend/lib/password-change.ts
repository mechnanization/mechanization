import { changePasswordSchema } from '@mechanization/shared-schemas';

/**
 * «تغيير كلمة المرور» in «أمان الحساب»: what is wrong with the form before it
 * is sent, and where the user lands afterwards.
 */

/** Which field says what; the screen turns each into its own words. */
export interface PasswordChangeIssues {
  currentPassword?: 'required';
  newPassword?: 'tooShort' | 'tooLong';
  confirmPassword?: 'mismatch';
}

/**
 * Judged by the route's own schema (`changePasswordSchema`), so the form refuses
 * exactly what the server would; zod's Arabic messages are not shown, the
 * caller's are. The confirmation is the form's own typo guard and never sent.
 */
export function passwordChangeIssues(input: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}): PasswordChangeIssues {
  const parsed = changePasswordSchema.safeParse({
    currentPassword: input.currentPassword,
    newPassword: input.newPassword,
  });
  const failures = parsed.success ? [] : parsed.error.issues;
  const on = (field: string) => failures.find((issue) => issue.path[0] === field);

  const issues: PasswordChangeIssues = {};
  if (on('currentPassword')) issues.currentPassword = 'required';
  const newPassword = on('newPassword');
  if (newPassword) {
    issues.newPassword = newPassword.code === 'too_big' ? 'tooLong' : 'tooShort';
  } else if (input.newPassword !== input.confirmPassword) {
    issues.confirmPassword = 'mismatch';
  }
  return issues;
}

/**
 * Why the staff sign-in page was opened: after the account's own password
 * change, which ends every session of it, this one included. A fixed value the
 * page compares, never text it shows nor a place it sends anyone.
 */
const PASSWORD_CHANGED_NOTICE = 'password-changed';

/** Where a successful change sends the user: sign-in, saying why. */
export function signInAfterPasswordChange(base: string): string {
  return `${base}/login?notice=${PASSWORD_CHANGED_NOTICE}`;
}

/** Whether the sign-in page was opened by `signInAfterPasswordChange`. */
export function openedAfterPasswordChange(search: string): boolean {
  return new URLSearchParams(search).get('notice') === PASSWORD_CHANGED_NOTICE;
}

/**
 * The same, after the account's second factor was switched on (`on`) or off
 * (audit SEC-02): confirming or removing it ends every session of the account,
 * this one included, as a password change does. Two fixed values, so the page
 * can say whether the next sign-in asks for a code.
 */
const SECOND_FACTOR_NOTICE = { on: 'second-factor-on', off: 'second-factor-off' } as const;

/** Where a confirmed or removed second factor sends the user: sign-in, saying why. */
export function signInAfterSecondFactorChange(base: string, state: 'on' | 'off'): string {
  return `${base}/login?notice=${SECOND_FACTOR_NOTICE[state]}`;
}

/** Which second-factor change opened the sign-in page, if one did. */
export function secondFactorNoticeOf(search: string): 'on' | 'off' | null {
  const notice = new URLSearchParams(search).get('notice');
  if (notice === SECOND_FACTOR_NOTICE.on) return 'on';
  if (notice === SECOND_FACTOR_NOTICE.off) return 'off';
  return null;
}

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

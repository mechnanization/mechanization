import { describe, expect, it } from 'vitest';
import {
  openedAfterPasswordChange,
  passwordChangeIssues,
  signInAfterPasswordChange,
} from './password-change';

/**
 * «تغيير كلمة المرور»: the form refuses what `POST auth/staff/change-password`
 * would (its own `changePasswordSchema`), and a success lands on sign-in with
 * a reason the page recognises and nothing it would follow.
 */
describe('passwordChangeIssues', () => {
  const valid = { currentPassword: 'old-secret', newPassword: 'a-new-password', confirmPassword: 'a-new-password' };

  it('passes a complete, matching change', () => {
    expect(passwordChangeIssues(valid)).toEqual({});
  });

  it('asks for the current password', () => {
    expect(passwordChangeIssues({ ...valid, currentPassword: '' })).toEqual({ currentPassword: 'required' });
  });

  it('refuses a new password under the staff floor, and one over the ceiling', () => {
    expect(passwordChangeIssues({ ...valid, newPassword: 'short', confirmPassword: 'short' })).toEqual({
      newPassword: 'tooShort',
    });
    const long = 'x'.repeat(201);
    expect(passwordChangeIssues({ ...valid, newPassword: long, confirmPassword: long })).toEqual({
      newPassword: 'tooLong',
    });
  });

  it('refuses a confirmation that does not match, once the new password itself is acceptable', () => {
    expect(passwordChangeIssues({ ...valid, confirmPassword: 'a-new-passwork' })).toEqual({
      confirmPassword: 'mismatch',
    });
    expect(passwordChangeIssues({ ...valid, newPassword: 'short', confirmPassword: 'other' })).toEqual({
      newPassword: 'tooShort',
    });
  });
});

describe('the sign-in page after a password change', () => {
  it('is opened with a notice it recognises', () => {
    const target = signInAfterPasswordChange('/zahle/ar/admin');
    expect(target.startsWith('/zahle/ar/admin/login?')).toBe(true);
    expect(openedAfterPasswordChange(target.slice(target.indexOf('?')))).toBe(true);
  });

  it('shows nothing for a plain visit or any other notice', () => {
    expect(openedAfterPasswordChange('')).toBe(false);
    expect(openedAfterPasswordChange('?notice=anything')).toBe(false);
  });
});

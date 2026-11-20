import { logApiError, logoutCitizen } from './api-client';
import { clearSession, loadSession } from './session';

/**
 * The portal's «خروج»: the session ended on the server first, then forgotten
 * here (task S14 of the 2026-11-14 security audit).
 *
 * Before, signing out only cleared this browser's storage, and a copy of the
 * token — another tab, a shared phone, a screenshot — kept opening the
 * citizen's file for the rest of its seven days. The server's half is best
 * effort: a sign-out always finishes, so a failed call is logged and the
 * local session cleared all the same, as `logoutStaff`'s callers do.
 *
 * Only for a press of «خروج». A 401 means the server already ended the
 * session, and those handlers clear the local copy with `clearSession` alone.
 */
export async function signOutCitizen(tenant: string): Promise<void> {
  try {
    await logoutCitizen(tenant, loadSession(tenant)?.accessToken);
  } catch (caught) {
    logApiError(caught);
  }
  clearSession(tenant);
}

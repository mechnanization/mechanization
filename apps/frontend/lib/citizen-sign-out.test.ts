import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const logoutCitizen = vi.fn(async (_tenant: string, _token?: string) => {
  calls.push('server');
});
const clearSession = vi.fn((_tenant: string) => {
  calls.push('local');
});

vi.mock('./api-client', () => ({
  logoutCitizen: (tenant: string, token?: string) => logoutCitizen(tenant, token),
  logApiError: vi.fn(),
}));
vi.mock('./session', () => ({
  loadSession: () => ({ accessToken: 'citizen-token' }),
  clearSession: (tenant: string) => clearSession(tenant),
}));

const { signOutCitizen } = await import('./citizen-sign-out');

/** The portal's «خروج» (task S14): ended on the server, then forgotten here — always both, in that order. */
describe('signOutCitizen', () => {
  beforeEach(() => {
    calls.length = 0;
    logoutCitizen.mockClear();
    clearSession.mockClear();
  });

  it('ends the session on the server with its token, then clears it here', async () => {
    await signOutCitizen('albazourieh');

    expect(logoutCitizen).toHaveBeenCalledWith('albazourieh', 'citizen-token');
    expect(calls).toEqual(['server', 'local']);
  });

  it('still signs out here when the server cannot be reached', async () => {
    logoutCitizen.mockRejectedValueOnce(new Error('offline'));

    await expect(signOutCitizen('albazourieh')).resolves.toBeUndefined();
    expect(clearSession).toHaveBeenCalledWith('albazourieh');
  });
});

import {
  Day3atiApiError,
  type Day3atiIntegration,
} from '../../../domain/interfaces/day3ati-integration.interface';
import { applyStaffSync, planStaffSync, STAFF_SYNC_RETRY_DELAYS_MS, type StaffSyncUser } from './staff-sync';

const editor = (over: Partial<StaffSyncUser> = {}): StaffSyncUser => ({
  role: 'ADMINISTRATIVE_OFFICER',
  isActive: true,
  fullName: 'Rima Haddad',
  ...over,
});

describe('planStaffSync', () => {
  it('creates an account for a new administrator or administrative officer', () => {
    for (const role of ['SUPER_ADMIN', 'ADMINISTRATIVE_OFFICER']) {
      expect(planStaffSync({ action: 'STAFF_CREATED', user: editor({ role }) })).toEqual({
        kind: 'upsert',
        account: { displayName: 'Rima Haddad', role: 'news_editor', language: 'ar' },
      });
    }
  });

  it('gives every other role no account, and sends nothing when one is created', () => {
    for (const role of ['AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ACCOUNTANT', 'VIEWER']) {
      expect(planStaffSync({ action: 'STAFF_CREATED', user: editor({ role }) })).toEqual({ kind: 'none' });
    }
  });

  it('updates the account when the name or the role moved, and ignores an email or a password', () => {
    expect(planStaffSync({ action: 'STAFF_UPDATED', changed: ['lastName'], user: editor() }).kind).toBe('upsert');
    expect(planStaffSync({ action: 'STAFF_UPDATED', changed: ['role'], user: editor() }).kind).toBe('upsert');
    expect(planStaffSync({ action: 'STAFF_UPDATED', changed: ['email', 'password'], user: editor() })).toEqual({
      kind: 'none',
    });
  });

  it('removes the account when the role changes away from an editor', () => {
    expect(
      planStaffSync({ action: 'STAFF_UPDATED', changed: ['role'], user: editor({ role: 'ACCOUNTANT' }) }),
    ).toEqual({ kind: 'remove' });
  });

  it('leaves alone a rename of someone who never had an account', () => {
    expect(
      planStaffSync({ action: 'STAFF_UPDATED', changed: ['firstName'], user: editor({ role: 'ACCOUNTANT' }) }),
    ).toEqual({ kind: 'none' });
  });

  it('removes the account when an editor is switched off or deleted, and brings it back when switched on', () => {
    const off = editor({ isActive: false });
    expect(planStaffSync({ action: 'STAFF_DEACTIVATED', user: off })).toEqual({ kind: 'remove' });
    // A delete hides the row, which also deactivates it.
    expect(planStaffSync({ action: 'STAFF_DELETED', user: off })).toEqual({ kind: 'remove' });
    expect(planStaffSync({ action: 'STAFF_REACTIVATED', user: editor() }).kind).toBe('upsert');
  });

  it('does not touch Day3ati for a restore, which stays disabled, or an action it does not know', () => {
    expect(planStaffSync({ action: 'STAFF_RESTORED', user: editor({ isActive: false }) })).toEqual({ kind: 'none' });
    expect(planStaffSync({ action: 'STAFF_TOTP_RESET', user: editor() })).toEqual({ kind: 'none' });
  });

  it('does nothing when the account cannot be read, or has no name to show', () => {
    expect(planStaffSync({ action: 'STAFF_CREATED', user: null })).toEqual({ kind: 'none' });
    expect(planStaffSync({ action: 'STAFF_CREATED', user: editor({ fullName: '   ' }) })).toEqual({ kind: 'none' });
  });

  it('reads the row, not the event: a created editor already switched off is removed, not created', () => {
    expect(planStaffSync({ action: 'STAFF_CREATED', user: editor({ isActive: false }) })).toEqual({ kind: 'remove' });
  });
});

describe('applyStaffSync', () => {
  const upsert = {
    kind: 'upsert' as const,
    account: { displayName: 'Rima Haddad', role: 'news_editor' as const, language: 'ar' as const },
  };

  const integration = (over: Partial<Day3atiIntegration> = {}): jest.Mocked<Day3atiIntegration> =>
    ({
      isConfigured: true,
      upsertStaff: jest.fn().mockResolvedValue(undefined),
      removeStaff: jest.fn().mockResolvedValue(undefined),
      ...over,
    }) as jest.Mocked<Day3atiIntegration>;

  const pause = jest.fn().mockResolvedValue(undefined);
  beforeEach(() => pause.mockClear());

  it('sends an upsert and a removal', async () => {
    const api = integration();
    await expect(applyStaffSync(api, 'albazourieh', 'u1', upsert, pause)).resolves.toEqual({ outcome: 'upserted' });
    await expect(applyStaffSync(api, 'albazourieh', 'u1', { kind: 'remove' }, pause)).resolves.toEqual({
      outcome: 'removed',
    });
    expect(api.upsertStaff).toHaveBeenCalledWith('albazourieh', 'u1', upsert.account);
    expect(api.removeStaff).toHaveBeenCalledWith('albazourieh', 'u1');
  });

  it('sends nothing for no plan, or while Day3ati is not configured', async () => {
    const api = integration();
    await expect(applyStaffSync(api, 't', 'u', { kind: 'none' }, pause)).resolves.toEqual({ outcome: 'skipped' });
    const off = integration({ isConfigured: false });
    await expect(applyStaffSync(off, 't', 'u', upsert, pause)).resolves.toEqual({ outcome: 'skipped' });
    expect(api.upsertStaff).not.toHaveBeenCalled();
    expect(off.upsertStaff).not.toHaveBeenCalled();
  });

  it('asks again when Day3ati does not answer, then succeeds', async () => {
    const api = integration({
      upsertStaff: jest
        .fn()
        .mockRejectedValueOnce(new Day3atiApiError('day3ati.unavailable', 'down'))
        .mockRejectedValueOnce(new Day3atiApiError('day3ati.http_503', 'busy', 503))
        .mockResolvedValue(undefined),
    });

    await expect(applyStaffSync(api, 't', 'u', upsert, pause)).resolves.toEqual({ outcome: 'upserted' });
    expect(api.upsertStaff).toHaveBeenCalledTimes(3);
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual([...STAFF_SYNC_RETRY_DELAYS_MS]);
  });

  it('gives up after the last retry and reports the code', async () => {
    const api = integration({
      removeStaff: jest.fn().mockRejectedValue(new Day3atiApiError('day3ati.unavailable', 'down')),
    });
    await expect(applyStaffSync(api, 't', 'u', { kind: 'remove' }, pause)).resolves.toEqual({
      outcome: 'failed',
      code: 'day3ati.unavailable',
    });
    expect(api.removeStaff).toHaveBeenCalledTimes(STAFF_SYNC_RETRY_DELAYS_MS.length + 1);
  });

  it('does not retry a refusal that asking again cannot change', async () => {
    const api = integration({
      upsertStaff: jest.fn().mockRejectedValue(new Day3atiApiError('integration.role_not_allowed', 'no', 400)),
    });
    await expect(applyStaffSync(api, 't', 'u', upsert, pause)).resolves.toEqual({
      outcome: 'failed',
      code: 'integration.role_not_allowed',
    });
    expect(api.upsertStaff).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it('reports a municipality with no village on Day3ati, without retrying', async () => {
    const api = integration({
      upsertStaff: jest.fn().mockRejectedValue(new Day3atiApiError('integration.tenant_not_mapped', 'no', 404)),
    });
    await expect(applyStaffSync(api, 't', 'u', upsert, pause)).resolves.toEqual({ outcome: 'tenant_not_mapped' });
    expect(api.upsertStaff).toHaveBeenCalledTimes(1);
  });

  it('never throws, even for an error it does not know', async () => {
    const api = integration({ upsertStaff: jest.fn().mockRejectedValue(new TypeError('boom')) });
    await expect(applyStaffSync(api, 't', 'u', upsert, pause)).resolves.toEqual({
      outcome: 'failed',
      code: 'day3ati.unexpected',
    });
  });
});

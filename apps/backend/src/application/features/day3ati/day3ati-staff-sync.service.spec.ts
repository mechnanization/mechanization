import { Day3atiApiError, type Day3atiIntegration } from '../../../domain/interfaces/day3ati-integration.interface';
import type { UserRepository } from '../../../domain/interfaces/user-repository.interface';
import { Day3atiStaffSyncService } from './day3ati-staff-sync.service';

describe('Day3atiStaffSyncService', () => {
  const staffRow = (over: Record<string, unknown> = {}) => ({
    kind: 'STAFF',
    role: 'ADMINISTRATIVE_OFFICER',
    isActive: true,
    fullName: 'Rima Haddad',
    ...over,
  });

  const setup = (row: unknown = staffRow(), over: Partial<Day3atiIntegration> = {}) => {
    const integration = {
      isConfigured: true,
      upsertStaff: jest.fn().mockResolvedValue(undefined),
      removeStaff: jest.fn().mockResolvedValue(undefined),
      ...over,
    } as jest.Mocked<Day3atiIntegration>;
    const users = { findById: jest.fn().mockResolvedValue(row) } as unknown as jest.Mocked<UserRepository>;
    return { integration, users, service: new Day3atiStaffSyncService(integration, users) };
  };

  const event = (over: Record<string, unknown> = {}) => ({
    tenantSlug: 'albazourieh',
    staffId: 'user-1',
    action: 'STAFF_CREATED',
    ...over,
  });

  it('creates the account for a new editor, from the row and not the event', async () => {
    const { service, integration } = setup();

    await service.sync(event());

    expect(integration.upsertStaff).toHaveBeenCalledWith('albazourieh', 'user-1', {
      displayName: 'Rima Haddad',
      role: 'news_editor',
      language: 'ar',
    });
  });

  it('removes the account when the editor is deactivated', async () => {
    const { service, integration } = setup(staffRow({ isActive: false }));

    await service.sync(event({ action: 'STAFF_DEACTIVATED' }));

    expect(integration.removeStaff).toHaveBeenCalledWith('albazourieh', 'user-1');
  });

  it('does nothing for a citizen row, a missing row, or a role without an account', async () => {
    for (const row of [staffRow({ kind: 'CITIZEN' }), null, staffRow({ role: 'COLLECTOR' })]) {
      const { service, integration } = setup(row);
      await service.sync(event());
      expect(integration.upsertStaff).not.toHaveBeenCalled();
      expect(integration.removeStaff).not.toHaveBeenCalled();
    }
  });

  it('does not even read the account while Day3ati is off', async () => {
    const { service, users } = setup(staffRow(), { isConfigured: false });
    await service.sync(event());
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('never throws into the staff save: a refusing Day3ati and an unreadable account are both swallowed', async () => {
    const refusing = setup(staffRow(), {
      upsertStaff: jest.fn().mockRejectedValue(new Day3atiApiError('integration.role_not_allowed', 'no', 400)),
    });
    await expect(refusing.service.sync(event())).resolves.toBeUndefined();

    const unreadable = setup();
    unreadable.users.findById.mockRejectedValue(new Error('connection reset'));
    await expect(unreadable.service.sync(event())).resolves.toBeUndefined();
    expect(unreadable.integration.upsertStaff).not.toHaveBeenCalled();
  });

  it('stops sending for a municipality Day3ati has no village for', async () => {
    const { service, integration } = setup(staffRow(), {
      upsertStaff: jest.fn().mockRejectedValue(new Day3atiApiError('integration.tenant_not_mapped', 'no', 404)),
    });

    await service.sync(event());
    await service.sync(event({ staffId: 'user-2' }));

    expect(integration.upsertStaff).toHaveBeenCalledTimes(1);
  });

  it('sends one user\'s quick changes in the order they happened', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const { service, integration, users } = setup(staffRow());
    users.findById
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => (releaseFirst = resolve));
        return staffRow() as never;
      })
      .mockResolvedValueOnce(staffRow({ isActive: false }) as never);
    integration.upsertStaff.mockImplementation(async () => void order.push('upsert'));
    integration.removeStaff.mockImplementation(async () => void order.push('remove'));

    const first = service.sync(event());
    const second = service.sync(event({ action: 'STAFF_DEACTIVATED' }));
    // Let the first change reach its (held) read before the second is allowed anywhere near Day3ati.
    await new Promise((resolve) => setImmediate(resolve));
    expect(users.findById).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['upsert', 'remove']);
  });

  it('is what the staff.changed listener runs', async () => {
    const { service, integration } = setup();
    await service.onStaffChanged(event());
    expect(integration.upsertStaff).toHaveBeenCalledTimes(1);
  });
});

import { StaffService } from './staff.service';

/*
  «حذف موظف» — what a super admin's delete does to a staff account: it hides
  it. The row, its details and everything it did stay on the record; the
  account leaves the list and can never sign in. Nobody deletes themselves.
*/

const ADMIN = { id: 'admin-1', role: 'SUPER_ADMIN' };

function setup(
  target: { id: string; kind: string; role?: string } | null = { id: 'staff-1', kind: 'STAFF', role: 'COLLECTOR' },
  hidden = false,
) {
  const users = {
    findById: jest.fn(async () => target),
    isStaffHidden: jest.fn(async () => hidden),
    setStaffActive: jest.fn(async () => undefined),
    hideStaff: jest.fn(async () => undefined),
  };
  const revocation = { forget: jest.fn(async () => undefined) };
  const events = { emit: jest.fn() };
  const service = new StaffService(
    users as never,
    {} as never,
    {} as never,
    {} as never,
    revocation as never,
    {} as never,
    events as never,
    {} as never,
    {} as never,
    {} as never,
  );
  // Nothing owed unless a test says otherwise.
  jest.spyOn(service, 'getInspectorProfile').mockResolvedValue({ pendingBalance: 0 } as never);
  return { service, users, revocation, events };
}

describe('StaffService.remove', () => {
  it('hides the account and ends its session — never removes the row', async () => {
    const { service, users, revocation, events } = setup();
    await service.remove({ tenantSlug: 't', id: 'staff-1', actor: ADMIN });

    expect(users.hideStaff).toHaveBeenCalledWith('staff-1');

    expect(revocation.forget).toHaveBeenCalledWith('staff-1');
    expect(events.emit).toHaveBeenCalledWith(
      'staff.changed',
      expect.objectContaining({ action: 'STAFF_DELETED', staffId: 'staff-1', role: 'COLLECTOR' }),
    );
  });

  it('refuses deleting your own account', async () => {
    const { service, users } = setup({ id: 'admin-1', kind: 'STAFF' });
    await expect(service.remove({ tenantSlug: 't', id: 'admin-1', actor: ADMIN })).rejects.toThrow('حسابك الخاص');
    expect(users.hideStaff).not.toHaveBeenCalled();
  });

  it('refuses a citizen — this deletes staff only', async () => {
    const { service, users } = setup({ id: 'citizen-1', kind: 'CITIZEN' });
    await expect(service.remove({ tenantSlug: 't', id: 'citizen-1', actor: ADMIN })).rejects.toThrow();
    expect(users.hideStaff).not.toHaveBeenCalled();
  });
});

describe('a deleted staff account stays deleted', () => {
  it('cannot be re-activated', async () => {
    const { service, users } = setup(undefined, true);
    await expect(
      service.setActive({ tenantSlug: 't', id: 'staff-1', isActive: true, actor: ADMIN }),
    ).rejects.toThrow();
    expect(users.setStaffActive).not.toHaveBeenCalled();
  });

  it('cannot be deleted twice', async () => {
    const { service, users } = setup(undefined, true);
    await expect(service.remove({ tenantSlug: 't', id: 'staff-1', actor: ADMIN })).rejects.toThrow();
    expect(users.hideStaff).not.toHaveBeenCalled();
  });

  it('a live account can still be disabled and re-enabled', async () => {
    const { service, users } = setup();
    await service.setActive({ tenantSlug: 't', id: 'staff-1', isActive: false, actor: ADMIN });
    expect(users.setStaffActive).toHaveBeenCalledWith('staff-1', false);
  });
});

describe('an inspector still owed commission', () => {
  it('is not deleted until paid out', async () => {
    const { service, users } = setup({ id: 'insp-1', kind: 'STAFF', role: 'FIELD_INSPECTOR' });
    jest.spyOn(service, 'getInspectorProfile').mockResolvedValue({ pendingBalance: 40 } as never);
    await expect(service.remove({ tenantSlug: 't', id: 'insp-1', actor: ADMIN })).rejects.toThrow('40.00');
    expect(users.hideStaff).not.toHaveBeenCalled();
  });

  it('is not deleted while owed commission, whatever the role — earnings follow the work, not the title', async () => {
    // An admin who filed records is paid for them (the roster lists them), and
    // an inspector re-roled first must not slip past the guard either.
    for (const role of ['SUPER_ADMIN', 'COLLECTOR', 'ADMINISTRATIVE_OFFICER']) {
      const { service, users } = setup({ id: 'staff-9', kind: 'STAFF', role });
      jest.spyOn(service, 'getInspectorProfile').mockResolvedValue({ pendingBalance: 12.5 } as never);
      await expect(service.remove({ tenantSlug: 't', id: 'staff-9', actor: ADMIN })).rejects.toThrow('12.50');
      expect(users.hideStaff).not.toHaveBeenCalled();
    }
  });

  it('is deleted once nothing is owed', async () => {
    const { service, users } = setup({ id: 'insp-1', kind: 'STAFF', role: 'FIELD_INSPECTOR' });
    jest.spyOn(service, 'getInspectorProfile').mockResolvedValue({ pendingBalance: 0 } as never);
    await service.remove({ tenantSlug: 't', id: 'insp-1', actor: ADMIN });
    expect(users.hideStaff).toHaveBeenCalledWith('insp-1');
  });
});

describe('StaffService.restore', () => {
  it('brings a deleted account back onto the list', async () => {
    const { service, users, events } = setup(undefined, true);
    (users as Record<string, unknown>).restoreStaff = jest.fn(async () => undefined);
    await service.restore({ tenantSlug: 't', id: 'staff-1', actor: ADMIN });
    expect((users as unknown as { restoreStaff: jest.Mock }).restoreStaff).toHaveBeenCalledWith('staff-1');
    expect(events.emit).toHaveBeenCalledWith('staff.changed', expect.objectContaining({ action: 'STAFF_RESTORED' }));
  });

  it('refuses an account that was never deleted', async () => {
    const { service } = setup(undefined, false);
    await expect(service.restore({ tenantSlug: 't', id: 'staff-1', actor: ADMIN })).rejects.toThrow();
  });
});

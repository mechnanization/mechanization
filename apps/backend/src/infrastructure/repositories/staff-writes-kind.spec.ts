import { NotFoundError } from '../../domain/errors/domain-error';
import { PrismaUserRepository } from './user.repository';

/**
 * The staff writes say `kind = 'STAFF'` in their own WHERE (audit SEC-11).
 *
 * `users` holds staff and citizens, and the check lived only in
 * `StaffService`'s read before each call. These pin the repository itself:
 * every write is scoped to a staff row, and a citizen's id (or no row at all)
 * is refused with `STAFF_NOT_FOUND` instead of being renamed, disabled or
 * hidden.
 */
function repository(matched: number) {
  const user = {
    updateMany: jest.fn().mockResolvedValue({ count: matched }),
    update: jest.fn(),
    findFirst: jest.fn().mockResolvedValue(null),
  };
  return { users: new PrismaUserRepository({ prisma: { user } } as never), user };
}

const CITIZEN_ID = '3f2a9c1e-7b4d-4e8a-9c1f-2b3d4e5f6a7b';

const writes: Array<[string, (users: PrismaUserRepository) => Promise<void>]> = [
  ['updateStaff', (users) => users.updateStaff(CITIZEN_ID, { firstName: 'سمير' })],
  ['setStaffActive', (users) => users.setStaffActive(CITIZEN_ID, false)],
  ['restoreStaff', (users) => users.restoreStaff(CITIZEN_ID)],
  ['hideStaff', (users) => users.hideStaff(CITIZEN_ID)],
];

describe('PrismaUserRepository — staff writes are pinned to kind STAFF', () => {
  it.each(writes)('%s writes only where kind is STAFF', async (_name, write) => {
    const { users, user } = repository(1);

    await write(users);

    expect(user.updateMany).toHaveBeenCalledTimes(1);
    expect(user.updateMany.mock.calls[0]![0].where).toEqual({ id: CITIZEN_ID, kind: 'STAFF' });
    expect(user.update).not.toHaveBeenCalled();
  });

  it.each(writes)('%s refuses a citizen id with STAFF_NOT_FOUND', async (_name, write) => {
    const { users } = repository(0);

    const refusal = await write(users).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(NotFoundError);
    expect((refusal as NotFoundError).code).toBe('STAFF_NOT_FOUND');
  });

  it('keeps the session-ending bump on a role change', async () => {
    const { users, user } = repository(1);

    await users.updateStaff(CITIZEN_ID, { role: 'COLLECTOR' as never });

    expect(user.updateMany.mock.calls[0]![0].data).toMatchObject({ tokenVersion: { increment: 1 } });
  });
});

import { Prisma } from '../../generated/tenant-client';
import { NotFoundError } from '../../domain/errors/domain-error';
import { PrismaRegistrationRepository } from './registration.repository';

/**
 * A card that names a building or a flat the register does not hold.
 *
 * The offline queue can send one: a registration that named a building queued
 * on the same phone, after that building was refused or discarded. The insert
 * then breaks a foreign key, and `translate` passed the Prisma error through as
 * a 500 — retried by the queue on every drain and reported to Sentry each time.
 * The constraint names are what Postgres 17 reports through Prisma 5, read off
 * a real violation: `property_entries_buildingId_fkey (index)` and
 * `building_units_unitId_fkey (index)`.
 */
function repositoryFailingWith(error: unknown) {
  const tx = {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'new-citizen' }),
    },
    registration: {
      create: jest.fn().mockResolvedValue({ id: 'reg-1', referenceNumber: 'BZR-1' }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    propertyEntry: { create: jest.fn().mockRejectedValue(error) },
    citizenMerge: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const db = { $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)) };
  return new PrismaRegistrationRepository({ prisma: db, tenantSlug: 'albazourieh' } as never);
}

const filing = {
  citizen: { firstName: 'يوسف', lastName: 'جفال' } as never,
  citizenReference: 'BZR-C-1',
  registrationReference: 'BZR-R-1',
  properties: [
    { props: { occupancyType: 'OWNER', propertyType: 'BUILDING', propertyNumber: '1042', buildingId: 'gone' } },
  ] as never,
  status: 'PENDING' as const,
  flaggedFields: [],
};

const foreignKey = (constraint: string) =>
  new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
    code: 'P2003',
    clientVersion: Prisma.prismaVersion.client,
    meta: { field_name: `${constraint} (index)` },
  });

describe('registration — a card naming what the register does not hold', () => {
  it.each([
    ['property_entries_buildingId_fkey', 'BUILDING_NOT_FOUND'],
    ['building_units_unitId_fkey', 'UNIT_NOT_FOUND'],
  ])('refuses %s as %s, not as a 500', async (constraint, code) => {
    const refusal = await repositoryFailingWith(foreignKey(constraint))
      .submit(filing)
      .catch((caught: unknown) => caught);

    expect(refusal).toBeInstanceOf(NotFoundError);
    expect(refusal).toMatchObject({ code });
  });

  it('passes any other foreign key through as it was', async () => {
    const other = foreignKey('registrations_citizenId_fkey');
    const refusal = await repositoryFailingWith(other)
      .submit(filing)
      .catch((caught: unknown) => caught);

    expect(refusal).toBe(other);
  });
});

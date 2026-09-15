import { LandlordLinkService, readFootprint } from './landlord-link.service';
import { ConflictError, ValidationError } from '../../../domain/errors/domain-error';

/**
 * Identifying the owner a مستأجر named — and, much more importantly, refusing
 * to.
 *
 * ## What is pinned down here, and what is not
 *
 * Every test in this file is about a **decision**: whether a confirmation is
 * refused, which reason blocks it, whether a candidate is offered, what an
 * answer is paired with. Linking the right person is one narrow path; the ways
 * to link the wrong one are many, each plausible, and each ends with a citizen
 * billed for property that is not theirs.
 *
 * What a link *writes* — the occupancy, the owner's card, the footprint, and
 * the exact revert — spans six tables and is only true if a database says so.
 * That lives in `landlord-link.integration.spec.ts`, against real Postgres.
 */

const ENTRY = 'entry-1';
const OWNER = 'owner-1';
const TENANT_CITIZEN = 'tenant-1';
const BUILDING = 'building-1';
/**
 * What «03 123456» is stored as. The trunk `0` is dropped by
 * `internationalPhone`, so a fixture written as `+96103…` would be a number no
 * row in this register can hold.
 */
const LANDLORD_PHONE = '+9613123456';

const actor = { id: 'staff-1', role: 'SUPER_ADMIN' };

interface HarnessOptions {
  entry?: Record<string, unknown> | null;
  citizen?: Record<string, unknown> | null;
  building?: Record<string, unknown> | null;
  /** Cards the candidate holds on this building or parcel. */
  ownerCards?: Array<Record<string, unknown>>;
  occupancies?: Array<Record<string, unknown>>;
  /** Current owner spells recorded on the planned flats, whoever holds them. */
  unitOwners?: Array<{ unitId: string; citizenId: string; name?: string }>;
  vacantUnitIds?: string[];
  registrations?: number;
}

function tenantCard(over: Record<string, unknown> = {}) {
  return {
    id: ENTRY,
    landlordName: 'سعيد حرب',
    landlordPhone: LANDLORD_PHONE,
    landlordCitizenId: null,
    landlordLinkFootprint: null,
    occupancyType: 'TENANT',
    propertyType: 'BUILDING',
    propertyNumber: '1042',
    buildingName: 'بناية النور',
    buildingId: BUILDING,
    createdAt: new Date('2026-03-01'),
    building: { code: 'A-1042-A' },
    registration: {
      id: 'reg-1',
      referenceNumber: 'REF-1',
      citizen: { id: TENANT_CITIZEN, firstName: 'علي', middleName: null, lastName: 'صالح' },
    },
    units: [{ unitId: 'unit-1', unit: { buildingId: BUILDING, unitCode: '0101' } }],
    ...over,
  };
}

function harness(options: HarnessOptions = {}) {
  const citizen =
    options.citizen === undefined
      ? {
          id: OWNER,
          kind: 'CITIZEN',
          phone: LANDLORD_PHONE,
          whatsapp: null,
          isActive: true,
        }
      : options.citizen;

  const planCitizen = citizen
    ? {
        firstName: 'سعيد',
        middleName: null,
        lastName: 'حرب',
        motherName: null,
        referenceNumber: 'REF-9',
        residence: 'RESIDENT',
        createdAt: new Date('2026-01-01'),
        ...citizen,
        _count: { registrations: options.registrations ?? 1 },
      }
    : null;

  const transaction = jest.fn();

  const db = {
    propertyEntry: {
      findUnique: jest
        .fn()
        .mockResolvedValue(options.entry === undefined ? tenantCard() : options.entry),
      findMany: jest.fn().mockResolvedValue(options.ownerCards ?? []),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    building: {
      findMany: jest.fn().mockResolvedValue(
        options.building === null
          ? []
          : [
              {
                id: BUILDING,
                parcelNumber: '1042',
                sharedParcelNumbers: [],
                structureType: 'RESIDENTIAL_BUILDING',
                units: [
                  { id: 'unit-1', unitCode: '0101' },
                  { id: 'unit-2', unitCode: '0102' },
                ],
                ...(options.building ?? {}),
              },
            ],
      ),
    },
    unitVacancyConfirmation: {
      findMany: jest
        .fn()
        .mockResolvedValue((options.vacantUnitIds ?? []).map((unitId) => ({ unitId }))),
    },
    unitOccupancy: {
      // Two reads: the candidate's own spells, and every owner of the flats.
      findMany: jest.fn().mockImplementation(({ where }: { where: { role?: string } }) =>
        Promise.resolve(
          where.role === 'OWNER'
            ? (options.unitOwners ?? []).map((row) => ({
                unitId: row.unitId,
                citizenId: row.citizenId,
                citizen: { firstName: row.name ?? 'مالك', middleName: null, lastName: 'مسجَّل' },
              }))
            : (options.occupancies ?? []),
        ),
      ),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue(citizen),
      findMany: jest.fn().mockResolvedValue(planCitizen ? [planCitizen] : []),
    },
    $transaction: transaction,
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([]),
  };

  const scope = { prisma: db, tenantSlug: 'albazourieh', schemaName: 'tenant_albazourieh' };
  const context = {
    ...scope,
    require: () => scope,
    run: (_scope: unknown, work: () => unknown) => work(),
  };

  const recordOccupancy = jest.fn();
  const service = new LandlordLinkService(
    context as never,
    { recordOccupancy, ensureOnFile: jest.fn() } as never,
    { emit: jest.fn() } as never,
  );

  return { service, db, transaction, recordOccupancy };
}

async function refusal(promise: Promise<unknown>): Promise<Error & { details?: unknown }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { details?: unknown };
  }
  throw new Error('expected the call to be refused');
}

describe('confirm — the guards that stop a wrong link', () => {
  it('refuses when the number on the card is not the citizen’s', async () => {
    /*
      The load-bearing check. `citizenId` arrives from a request and nothing
      upstream has proved it belongs to the person the card names. A clerk may
      answer the question; they may not invent it.
    */
    const { service, transaction } = harness({
      citizen: { id: OWNER, kind: 'CITIZEN', phone: '+96171999888', whatsapp: null, isActive: true },
    });

    await expect(
      service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('accepts a match on whatsapp, not only on the primary phone', async () => {
    const { service, transaction } = harness({
      citizen: {
        id: OWNER,
        kind: 'CITIZEN',
        phone: '+96171999888',
        whatsapp: LANDLORD_PHONE,
        isActive: true,
      },
    });
    transaction.mockRejectedValue(new Error('reached the write'));

    await expect(
      service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor }),
    ).rejects.toThrow('reached the write');
  });

  it('refuses to link a card to the person who filed it', async () => {
    // A household shares a line; the son writes the family number as his
    // landlord's. Linking records someone renting from themselves.
    const { service, transaction } = harness({
      citizen: {
        id: TENANT_CITIZEN,
        kind: 'CITIZEN',
        phone: LANDLORD_PHONE,
        whatsapp: null,
        isActive: true,
      },
    });

    await expect(
      service.confirm({ propertyEntryId: ENTRY, citizenId: TENANT_CITIZEN, actor }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses an OWNER card, which has no landlord to identify', async () => {
    const { service, transaction } = harness({ entry: tenantCard({ occupancyType: 'OWNER' }) });

    await expect(
      service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('is idempotent — re-confirming the same pair changes nothing', async () => {
    // Two clerks reaching the same proposal, or an offline queue delivering
    // the confirmation twice. Agreement is not a conflict.
    const { service, transaction } = harness({ entry: tenantCard({ landlordCitizenId: OWNER }) });

    const result = await service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor });

    expect(result).toEqual({
      linked: false,
      occupanciesRecorded: 0,
      unitsClaimed: 0,
      ownerCardCreated: false,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses to replace a link to somebody else without an undo first', async () => {
    /*
      It used to overwrite `landlordCitizenId` in place — moving the flat from
      one person's bill to another's with the first person's occupancy and card
      still standing. The undo is what removes those, and a person has to press
      it.
    */
    const { service, transaction } = harness({
      entry: tenantCard({ landlordCitizenId: 'someone-else' }),
    });

    await expect(
      service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses a deactivated citizen', async () => {
    const { service, transaction } = harness({
      citizen: { id: OWNER, kind: 'CITIZEN', phone: LANDLORD_PHONE, whatsapp: null, isActive: false },
    });

    await expect(
      service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(transaction).not.toHaveBeenCalled();
  });
});

/**
 * «Every link that exists has a property.»
 *
 * A link that cannot put the flat on the owner's file tells every screen the
 * owner is known and bills nobody. Each block below names the step that fixes
 * it, and nothing is written until that step is taken.
 */
describe('confirm — blocked until the property can reach the owner’s file', () => {
  const blockOf = async (options: HarnessOptions) => {
    const { service, transaction } = harness(options);
    const error = await refusal(
      service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor }),
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect(transaction).not.toHaveBeenCalled();
    return (error.details as { block: { code: string } }).block.code;
  };

  it('a tenant card not on a surveyed building', async () => {
    expect(await blockOf({ entry: tenantCard({ buildingId: null, units: [] }), building: null })).toBe(
      'NOT_ON_SURVEY',
    );
  });

  it('a مبنى card that names no flat of the building', async () => {
    expect(await blockOf({ entry: tenantCard({ units: [] }) })).toBe('NO_UNITS');
  });

  it('a flat ticked from a different building — a stale client, not a claim', async () => {
    expect(
      await blockOf({
        entry: tenantCard({
          units: [{ unitId: 'unit-9', unit: { buildingId: 'building-2', unitCode: '0901' } }],
        }),
      }),
    ).toBe('NO_UNITS');
  });

  it('a flat the municipality has confirmed empty', async () => {
    expect(await blockOf({ vacantUnitIds: ['unit-1'] })).toBe('UNIT_VACANT');
  });

  it('an owner who filed the same parcel without linking it — it would be billed twice', async () => {
    expect(
      await blockOf({
        ownerCards: [
          {
            id: 'own-card',
            occupancyType: 'OWNER',
            propertyType: 'BUILDING',
            buildingId: null,
            propertyNumber: '1042',
            units: [],
            registration: { citizenId: OWNER },
          },
        ],
      }),
    ).toBe('OWNER_CARD_UNLINKED');
  });

  it('an owner who filed a parcel the building shares, without linking it — billed twice too', async () => {
    /*
      The building is filed under 1042 and also stands on 1043. The owner's own
      card says 1043: the same property, so a link would bill the flat on two
      cards exactly as it would for 1042.
    */
    expect(
      await blockOf({
        building: { sharedParcelNumbers: ['1043'] },
        ownerCards: [
          {
            id: 'own-card',
            occupancyType: 'OWNER',
            propertyType: 'BUILDING',
            buildingId: null,
            propertyNumber: '1043',
            units: [],
            registration: { citizenId: OWNER },
          },
        ],
      }),
    ).toBe('OWNER_CARD_UNLINKED');
  });

  it('lets through an owner who also rents another flat in the building', async () => {
    /*
      Owning one flat and renting the shop below it is ordinary. This was
      blocked while `claimOnFile` would have ticked the owned flat onto the
      tenancy card; a flat now only joins a card of its own capacity, so the
      link gives them an ownership card beside the tenancy.
    */
    const { service, transaction } = harness({
      ownerCards: [
        {
          id: 'tenancy',
          occupancyType: 'TENANT',
          propertyType: 'BUILDING',
          buildingId: BUILDING,
          propertyNumber: '1042',
          units: [{ unitId: 'unit-2' }],
          registration: { citizenId: OWNER },
        },
      ],
    });
    transaction.mockRejectedValue(new Error('reached the write'));

    await expect(
      service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor }),
    ).rejects.toThrow('reached the write');
  });

  it('an owner recorded as living in that very flat as its tenant', async () => {
    expect(
      await blockOf({
        occupancies: [{ unitId: 'unit-1', citizenId: OWNER, role: 'TENANT' }],
      }),
    ).toBe('OWNER_OCCUPIES_UNIT');
  });

  it('an owner with no file to put the property on', async () => {
    expect(await blockOf({ registrations: 0 })).toBe('OWNER_NO_FILE');
  });

  it('a flat the census already records as somebody else’s', async () => {
    /*
      A link makes its candidate the owner of every flat on the card. On a flat
      with a known owner that is a second owner — and on a card the matrix used
      to fill with flats from two owners, the next save of the tenant's file
      handed one owner the other's flat.
    */
    expect(
      await blockOf({ unitOwners: [{ unitId: 'unit-1', citizenId: 'owner-2', name: 'هشام' }] }),
    ).toBe('UNIT_OWNED_BY_OTHER');
  });

  it('lets through a candidate who is one of the flat’s co-owners', async () => {
    const { service, transaction } = harness({
      unitOwners: [
        { unitId: 'unit-1', citizenId: 'owner-2' },
        { unitId: 'unit-1', citizenId: OWNER },
      ],
    });
    transaction.mockRejectedValue(new Error('reached the write'));

    await expect(
      service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor }),
    ).rejects.toThrow('reached the write');
  });

  it('lets a منزل on a one-unit structure through, naming that unit', async () => {
    /*
      A منزل has no units to tick, so it names none — the census sync infers
      the single unit, and so does the plan. Refusing it would make every
      tenanted house unlinkable.
    */
    const { service, transaction } = harness({
      entry: tenantCard({ propertyType: 'HOUSE', units: [] }),
      building: {
        structureType: 'INDEPENDENT_HOUSE',
        units: [{ id: 'unit-1', unitCode: '0001' }],
      },
    });
    transaction.mockRejectedValue(new Error('reached the write'));

    await expect(
      service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor }),
    ).rejects.toThrow('reached the write');
  });
});

describe('candidatesFor — the form’s lookup', () => {
  it('normalises what was typed before comparing it to what is stored', async () => {
    const { service, db } = harness();

    await service.candidatesFor('03 123456');

    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          OR: [{ phone: LANDLORD_PHONE }, { whatsapp: LANDLORD_PHONE }],
        }),
      }),
    );
  });

  it('returns everybody on a shared line, so the officer can say which one', async () => {
    const { service, db } = harness();
    db.user.findMany.mockResolvedValue([
      { id: 'a', firstName: 'أب', middleName: 'علي', lastName: 'حرب', motherName: null, phone: LANDLORD_PHONE, whatsapp: null, referenceNumber: null, residence: 'RESIDENT', createdAt: new Date() },
      { id: 'b', firstName: 'ابن', middleName: 'أب', lastName: 'حرب', motherName: null, phone: LANDLORD_PHONE, whatsapp: null, referenceNumber: null, residence: 'RESIDENT', createdAt: new Date() },
    ]);

    const found = await service.candidatesFor(LANDLORD_PHONE);

    expect(found.map((candidate) => candidate.id)).toEqual(['a', 'b']);
    expect(found[1]).toMatchObject({ name: 'ابن أب حرب', fatherName: 'أب' });
  });

  it('says nothing about a number too malformed to be one', async () => {
    const { service, db } = harness();

    expect(await service.candidatesFor('12')).toEqual([]);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});

/**
 * «نعم، هو المالك» answered on the form and applied by the save.
 *
 * Every test is about the seam between an answer and the proposals it is
 * matched against, because that seam is where an answer can be attached to the
 * wrong card. The confirmation it delegates to is guarded above.
 */
describe('applyAgreements — an answer given before the card existed', () => {
  const proposal = (over: Record<string, unknown> = {}) =>
    ({
      propertyEntryId: ENTRY,
      occupancyType: 'TENANT',
      propertyType: 'BUILDING',
      landlordName: 'سعيد حرب',
      landlordPhone: LANDLORD_PHONE,
      propertyNumber: '1042',
      buildingName: 'بناية النور',
      buildingId: BUILDING,
      buildingCode: null,
      units: [{ unitId: 'unit-1', unitCode: '0101' }],
      linkedUnitCount: 1,
      filedAt: '2026-03-01T00:00:00.000Z',
      filedBy: null,
      blocked: null,
      candidates: [
        {
          id: OWNER,
          name: 'سعيد حرب',
          fatherName: null,
          motherName: null,
          phone: LANDLORD_PHONE,
          referenceNumber: null,
          residence: 'RESIDENT',
          registeredAt: null,
          outcome: 'NEW_CARD',
          blocked: null,
        },
      ],
      ...over,
    }) as never;

  const confirmed = { linked: true, occupanciesRecorded: 1, unitsClaimed: 1, ownerCardCreated: true };

  it('does nothing at all when the officer answered nothing', async () => {
    const { service } = harness();
    const confirm = jest.spyOn(service, 'confirm');
    const filed = [proposal()];

    expect(await service.applyAgreements({ filed, agreements: [], actor })).toEqual({
      remaining: filed,
      linked: 0,
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('links the card the answer names and stops asking about it', async () => {
    const { service } = harness();
    const confirm = jest.spyOn(service, 'confirm').mockResolvedValue(confirmed);

    const result = await service.applyAgreements({
      filed: [proposal()],
      agreements: [{ phone: LANDLORD_PHONE, citizenId: OWNER }],
      actor,
    });

    expect(result).toEqual({ remaining: [], linked: 1 });
    expect(confirm).toHaveBeenCalledWith({ propertyEntryId: ENTRY, citizenId: OWNER, actor });
  });

  it('ignores an answer whose number no longer matches the card', async () => {
    const { service } = harness();
    const confirm = jest.spyOn(service, 'confirm');
    const filed = [proposal({ landlordPhone: '+96171999888' })];

    const result = await service.applyAgreements({
      filed,
      agreements: [{ phone: LANDLORD_PHONE, citizenId: OWNER }],
      actor,
    });

    expect(result).toEqual({ remaining: filed, linked: 0 });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('ignores an answer naming somebody who is not a candidate on the card', async () => {
    const { service } = harness();
    const confirm = jest.spyOn(service, 'confirm');
    const filed = [proposal()];

    const result = await service.applyAgreements({
      filed,
      agreements: [{ phone: LANDLORD_PHONE, citizenId: 'somebody-else' }],
      actor,
    });

    expect(result).toEqual({ remaining: filed, linked: 0 });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('leaves a claim open when its link was refused, rather than swallowing it', async () => {
    // Including a block: the officer said yes, the card is not on the survey
    // yet, and the claim stays on the queue with the step that fixes it.
    const { service } = harness();
    jest.spyOn(service, 'confirm').mockRejectedValue(new ConflictError('blocked'));
    const filed = [proposal()];

    const result = await service.applyAgreements({
      filed,
      agreements: [{ phone: LANDLORD_PHONE, citizenId: OWNER }],
      actor,
    });

    expect(result).toEqual({ remaining: filed, linked: 0 });
  });

  it('applies one answer without disturbing the claims it says nothing about', async () => {
    const { service } = harness();
    jest.spyOn(service, 'confirm').mockResolvedValue(confirmed);
    const other = proposal({ propertyEntryId: 'entry-2', landlordPhone: '+96171999888' });

    const result = await service.applyAgreements({
      filed: [proposal(), other],
      agreements: [{ phone: LANDLORD_PHONE, citizenId: OWNER }],
      actor,
    });

    expect(result.linked).toBe(1);
    expect(result.remaining).toEqual([other]);
  });
});

describe('dismiss — an answer about people, not about the number', () => {
  it('refuses a dismissal naming nobody', async () => {
    // A card-wide «no» is what shut the real owner out when they registered
    // later on the same line.
    const { service, db } = harness();

    await expect(
      service.dismiss({ propertyEntryId: ENTRY, candidateIds: [], actor }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('reports that it changed nothing when the claim was already settled', async () => {
    const { service, db } = harness();
    db.$executeRaw.mockResolvedValue(0);

    expect(
      await service.dismiss({
        propertyEntryId: ENTRY,
        candidateIds: ['6f0e8a52-1d2b-4c4e-9f7e-0d3c2b1a0f9e'],
        actor,
      }),
    ).toEqual({ dismissed: false });
  });
});

describe('readFootprint — an unrecognised footprint reverts nothing', () => {
  const footprint = {
    v: 1,
    ownerId: OWNER,
    linkedAt: '2026-09-13T00:00:00.000Z',
    actorId: 'staff-1',
    units: [{ unitId: 'unit-1', unitCode: '0101', occupancyId: 'occ-1', row: null }],
    mintedCardIds: [],
  };

  it('reads one this build wrote, filling fields older footprints lack', () => {
    expect(readFootprint(footprint, OWNER)?.units[0]).toMatchObject({
      cases: [],
      filledUnitStatus: null,
      liftedSurveyFrom: null,
    });
  });

  it('rejects a footprint written about a different owner', () => {
    // The owner was deleted and the column set null, or the link was replaced:
    // the rows it names are not this owner's to revert.
    expect(readFootprint(footprint, 'someone-else')).toBeNull();
  });

  it('rejects a version it does not know', () => {
    expect(readFootprint({ ...footprint, v: 2 }, OWNER)).toBeNull();
    expect(readFootprint(null, OWNER)).toBeNull();
  });
});

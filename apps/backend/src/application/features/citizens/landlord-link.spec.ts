import { LandlordLinkService } from './landlord-link.service';
import { ValidationError } from '../../../domain/errors/domain-error';

/**
 * Identifying the owner a مستأجر named — and, much more importantly, refusing
 * to.
 *
 * ## What is actually being pinned down here
 *
 * Every test in this file is about a **refusal**, and that is the right shape
 * for the feature. Linking the right person is one narrow happy path; the ways
 * to link the *wrong* one are numerous, each individually plausible, and each
 * ends with a citizen billed for property that is not theirs.
 *
 * The register is explicit that a phone is not an identity — `User` is unique
 * on the identity document *because* «a household commonly shares one phone» —
 * so this service exists in a place where the evidence is known to be weak. The
 * guards below are what make a weak signal safe to act on: a person answers the
 * question, and the server checks that the question it was answering was real.
 *
 * ## Why stubs rather than a database
 *
 * Because every assertion is about a decision, not a row: whether a confirm is
 * refused, whether a candidate is offered, which `where` a dismissal narrows
 * itself to. A fixture would demonstrate that the rows it happens to contain
 * behaved; it would say nothing about the shared-household row that was not in
 * it and would have been linked anyway. The DB-backed behaviour these delegate
 * to — `recordOccupancy` — has its own integration suite.
 */

const ENTRY = 'entry-1';
const OWNER = 'owner-1';
const TENANT_CITIZEN = 'tenant-1';
/**
 * What «03 123456» is stored as.
 *
 * The trunk `0` is dropped by `internationalPhone`, not carried into the E.164
 * form — so a fixture written as `+96103…` would be a number no row in this
 * register can hold, and the normalisation test below would pass against a
 * value the real column never contains.
 */
const LANDLORD_PHONE = '+9613123456';

function harness(overrides: {
  entry?: Record<string, unknown> | null;
  citizen?: Record<string, unknown> | null;
  /** A card the owner has already filed on this building, if any. */
  ownerCard?: Record<string, unknown> | null;
  building?: Record<string, unknown> | null;
  registration?: Record<string, unknown> | null;
} = {}) {
  const propertyEntryUpdate = jest.fn().mockResolvedValue({});
  const propertyEntryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const propertyEntryCreate = jest.fn().mockResolvedValue({ id: 'owner-card-1' });
  const recordOccupancy = jest.fn().mockResolvedValue({ occupancy: {}, casesResolved: 0 });

  const db = {
    propertyEntry: {
      findUnique: jest.fn().mockResolvedValue(
        overrides.entry === undefined
          ? {
              id: ENTRY,
              occupancyType: 'TENANT',
              landlordPhone: LANDLORD_PHONE,
              landlordCitizenId: null,
              buildingId: 'building-1',
              neighborhood: 'حي الزيتون',
              propertyNumber: '1042',
              registration: { citizenId: TENANT_CITIZEN },
              units: [{ unitId: 'unit-1' }, { unitId: 'unit-2' }, { unitId: null }],
            }
          : overrides.entry,
      ),
      // `declareOwnership` asks this whether the owner already holds a card on
      // the building; undefined in the overrides means "they do not".
      findFirst: jest.fn().mockResolvedValue(overrides.ownerCard ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      create: propertyEntryCreate,
      update: propertyEntryUpdate,
      updateMany: propertyEntryUpdateMany,
    },
    building: {
      findUnique: jest.fn().mockResolvedValue(
        overrides.building === undefined
          ? {
              id: 'building-1',
              parcelNumber: '1042',
              name: 'بناية النور',
              structureType: 'RESIDENTIAL_BUILDING',
            }
          : overrides.building,
      ),
    },
    registration: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          overrides.registration === undefined ? { id: 'owner-reg-1' } : overrides.registration,
        ),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue(
        overrides.citizen === undefined
          ? { id: OWNER, kind: 'CITIZEN', phone: LANDLORD_PHONE, whatsapp: null }
          : overrides.citizen,
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    unitOccupancy: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const service = new LandlordLinkService(
    { prisma: db, tenantSlug: 'albazourieh' } as never,
    { recordOccupancy } as never,
    { emit: jest.fn() } as never,
  );

  return {
    service,
    db,
    propertyEntryUpdate,
    propertyEntryUpdateMany,
    propertyEntryCreate,
    recordOccupancy,
  };
}

const actor = { id: 'staff-1', role: 'SUPER_ADMIN' };

describe('confirm — the guards that stop a wrong link', () => {
  it('refuses when the number on the card is not the citizen’s', async () => {
    /*
      The load-bearing check. `citizenId` arrives from a request and nothing
      upstream has proved it belongs to the person the card names, so without
      this any account that can write could assert *any* citizen as *any*
      card's landlord — and have every screen afterwards report it as a
      confirmed match. A clerk may answer the question; they may not invent it.
    */
    const { service, propertyEntryUpdate } = harness({
      citizen: { id: OWNER, kind: 'CITIZEN', phone: '+96171999888', whatsapp: null },
    });

    await expect(
      service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(propertyEntryUpdate).not.toHaveBeenCalled();
  });

  it('accepts a match on whatsapp, not only on the primary phone', async () => {
    // A landlord's number given by their tenant is as likely to be the one they
    // actually answer as the one they registered with.
    const { service, propertyEntryUpdate } = harness({
      citizen: { id: OWNER, kind: 'CITIZEN', phone: '+96171999888', whatsapp: LANDLORD_PHONE },
    });

    await service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor });

    expect(propertyEntryUpdate).toHaveBeenCalled();
  });

  it('refuses to link a card to the person who filed it', async () => {
    /*
      Reachable without anyone doing anything strange: a household shares a
      line, the son files as a مستأجر and writes the family number as his
      landlord's. Linking records someone as renting from themselves, and puts
      an OWNER spell beside their own TENANT spell on one flat — a contradiction
      the matrix would then display forever, on a card that can bill.
    */
    const { service, propertyEntryUpdate } = harness({
      citizen: { id: TENANT_CITIZEN, kind: 'CITIZEN', phone: LANDLORD_PHONE, whatsapp: null },
    });

    await expect(
      service.confirm({ propertyEntryId: ENTRY, citizenId: TENANT_CITIZEN, actor }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(propertyEntryUpdate).not.toHaveBeenCalled();
  });

  it('refuses an OWNER card, which has no landlord to identify', async () => {
    // `PropertyEntry.normalise` already blanks the phone on one, so this is
    // unreachable through the form — but a rule that decides who gets billed
    // should not rest on another layer having tidied up first.
    const { service, propertyEntryUpdate } = harness({
      entry: {
        id: ENTRY,
        occupancyType: 'OWNER',
        landlordPhone: LANDLORD_PHONE,
        landlordCitizenId: null,
        buildingId: 'building-1',
        registration: { citizenId: TENANT_CITIZEN },
        units: [],
      },
    });

    await expect(
      service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(propertyEntryUpdate).not.toHaveBeenCalled();
  });

  it('is idempotent — re-confirming the same pair changes nothing', async () => {
    // Two clerks reaching the same proposal, or an offline queue delivering the
    // confirmation twice. Agreement is not a conflict.
    const { service, propertyEntryUpdate, recordOccupancy } = harness({
      entry: {
        id: ENTRY,
        occupancyType: 'TENANT',
        landlordPhone: LANDLORD_PHONE,
        landlordCitizenId: OWNER,
        buildingId: 'building-1',
        registration: { citizenId: TENANT_CITIZEN },
        units: [{ unitId: 'unit-1' }],
      },
    });

    const result = await service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor });

    expect(result).toEqual({
      linked: false,
      occupanciesRecorded: 0,
      unitsClaimed: 0,
      ownerCardCreated: false,
    });
    expect(propertyEntryUpdate).not.toHaveBeenCalled();
    expect(recordOccupancy).not.toHaveBeenCalled();
  });
});

describe('confirm — putting the structure on the owner’s own file', () => {
  /*
    Why this exists at all: `assessCitizen` bills from property cards, and
    `attachOccupancies` consults occupancies only to itemise a مبنى card naming
    no flats of its own. An OWNER occupancy with no card behind it is therefore
    invisible to billing — the matrix shows the owner and nobody is charged the
    الأرصفة on a unit the municipality can name.
  */
  it('creates a card claiming the structure, with no unit rows', async () => {
    /*
      The empty `units` array is the load-bearing part. It is what makes the
      card consume the occupancy list, so the claim tracks every flat this
      owner is linked to — now and after the next tenant — instead of freezing
      at whatever this one tenancy happened to name. It is also the honest
      assertion: the clerk confirmed a person, not an inventory.
    */
    const { service, propertyEntryCreate } = harness();

    const result = await service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor });

    expect(result.ownerCardCreated).toBe(true);
    const [[call]] = propertyEntryCreate.mock.calls;
    expect(call.data).toMatchObject({
      registrationId: 'owner-reg-1',
      occupancyType: 'OWNER',
      propertyType: 'BUILDING',
      buildingId: 'building-1',
      propertyNumber: '1042',
      neighborhood: 'حي الزيتون',
    });
    expect(call.data.units).toBeUndefined();
  });

  it('never touches a card the owner already filed on this building', async () => {
    /*
      That card is their own account of what they hold. Topping up an itemised
      one would also change how it is billed — an itemised card stops consuming
      the occupancy list, so adding the flats from a single tenancy could
      *reduce* what the owner is charged.
    */
    const { service, propertyEntryCreate } = harness({ ownerCard: { id: 'existing-card' } });

    const result = await service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor });

    expect(result.linked).toBe(true);
    expect(result.ownerCardCreated).toBe(false);
    expect(propertyEntryCreate).not.toHaveBeenCalled();
  });

  it('states who is in a منزل, so the owner is not charged the occupancy fee too', async () => {
    /*
      A منزل bills its single unit from its own columns rather than from unit
      rows, so a null حالة reads as "nobody was asked" and `bearsFee` charges
      the owner the occupancy fee their tenant is already paying. This is the
      double-charge `FeeBearer` exists to end, arriving through a new door.
    */
    const { service, propertyEntryCreate } = harness({
      building: {
        id: 'building-1',
        parcelNumber: '1042',
        name: null,
        structureType: 'INDEPENDENT_HOUSE',
      },
    });

    await service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor });

    const [[call]] = propertyEntryCreate.mock.calls;
    expect(call.data).toMatchObject({ propertyType: 'HOUSE', unitStatus: 'RENTED' });
  });

  it('records a شاغل بتسامح as مشغولة بتسامح rather than as a tenancy', async () => {
    const { service, propertyEntryCreate } = harness({
      entry: {
        id: ENTRY,
        occupancyType: 'FREE_OCCUPANT',
        landlordPhone: LANDLORD_PHONE,
        landlordCitizenId: null,
        buildingId: 'building-1',
        neighborhood: 'حي الزيتون',
        propertyNumber: '1042',
        registration: { citizenId: TENANT_CITIZEN },
        units: [{ unitId: 'unit-1' }],
      },
      building: {
        id: 'building-1',
        parcelNumber: '1042',
        name: null,
        structureType: 'INDEPENDENT_HOUSE',
      },
    });

    await service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor });

    const [[call]] = propertyEntryCreate.mock.calls;
    expect(call.data).toMatchObject({ unitStatus: 'FREE_OCCUPIED' });
  });

  it('withholds a card for a structure the link cannot be carried on', async () => {
    /*
      `branchFieldsOnly` drops `buildingId` from anything but مبنى and منزل, so
      a TENT_SHELTER card would lose its link the first time anyone edited it —
      a holding attached to nothing. The occupancy still records the ownership.
    */
    const { service, propertyEntryCreate } = harness({
      building: {
        id: 'building-1',
        parcelNumber: '1042',
        name: null,
        structureType: 'TENT_SHELTER',
      },
    });

    const result = await service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor });

    expect(result.linked).toBe(true);
    expect(result.ownerCardCreated).toBe(false);
    expect(propertyEntryCreate).not.toHaveBeenCalled();
  });

  it('still links when the owner has no registration to hang a card on', async () => {
    // Not reachable through the register — a citizen exists because a
    // registration created them — but refused rather than assumed.
    const { service, propertyEntryCreate } = harness({ registration: null });

    const result = await service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor });

    expect(result.linked).toBe(true);
    expect(result.ownerCardCreated).toBe(false);
    expect(propertyEntryCreate).not.toHaveBeenCalled();
  });
});

describe('confirm — what a link writes', () => {
  it('records the owner on every canonical unit the card names, and only those', async () => {
    // The third row in the fixture has `unitId: null` — a flat the officer
    // typed by hand on a parcel nobody has surveyed. There is no canonical unit
    // to put an occupancy on, and inventing one would mint a unit from a
    // tenant's description of somebody else's property.
    const { service, recordOccupancy } = harness();

    const result = await service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor });

    expect(result.unitsClaimed).toBe(2);
    expect(recordOccupancy).toHaveBeenCalledTimes(2);
    expect(recordOccupancy).toHaveBeenCalledWith(
      { unitId: 'unit-1', citizenId: OWNER, role: 'OWNER' },
      actor,
    );
  });

  it('clears an earlier dismissal, because a confirmation supersedes it', async () => {
    const { service, propertyEntryUpdate } = harness();

    await service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor });

    expect(propertyEntryUpdate).toHaveBeenCalledWith({
      where: { id: ENTRY },
      data: { landlordCitizenId: OWNER, landlordLinkDismissedAt: null },
    });
  });

  it('keeps the link when one unit fails, rather than losing all of them', async () => {
    /*
      The flats are independent — each `recordOccupancy` is its own set of
      writes — so stopping at the first failure leaves more of the matrix wrong
      than carrying on does. The link itself is already committed and correct.
    */
    const { service, recordOccupancy } = harness();
    recordOccupancy
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce({ occupancy: {}, casesResolved: 0 });

    const result = await service.confirm({ propertyEntryId: ENTRY, citizenId: OWNER, actor });

    expect(result.linked).toBe(true);
    expect(result.occupanciesRecorded).toBe(1);
    expect(result.unitsClaimed).toBe(2);
  });
});

describe('candidateFor — the inline lookup', () => {
  it('normalises what was typed before comparing it to what is stored', async () => {
    /*
      The one entry point taking a number straight from a keyboard. Every stored
      number is E.164, so an exact comparison against «03 123456» finds nothing
      and the control reports "not registered" about a citizen the register
      holds — confidently wrong, in the direction of not linking.
    */
    const { service, db } = harness();
    db.user.findMany.mockResolvedValue([
      { id: OWNER, firstName: 'سعيد', middleName: null, lastName: 'حرب', phone: LANDLORD_PHONE, referenceNumber: 'REF-9' },
    ]);

    const candidate = await service.candidateFor('03 123456');

    expect(candidate).toMatchObject({ id: OWNER, name: 'سعيد حرب' });
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ phone: LANDLORD_PHONE }, { whatsapp: LANDLORD_PHONE }],
        }),
      }),
    );
  });

  it('offers nobody when several citizens share the number', async () => {
    /*
      A shared household line, and the one case where picking *is* guessing.
      This path has nobody to ask — the card is not even saved — so it says
      nothing rather than offering an arbitrary one of them as the answer. The
      queue shows all of them to a person who can choose.
    */
    const { service, db } = harness();
    db.user.findMany.mockResolvedValue([
      { id: 'a', firstName: 'أب', middleName: null, lastName: 'ما', phone: LANDLORD_PHONE, referenceNumber: null },
      { id: 'b', firstName: 'ابن', middleName: null, lastName: 'ما', phone: LANDLORD_PHONE, referenceNumber: null },
    ]);

    expect(await service.candidateFor(LANDLORD_PHONE)).toBeNull();
  });

  it('says nothing about a number too malformed to be one', async () => {
    const { service, db } = harness();

    expect(await service.candidateFor('12')).toBeNull();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});

describe('proposals — what the queue offers', () => {
  const claim = {
    id: ENTRY,
    landlordName: 'سعيد حرب',
    landlordPhone: LANDLORD_PHONE,
    occupancyType: 'TENANT',
    propertyNumber: '1042',
    buildingName: 'بناية النور',
    buildingId: 'building-1',
    registration: {
      id: 'reg-1',
      referenceNumber: 'REF-1',
      citizen: { id: TENANT_CITIZEN, firstName: 'علي', lastName: 'صالح' },
    },
    units: [{ unitId: 'unit-1' }, { unitId: null }],
  };

  it('counts only the flats a link would actually claim', async () => {
    const { service, db } = harness();
    db.propertyEntry.findMany.mockResolvedValue([claim]);
    db.user.findMany.mockResolvedValue([
      { id: OWNER, firstName: 'سعيد', middleName: null, lastName: 'حرب', phone: LANDLORD_PHONE, whatsapp: null, referenceNumber: 'REF-9' },
    ]);

    const [proposal] = await service.proposals();

    expect(proposal!.linkedUnitCount).toBe(1);
    expect(proposal!.candidates).toHaveLength(1);
  });

  it('never offers the card’s own filer as its landlord', async () => {
    // The shared-household line again, arriving one layer earlier. Offering it
    // at all invites the confirm guard to be the last line of defence, and a
    // guard nobody reaches is a guard nobody maintains.
    const { service, db } = harness();
    db.propertyEntry.findMany.mockResolvedValue([claim]);
    db.user.findMany.mockResolvedValue([
      { id: TENANT_CITIZEN, firstName: 'علي', middleName: null, lastName: 'صالح', phone: LANDLORD_PHONE, whatsapp: null, referenceNumber: 'REF-1' },
    ]);

    expect(await service.proposals()).toEqual([]);
  });

  it('counts a citizen once when their phone and whatsapp are the same number', async () => {
    const { service, db } = harness();
    db.propertyEntry.findMany.mockResolvedValue([claim]);
    db.user.findMany.mockResolvedValue([
      {
        id: OWNER,
        firstName: 'سعيد',
        middleName: null,
        lastName: 'حرب',
        phone: LANDLORD_PHONE,
        whatsapp: LANDLORD_PHONE,
        referenceNumber: 'REF-9',
      },
    ]);

    const [proposal] = await service.proposals();

    expect(proposal!.candidates).toHaveLength(1);
  });

  it('asks only for claims nobody has resolved', async () => {
    const { service, db } = harness();

    await service.proposals();

    expect(db.propertyEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          landlordCitizenId: null,
          landlordLinkDismissedAt: null,
          landlordPhone: { not: null },
        }),
      }),
    );
  });
});

describe('claimsNaming — narrowed in the database, not in memory', () => {
  it('asks only for claims naming this citizen’s own numbers', async () => {
    /*
      This runs after **every** citizen save. Unscoped it reads every open claim
      in the municipality to keep the handful mentioning one number — the whole
      tail of unresolved tenancies, fetched to discard, on each registration.

      Worth its own test because the failure is invisible: the scope and the
      `not: null` guard share a key, so writing them as two object entries makes
      the second silently overwrite the first. The results stay correct and only
      the cost changes, which is exactly the kind of regression no assertion
      about output would ever catch.
    */
    const { service, db } = harness({
      citizen: { id: OWNER, kind: 'CITIZEN', phone: LANDLORD_PHONE, whatsapp: '+96171999888' },
    });

    await service.claimsNaming(OWNER);

    expect(db.propertyEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          landlordPhone: { in: [LANDLORD_PHONE, '+96171999888'] },
        }),
      }),
    );
  });

  it('reads nothing at all for a citizen with no number on file', async () => {
    const { service, db } = harness({
      citizen: { id: OWNER, kind: 'CITIZEN', phone: null, whatsapp: null },
    });

    expect(await service.claimsNaming(OWNER)).toEqual([]);
    expect(db.propertyEntry.findMany).not.toHaveBeenCalled();
  });

  it('drops a claim whose number resolves to somebody else on the same line', async () => {
    // The father is the landlord; the son has just registered on the family
    // phone. The query finds the claim — it names a number he answers on — and
    // this is what stops it being offered as *his*.
    const { service, db } = harness({
      citizen: { id: 'son', kind: 'CITIZEN', phone: LANDLORD_PHONE, whatsapp: null },
    });
    db.propertyEntry.findMany.mockResolvedValue([
      {
        id: ENTRY,
        landlordName: 'سعيد حرب',
        landlordPhone: LANDLORD_PHONE,
        occupancyType: 'TENANT',
        propertyNumber: '1042',
        buildingName: null,
        buildingId: null,
        registration: {
          id: 'reg-1',
          referenceNumber: 'REF-1',
          citizen: { id: TENANT_CITIZEN, firstName: 'علي', lastName: 'صالح' },
        },
        units: [],
      },
    ]);
    db.user.findMany.mockResolvedValue([
      { id: 'father', firstName: 'سعيد', middleName: null, lastName: 'حرب', phone: LANDLORD_PHONE, whatsapp: null, referenceNumber: null },
    ]);

    expect(await service.claimsNaming('son')).toEqual([]);
  });
});

describe('dismiss — narrowed so it cannot overwrite an answer', () => {
  it('only touches a claim that is still open', async () => {
    // Without the narrowing, dismissing a stale row on a screen somebody else
    // has since confirmed would silently un-answer it.
    const { service, propertyEntryUpdateMany } = harness();

    await service.dismiss({ propertyEntryId: ENTRY, actor });

    expect(propertyEntryUpdateMany).toHaveBeenCalledWith({
      where: { id: ENTRY, landlordCitizenId: null, landlordLinkDismissedAt: null },
      data: { landlordLinkDismissedAt: expect.any(Date) },
    });
  });

  it('reports that it changed nothing when the claim was already settled', async () => {
    const { service, propertyEntryUpdateMany } = harness();
    propertyEntryUpdateMany.mockResolvedValue({ count: 0 });

    expect(await service.dismiss({ propertyEntryId: ENTRY, actor })).toEqual({ dismissed: false });
  });
});

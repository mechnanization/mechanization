import { BuildingsService } from './buildings.service';

/**
 * Recording a spell establishes the citizen's own claim on the flat.
 *
 * ## The defect this pins down
 *
 * The mirror of `census-release.spec.ts`, and the half that was missing.
 * `endOccupancy` released a citizen's `PropertyEntry`/`BuildingUnit` claim when
 * a spell ended; nothing established one when a spell began. So the two halves
 * of one fact were maintained in a single direction of travel.
 *
 * An officer who tapped «تسجيل شاغل» therefore got an occupancy on the matrix,
 * a citizen file that went on saying nothing about the flat, and — the moment
 * the matrix re-rendered — an amber «غير مرتبط بملفه» beside the row they had
 * just created, on the commonest correct action in the census, with no way to
 * act on it but to leave and hand-edit that person's card.
 *
 * It cost money in the direction that matters: `assessCitizen` bills the cards
 * a citizen filed, so an occupancy with no card behind it is a flat nobody is
 * charged for.
 *
 * ## Why these are stubbed rather than run against a database
 *
 * For the reason `census-release.spec.ts` gives, inverted. There every
 * assertion was about the shape of a `where` — which rows a release may touch.
 * Here they are about the shape of a `create`, and about the four occasions on
 * which nothing may be created at all. A fixture proves a row appeared; it says
 * nothing about the neighbouring card that was left alone, which is most of
 * what this path has to get right.
 */

const UNIT = 'unit-1';
const BUILDING = 'building-1';
const CITIZEN = 'citizen-1';
const REGISTRATION = 'reg-1';

interface HarnessOptions {
  /** How many units the structure has — the منزل inference's one condition. */
  unitsInBuilding?: number;
  /** `null` models a citizen with no file to attach a card to. */
  registration?: { id: string } | null;
  /** The citizen's existing card on this building, if any. */
  existingEntry?: {
    id: string;
    propertyType: string;
    units: Array<{ id: string; unitId: string | null }>;
  } | null;
  structureType?: string;
  /** What the unit's حالة already is, for the narrowing assertions. */
  role?: string;
}

function harness(options: HarnessOptions = {}) {
  const {
    unitsInBuilding = 6,
    registration = { id: REGISTRATION },
    existingEntry = null,
    structureType = 'RESIDENTIAL_BUILDING',
  } = options;

  const propertyEntryCreate = jest.fn().mockResolvedValue({ id: 'entry-new' });
  const buildingUnitCreate = jest.fn().mockResolvedValue({ id: 'bu-new' });
  const unitUpdate = jest.fn().mockResolvedValue({});
  const unitUpdateMany = jest.fn().mockResolvedValue({ count: 1 });

  const db = {
    unit: {
      findUnique: jest.fn().mockImplementation(({ select }: { select: Record<string, unknown> }) =>
        // Two different reads of the same row: `recordOccupancy` wants the
        // building, `unitDescription` wants the flat's description.
        'buildingId' in select
          ? { id: UNIT, buildingId: BUILDING, unitCode: '0101' }
          : { unitType: 'APARTMENT', floor: 1, side: 'شرقية', unitArea: null },
      ),
      update: unitUpdate,
      updateMany: unitUpdateMany,
      count: jest.fn().mockResolvedValue(unitsInBuilding),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ id: CITIZEN, kind: 'CITIZEN' }) },
    // No vacancy standing on this flat: `recordOccupancy` asks before it writes
    // over one. The refusal and the acknowledged override are covered in
    // `occupancy-end.spec.ts` and the DB integration suite.
    unitVacancyConfirmation: { findFirst: jest.fn().mockResolvedValue(null) },
    unitOccupancy: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: 'occ-1',
        unitId: UNIT,
        citizenId: CITIZEN,
        role: options.role ?? 'OWNER',
        shares: null,
        fromDate: new Date('2026-09-12'),
        toDate: null,
        registrationId: null,
        citizen: { firstName: 'محمد', lastName: 'لا' },
      }),
      update: jest.fn(),
    },
    building: {
      findUnique: jest.fn().mockResolvedValue({
        id: BUILDING,
        parcelNumber: '399',
        name: 'بناية النور',
        structureType,
      }),
    },
    registration: { findFirst: jest.fn().mockResolvedValue(registration) },
    propertyEntry: {
      findFirst: jest.fn().mockResolvedValue(existingEntry),
      create: propertyEntryCreate,
    },
    buildingUnit: { create: buildingUnitCreate },
  };

  const service = new BuildingsService(
    { prisma: db, tenantSlug: 'albazourieh' } as never,
    { resolveForUnit: jest.fn().mockResolvedValue(0) } as never,
    { emit: jest.fn() } as never,
  );

  return { service, db, propertyEntryCreate, buildingUnitCreate, unitUpdate, unitUpdateMany };
}

const actor = { id: 'staff-1', role: 'SUPER_ADMIN' };

function record(service: BuildingsService, over: Record<string, unknown> = {}) {
  return service.recordOccupancy(
    { unitId: UNIT, citizenId: CITIZEN, role: 'OWNER', ...over } as never,
    actor,
  );
}

describe('recordOccupancy — establishing the census claim', () => {
  it('mints a property card on the citizen’s file, ticking this very flat', async () => {
    const { service, propertyEntryCreate } = harness();

    const result = await record(service);

    expect(propertyEntryCreate).toHaveBeenCalledTimes(1);
    const { data } = propertyEntryCreate.mock.calls[0][0];
    expect(data.registrationId).toBe(REGISTRATION);
    expect(data.buildingId).toBe(BUILDING);
    expect(data.units.create.unitId).toBe(UNIT);
    expect(result.fileLink).toEqual({ backed: true, outcome: 'ENTRY_CREATED' });
  });

  it('reports the occupancy as backed, so the warning never fires on it', async () => {
    /*
      The whole of the user-visible bug. The write path returns the row it just
      wrote, and used to return `backedByFile: true` by convention rather than
      by fact — while `get`, on the next render, answered honestly and put an
      amber flag on it. The two now agree because the claim is real.
    */
    const { service } = harness();

    const result = await record(service);

    expect(result.occupancy.backedByFile).toBe(true);
  });

  it('carries صفة الإشغال across as نوع الإشغال, so a tenant files a tenant’s card', async () => {
    /*
      The three roles and the three occupancy types are the same three values
      because they are one question asked of the unit and of the card. Getting
      this wrong would record every occupant as an owner — a deed asserted on a
      register that had only been told somebody lives there.
    */
    for (const role of ['OWNER', 'TENANT', 'FREE_OCCUPANT']) {
      const { service, propertyEntryCreate } = harness({ role });

      await record(service, { role });

      expect(propertyEntryCreate.mock.calls[0][0].data.occupancyType).toBe(role);
    }
  });

  it('puts the description and حالة on a منزل card, which has no units to tick', async () => {
    const { service, propertyEntryCreate } = harness({
      unitsInBuilding: 1,
      structureType: 'INDEPENDENT_HOUSE',
    });

    await record(service, { role: 'TENANT' });

    const { data } = propertyEntryCreate.mock.calls[0][0];
    expect(data.propertyType).toBe('HOUSE');
    expect(data.units).toBeUndefined();
    // Derived from the tenancy: `bearsFee` reads a null حالة as "nobody was
    // asked" and charges the owner an occupancy fee the tenant is already paying.
    expect(data.unitStatus).toBe('RENTED');
  });

  it('adds the missing tick to a card that already itemises other flats', async () => {
    /*
      Such a card stopped consuming the occupancy list the moment it listed
      anything (`attachOccupancies`), so a row here is the only way this
      occupancy can be backed at all.
    */
    const { service, buildingUnitCreate, propertyEntryCreate } = harness({
      existingEntry: {
        id: 'entry-1',
        propertyType: 'BUILDING',
        units: [{ id: 'bu-1', unitId: 'unit-other' }],
      },
    });

    const result = await record(service);

    expect(propertyEntryCreate).not.toHaveBeenCalled();
    expect(buildingUnitCreate).toHaveBeenCalledTimes(1);
    const { data } = buildingUnitCreate.mock.calls[0][0];
    expect(data.propertyEntryId).toBe('entry-1');
    expect(data.unitId).toBe(UNIT);
    // The floor is copied from the canonical unit as the one label
    // `parseFloorLabel` reads back to the integer it came from.
    expect(data.floor).toBe('1');
    expect(result.fileLink.outcome).toBe('UNIT_ADDED');
  });

  it('writes nothing when a card of theirs already claims the flat', async () => {
    const { service, buildingUnitCreate, propertyEntryCreate } = harness({
      existingEntry: {
        id: 'entry-1',
        propertyType: 'BUILDING',
        units: [{ id: 'bu-1', unitId: UNIT }],
      },
    });

    const result = await record(service);

    expect(propertyEntryCreate).not.toHaveBeenCalled();
    expect(buildingUnitCreate).not.toHaveBeenCalled();
    expect(result.fileLink).toEqual({ backed: true, outcome: 'ALREADY_CLAIMED' });
  });

  it('leaves an un-itemised مبنى card alone — it already claims every flat they hold', async () => {
    /*
      The shape `heldThroughOccupancy` exists for, and the one
      `LandlordLinkService.declareOwnership` deliberately mints. Ticking a flat
      onto it would *reduce* what its holder is charged, because an itemised
      card stops reading the occupancy list.
    */
    const { service, buildingUnitCreate, propertyEntryCreate } = harness({
      existingEntry: { id: 'entry-1', propertyType: 'BUILDING', units: [] },
    });

    const result = await record(service);

    expect(propertyEntryCreate).not.toHaveBeenCalled();
    expect(buildingUnitCreate).not.toHaveBeenCalled();
    expect(result.fileLink).toEqual({ backed: true, outcome: 'ALREADY_CLAIMED' });
  });

  it('invents no file for a citizen who has none, and says so', async () => {
    /*
      The one state «غير مرتبط بملفه» is now meant to describe — and the only
      one it should ever appear in.
    */
    const { service, propertyEntryCreate } = harness({ registration: null });

    const result = await record(service);

    expect(propertyEntryCreate).not.toHaveBeenCalled();
    expect(result.fileLink).toEqual({ backed: false, outcome: 'NO_FILE' });
    expect(result.occupancy.backedByFile).toBe(false);
  });

  it('mints no card on a خيمة, which cannot carry the link', async () => {
    /*
      `branchFieldsOnly` drops `buildingId` from anything but مبنى and منزل, so
      the card would lose its link the first time anyone edited it — a holding
      attached to nothing. The same refusal `declareOwnership` makes.
    */
    const { service, propertyEntryCreate } = harness({ structureType: 'TENT_SHELTER' });

    const result = await record(service);

    expect(propertyEntryCreate).not.toHaveBeenCalled();
    expect(result.fileLink).toEqual({ backed: false, outcome: 'UNLINKABLE_STRUCTURE' });
  });
});

describe('recordOccupancy — حالة الوحدة', () => {
  it('takes an owner’s stated حالة as a finding, replacing what was there', async () => {
    /*
      «سجّلت المالك» used to say nothing about whether the flat was lived in,
      let, lent or empty — so `bearsFee` read the null as "nobody was asked" and
      charged the owner the occupancy fee while the tenant downstairs was
      charged it too on their own card. An owner who states «مؤجرة» is making a
      finding, and a finding replaces the previous one.
    */
    const { service, unitUpdate, unitUpdateMany } = harness();

    await record(service, { role: 'OWNER', unitStatus: 'RENTED' });

    expect(unitUpdate).toHaveBeenCalledWith({
      where: { id: UNIT },
      data: { unitStatus: 'RENTED' },
    });
    expect(unitUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { unitStatus: expect.anything() } }),
    );
  });

  it('leaves an unstated حالة alone rather than guessing «مشغولة من المالك»', async () => {
    const { service, unitUpdate } = harness();

    await record(service, { role: 'OWNER' });

    // An owner says nothing about residence on their own — the deed is not a
    // statement of it (D2) — so nothing is written and the flat keeps whatever
    // an officer previously established.
    expect(unitUpdate).not.toHaveBeenCalled();
  });

  it('still only infers a non-owner’s حالة into a unit nobody has answered for', async () => {
    /*
      Unchanged, and deliberately so: an inference may fill a gap, never
      overwrite a finding. An officer who recorded «شاغرة» and a tenancy that
      says otherwise are a contradiction for a person to resolve.
    */
    const { service, unitUpdate, unitUpdateMany } = harness({ role: 'TENANT' });

    await record(service, { role: 'TENANT' });

    expect(unitUpdate).not.toHaveBeenCalled();
    expect(unitUpdateMany).toHaveBeenCalledWith({
      where: { id: UNIT, unitStatus: null },
      data: { unitStatus: 'RENTED' },
    });
  });
});

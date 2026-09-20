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
  /** How many units the structure has — what decides منزل or مبنى on a card being minted. */
  unitsInBuilding?: number;
  /** `null` models a citizen with no file to attach a card to. */
  registration?: { id: string } | null;
  /** The citizen's existing card on this building, if any. */
  existingEntry?: {
    id: string;
    propertyType: string;
    occupancyType?: string;
    units: Array<{ id: string; unitId: string | null }>;
  } | null;
  /** Every card of theirs on this building, oldest first, when there are several. */
  existingCards?: Array<{
    id: string;
    propertyType: string;
    occupancyType: string;
    landlordCitizenId?: string | null;
    landlordPhone?: string | null;
    units: Array<{ id: string; unitId: string | null }>;
  }>;
  structureType?: string;
  /** What the unit's حالة already is, for the narrowing assertions. */
  role?: string;
  /** Registered citizens by id, for the owner a tenant is recorded as renting from. */
  owners?: Record<string, { phone: string | null; whatsapp?: string | null }>;
  /** Current owner spells on units other than this one, for the typed-number reuse. */
  otherOwnerSpells?: Array<{ unitId: string }>;
  /**
   * What the census says *this* citizen currently holds in *this* structure.
   *
   * What a منزل card is about is read from here, because the card itself does
   * not say: it bills from its own columns and has no units array.
   */
  spellsHere?: Array<{ unitId: string; role: string }>;
  /**
   * The area the census already holds for the flat.
   *
   * Null by default, which is what a matrix painted from the street looks like:
   * `generateUnits` and the grid picker both assert that a flat exists, not
   * that anybody has measured it.
   */
  unitArea?: number | null;
}

function harness(options: HarnessOptions = {}) {
  const {
    unitsInBuilding = 6,
    registration = { id: REGISTRATION },
    existingEntry = null,
    existingCards,
    structureType = 'RESIDENTIAL_BUILDING',
  } = options;

  const propertyEntryCreate = jest.fn().mockResolvedValue({ id: 'entry-new' });
  const buildingUnitCreate = jest.fn().mockResolvedValue({ id: 'bu-new' });
  const unitUpdate = jest.fn().mockResolvedValue({});

  /*
    The flat's area as the stub holds it, so a write is visible to the read
    that follows it.

    The one piece of state this harness keeps, and it has to: `claimOnFile`
    copies the canonical unit's description onto the card it mints, so whether
    the card carries the officer's measurement or the null it replaced depends
    entirely on the order of the write and that read. A stub that answered the
    same thing before and after the update could not tell the two apart, and
    the ordering is exactly what went wrong.

    The narrowing is modelled too — `where: { unitArea: null }` — because it is
    what protects a surveyed measurement from being overwritten here.
  */
  let storedArea: number | null = options.unitArea ?? null;
  const unitUpdateMany = jest
    .fn()
    .mockImplementation(({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if ('unitArea' in data) {
        if (where.unitArea === null && storedArea !== null) return Promise.resolve({ count: 0 });
        storedArea = data.unitArea as number;
        return Promise.resolve({ count: 1 });
      }
      return Promise.resolve({ count: 1 });
    });

  const db = {
    unit: {
      findUnique: jest.fn().mockImplementation(({ select }: { select: Record<string, unknown> }) =>
        // Two different reads of the same row: `recordOccupancy` wants the
        // building and the area it may be about to fill in, `unitDescription`
        // wants the flat's description.
        'buildingId' in select
          ? { id: UNIT, buildingId: BUILDING, unitCode: '0101', unitArea: storedArea }
          : { unitType: 'APARTMENT', floor: 1, side: 'شرقية', unitArea: storedArea },
      ),
      update: unitUpdate,
      updateMany: unitUpdateMany,
      count: jest.fn().mockResolvedValue(unitsInBuilding),
    },
    user: {
      findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          options.owners?.[where.id]
            ? {
                id: where.id,
                kind: 'CITIZEN',
                firstName: 'مالك',
                middleName: null,
                lastName: 'مسجَّل',
                whatsapp: null,
                ...options.owners[where.id],
              }
            : { id: CITIZEN, kind: 'CITIZEN' },
        ),
      ),
    },
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
      // Two different reads again: this citizen's own spells in this building,
      // and other people's owner spells on a candidate card's flats.
      findMany: jest
        .fn()
        .mockImplementation(({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(where.unit ? (options.spellsHere ?? []) : (options.otherOwnerSpells ?? [])),
        ),
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
      findMany: jest.fn().mockResolvedValue(
        (existingCards ?? (existingEntry ? [existingEntry] : [])).map((card) => ({
          // A card of the capacity being recorded unless the test says otherwise.
          occupancyType: options.role ?? 'OWNER',
          landlordCitizenId: null,
          landlordPhone: null,
          landlordLinkDismissedIds: [],
          ...card,
        })),
      ),
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

/**
 * مساحة الوحدة, recorded from the doorstep.
 *
 * The matrix is painted from the street, so `Unit.unitArea` is routinely null —
 * and this path mints the citizen's card *from* the unit, so the card inherited
 * the null and `assessCitizen` then refused to price a PER_AREA notice against
 * it. Linking an occupant is the first moment anybody is inside, and the form
 * had nowhere to put the measurement.
 *
 * The two rules these pin down: it fills a gap and never overwrites a finding,
 * and it is written before the card is minted so the card carries the new
 * number rather than the null it replaced.
 */
describe('recordOccupancy — the flat’s area', () => {
  it('writes the area onto the unit, narrowed to one that has none', async () => {
    const { service, db } = harness();

    await record(service, { unitArea: 96.5 });

    const [[call]] = db.unit.updateMany.mock.calls.filter(
      ([arg]: [{ data: Record<string, unknown> }]) => 'unitArea' in arg.data,
    );
    expect(call.where).toEqual({ id: UNIT, unitArea: null });
    expect(call.data).toEqual({ unitArea: 96.5 });
  });

  it('writes nothing at all when the form sent no area', async () => {
    const { service, db } = harness();

    await record(service);

    const areaWrites = db.unit.updateMany.mock.calls.filter(
      ([arg]: [{ data: Record<string, unknown> }]) => 'unitArea' in arg.data,
    );
    expect(areaWrites).toHaveLength(0);
  });

  it('leaves a measured flat alone — the narrowing is what does it', async () => {
    /*
      The guard is in the `where`, not in the caller, so it holds even against a
      client that sends an area for a unit that already has one. Correcting a
      surveyed measurement is the unit editor's job; doing it as a side effect
      of filing a tenant would change a PER_AREA bill with nothing on screen to
      say so.
    */
    const { service, db } = harness({ unitArea: 180 });

    await record(service, { unitArea: 1 });

    const [[call]] = db.unit.updateMany.mock.calls.filter(
      ([arg]: [{ data: Record<string, unknown> }]) => 'unitArea' in arg.data,
    );
    expect(call.where.unitArea).toBeNull();
  });

  it('carries the area onto the card it mints, not the null it replaced', async () => {
    /*
      Ordering, asserted because it is the whole point. `claimOnFile` copies the
      canonical unit's description onto the new card, so the area has to be on
      the unit *before* the card is built — otherwise the officer measures the
      flat, the unit gets the number, and the card that bills it does not.
    */
    const { service, propertyEntryCreate } = harness({ unitArea: null });

    await record(service, { unitArea: 96.5 });

    const { data } = propertyEntryCreate.mock.calls[0][0];
    expect(data.units.create.unitArea).toBe(96.5);
  });
});

describe('recordOccupancy — establishing the census claim', () => {
  it('mints a property card on the citizen’s file, ticking this very flat', async () => {
    const { service, propertyEntryCreate } = harness();

    const result = await record(service);

    expect(propertyEntryCreate).toHaveBeenCalledTimes(1);
    const { data } = propertyEntryCreate.mock.calls[0][0];
    expect(data.registrationId).toBe(REGISTRATION);
    expect(data.buildingId).toBe(BUILDING);
    expect(data.units.create.unitId).toBe(UNIT);
    expect(result.fileLink).toEqual({
      backed: true,
      outcome: 'ENTRY_CREATED',
      propertyEntryId: 'entry-new',
    });
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

  /*
    Z-5-201-A, 2026-09-19. An officer filed a citizen on a منزل card of 130 m²
    while the structure was a single house, then made it a three-floor building,
    added a 9 m² مستودع, and recorded the same man as its owner. The مستودع was
    ticked onto his منزل card — and `billableUnits` reads a card's rows whenever
    it has any and its own columns only while it has none, so from that moment
    the municipality assessed 9 m² and his home was not assessed at all.

    One matrix tap, no warning, and nothing in the file that looks wrong.
  */
  it('leaves a منزل card unticked when they hold another flat here, so the house stays billed', async () => {
    const { service, buildingUnitCreate, propertyEntryCreate } = harness({
      unitsInBuilding: 2,
      existingEntry: { id: 'entry-house', propertyType: 'HOUSE', units: [] },
      // The home the منزل card was filed for, which no row names.
      spellsHere: [
        { unitId: 'unit-home', role: 'OWNER' },
        { unitId: UNIT, role: 'OWNER' },
      ],
    });

    const result = await record(service);

    expect(buildingUnitCreate).not.toHaveBeenCalled();
    expect(result.fileLink.outcome).toBe('ENTRY_CREATED');
    const { data } = propertyEntryCreate.mock.calls[0][0];
    expect(data.units.create.unitId).toBe(UNIT);
  });

  it('writes nothing when the منزل card is about this very flat', async () => {
    // The same shape, minus the second holding: nothing else here is theirs, so
    // the card that bills from its own columns is this flat's card. Re-recording
    // the spell — an owner link re-running over a flat the matrix already has —
    // must not mint a second card and bill the man twice.
    const { service, buildingUnitCreate, propertyEntryCreate } = harness({
      unitsInBuilding: 2,
      existingEntry: { id: 'entry-house', propertyType: 'HOUSE', units: [] },
      spellsHere: [{ unitId: UNIT, role: 'OWNER' }],
    });

    const result = await record(service);

    expect(buildingUnitCreate).not.toHaveBeenCalled();
    expect(propertyEntryCreate).not.toHaveBeenCalled();
    expect(result.fileLink).toEqual({
      backed: true,
      outcome: 'ALREADY_CLAIMED',
      propertyEntryId: 'entry-house',
    });
  });

  it('files a flat on a built-up منزل as a مبنى card naming it', async () => {
    /*
      With several units standing there is nothing for a card billing from its
      own columns to be about, and no honest way to make it say which flat it
      is: `PropertyEntry` forbids a HOUSE card a units array, the منزل branch
      of `propertyEntrySchema` has no such field for the form to round-trip,
      and a row written past both is deleted by the first save of the file.

      So the census decides نوع العقار, not `STRUCTURE_TYPE_MAP` alone.
    */
    const { service, propertyEntryCreate } = harness({
      unitsInBuilding: 3,
      structureType: 'INDEPENDENT_HOUSE',
    });

    await record(service, { role: 'TENANT' });

    const { data } = propertyEntryCreate.mock.calls[0][0];
    expect(data.propertyType).toBe('BUILDING');
    expect(data.units.create.unitId).toBe(UNIT);
    // The columns a منزل bills from stay empty: the row carries the flat.
    expect(data.unitArea).toBeUndefined();
    expect(data.unitType).toBeUndefined();
  });

  it('still files a منزل as a منزل while it is the only unit standing', async () => {
    const { service, propertyEntryCreate } = harness({
      unitsInBuilding: 1,
      structureType: 'INDEPENDENT_HOUSE',
      unitArea: 130,
    });

    await record(service);

    const { data } = propertyEntryCreate.mock.calls[0][0];
    expect(data.propertyType).toBe('HOUSE');
    expect(data.units).toBeUndefined();
    expect(data.unitArea).toBe(130);
  });

  it('lets two منزل cards account for two flats rather than minting a third', async () => {
    /*
      Neither card says which flat it is, so the flats are counted against the
      cards rather than matched to them. Two column-billing cards cover two
      flats between them, and this is one of the two — a third card would bill
      the man for a flat he holds once, twice.

      Reachable only through cards filed by hand: this path mints at most one
      per capacity per structure. Which is the point — the rule has to hold on
      data it did not create.
    */
    const { service, buildingUnitCreate, propertyEntryCreate } = harness({
      unitsInBuilding: 3,
      existingCards: [
        { id: 'entry-a', propertyType: 'HOUSE', occupancyType: 'OWNER', units: [] },
        { id: 'entry-b', propertyType: 'HOUSE', occupancyType: 'OWNER', units: [] },
      ],
      spellsHere: [
        { unitId: 'unit-home', role: 'OWNER' },
        { unitId: UNIT, role: 'OWNER' },
      ],
    });

    const result = await record(service);

    expect(buildingUnitCreate).not.toHaveBeenCalled();
    expect(propertyEntryCreate).not.toHaveBeenCalled();
    expect(result.fileLink.outcome).toBe('ALREADY_CLAIMED');
    expect(result.fileLink.propertyEntryId).toBe('entry-a');
  });

  it('files the flat those cards cannot account for', async () => {
    // Three flats held, two cards that each bill one: the surplus gets its own.
    const { service, buildingUnitCreate, propertyEntryCreate } = harness({
      unitsInBuilding: 4,
      existingCards: [
        { id: 'entry-a', propertyType: 'HOUSE', occupancyType: 'OWNER', units: [] },
        { id: 'entry-b', propertyType: 'HOUSE', occupancyType: 'OWNER', units: [] },
      ],
      spellsHere: [
        { unitId: 'unit-home', role: 'OWNER' },
        { unitId: 'unit-shop', role: 'OWNER' },
        { unitId: UNIT, role: 'OWNER' },
      ],
    });

    const result = await record(service);

    // Never as a row on one of them: that card would stop billing its own flat.
    expect(buildingUnitCreate).not.toHaveBeenCalled();
    expect(result.fileLink.outcome).toBe('ENTRY_CREATED');
    const { data } = propertyEntryCreate.mock.calls[0][0];
    expect(data.units.create.unitId).toBe(UNIT);
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
    expect(result.fileLink).toEqual({
      backed: true,
      outcome: 'ALREADY_CLAIMED',
      propertyEntryId: 'entry-1',
    });
  });

  it('ticks an owner’s flat onto their مالك card, not the older مستأجر card beside it', async () => {
    /*
      Somebody renting flat 1 and owning flat 3 in one block holds two cards
      there. Oldest-first put the owned flat on the tenancy card, and
      `billableUnits` takes the role from the card — so every owner-borne fee
      on flat 3 went to them as a tenant, on a row that looked correct.
    */
    const { service, buildingUnitCreate } = harness({
      existingCards: [
        {
          id: 'tenancy-card',
          propertyType: 'BUILDING',
          occupancyType: 'TENANT',
          units: [{ id: 'bu-1', unitId: 'unit-rented' }],
        },
        {
          id: 'owner-card',
          propertyType: 'BUILDING',
          occupancyType: 'OWNER',
          units: [{ id: 'bu-2', unitId: 'unit-owned-before' }],
        },
      ],
    });

    const result = await record(service, { role: 'OWNER' });

    expect(buildingUnitCreate.mock.calls[0][0].data.propertyEntryId).toBe('owner-card');
    expect(result.fileLink).toEqual({
      backed: true,
      outcome: 'UNIT_ADDED',
      propertyEntryId: 'owner-card',
    });
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
    expect(result.fileLink).toEqual({
      backed: true,
      outcome: 'ALREADY_CLAIMED',
      propertyEntryId: 'entry-1',
    });
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

/**
 * One tenancy card per owner.
 *
 * The defect: a tenant already renting flat 0001 from one owner was recorded on
 * flat 0101 of another, and the flat was ticked onto the first card — so their
 * file said 0101 was rented from the wrong person, ending it recorded the
 * ending against that person, and the next save of the file would have moved
 * the first owner onto the second owner's flat.
 */
describe('recordOccupancy — one tenancy card per owner', () => {
  const OWNER_A = 'owner-a';
  const OWNER_B = 'owner-b';

  it('files a flat rented from a second owner on a card of its own', async () => {
    const { service, propertyEntryCreate, buildingUnitCreate } = harness({
      role: 'TENANT',
      owners: { [OWNER_B]: { phone: '+96171000002' } },
      existingCards: [
        {
          id: 'rented-from-a',
          propertyType: 'BUILDING',
          occupancyType: 'TENANT',
          landlordCitizenId: OWNER_A,
          landlordPhone: '+96171000001',
          units: [{ id: 'bu-1', unitId: 'unit-shop' }],
        },
      ],
    });

    const result = await record(service, { role: 'TENANT', landlordCitizenId: OWNER_B });

    expect(buildingUnitCreate).not.toHaveBeenCalled();
    expect(propertyEntryCreate).toHaveBeenCalledTimes(1);
    const { data } = propertyEntryCreate.mock.calls[0][0];
    expect(data.occupancyType).toBe('TENANT');
    // The owner's own name and number, so the card can be saved from the form.
    expect(data.landlordPhone).toBe('+96171000002');
    expect(data.landlordName).toBe('مالك مسجَّل');
    // The link itself is the owner-link service's to write, with its footprint.
    expect(data.landlordCitizenId).toBeUndefined();
    expect(result.fileLink.outcome).toBe('ENTRY_CREATED');
  });

  it('adds the flat to the tenancy card already linked to the same owner', async () => {
    const { service, propertyEntryCreate, buildingUnitCreate } = harness({
      role: 'TENANT',
      owners: { [OWNER_B]: { phone: '+96171000002' } },
      existingCards: [
        {
          id: 'rented-from-a',
          propertyType: 'BUILDING',
          occupancyType: 'TENANT',
          landlordCitizenId: OWNER_A,
          units: [{ id: 'bu-1', unitId: 'unit-shop' }],
        },
        {
          id: 'rented-from-b',
          propertyType: 'BUILDING',
          occupancyType: 'TENANT',
          landlordCitizenId: OWNER_B,
          units: [{ id: 'bu-2', unitId: 'unit-store' }],
        },
      ],
    });

    const result = await record(service, { role: 'TENANT', landlordCitizenId: OWNER_B });

    expect(propertyEntryCreate).not.toHaveBeenCalled();
    expect(buildingUnitCreate.mock.calls[0][0].data.propertyEntryId).toBe('rented-from-b');
    expect(result.fileLink).toEqual({
      backed: true,
      outcome: 'UNIT_ADDED',
      propertyEntryId: 'rented-from-b',
    });
  });

  it('reuses an unlinked card typed with the owner’s number — unless its flats are somebody else’s', async () => {
    const card = {
      id: 'typed-b',
      propertyType: 'BUILDING',
      occupancyType: 'TENANT',
      landlordPhone: '+96171000002',
      units: [{ id: 'bu-1', unitId: 'unit-other' }],
    };

    const theirs = harness({
      role: 'TENANT',
      owners: { [OWNER_B]: { phone: '+96171000002' } },
      existingCards: [card],
    });
    const reused = await record(theirs.service, { role: 'TENANT', landlordCitizenId: OWNER_B });
    expect(reused.fileLink.outcome).toBe('UNIT_ADDED');

    const somebodyElses = harness({
      role: 'TENANT',
      owners: { [OWNER_B]: { phone: '+96171000002' } },
      existingCards: [card],
      otherOwnerSpells: [{ unitId: 'unit-other' }],
    });
    const minted = await record(somebodyElses.service, { role: 'TENANT', landlordCitizenId: OWNER_B });
    expect(minted.fileLink.outcome).toBe('ENTRY_CREATED');
  });

  it('files a tenancy whose owner nobody named on a card of its own', async () => {
    /*
      Two flats with unknown owners are not known to share one, and filing them
      together would hand both to whichever owner is identified first.
    */
    const { service, propertyEntryCreate } = harness({
      role: 'TENANT',
      existingCards: [
        {
          id: 'unknown-owner',
          propertyType: 'BUILDING',
          occupancyType: 'TENANT',
          units: [{ id: 'bu-1', unitId: 'unit-other' }],
        },
      ],
    });

    const result = await record(service, { role: 'TENANT' });

    expect(propertyEntryCreate).toHaveBeenCalledTimes(1);
    expect(result.fileLink.outcome).toBe('ENTRY_CREATED');
  });

  it('writes a typed owner onto the new tenancy card', async () => {
    const { service, propertyEntryCreate } = harness({ role: 'TENANT' });

    await record(service, { role: 'TENANT', landlordName: 'سعيد حرب', landlordPhone: '+96171000009' });

    const { data } = propertyEntryCreate.mock.calls[0][0];
    expect(data.landlordName).toBe('سعيد حرب');
    expect(data.landlordPhone).toBe('+96171000009');
  });

  it('never ticks a flat somebody owns onto their مستأجر card', async () => {
    /*
      Rows bill in the card's نوع الإشغال. With only a tenancy card on the
      building, the owned flat used to land on it and bill as a tenancy.
    */
    const { service, propertyEntryCreate, buildingUnitCreate } = harness({
      existingCards: [
        {
          id: 'tenancy-card',
          propertyType: 'BUILDING',
          occupancyType: 'TENANT',
          units: [{ id: 'bu-1', unitId: 'unit-rented' }],
        },
      ],
    });

    const result = await record(service, { role: 'OWNER' });

    expect(buildingUnitCreate).not.toHaveBeenCalled();
    expect(propertyEntryCreate.mock.calls[0][0].data.occupancyType).toBe('OWNER');
    expect(result.fileLink.outcome).toBe('ENTRY_CREATED');
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

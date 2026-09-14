import { BuildingsService } from './buildings.service';

/**
 * Ending a spell releases the citizen's own claim on the flat.
 *
 * ## The defect this pins down
 *
 * Who is in a unit is recorded twice: `UnitOccupancy`, which the matrix shows,
 * and the citizen's `PropertyEntry`/`BuildingUnit` link, which their file
 * displays and which billing reads. `CensusSyncService` writes both, because a
 * registration establishes both. `endOccupancy` used to write only the first.
 *
 * So an officer who ended a spell from the matrix saw the occupant go, while
 * the register went on answering «من يملك هذه الوحدة؟» with them — and the
 * next ordinary save of that citizen's file re-created the occupancy from the
 * link nobody had cleared. A household evicted on paper moved back in because
 * somebody corrected a phone number.
 *
 * ## Why these are stubbed rather than run against a database
 *
 * Every assertion here is about the **shape of the `where`** — which rows the
 * release is allowed to touch. That is exactly what an integration test is
 * worst at showing: a fixture proves the rows it happens to contain were
 * updated, and says nothing about the neighbour's card that was not in the
 * fixture and would have been swept up too. The narrowing is the behaviour, so
 * the narrowing is what is asserted.
 */

const UNIT = 'unit-1';
const BUILDING = 'building-1';
const CITIZEN = 'citizen-1';

function harness(unitsInBuilding: number) {
  const buildingUnitUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const propertyEntryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });

  const db = {
    unitOccupancy: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'occ-1',
        unitId: UNIT,
        citizenId: CITIZEN,
        role: 'OWNER',
        fromDate: new Date('2026-01-01'),
        toDate: null,
        unit: { buildingId: BUILDING, unitCode: '0001' },
      }),
      update: jest.fn().mockResolvedValue({
        id: 'occ-1',
        unitId: UNIT,
        citizenId: CITIZEN,
        role: 'OWNER',
        shares: null,
        fromDate: new Date('2026-01-01'),
        toDate: new Date('2026-09-11'),
        registrationId: null,
        citizen: { firstName: 'هاشم', lastName: 'نصرالله' },
      }),
    },
    buildingUnit: { updateMany: buildingUnitUpdateMany },
    propertyEntry: { updateMany: propertyEntryUpdateMany },
    unit: { count: jest.fn().mockResolvedValue(unitsInBuilding) },
  };

  const service = new BuildingsService(
    { prisma: db, tenantSlug: 'albazourieh' } as never,
    { resolveForUnit: jest.fn().mockResolvedValue(0) } as never,
    { emit: jest.fn() } as never,
  );

  return { service, db, buildingUnitUpdateMany, propertyEntryUpdateMany };
}

const actor = { id: 'staff-1', role: 'SUPER_ADMIN' };

describe('endOccupancy — releasing the census claim', () => {
  it('drops the tick that pointed a مبنى card at this flat', async () => {
    const { service, buildingUnitUpdateMany } = harness(6);

    await service.endOccupancy('occ-1', { reason: 'OWNERSHIP_TRANSFERRED' }, actor);

    expect(buildingUnitUpdateMany).toHaveBeenCalledWith({
      where: {
        unitId: UNIT,
        // An ended tenancy's row keeps naming its flat as history (0046); only
        // a current claim is released.
        endedAt: null,
        propertyEntry: { endedAt: null, registration: { citizenId: CITIZEN } },
      },
      data: { unitId: null },
    });
  });

  it("nulls the link without deleting the citizen's own line about the flat", async () => {
    /*
      The `BuildingUnit` row is what the citizen filed — floor, area, أسهم —
      and remains true whether or not the census still agrees they live there.
      Deleting it would answer "they moved out" by discarding their statement.
    */
    const { service, buildingUnitUpdateMany } = harness(6);

    await service.endOccupancy('occ-1', { reason: 'OWNERSHIP_TRANSFERRED' }, actor);

    const [call] = buildingUnitUpdateMany.mock.calls;
    expect(call[0].data).toEqual({ unitId: null });
    expect(Object.keys(call[0].data)).toEqual(['unitId']);
  });

  it('releases a منزل standing on a one-unit structure, where the claim is the buildingId', async () => {
    /*
      Such a card has no units to tick, so `CensusSyncService` infers the unit
      from the building. Clearing unit links alone would leave the inference
      free to re-create exactly the occupancy just ended.
    */
    const { service, propertyEntryUpdateMany } = harness(1);

    await service.endOccupancy('occ-1', { reason: 'OWNERSHIP_TRANSFERRED' }, actor);

    expect(propertyEntryUpdateMany).toHaveBeenCalledWith({
      where: {
        buildingId: BUILDING,
        propertyType: 'HOUSE',
        endedAt: null,
        registration: { citizenId: CITIZEN },
        units: { none: { unitId: { not: null } } },
      },
      data: { buildingId: null },
    });
  });

  it('leaves buildingId alone on a multi-unit block', async () => {
    /*
      A منزل linked to a six-flat block claims nothing by inference, so severing
      its `buildingId` would discard a link an officer made deliberately and
      answer "this person left flat 3" by forgetting which building it was.
    */
    const { service, propertyEntryUpdateMany } = harness(6);

    await service.endOccupancy('occ-1', { reason: 'OWNERSHIP_TRANSFERRED' }, actor);

    expect(propertyEntryUpdateMany).not.toHaveBeenCalled();
  });

  it("never reaches another citizen's cards", async () => {
    /*
      The failure that would be invisible in production and catastrophic: a
      release scoped to the unit alone would evict every co-owner and tenant
      recorded on the same flat, from a button that says «إنهاء الإشغال» for
      one person.
    */
    const { service, buildingUnitUpdateMany, propertyEntryUpdateMany } = harness(1);

    await service.endOccupancy('occ-1', { reason: 'OWNERSHIP_TRANSFERRED' }, actor);

    for (const mock of [buildingUnitUpdateMany, propertyEntryUpdateMany]) {
      const where = mock.mock.calls[0][0].where;
      const citizenScope =
        where.propertyEntry?.registration?.citizenId ?? where.registration?.citizenId;
      expect(citizenScope).toBe(CITIZEN);
    }
  });

  it('reports what it released, so the audit row can name it', async () => {
    /*
      This is the half that edits somebody's file rather than the census, and a
      resident disputing a bill is entitled to see when their card stopped
      claiming the flat and who did it.
    */
    const emit = jest.fn();
    const { db } = harness(1);
    const service = new BuildingsService(
      { prisma: db, tenantSlug: 'albazourieh' } as never,
      { resolveForUnit: jest.fn().mockResolvedValue(0) } as never,
      { emit } as never,
    );

    await service.endOccupancy('occ-1', { reason: 'OWNERSHIP_TRANSFERRED' }, actor);

    const [, payload] = emit.mock.calls.find(([event]) => event === 'building.changed') ?? [];
    expect(payload.action).toBe('OCCUPANCY_ENDED');
    expect(payload.after).toMatchObject({
      citizenId: CITIZEN,
      unitLinksCleared: 1,
      buildingLinksCleared: 1,
    });
  });
});

/**
 * Which occupancies a save is allowed to release.
 *
 * `RegistrationRepository.submit` upserts the citizen by identity document but
 * always *creates* a registration, so filing someone the municipality already
 * knows — «سجّل هذه الأسرة في هذه الوحدة» on a returning household — leaves
 * them with two registrations and one citizen row.
 *
 * Scoped to a single `registrationId`, the flats the earlier filing claimed
 * could never be released: `getEditable` loads `take: 1`, so the officer could
 * not see those cards to untick them, and no save would close them. The
 * household stayed recorded in a flat nothing on any screen claimed, and
 * billing followed the occupancy.
 *
 * The three rules below are one sentence each and all three have to hold at
 * once, which is why they are asserted against the `where` rather than against
 * a fixture: a fixture shows that the rows it contains were closed and says
 * nothing about the neighbour's row that was not in it.
 */
describe('endUnclaimed — whose claims a save supersedes', () => {
  async function whereUsedByRelease() {
    const findMany = jest.fn().mockResolvedValue([]);

    const db = {
      propertyEntry: { findMany: jest.fn().mockResolvedValue([]) },
      unitOccupancy: { findMany, updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };

    const { CensusSyncService } = await import('./census-sync.service');
    const service = new CensusSyncService(
      { prisma: db, tenantSlug: 'albazourieh' } as never,
      { resolveForUnit: jest.fn() } as never,
      { emit: jest.fn() } as never,
    );

    await service.syncRegistration({
      registrationId: 'reg-latest',
      citizenId: CITIZEN,
      actor,
    });

    return findMany.mock.calls[0][0].where;
  }

  it("reaches every one of this citizen's own registrations, not just the one being saved", async () => {
    const where = await whereUsedByRelease();

    expect(where.registration).toEqual({ citizenId: CITIZEN });
    // The old scope. Its presence would mean an earlier filing's flats stay
    // claimed forever, which is the defect this widening removes.
    expect(where.registrationId).not.toBe('reg-latest');
  });

  it('never touches an occupancy recorded straight onto the matrix', async () => {
    /*
      Those carry no `registrationId`. Without this exclusion, saving one
      household's card would evict everyone a stairwell survey had recorded —
      silently, in the same save as a phone-number correction.
    */
    const where = await whereUsedByRelease();

    expect(where.registrationId).toEqual({ not: null });
  });

  it("never reaches another person's occupancy", async () => {
    const where = await whereUsedByRelease();

    expect(where.citizenId).toBe(CITIZEN);
    expect(where.registration.citizenId).toBe(CITIZEN);
  });

  it('closes everything when the file claims no unit at all', async () => {
    /*
      An officer who unlinks every card is saying the household is in none of
      them. A `unitId` filter here would be a no-op list and leave every spell
      standing.
    */
    const where = await whereUsedByRelease();

    expect(where.unitId).toBeUndefined();
    expect(where.toDate).toBeNull();
  });
});

/**
 * What `deleteUnit` refuses, and why each refusal is separate.
 *
 * `Unit` is the parent of more history than its size suggests, and Prisma
 * cascades most of it silently: `UnitOccupancy`, `UnitVisit` and
 * `DamageAssessment` are all `onDelete: Cascade`, and `BuildingUnit.unitId` is
 * `SetNull`. So a delete that slipped past these guards would erase who has
 * lived in a flat, how many times officers went to its door, and the
 * war-damage findings that are the evidentiary basis for compensation — with
 * one audit row saying a unit was removed.
 *
 * Asserted at the guard rather than through a fixture because the failure mode
 * is a *missing* check, and a fixture only ever proves that the rows it
 * happens to contain were handled.
 */
describe('deleteUnit — what it refuses', () => {
  const UNIT = 'unit-1';

  function service(counts: {
    current?: number;
    historical?: number;
    visits?: number;
    damage?: number;
    cards?: number;
    /** Confirmations the municipality stands behind — see the vacancy refusal. */
    vacancies?: number;
  }) {
    const del = jest.fn().mockResolvedValue({});
    const db = {
      unit: {
        findUnique: jest.fn().mockResolvedValue({
          id: UNIT,
          buildingId: 'building-1',
          unitCode: '0101',
          floor: 1,
          sequence: 1,
        }),
        delete: del,
      },
      unitOccupancy: {
        count: jest
          .fn()
          .mockResolvedValueOnce(counts.current ?? 0)
          .mockResolvedValueOnce(counts.historical ?? 0),
      },
      unitVisit: { count: jest.fn().mockResolvedValue(counts.visits ?? 0) },
      damageAssessment: { count: jest.fn().mockResolvedValue(counts.damage ?? 0) },
      buildingUnit: { count: jest.fn().mockResolvedValue(counts.cards ?? 0) },
      unitVacancyConfirmation: {
        count: jest.fn().mockResolvedValue(counts.vacancies ?? 0),
      },
      building: { update: jest.fn() },
    };

    return {
      del,
      db,
      instance: new BuildingsService(
        { prisma: db, tenantSlug: 'albazourieh' } as never,
        { resolveForUnit: jest.fn() } as never,
        { emit: jest.fn() } as never,
      ),
    };
  }

  it('deletes a flat nothing has been recorded against', async () => {
    const { instance, del } = service({});
    await instance.deleteUnit(UNIT, actor);
    expect(del).toHaveBeenCalledWith({ where: { id: UNIT } });
  });

  it.each([
    ['a current occupancy', { current: 1, historical: 1 }],
    ['a past occupancy', { historical: 1 }],
    ["a citizen's property card", { cards: 1 }],
    ['a damage assessment', { damage: 1 }],
    ['a field visit', { visits: 1 }],
    // A confirmation is why the flat reads «شاغرة» and why its owner is exempt
    // from the occupancy fee. Deleting the unit cascades it away.
    ['a vacancy confirmation', { vacancies: 1 }],
  ])('refuses a flat carrying %s', async (_what, counts) => {
    const { instance, del } = service(counts);
    await expect(instance.deleteUnit(UNIT, actor)).rejects.toThrow();
    expect(del).not.toHaveBeenCalled();
  });

  it('leaves unitsTotal to the database trigger', async () => {
    /*
      Migration 0030 puts `units_sync_building_counts` on INSERT/DELETE/UPDATE
      of `units`, which recomputes both counters. Decrementing here as well
      would take the survey-coverage denominator two below the truth on every
      deletion — visible only as a percentage that crept past 100%.
    */
    const { instance, db } = service({});
    await instance.deleteUnit(UNIT, actor);
    expect(db.building.update).not.toHaveBeenCalled();
  });
});

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { houseCardOnMultiUnitBuilding } from '../../../infrastructure/prisma/house-card-guard';
import { CasesService } from '../cases/cases.service';
import { PrismaCaseRepository } from '../../../infrastructure/repositories/case.repository';
import { BuildingsService } from './buildings.service';
import { CensusSyncService } from './census-sync.service';

/**
 * «هذا المنزل يصبح مبنى» and «دوبلكس» (migration 0095, decision D28), against a
 * real Postgres.
 *
 * The first describe replays B-1-352-A (2026-10-14) as it should have gone: a
 * house on نافع's file gets a second floor, the officer says it is a separate
 * flat, and his file ends with ONE «مبنى» card naming both flats — where
 * production ended with a «منزل» card and a second «مبنى» card billing the same
 * home twice, and an occupancy the next save quietly closed.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17 to run it; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_house_growth_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('a house that grows (D28)', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let buildings: BuildingsService;
  let census: CensusSyncService;
  let officerId: string;
  const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];

  const actor = () => ({ id: officerId, role: 'FIELD_INSPECTOR' });

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);

    const context = {
      get prisma() {
        return db;
      },
      tenantSlug: 'growth',
      schemaName: SCHEMA,
    } as unknown as TenantContextService;

    const events = new EventEmitter2();
    events.onAny((name, payload) => emitted.push({ name: String(name), payload: payload as Record<string, unknown> }));
    const cases = new CasesService(
      new PrismaCaseRepository(context),
      { findById: async () => ({ id: officerId, kind: 'CITIZEN' }) } as never,
      events,
    );
    buildings = new BuildingsService(context, cases, events);
    census = new CensusSyncService(context, cases, events);

    officerId = randomUUID();
    await db.user.create({
      data: {
        id: officerId,
        kind: 'STAFF',
        tenantSlug: 'growth',
        email: `officer-${officerId}@growth.gov.lb`,
        firstName: 'علي',
        lastName: 'حدرج',
        role: 'FIELD_INSPECTOR',
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  const citizen = async (firstName: string): Promise<string> => {
    const id = randomUUID();
    await db.user.create({ data: { id, kind: 'CITIZEN', tenantSlug: 'growth', firstName, lastName: 'حدرج' } });
    return id;
  };

  /** A structure with one unit on the ground floor, as the wizard paints a house. */
  const oneUnitStructure = async (
    parcelNumber: string,
    structureType: 'INDEPENDENT_HOUSE' | 'RESIDENTIAL_BUILDING',
    unitType: 'INDEPENDENT_HOUSE' | 'APARTMENT' = structureType === 'INDEPENDENT_HOUSE' ? 'INDEPENDENT_HOUSE' : 'APARTMENT',
  ) => {
    const { building } = await buildings.create(
      {
        parcelNumber,
        structureType,
        lifecycleStatus: 'IN_USE',
        floorsCount: 1,
        units: [{ floor: 0, unitType, startCol: 1, endCol: 1 }],
      },
      actor(),
    );
    const unit = await db.unit.findFirstOrThrow({ where: { buildingId: building.id } });
    return { building, unit };
  };

  /** A filing whose only card is a «منزل» on that structure, flagged «غير مؤكَّد» on its side. */
  const houseFiling = async (input: {
    citizenId: string;
    buildingId: string;
    parcelNumber: string;
    occupancyType?: 'OWNER' | 'TENANT';
  }) => {
    const owner = (input.occupancyType ?? 'OWNER') === 'OWNER';
    const registration = await db.registration.create({
      data: {
        citizenId: input.citizenId,
        referenceNumber: `REG-${randomUUID().slice(0, 8)}`,
        flaggedFields: [{ path: 'properties.0.side', status: 'UNKNOWN', reason: 'لم يُعرف' }] as never,
      },
      select: { id: true },
    });
    const card = await db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: input.occupancyType ?? 'OWNER',
        propertyType: 'HOUSE',
        neighborhood: 'الحي الشرقي',
        propertyNumber: input.parcelNumber,
        buildingName: 'بيت المهندس نافع',
        buildingId: input.buildingId,
        unitType: 'INDEPENDENT_HOUSE',
        unitArea: 170,
        unitStatus: owner ? 'OWNER_OCCUPIED' : null,
        sharedRights: ['ROOF'],
      },
      select: { id: true },
    });
    // What a registration does next: the sole-unit inference records the household.
    await census.syncRegistration({ registrationId: registration.id, citizenId: input.citizenId, actor: actor() });
    return { registrationId: registration.id, cardId: card.id };
  };

  const refusal = (promise: Promise<unknown>) => promise.then(() => null, (caught: unknown) => caught);

  describe('B-1-352-A, replayed: a second floor that is a separate flat', () => {
    it('asks before a house on somebody’s file gets a second unit, and writes nothing', async () => {
      const { building, unit } = await oneUnitStructure('GROW-1', 'RESIDENTIAL_BUILDING');
      const nafe = await citizen('نافع');
      await houseFiling({ citizenId: nafe, buildingId: building.id, parcelNumber: 'GROW-1' });

      const caught = await refusal(buildings.addUnit(building.id, { floor: 1, unitType: 'APARTMENT' }, actor()));
      expect(caught).toMatchObject({ code: 'HOUSE_GROWTH_UNANSWERED', params: { unitCode: unit.unitCode } });
      expect((caught as { details: { holders: unknown[] } }).details.holders).toEqual([
        { name: 'نافع حدرج', capacity: 'OWNER' },
      ]);
      expect(await db.unit.count({ where: { buildingId: building.id } })).toBe(1);
    });

    it('turns the «منزل» card into one «مبنى» card naming the house, and the new flat joins it', async () => {
      const { building, unit: house } = await oneUnitStructure('GROW-2', 'RESIDENTIAL_BUILDING');
      const nafe = await citizen('نافع');
      const { registrationId, cardId } = await houseFiling({
        citizenId: nafe,
        buildingId: building.id,
        parcelNumber: 'GROW-2',
      });

      const upper = await buildings.addUnit(
        building.id,
        { floor: 1, unitType: 'APARTMENT', houseGrowth: 'SEPARATE_UNIT' },
        actor(),
      );

      // The same card — its id, so its filing officer and history stay with it.
      const card = await db.propertyEntry.findUniqueOrThrow({
        where: { id: cardId },
        include: { units: true },
      });
      expect(card.propertyType).toBe('BUILDING');
      expect(card.unitArea).toBeNull();
      expect(card.sharedRights).toEqual([]);
      expect(card.units).toHaveLength(1);
      expect(card.units[0]).toMatchObject({
        unitId: house.id,
        unitType: house.unitType,
        floor: '0',
        unitStatus: 'OWNER_OCCUPIED',
        sharedRights: ['ROOF'],
      });
      expect(Number(card.units[0]!.unitArea)).toBe(170);

      // The «غير مؤكَّد» on the side moved with the field onto the row.
      const registration = await db.registration.findUniqueOrThrow({ where: { id: registrationId } });
      expect(registration.flaggedFields).toEqual([
        { path: 'properties.0.units.0.side', status: 'UNKNOWN', reason: 'لم يُعرف' },
      ]);

      // The next save of his file keeps him in his home.
      await census.syncRegistration({ registrationId, citizenId: nafe, actor: actor() });
      const spell = await db.unitOccupancy.findFirstOrThrow({ where: { unitId: house.id, citizenId: nafe } });
      expect(spell.toDate).toBeNull();

      // Recording him on the upper flat adds a row to the same card — not a second card.
      const recorded = await buildings.recordOccupancy(
        { unitId: upper.id, citizenId: nafe, role: 'OWNER', unitStatus: 'OWNER_OCCUPIED', unitArea: 170 },
        actor(),
        { fromMatrix: true },
      );
      expect(recorded.fileLink).toMatchObject({ outcome: 'UNIT_ADDED', propertyEntryId: cardId });
      const cards = await db.propertyEntry.findMany({
        where: { registrationId, endedAt: null },
        include: { units: { where: { endedAt: null } } },
      });
      expect(cards).toHaveLength(1);
      expect(cards[0]!.units.map((row) => row.unitId).sort()).toEqual([house.id, upper.id].sort());

      // Each holder's file says the card changed shape, and why.
      const trail = emitted.find(
        (event) =>
          event.name === 'citizen.changed' &&
          event.payload.citizenId === nafe &&
          (event.payload.after as { via?: string }).via === 'HOUSE_GREW',
      );
      expect(trail?.payload).toMatchObject({ before: { propertyType: 'HOUSE', unitArea: 170 } });
    });

    it('converts a tenant’s «منزل» card too, with no حالة on its row', async () => {
      const { building, unit: house } = await oneUnitStructure('GROW-3', 'RESIDENTIAL_BUILDING');
      const tenant = await citizen('احمد');
      const { cardId } = await houseFiling({
        citizenId: tenant,
        buildingId: building.id,
        parcelNumber: 'GROW-3',
        occupancyType: 'TENANT',
      });

      await buildings.addUnit(building.id, { floor: 0, unitType: 'GARAGE', houseGrowth: 'SEPARATE_UNIT' }, actor());

      const row = await db.buildingUnit.findFirstOrThrow({ where: { propertyEntryId: cardId } });
      expect(row).toMatchObject({ unitId: house.id, unitStatus: null });
    });

    it('still refuses a second unit on a «منزل مستقل» structure — that one is retyped first', async () => {
      const { building } = await oneUnitStructure('GROW-4', 'INDEPENDENT_HOUSE');
      const owner = await citizen('رضا');
      await houseFiling({ citizenId: owner, buildingId: building.id, parcelNumber: 'GROW-4' });

      const caught = await refusal(
        buildings.addUnit(building.id, { floor: 1, unitType: 'APARTMENT', houseGrowth: 'SEPARATE_UNIT' }, actor()),
      );
      expect(caught).toMatchObject({ kind: 'VALIDATION_FAILED' });
      expect(await db.propertyEntry.count({ where: { buildingId: building.id, propertyType: 'HOUSE' } })).toBe(1);
    });
  });

  describe('a level of the same home', () => {
    it('raises the house a storey instead of adding a unit, and grows the building', async () => {
      const { building, unit: house } = await oneUnitStructure('LEVEL-1', 'INDEPENDENT_HOUSE');
      const owner = await citizen('حسين');
      const { cardId } = await houseFiling({ citizenId: owner, buildingId: building.id, parcelNumber: 'LEVEL-1' });

      const row = await buildings.addUnit(
        building.id,
        { floor: 1, unitType: 'INDEPENDENT_HOUSE', houseGrowth: 'EXTRA_LEVEL' },
        actor(),
      );

      expect(row).toMatchObject({ id: house.id, levels: 2 });
      expect(await db.unit.count({ where: { buildingId: building.id } })).toBe(1);
      const after = await db.building.findUniqueOrThrow({ where: { id: building.id } });
      expect(after.floorsCount).toBe(2);
      // Still one unit, so the «منزل» card stays a «منزل» and still claims it.
      const card = await db.propertyEntry.findUniqueOrThrow({ where: { id: cardId } });
      expect(card.propertyType).toBe('HOUSE');
    });

    it('asks on a bare «منزل مستقل» too, and grows it without a card on it', async () => {
      const { building, unit: house } = await oneUnitStructure('LEVEL-2', 'INDEPENDENT_HOUSE');
      const caught = await refusal(buildings.addUnit(building.id, { floor: 1, unitType: 'INDEPENDENT_HOUSE' }, actor()));
      expect(caught).toMatchObject({ code: 'HOUSE_GROWTH_UNANSWERED' });

      await buildings.addUnit(building.id, { floor: 1, unitType: 'INDEPENDENT_HOUSE', houseGrowth: 'EXTRA_LEVEL' }, actor());
      expect((await db.unit.findUniqueOrThrow({ where: { id: house.id } })).levels).toBe(2);
    });

    it('adds a level only directly above the home', async () => {
      const { building } = await oneUnitStructure('LEVEL-3', 'INDEPENDENT_HOUSE');
      const caught = await refusal(
        buildings.addUnit(building.id, { floor: 2, unitType: 'INDEPENDENT_HOUSE', houseGrowth: 'EXTRA_LEVEL' }, actor()),
      );
      expect(caught).toMatchObject({ code: 'HOUSE_GROWTH_NOT_ABOVE', params: { floor: 1 } });
    });
  });

  describe('«عدد طوابق المسكن» on a unit', () => {
    it('makes a flat a duplex and grows the building to hold it', async () => {
      const { building, unit } = await oneUnitStructure('DUPLEX-1', 'RESIDENTIAL_BUILDING');
      const row = await buildings.updateUnit(unit.id, { levels: 2 }, actor());
      expect(row.levels).toBe(2);
      expect((await db.building.findUniqueOrThrow({ where: { id: building.id } })).floorsCount).toBe(2);
    });

    it('refuses levels on a shop, and refuses retyping a duplex into one', async () => {
      const { building, unit } = await oneUnitStructure('DUPLEX-2', 'RESIDENTIAL_BUILDING');
      const shop = await buildings.addUnit(
        building.id,
        { floor: 0, unitType: 'SHOP', startCol: 2, endCol: 2, acknowledgedDuplicates: true },
        actor(),
      );
      expect(await refusal(buildings.updateUnit(shop.id, { levels: 2 }, actor()))).toMatchObject({
        code: 'UNIT_LEVELS_NOT_DWELLING',
      });

      await buildings.updateUnit(unit.id, { levels: 2 }, actor());
      expect(await refusal(buildings.updateUnit(unit.id, { unitType: 'SHOP' }, actor()))).toMatchObject({
        code: 'UNIT_LEVELS_NOT_DWELLING',
      });
    });

    it('refuses to rise into a floor where another flat is drawn in the same columns', async () => {
      const { building, unit } = await oneUnitStructure('DUPLEX-3', 'RESIDENTIAL_BUILDING');
      await db.building.update({ where: { id: building.id }, data: { floorsCount: 2 } });
      const above = await db.unit.create({
        data: {
          buildingId: building.id,
          floor: 1,
          sequence: 1,
          unitCode: '0101',
          unitType: 'APARTMENT',
          startCol: 1,
          endCol: 1,
        },
      });

      expect(await refusal(buildings.updateUnit(unit.id, { levels: 2 }, actor()))).toMatchObject({
        code: 'UNIT_LEVELS_BLOCKED',
        params: { unitCode: unit.unitCode, blockedBy: above.unitCode },
      });
    });

    it('keeps a new unit off a duplex’s upper level', async () => {
      const { building, unit } = await oneUnitStructure('DUPLEX-4', 'RESIDENTIAL_BUILDING');
      await buildings.updateUnit(unit.id, { levels: 2 }, actor());

      const onTop = await refusal(
        buildings.addUnit(building.id, { floor: 1, unitType: 'APARTMENT', startCol: 1, endCol: 1 }, actor()),
      );
      expect(onTop).toMatchObject({ code: 'UNIT_ON_UPPER_LEVEL', params: { unitCode: unit.unitCode } });

      // Beside it is fine.
      const beside = await buildings.addUnit(
        building.id,
        { floor: 1, unitType: 'APARTMENT', startCol: 2, endCol: 2 },
        actor(),
      );
      expect(beside.unitCode).toBe('0101');
    });
  });

  describe('a «منزل» card that slipped past both doors', () => {
    it('is held by the census sync, not evicted, and refused on the next write', async () => {
      const { building, unit: house } = await oneUnitStructure('STRAY-1', 'RESIDENTIAL_BUILDING');
      const owner = await citizen('جهاد');
      const { registrationId } = await houseFiling({
        citizenId: owner,
        buildingId: building.id,
        parcelNumber: 'STRAY-1',
      });
      // A second unit written behind the matrix's back — an older client.
      await db.unit.create({
        data: { buildingId: building.id, floor: 1, sequence: 1, unitCode: '0101', unitType: 'APARTMENT' },
      });

      await census.syncRegistration({ registrationId, citizenId: owner, actor: actor() });
      const spell = await db.unitOccupancy.findFirstOrThrow({ where: { unitId: house.id, citizenId: owner } });
      expect(spell.toDate).toBeNull();

      const crowded = await houseCardOnMultiUnitBuilding(db, [{ propertyType: 'HOUSE', buildingId: building.id }]);
      expect(crowded).toEqual({ index: 0, buildingCode: building.code });
    });
  });
});

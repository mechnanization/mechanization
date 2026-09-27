import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { CasesService } from '../cases/cases.service';
import { PrismaCaseRepository } from '../../../infrastructure/repositories/case.repository';
import { BuildingsService } from './buildings.service';
import { CensusSyncService } from './census-sync.service';

/**
 * Correcting a building, a unit or a citizen's cards without leaving the
 * record contradicting itself — against a real schema, because every guard
 * here is a query (a nested relation filter, a stamped end) that a mock would
 * answer however the test wanted.
 *
 * Set `TEST_DATABASE_URL` to run it; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_record_editing_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('record editing', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let buildings: BuildingsService;
  let census: CensusSyncService;
  let officerId: string;

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
      tenantSlug: 'editing',
      schemaName: SCHEMA,
    } as unknown as TenantContextService;

    const events = new EventEmitter2();
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
        tenantSlug: 'editing',
        email: `officer-${officerId}@editing.gov.lb`,
        firstName: 'مفتش',
        lastName: 'ميداني',
        role: 'FIELD_INSPECTOR',
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  const citizen = async (firstName: string, residence: 'RESIDENT' | 'NON_RESIDENT_OWNER' = 'RESIDENT') => {
    const id = randomUUID();
    await db.user.create({
      data: { id, kind: 'CITIZEN', tenantSlug: 'editing', firstName, lastName: 'تجربة', residence },
    });
    return id;
  };

  /** A three-storey block, one unit per floor of the given type. */
  const block = async (parcelNumber: string, unitType: 'APARTMENT' | 'SHOP' = 'APARTMENT') => {
    const { building } = await buildings.create(
      { parcelNumber, structureType: 'RESIDENTIAL_BUILDING', lifecycleStatus: 'IN_USE', floorsCount: 3 },
      actor(),
    );
    const { units } = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 2, unitsPerFloor: 1, unitType },
      actor(),
    );
    return { building, units: [...units].sort((a, b) => a.floor - b.floor) };
  };

  const card = async (input: {
    citizenId: string;
    parcelNumber: string;
    buildingId: string;
    unitId: string;
    occupancyType: 'OWNER' | 'TENANT';
    unitType?: string;
  }) => {
    const registration = await db.registration.create({
      data: { citizenId: input.citizenId, referenceNumber: `REG-${randomUUID().slice(0, 8)}` },
      select: { id: true },
    });
    const entry = await db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: input.occupancyType,
        propertyType: 'BUILDING',
        neighborhood: 'الحي',
        propertyNumber: input.parcelNumber,
        buildingId: input.buildingId,
        ...(input.occupancyType === 'TENANT'
          ? { landlordName: 'مالك تجربة', landlordPhone: '+96177000001' }
          : {}),
        units: {
          create: [{ unitType: (input.unitType ?? 'SHOP') as never, floor: '0', unitArea: 40, unitId: input.unitId }],
        },
      },
      select: { id: true },
    });
    return { registrationId: registration.id, entryId: entry.id };
  };

  // ─────────────────────────────  Floors  ─────────────────────────────

  describe('lowering the floor count', () => {
    it('refuses a count that leaves units outside the building, naming them', async () => {
      const { building } = await block('EDIT-F1');

      await expect(buildings.update(building.id, { floorsCount: 2 }, actor())).rejects.toThrow(/0201/);

      const stored = await db.building.findUniqueOrThrow({ where: { id: building.id } });
      expect(stored.floorsCount).toBe(3);
    });

    it('accepts it once the units on the removed floor are gone', async () => {
      const { building, units } = await block('EDIT-F2');
      await buildings.deleteUnit(units[2]!.id, actor());

      const updated = await buildings.update(building.id, { floorsCount: 2 }, actor());
      expect(updated.floorsCount).toBe(2);
    });

    it('never checks a raise', async () => {
      const { building } = await block('EDIT-F3');
      const updated = await buildings.update(building.id, { floorsCount: 6 }, actor());
      expect(updated.floorsCount).toBe(6);
    });
  });

  // ─────────────────────────────  Units  ─────────────────────────────

  describe('moving a unit past the top floor', () => {
    it('grows the building so the unit stays on the matrix', async () => {
      const { building, units } = await block('EDIT-M1');

      const moved = await buildings.updateUnit(units[2]!.id, { floor: 5 }, actor());

      expect(moved.unitCode).toBe('0501');
      const stored = await db.building.findUniqueOrThrow({ where: { id: building.id } });
      expect(stored.floorsCount).toBe(6);
    });
  });

  describe('retyping a unit a non-resident rents', () => {
    it('refuses making it a dwelling while their tenancy stands', async () => {
      const { units } = await block('EDIT-N1', 'SHOP');
      const tenantId = await citizen('سامي', 'NON_RESIDENT_OWNER');
      await db.unitOccupancy.create({ data: { unitId: units[0]!.id, citizenId: tenantId, role: 'TENANT' } });

      await expect(buildings.updateUnit(units[0]!.id, { unitType: 'APARTMENT' }, actor())).rejects.toThrow(
        /سامي تجربة/,
      );
      const stored = await db.unit.findUniqueOrThrow({ where: { id: units[0]!.id } });
      expect(stored.unitType).toBe('SHOP');
    });

    it('refuses it when only their card holds the unit', async () => {
      const { building, units } = await block('EDIT-N2', 'SHOP');
      const tenantId = await citizen('رامي', 'NON_RESIDENT_OWNER');
      await card({
        citizenId: tenantId,
        parcelNumber: 'EDIT-N2',
        buildingId: building.id,
        unitId: units[0]!.id,
        occupancyType: 'TENANT',
      });

      await expect(buildings.updateUnit(units[0]!.id, { unitType: 'APARTMENT' }, actor())).rejects.toThrow(
        /رامي تجربة/,
      );
    });

    it('lets it become another kind of premises', async () => {
      const { units } = await block('EDIT-N3', 'SHOP');
      const tenantId = await citizen('هادي', 'NON_RESIDENT_OWNER');
      await db.unitOccupancy.create({ data: { unitId: units[0]!.id, citizenId: tenantId, role: 'TENANT' } });

      const updated = await buildings.updateUnit(units[0]!.id, { unitType: 'OFFICE' }, actor());
      expect(updated.unitType).toBe('OFFICE');
    });

    it('lets it become a dwelling under a resident tenant', async () => {
      const { units } = await block('EDIT-N4', 'SHOP');
      const tenantId = await citizen('فادي');
      await db.unitOccupancy.create({ data: { unitId: units[0]!.id, citizenId: tenantId, role: 'TENANT' } });

      const updated = await buildings.updateUnit(units[0]!.id, { unitType: 'APARTMENT' }, actor());
      expect(updated.unitType).toBe('APARTMENT');
    });

    it('refuses «مشغولة من المالك» on a dwelling whose only owner lives elsewhere', async () => {
      const { units } = await block('EDIT-N5');
      const ownerId = await citizen('نادر', 'NON_RESIDENT_OWNER');
      await db.unitOccupancy.create({ data: { unitId: units[0]!.id, citizenId: ownerId, role: 'OWNER' } });

      await expect(
        buildings.updateUnit(units[0]!.id, { unitStatus: 'OWNER_OCCUPIED' }, actor()),
      ).rejects.toThrow(/مسكن موسمي/);
    });
  });

  // ─────────────────────────  Removing a card  ─────────────────────────

  describe('a removed card closes its flats with the officer’s answer', () => {
    /** An owner recorded on flat 0001 through their card, as the sync records one. */
    const ownerOnFile = async (parcelNumber: string) => {
      const { building, units } = await block(parcelNumber);
      const citizenId = await citizen('مالك');
      const { registrationId, entryId } = await card({
        citizenId,
        parcelNumber,
        buildingId: building.id,
        unitId: units[0]!.id,
        occupancyType: 'OWNER',
        unitType: 'APARTMENT',
      });
      await census.syncRegistration({ registrationId, citizenId, actor: actor() });
      // What `CitizensService.update` does to a card the form no longer sends.
      const removeCard = () => db.propertyEntry.delete({ where: { id: entryId } });
      return { unitId: units[0]!.id, citizenId, registrationId, removeCard };
    };

    it('keeps a sale in the flat’s history, ending on the sale', async () => {
      const { unitId, citizenId, registrationId, removeCard } = await ownerOnFile('EDIT-R1');
      await removeCard();

      const soldOn = new Date(Date.now() + 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
      const spell = await db.unitOccupancy.findFirstOrThrow({ where: { unitId, citizenId } });
      await census.syncRegistration({
        registrationId,
        citizenId,
        actor: actor(),
        endings: new Map([[unitId, { reason: 'OWNERSHIP_TRANSFERRED', endedAt: soldOn }]]),
      });

      const ended = await db.unitOccupancy.findUniqueOrThrow({ where: { id: spell.id } });
      expect(ended.endReason).toBe('OWNERSHIP_TRANSFERRED');
      // Recorded minutes ago, sold "yesterday": never before the register knew them.
      expect(ended.toDate!.getTime()).toBe(Math.max(soldOn.getTime(), spell.fromDate.getTime()));
    });

    it('marks an error as one, so it leaves the flat’s history', async () => {
      const { unitId, citizenId, registrationId, removeCard } = await ownerOnFile('EDIT-R2');
      await removeCard();

      await census.syncRegistration({
        registrationId,
        citizenId,
        actor: actor(),
        endings: new Map([[unitId, { reason: 'RECORDED_IN_ERROR' }]]),
      });

      const ended = await db.unitOccupancy.findFirstOrThrow({ where: { unitId, citizenId } });
      expect(ended.endReason).toBe('RECORDED_IN_ERROR');
      expect(ended.toDate).not.toBeNull();
    });

    it('closes plainly when nobody was asked, as before', async () => {
      const { unitId, citizenId, registrationId, removeCard } = await ownerOnFile('EDIT-R3');
      await removeCard();

      await census.syncRegistration({ registrationId, citizenId, actor: actor() });

      const ended = await db.unitOccupancy.findFirstOrThrow({ where: { unitId, citizenId } });
      expect(ended.endReason).toBeNull();
      expect(ended.toDate).not.toBeNull();
    });
  });
});

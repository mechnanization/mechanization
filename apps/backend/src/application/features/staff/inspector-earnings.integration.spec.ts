import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { PrismaCaseRepository } from '../../../infrastructure/repositories/case.repository';
import { PrismaUserRepository } from '../../../infrastructure/repositories/user.repository';
import { AuditService } from '../audit/audit.service';
import { BuildingsService } from '../buildings/buildings.service';
import { CasesService } from '../cases/cases.service';
import { LandlordLinkService } from '../citizens/landlord-link.service';
import { OwnershipService } from '../citizens/ownership.service';
import { TenancyService } from '../citizens/tenancy.service';
import { ExpensesService } from '../treasury/expenses.service';
import { TreasuryLedgerService } from '../treasury/treasury-ledger.service';
import { StaffService } from './staff.service';

/**
 * Who is paid for a unit line, against a real Postgres (migrations 0096, 0097).
 *
 * The defect (production, 2026-10-06): one officer registered a doctor as the
 * tenant of a clinic; a second officer later visited the doctor's own building
 * and recorded him on the matrix as owner of a flat and a warehouse. Both lines
 * went onto the doctor's file, registered by the first officer, and both dollars
 * went to him. What only a database proves here: that the matrix writes the
 * second officer onto those lines, that the inspector's page and the roster both
 * pay him for them, and that 0097 recovers the filer of lines written before the
 * column existed without handing anyone a line he only re-saved.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_inspector_earnings_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const BACKFILL = readFileSync(
  join(__dirname, '../../../infrastructure/prisma/tenant/migrations/0097_building_unit_filed_by_backfill/migration.sql'),
  'utf8',
);

describeIfDb('Who is paid for a unit line', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let buildings: BuildingsService;
  let tenancy: TenancyService;
  let users: PrismaUserRepository;
  let staff: StaffService;

  /** Registered the doctor. */
  let registrar: string;
  /** Visited the doctor's own building. */
  let visitor: string;
  /** A third officer, for the trail's ambiguous instant. */
  let bystander: string;

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'earnings', schemaName: SCHEMA, prisma: db }, work);

  const officer = async (firstName: string) => {
    const id = randomUUID();
    await db.user.create({
      data: { id, kind: 'STAFF', tenantSlug: 'earnings', email: `${id}@t.gov.lb`, firstName, lastName: 'الميداني', role: 'FIELD_INSPECTOR' },
    });
    return id;
  };

  /** A citizen with a file one officer registered, `at` when he did. */
  const citizen = async (firstName: string, createdById: string, submittedAt = new Date()) => {
    const id = randomUUID();
    await db.user.create({ data: { id, kind: 'CITIZEN', tenantSlug: 'earnings', firstName, lastName: 'المواطن' } });
    const registration = await db.registration.create({
      data: { citizenId: id, referenceNumber: `R-${randomUUID().slice(0, 10)}`, createdById, submittedAt },
      select: { id: true },
    });
    return { id, registrationId: registration.id };
  };

  let parcels = 0;
  const block = async (unitsPerFloor: number) =>
    within(async () => {
      const actor = { id: registrar, role: 'FIELD_INSPECTOR' };
      const { building } = await buildings.create(
        { parcelNumber: `ERN-${++parcels}`, structureType: 'RESIDENTIAL_BUILDING', lifecycleStatus: 'IN_USE', floorsCount: 1 },
        actor,
      );
      const { units } = await buildings.generateUnits(
        building.id,
        { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor, unitType: 'APARTMENT' as never },
        actor,
      );
      return { building, units };
    });

  const runBackfill = async () => {
    await ddl.query('BEGIN');
    try {
      await ddl.query(`SET LOCAL search_path TO "${SCHEMA}"`);
      await ddl.query(BACKFILL);
      await ddl.query('COMMIT');
    } catch (error) {
      await ddl.query('ROLLBACK');
      throw error;
    }
  };

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();

    const events = new EventEmitter2();
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    const cases = new CasesService(new PrismaCaseRepository(context), { findById: async (id: string) => ({ id, kind: 'CITIZEN' }) } as never, events);
    buildings = new BuildingsService(context, cases, events);
    const links = new LandlordLinkService(context, buildings, events, audit);
    const ownership = new OwnershipService(context, buildings, cases, links, events, audit);
    tenancy = new TenancyService(context, buildings, cases, links, events, ownership, audit);

    const ledger = new TreasuryLedgerService(context);
    users = new PrismaUserRepository(context);
    staff = new StaffService(
      users,
      {} as never,
      {} as never,
      context,
      {} as never,
      {} as never,
      { emit: () => true } as never,
      new ExpensesService(context, ledger, audit),
      ledger,
      audit,
    );

    registrar = await officer('المسجّل');
    visitor = await officer('الزائر');
    bystander = await officer('العابر');
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('pays the officer who recorded an owner on the matrix, not the one who registered the citizen', async () => {
    const clinicBlock = await block(1);
    const ownBuilding = await block(2);
    const doctor = await citizen('الطبيب', registrar);

    // The registrar's own work: the doctor's tenancy of the clinic, filed with the file.
    await db.propertyEntry.create({
      data: {
        registrationId: doctor.registrationId,
        occupancyType: 'TENANT',
        propertyType: 'BUILDING',
        buildingId: clinicBlock.building.id,
        units: { create: [{ unitId: clinicBlock.units[0]!.id, unitType: 'CLINIC', floor: '0', unitArea: 60 }] },
      },
    });

    // The visitor, on the matrix of the doctor's own building.
    for (const unit of ownBuilding.units) {
      await within(() =>
        tenancy.recordOccupancy(
          { unitId: unit.id, citizenId: doctor.id, role: 'OWNER', unitStatus: 'OWNER_OCCUPIED' } as never,
          { id: visitor, role: 'FIELD_INSPECTOR' },
        ),
      );
    }

    const ownerLines = await db.buildingUnit.findMany({
      where: { unitId: { in: ownBuilding.units.map((unit) => unit.id) } },
      include: { propertyEntry: { select: { registrationId: true } } },
    });
    expect(ownerLines).toHaveLength(2);
    for (const line of ownerLines) {
      // On the registrar's file, and the visitor's work.
      expect(line.propertyEntry.registrationId).toBe(doctor.registrationId);
      expect(line.filedById).toBe(visitor);
    }

    const visitorPage = await within(() => staff.getInspectorProfile('earnings', visitor));
    const registrarPage = await within(() => staff.getInspectorProfile('earnings', registrar));
    expect(visitorPage.totalProperties).toBe(2);
    expect(registrarPage.totalProperties).toBe(1);

    // His log shows the doctor's file as one he added to, dated when he added to it.
    const entry = visitorPage.recentRegistrations.find((item) => item.registrationId === doctor.registrationId)!;
    expect(entry).toMatchObject({ addedToOthersFile: true, propertyCount: 2, commissionEarned: 2 });
    expect(new Date(entry.creditedAt!).getTime()).toBeGreaterThanOrEqual(
      Math.min(...ownerLines.map((line) => line.createdAt.getTime())),
    );
    // Not a citizen he registered.
    expect(visitorPage.totalCitizens).toBe(0);
    expect(registrarPage.recentRegistrations.find((item) => item.registrationId === doctor.registrationId)).toMatchObject({
      addedToOthersFile: false,
      propertyCount: 1,
    });

    // The roster agrees with both pages.
    const roster = await within(() => users.listStaff());
    expect(roster.find((row) => row.id === visitor)?.registeredPropertiesCount).toBe(2);
    expect(roster.find((row) => row.id === registrar)?.registeredPropertiesCount).toBe(1);
  });

  describe('0097, filling the lines filed before the column', () => {
    /** A line on `registrationId`'s file, written at `at` with no filer, as every line before 0096. */
    const legacyLine = async (registrationId: string, unitId: string, at: Date) => {
      const card = await db.propertyEntry.create({
        data: { registrationId, occupancyType: 'OWNER', propertyType: 'BUILDING' },
        select: { id: true },
      });
      return db.buildingUnit.create({
        data: { propertyEntryId: card.id, unitId, unitType: 'APARTMENT', floor: '0', unitArea: 90, createdAt: at },
        select: { id: true, propertyEntryId: true },
      });
    };
    const trail = (action: string, actorId: string, at: Date) =>
      db.auditLogEntry.create({
        data: { action, actorId, actorRole: 'FIELD_INSPECTOR', entityType: 'Building', entityId: randomUUID(), createdAt: at },
      });
    const later = (from: Date, ms: number) => new Date(from.getTime() + ms);
    const filerOf = async (id: string) => (await db.buildingUnit.findUniqueOrThrow({ where: { id } })).filedById;

    it('names the one officer the trail names, and leaves every doubtful line with the file', async () => {
      const { units } = await block(6);
      const filed = new Date('2026-09-25T09:00:00.000Z');
      const file = await citizen('المالك', registrar, filed);
      const week = later(filed, 7 * 24 * 3_600_000);

      // Recorded on the matrix a week later by the visitor: his.
      const matrix = await legacyLine(file.registrationId, units[0]!.id, week);
      await trail('OCCUPANCY_RECORDED', visitor, later(week, 15));

      // Written while the visitor saved the file: maybe a line he re-saved, so it stays.
      const resaved = await legacyLine(file.registrationId, units[1]!.id, later(week, 60_000));
      await trail('OCCUPANCY_RECORDED', visitor, later(week, 60_015));
      await trail('CITIZEN_UPDATED', visitor, later(week, 60_900));

      // Written with the registration: the registrar's, whoever else was busy that minute.
      const withTheFile = await legacyLine(file.registrationId, units[2]!.id, later(filed, 30_000));
      await trail('OCCUPANCY_RECORDED', visitor, later(filed, 30_010));

      // Two officers in the same instant: nobody is named.
      const crowded = await legacyLine(file.registrationId, units[3]!.id, later(week, 120_000));
      await trail('OCCUPANCY_RECORDED', visitor, later(week, 120_010));
      await trail('OCCUPANCY_RECORDED', bystander, later(week, 120_020));

      // The trail names the file's own officer: nothing to write.
      const own = await legacyLine(file.registrationId, units[4]!.id, later(week, 180_000));
      await trail('OCCUPANCY_RECORDED', registrar, later(week, 180_015));

      await runBackfill();

      expect(await filerOf(matrix.id)).toBe(visitor);
      expect(await filerOf(resaved.id)).toBeNull();
      expect(await filerOf(withTheFile.id)).toBeNull();
      expect(await filerOf(crowded.id)).toBeNull();
      expect(await filerOf(own.id)).toBeNull();

      // A replay changes nothing.
      await runBackfill();
      expect(await filerOf(matrix.id)).toBe(visitor);
      expect(await filerOf(crowded.id)).toBeNull();
    });

    it('falls back on the owner link’s receipt where the trail is ambiguous', async () => {
      const { units } = await block(1);
      const filed = new Date('2026-09-20T09:00:00.000Z');
      const owner = await citizen('مالك الشقة', registrar, filed);
      const tenant = await citizen('المستأجر', bystander, filed);
      const linkedAt = later(filed, 3 * 24 * 3_600_000);

      const ownerLine = await legacyLine(owner.registrationId, units[0]!.id, linkedAt);
      await trail('LANDLORD_LINKED', visitor, later(linkedAt, 12));
      await trail('OCCUPANCY_RECORDED', bystander, later(linkedAt, 40));

      // The tenant's card carries what the visitor's link wrote on the owner's file.
      await db.propertyEntry.create({
        data: {
          registrationId: tenant.registrationId,
          occupancyType: 'TENANT',
          propertyType: 'BUILDING',
          landlordCitizenId: owner.id,
          landlordLinkFootprint: {
            v: 1,
            ownerId: owner.id,
            linkedAt: linkedAt.toISOString(),
            actorId: visitor,
            units: [{ unitId: units[0]!.id, unitCode: '0001', occupancyId: null, row: { propertyEntryId: ownerLine.propertyEntryId, snapshot: {} }, filledUnitStatus: null, liftedSurveyFrom: null, cases: [] }],
            mintedCardIds: [],
          },
        },
      });

      await runBackfill();
      expect(await filerOf(ownerLine.id)).toBe(visitor);
    });
  });
});

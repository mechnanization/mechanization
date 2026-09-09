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
import { DamageService } from './damage.service';

/**
 * The census, against a real Postgres.
 *
 * Three of its guarantees do not exist anywhere but the database, so a mocked
 * client cannot say anything about them:
 *
 *  - **Suffix allocation under concurrency.** Two officers standing on the same
 *    parcel with no signal both mint a provisional `A`; on sync the second has
 *    to become `B`. "Read the taken suffixes, pick the next, insert" is a
 *    read-then-write, and without the advisory lock two concurrent syncs
 *    interleave into the same answer. There is no concurrency to interleave in
 *    a unit test.
 *
 *  - **The unit-count trigger.** `unitsTotal`/`unitsSurveyed` are maintained by
 *    `sync_building_unit_counts` in migration 0030 and by nothing in this
 *    codebase, so "the counts are right" is a claim until a real INSERT
 *    updates them.
 *
 *  - **Auto-resolve on occupancy.** The case, the unit and the occupancy are
 *    three tables and the rule spans all of them.
 *
 * Set `TEST_DATABASE_URL` to run it; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_census_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Jest's 5-second default is a budget for a local socket. This suite talks to
 * whatever `TEST_DATABASE_URL` points at — in practice a hosted Postgres a
 * couple of hundred milliseconds away — and a single test here does a dozen
 * round trips. The tests are not slow; the network is.
 */
jest.setTimeout(60_000);

describeIfDb('BuildingsService', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let buildings: BuildingsService;
  let damage: DamageService;
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
      tenantSlug: 'census',
    } as unknown as TenantContextService;

    const events = new EventEmitter2();
    const cases = new CasesService(
      new PrismaCaseRepository(context),
      { findById: async () => ({ id: officerId, kind: 'CITIZEN' }) } as never,
      events,
    );

    buildings = new BuildingsService(context, cases, events);
    damage = new DamageService(context, events);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  });

  /**
   * One officer for the whole suite, and no per-test cleanup.
   *
   * Isolation comes from every test using its own parcel numbers and freshly
   * minted UUIDs — the same rule `payment-ledger.integration.spec.ts` states:
   * *"Isolation therefore comes from new rows, not from cleanup."*
   *
   * It used to wipe seven tables before each of twenty-odd tests, which is
   * upwards of a hundred and fifty round trips to a hosted database that exist
   * only to delete rows nothing was going to read. Three assertions genuinely
   * needed a clean table and each is now scoped to the rows its own test made,
   * which is a better assertion anyway: a test that only passes while it is the
   * only test in the file is one refactor away from lying.
   */
  beforeAll(async () => {
    officerId = randomUUID();
    await db.user.create({
      data: {
        id: officerId,
        kind: 'STAFF',
        tenantSlug: 'census',
        email: `officer-${officerId}@census.gov.lb`,
        firstName: 'مفتش',
        lastName: 'ميداني',
        role: 'FIELD_INSPECTOR',
      },
    });
  });

  const citizen = async (firstName: string): Promise<string> => {
    const id = randomUUID();
    await db.user.create({
      data: { id, kind: 'CITIZEN', tenantSlug: 'census', firstName, lastName: 'نصرالله' },
    });
    return id;
  };

  // ───────────────────────  Suffix allocation  ───────────────────────

  it('allocates A, then B, then C on one parcel', async () => {
    const a = await buildings.create({ parcelNumber: '1042', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 }, actor());
    const b = await buildings.create({ parcelNumber: '1042', structureType: 'INDEPENDENT_HOUSE', floorsCount: 1 }, actor());
    const c = await buildings.create({ parcelNumber: '1042', structureType: 'WAREHOUSE_HANGAR', floorsCount: 1 }, actor());

    expect([a, b, c].map((r) => r.building.codeSuffix)).toEqual(['A', 'B', 'C']);
    // No zone owns 1042, so the zone half renders X — a statement that the
    // parcel has not been assigned to a sector, not a blank that reads as a bug.
    expect(a.building.code).toBe('X-1042-A');
  });

  it('gives concurrent creates on one parcel distinct suffixes', async () => {
    /*
      The defect the advisory lock exists for, and the reason this file needs a
      real database.

      Six syncs arriving together on one parcel. Without the lock they read the
      same "taken" set, all compute the same next suffix, and five of them die
      on the unique index — as a 500, on records their officers were told had
      been sent.
    */
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        buildings.create(
          { parcelNumber: '2077', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
          actor(),
        ),
      ),
    );

    const suffixes = results.map((r) => r.building.codeSuffix).sort();
    expect(suffixes).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(new Set(results.map((r) => r.building.code)).size).toBe(6);
  });

  it('does not reuse a suffix across different parcels', async () => {
    const one = await buildings.create({ parcelNumber: '10', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 }, actor());
    const two = await buildings.create({ parcelNumber: '11', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 }, actor());

    // Each parcel numbers its own structures from A. The code is what
    // distinguishes them, not the suffix.
    expect(one.building.codeSuffix).toBe('A');
    expect(two.building.codeSuffix).toBe('A');
    expect(one.building.code).not.toBe(two.building.code);
  });

  it('tells an officer when the code they were quoting changed', async () => {
    await buildings.create({ parcelNumber: '3000', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 }, actor());

    // A phone that was offline showed "A"; the parcel already had one.
    const second = await buildings.create(
      { parcelNumber: '3000', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1, provisionalSuffix: 'A' },
      actor(),
    );

    expect(second.building.codeSuffix).toBe('B');
    expect(second.reconciled).toBe(true);
  });

  it('answers a re-delivered offline creation with the row it already made', async () => {
    const clientSubmissionId = randomUUID();
    const input = {
      parcelNumber: '4000',
      structureType: 'RESIDENTIAL_BUILDING' as const,
      floorsCount: 1,
      clientSubmissionId,
    };

    const first = await buildings.create(input, actor());
    const retry = await buildings.create(input, actor());

    expect(retry.deduplicated).toBe(true);
    expect(retry.building.id).toBe(first.building.id);
    expect(await db.building.count({ where: { parcelNumber: '4000' } })).toBe(1);
  });

  // ─────────────────────────  The unit matrix  ─────────────────────────

  it('generates a matrix and lets the trigger count it', async () => {
    const { building } = await buildings.create(
      { parcelNumber: '5000', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );

    const result = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 2, unitsPerFloor: 4, unitType: 'APARTMENT' },
      actor(),
    );

    expect(result.created).toBe(12);
    expect(result.units.map((u) => u.unitCode)).toContain('0204');

    const stored = await db.building.findUnique({ where: { id: building.id } });
    // Maintained by `sync_building_unit_counts`, not by this codebase.
    expect(stored?.unitsTotal).toBe(12);
    expect(stored?.unitsSurveyed).toBe(0);
    expect(stored?.floorsCount).toBe(3);
  });

  it('tops a matrix up rather than doubling it', async () => {
    // A re-tap on a slow connection must not invent flats.
    const { building } = await buildings.create(
      { parcelNumber: '5100', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    const blueprint = {
      kind: 'uniform' as const,
      fromFloor: 0,
      toFloor: 1,
      unitsPerFloor: 3,
      unitType: 'APARTMENT' as const,
    };

    await buildings.generateUnits(building.id, blueprint, actor());
    const second = await buildings.generateUnits(building.id, blueprint, actor());

    expect(second.created).toBe(0);
    expect(second.skipped).toBe(6);
    expect(await db.unit.count({ where: { buildingId: building.id } })).toBe(6);
  });

  it('counts a surveyed unit the moment its status changes', async () => {
    const { building } = await buildings.create(
      { parcelNumber: '5200', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    const { units } = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 2, unitType: 'APARTMENT' },
      actor(),
    );

    await buildings.updateUnit(units[0]!.id, { surveyStatus: 'COMPLETE' }, actor());
    expect((await db.building.findUnique({ where: { id: building.id } }))?.unitsSurveyed).toBe(1);

    // REFUSED ends a visit without producing any of the data the census
    // collects, so it does not count as surveyed — see SURVEYED_STATUS.
    await buildings.updateUnit(units[1]!.id, { surveyStatus: 'REFUSED' }, actor());
    expect((await db.building.findUnique({ where: { id: building.id } }))?.unitsSurveyed).toBe(1);
  });

  // ─────────────────  Occupancy, and the case it closes  ─────────────────

  it('closes the open case on a unit when somebody is recorded in it', async () => {
    const { building } = await buildings.create(
      { parcelNumber: '6000', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    const { units } = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 1, toFloor: 1, unitsPerFloor: 2, unitType: 'APARTMENT' },
      actor(),
    );
    const target = units[0]!;
    const other = units[1]!;

    const logged = await db.case.create({
      data: {
        notes: 'الشقة مقفلة ولم يرد أحد',
        caseType: 'UNIT_UNREACHABLE',
        unitId: target.id,
        buildingId: building.id,
      },
    });
    const untouched = await db.case.create({
      data: { notes: 'شقة أخرى', caseType: 'UNIT_UNREACHABLE', unitId: other.id },
    });

    const citizenId = await citizen('علي');
    const result = await buildings.recordOccupancy(
      { unitId: target.id, citizenId, role: 'TENANT' },
      actor(),
    );

    expect(result.casesResolved).toBe(1);
    expect((await db.case.findUnique({ where: { id: logged.id } }))?.status).toBe('RESOLVED');
    // The flat next door is still a visit somebody has to make.
    expect((await db.case.findUnique({ where: { id: untouched.id } }))?.status).toBe('OPEN');
  });

  it('marks a unit surveyed once it has an occupant, but does not overwrite a finding', async () => {
    const { building } = await buildings.create(
      { parcelNumber: '6100', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    const { units } = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 2, unitType: 'APARTMENT' },
      actor(),
    );

    await buildings.recordOccupancy(
      { unitId: units[0]!.id, citizenId: await citizen('حسن'), role: 'OWNER' },
      actor(),
    );
    expect((await db.unit.findUnique({ where: { id: units[0]!.id } }))?.surveyStatus).toBe(
      'COMPLETE',
    );

    // A demolished flat with an occupancy on it is a contradiction for a person
    // to resolve, not for a side effect to paper over.
    await buildings.updateUnit(units[1]!.id, { surveyStatus: 'DEMOLISHED' }, actor());
    await buildings.recordOccupancy(
      { unitId: units[1]!.id, citizenId: await citizen('زينب'), role: 'OWNER' },
      actor(),
    );
    expect((await db.unit.findUnique({ where: { id: units[1]!.id } }))?.surveyStatus).toBe(
      'DEMOLISHED',
    );
  });

  it('keeps a previous tenant rather than overwriting them', async () => {
    // D2: a former tenant is information the municipality needs, not history to
    // discard the moment somebody else moves in.
    const { building } = await buildings.create(
      { parcelNumber: '6200', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    const { units } = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 1, unitType: 'APARTMENT' },
      actor(),
    );
    const unitId = units[0]!.id;

    const first = await buildings.recordOccupancy(
      { unitId, citizenId: await citizen('سمير'), role: 'TENANT' },
      actor(),
    );
    await buildings.endOccupancy(first.occupancy.id, undefined, actor());
    await buildings.recordOccupancy(
      { unitId, citizenId: await citizen('مريم'), role: 'TENANT' },
      actor(),
    );

    const all = await db.unitOccupancy.findMany({ where: { unitId } });
    expect(all).toHaveLength(2);
    expect(all.filter((o) => o.toDate === null)).toHaveLength(1);
  });

  it('corrects a role rather than recording a second tenancy', async () => {
    const { building } = await buildings.create(
      { parcelNumber: '6300', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    const { units } = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 1, unitType: 'APARTMENT' },
      actor(),
    );
    const unitId = units[0]!.id;
    const citizenId = await citizen('كريم');

    await buildings.recordOccupancy({ unitId, citizenId, role: 'TENANT' }, actor());
    await buildings.recordOccupancy({ unitId, citizenId, role: 'OWNER' }, actor());

    const rows = await db.unitOccupancy.findMany({ where: { unitId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('OWNER');
  });

  it('refuses to delete a building somebody has been surveyed in', async () => {
    const { building } = await buildings.create(
      { parcelNumber: '6400', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    const { units } = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 1, unitType: 'APARTMENT' },
      actor(),
    );
    await buildings.recordOccupancy(
      { unitId: units[0]!.id, citizenId: await citizen('ندى'), role: 'OWNER' },
      actor(),
    );

    await expect(buildings.remove(building.id, actor())).rejects.toThrow();
  });

  // ──────────────────────────  Codes and zones  ──────────────────────────

  it('rewrites codes when a parcel joins a zone', async () => {
    const { building } = await buildings.create(
      { parcelNumber: '7000', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    expect(building.code).toBe('X-7000-A');

    await db.zone.create({
      data: { name: 'القطاع الشرقي', code: 'SEC-A1', parcelNumbers: ['7000'] },
    });
    const changed = await buildings.recomputeCodesForParcels(['7000']);

    expect(changed).toBe(1);
    expect((await db.building.findUnique({ where: { id: building.id } }))?.code).toBe(
      'SEC-A1-7000-A',
    );
  });

  it('survives a zone rename that would collide mid-update', async () => {
    /*
      `code` is unique, so renaming A→B while another building already holds the
      B code collides on a constraint that has nothing to do with the change
      being made. The two-phase rewrite is what makes this pass.
    */
    await db.zone.create({ data: { name: 'أ', code: 'A', parcelNumbers: ['8000'] } });
    await db.zone.create({ data: { name: 'ب', code: 'B', parcelNumbers: ['8001'] } });

    await buildings.create({ parcelNumber: '8000', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 }, actor());
    await buildings.create({ parcelNumber: '8001', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 }, actor());

    // The two sectors swap their parcels — every code on both has to move.
    await db.zone.updateMany({ where: { code: 'A' }, data: { parcelNumbers: ['8001'] } });
    await db.zone.updateMany({ where: { code: 'B' }, data: { parcelNumbers: ['8000'] } });

    const changed = await buildings.recomputeCodesForParcels(['8000', '8001']);
    expect(changed).toBe(2);

    // Scoped to the two parcels this test made, so it does not depend on being
    // the only test that ever created a building.
    const codes = (
      await db.building.findMany({
        where: { parcelNumber: { in: ['8000', '8001'] } },
        orderBy: { parcelNumber: 'asc' },
      })
    ).map((b) => b.code);
    expect(codes).toEqual(['B-8000-A', 'A-8001-A']);
  });

  // ────────────────────────────  Damage  ────────────────────────────

  it('keeps the repair without losing the collapse', async () => {
    // D3: a building damaged in 2024 and repaired in 2026 is two facts, and the
    // first is what a compensation claim rests on.
    const { building } = await buildings.create(
      { parcelNumber: '9000', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );

    await damage.record(
      {
        buildingId: building.id,
        level: 'UNSAFE_EVACUATE',
        source: 'FIELD_VISIT',
        assessedAt: new Date('2024-10-01'),
      },
      actor(),
    );
    await damage.record(
      {
        buildingId: building.id,
        level: 'SAFE_MINOR_DAMAGE',
        source: 'FIELD_VISIT',
        assessedAt: new Date('2026-03-01'),
      },
      actor(),
    );

    expect(await damage.currentLevel(building.id)).toBe('SAFE_MINOR_DAMAGE');
    expect(await damage.history(building.id)).toHaveLength(2);
  });

  it('reads a unit’s damage as the building’s', async () => {
    // "Top three floors gone, ground floor shop still trading" is one structure
    // and two rows; a history showing only building-level readings would be
    // missing the half that explains it.
    const { building } = await buildings.create(
      { parcelNumber: '9100', structureType: 'MIXED_USE', floorsCount: 1 },
      actor(),
    );
    const { units } = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 3, toFloor: 3, unitsPerFloor: 1, unitType: 'APARTMENT' },
      actor(),
    );

    await damage.record(
      { unitId: units[0]!.id, level: 'TOTAL_COLLAPSE', source: 'FIELD_VISIT' },
      actor(),
    );

    expect(await damage.currentLevel(building.id)).toBe('TOTAL_COLLAPSE');

    // A building with no coordinates is left off the map rather than plotted at
    // (0,0) — a pin in the Gulf of Guinea is worse than one the map does not
    // yet show, and the ledger lists it either way.
    const pins = await buildings.mapPins();
    expect(pins.find((pin) => pin.id === building.id)).toBeUndefined();
  });

  it('puts the worst survey status on the map pin', async () => {
    const { building } = await buildings.create(
      {
        parcelNumber: '9200',
        structureType: 'RESIDENTIAL_BUILDING',
        floorsCount: 1,
        latitude: 33.26,
        longitude: 35.26,
      },
      actor(),
    );
    const { units } = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 3, unitType: 'APARTMENT' },
      actor(),
    );

    await buildings.updateUnit(units[0]!.id, { surveyStatus: 'COMPLETE' }, actor());
    await buildings.updateUnit(units[1]!.id, { surveyStatus: 'COMPLETE' }, actor());
    await damage.record(
      { buildingId: building.id, level: 'RESTRICTED_USE', source: 'SATELLITE' },
      actor(),
    );

    const pin = (await buildings.mapPins()).find((candidate) => candidate.id === building.id);
    // Two of three surveyed, and the pin still reads NOT_SURVEYED — D11.
    expect(pin).toEqual(
      expect.objectContaining({
        surveyRollup: 'NOT_SURVEYED',
        unitsTotal: 3,
        unitsSurveyed: 2,
        worstDamageLevel: 'RESTRICTED_USE',
      }),
    );
  });
});

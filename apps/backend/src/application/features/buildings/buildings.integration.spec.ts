import { randomUUID } from 'node:crypto';
import { logVisitSchema, type CreateBuildingInput } from '@mechanization/shared-schemas';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { CasesService } from '../cases/cases.service';
import { ConflictError } from '../../common/exceptions';
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

/**
 * The schema-building hook gets its own, larger budget.
 *
 * `beforeAll` drops the spec's schema and replays the **whole migration chain**
 * — thirty-odd hand-written files — against whatever `TEST_DATABASE_URL` points
 * at, which in practice is a hosted Postgres a few hundred milliseconds away.
 * At 60s that hook fails on a slow link while every test in the suite would
 * have passed, and a suite that reports "failed to run" for a network hiccup is
 * a suite people learn to re-run rather than read.
 *
 * The per-test budget stays at 60s: an individual assertion taking a minute is
 * a real problem, and this must not hide it.
 */
const SETUP_TIMEOUT_MS = 240_000;

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
      /*
        Raw queries now write this into their SQL rather than leaning on
        `search_path` — see `tenant-schema-ref.ts`. Supplying it here is what
        makes these suites exercise the qualified form rather than a shape
        that only works because the test client pins one schema per connection.
      */
      schemaName: SCHEMA,
    } as unknown as TenantContextService;

    const events = new EventEmitter2();
    const cases = new CasesService(
      new PrismaCaseRepository(context),
      { findById: async () => ({ id: officerId, kind: 'CITIZEN' }) } as never,
      events,
    );

    buildings = new BuildingsService(context, cases, events);
    damage = new DamageService(context, events);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    /*
      The same budget as the hook that built it: this drops the schema CASCADE
      over the same link, and a teardown that times out is reported as "Test
      suite failed to run" even when every test in the file passed — which reads
      as a broken suite rather than a slow one.
    */
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

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

  /**
   * `buildings.create`, with the two answers every test here would otherwise
   * have to repeat.
   *
   * `CreateBuildingInput` is the schema's *output* type, so a field carrying a
   * `.default()` is required of a caller that did not go through Zod — which
   * this suite has not, because it drives the service directly. Supplying them
   * here rather than in thirty-seven object literals means the next default
   * added to the schema is one line of change, not thirty-seven.
   *
   * `acknowledgedDuplicates` is the interesting one. Most of these tests put
   * several structures on one parcel *deliberately* — that is what suffix
   * allocation is — so the duplicate guard would refuse them all, and refusing
   * them is not what any of these tests is about. It is exercised on its own,
   * with the flag left off, further down.
   */
  const createBuilding = (
    input: Omit<CreateBuildingInput, 'lifecycleStatus' | 'acknowledgedDuplicates'> &
      Partial<Pick<CreateBuildingInput, 'lifecycleStatus' | 'acknowledgedDuplicates'>>,
    by: { id: string; role: string },
  ) => buildings.create({ lifecycleStatus: 'IN_USE', acknowledgedDuplicates: true, ...input }, by);

  /**
   * Runs a creation that is expected to be refused, and hands back the refusal.
   *
   * `.catch(e => e)` would type the result as a union of the refusal and the
   * building that was not created, and a test that has to narrow that union
   * before asserting anything is a test that would still pass if the guard
   * stopped guarding. This fails loudly when nothing is thrown.
   */
  const refusalFrom = async (run: () => Promise<unknown>): Promise<ConflictError> => {
    try {
      await run();
    } catch (error) {
      if (error instanceof ConflictError) return error;
      throw error;
    }
    throw new Error('expected the duplicate guard to refuse this creation, and it did not');
  };

  // ───────────────────────  Suffix allocation  ───────────────────────

  it('allocates A, then B, then C on one parcel', async () => {
    const a = await createBuilding({ parcelNumber: '1042', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 }, actor());
    const b = await createBuilding({ parcelNumber: '1042', structureType: 'INDEPENDENT_HOUSE', floorsCount: 1 }, actor());
    const c = await createBuilding({ parcelNumber: '1042', structureType: 'WAREHOUSE_HANGAR', floorsCount: 1 }, actor());

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
        createBuilding(
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
    const one = await createBuilding({ parcelNumber: '10', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 }, actor());
    const two = await createBuilding({ parcelNumber: '11', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 }, actor());

    // Each parcel numbers its own structures from A. The code is what
    // distinguishes them, not the suffix.
    expect(one.building.codeSuffix).toBe('A');
    expect(two.building.codeSuffix).toBe('A');
    expect(one.building.code).not.toBe(two.building.code);
  });

  it('tells an officer when the code they were quoting changed', async () => {
    await createBuilding({ parcelNumber: '3000', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 }, actor());

    // A phone that was offline showed "A"; the parcel already had one.
    const second = await createBuilding(
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

    const first = await createBuilding(input, actor());
    const retry = await createBuilding(input, actor());

    expect(retry.deduplicated).toBe(true);
    expect(retry.building.id).toBe(first.building.id);
    expect(await db.building.count({ where: { parcelNumber: '4000' } })).toBe(1);
  });

  // ─────────────────────────  The unit matrix  ─────────────────────────

  /*
    عدد الطوابق and the blueprint's range are one statement, not two.

    They were unrelated on both sides: a building declared as one storey
    accepted a range up to floor 40, generated forty floors of flats, and had
    its own `floorsCount` silently rewritten to match — so the field the officer
    had just filled in was overwritten by the field beside it, in the same save.

    Which way the disagreement is resolved depends on whether the officer stated
    both numbers. In the blueprint form they did, so it is refused; on `addUnit`
    they did not, so the count follows the unit.
  */
  it('refuses a blueprint that reaches above the building it is for', async () => {
    const { building } = await createBuilding(
      { parcelNumber: '5010', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 2 },
      actor(),
    );

    await expect(
      buildings.generateUnits(
        building.id,
        { kind: 'uniform', fromFloor: 0, toFloor: 5, unitsPerFloor: 1, unitType: 'APARTMENT' },
        actor(),
      ),
    ).rejects.toThrow(/5[\s\S]*2|2[\s\S]*5/);

    // Refused before anything was written, not half-way through it.
    expect(await db.unit.count({ where: { buildingId: building.id } })).toBe(0);
    expect((await db.building.findUnique({ where: { id: building.id } }))?.floorsCount).toBe(2);
  });

  it('accepts a basement without counting it as a storey', async () => {
    // عدد الطوابق counts what stands above ground, so a قبو never moves the
    // ceiling and never has to be made room for.
    const { building } = await createBuilding(
      { parcelNumber: '5020', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );

    const result = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: -1, toFloor: 0, unitsPerFloor: 1, unitType: 'APARTMENT' },
      actor(),
    );

    expect(result.created).toBe(2);
    expect(result.units.map((u) => u.unitCode)).toContain('B101');
    expect((await db.building.findUnique({ where: { id: building.id } }))?.floorsCount).toBe(1);
  });

  it('raises the floor count for a unit added on a floor the register did not know about', async () => {
    /*
      The other side of the rule. An officer standing on the fourth floor of a
      building the register calls three-storey is correcting it, and there is no
      second number in front of them to contradict — so the count follows the
      unit rather than refusing it.
    */
    const { building } = await createBuilding(
      { parcelNumber: '5030', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 2 },
      actor(),
    );

    await buildings.addUnit(building.id, { floor: 4, unitType: 'APARTMENT' }, actor());

    expect((await db.building.findUnique({ where: { id: building.id } }))?.floorsCount).toBe(5);

    // Only ever upward: a ground-floor محل is not evidence the block got shorter.
    await buildings.addUnit(building.id, { floor: 0, unitType: 'SHOP' }, actor());
    expect((await db.building.findUnique({ where: { id: building.id } }))?.floorsCount).toBe(5);
  });

  it('generates a matrix and lets the trigger count it', async () => {
    const { building } = await createBuilding(
      { parcelNumber: '5000', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 3 },
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
    /*
      Unchanged by the generation, which is the point.

      `generateUnits` used to *raise* `floorsCount` to cover whatever range it
      was handed — so the field the officer filled in was rewritten by the range
      beside it. It now refuses a range that does not fit instead, and the
      number here is the one the building was created with.
    */
    expect(stored?.floorsCount).toBe(3);
  });

  it('tops a matrix up rather than doubling it', async () => {
    // A re-tap on a slow connection must not invent flats.
    const { building } = await createBuilding(
      { parcelNumber: '5100', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 2 },
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
    const { building } = await createBuilding(
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
    const { building } = await createBuilding(
      { parcelNumber: '6000', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 2 },
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
    const { building } = await createBuilding(
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
    const { building } = await createBuilding(
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
    const { building } = await createBuilding(
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
    const { building } = await createBuilding(
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
    const { building } = await createBuilding(
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

    await createBuilding({ parcelNumber: '8000', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 }, actor());
    await createBuilding({ parcelNumber: '8001', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 }, actor());

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
    const { building } = await createBuilding(
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
    const { building } = await createBuilding(
      { parcelNumber: '9100', structureType: 'MIXED_USE', floorsCount: 4 },
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
    const { building } = await createBuilding(
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
  // ────────────────────────  The census ledger  ────────────────────────

  /**
   * `list` is what the Phase 3 ledger reads, and three of its guarantees exist
   * only against a real database:
   *
   *  - the sector filter is an expansion of `Zone.parcelNumbers` into a parcel
   *    list, because a building carries no `zoneId` to filter on (D13);
   *  - the damage filter is the newest row of an append-only log, and it has to
   *    narrow `total` and the page together or the two describe different sets;
   *  - `summary` is aggregated over the whole filtered predicate, not the page.
   *
   * Each test scopes its assertions to parcels it created, so the suite stays
   * independent of whatever else is in the schema.
   */
  it('filters the ledger by sector, expanding it to that sector’s parcels', async () => {
    await db.zone.create({
      data: { name: 'قطاع السجل', code: 'LEDG', color: '#3B82F6', parcelNumbers: ['9400'] },
    });

    const inside = await createBuilding(
      { parcelNumber: '9400', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    const outside = await createBuilding(
      { parcelNumber: '9401', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );

    const zone = await db.zone.findFirstOrThrow({ where: { code: 'LEDG' } });
    const listed = await buildings.list({ zoneId: zone.id, limit: 500 });
    const ids = listed.buildings.map((row) => row.id);

    expect(ids).toContain(inside.building.id);
    expect(ids).not.toContain(outside.building.id);
    // The sector's own name travels with the row: the ledger shows it as a
    // column, and it is resolved here rather than stored (D13).
    expect(listed.buildings.find((row) => row.id === inside.building.id)?.zoneName).toBe(
      'قطاع السجل',
    );
  });

  it('returns nothing for a sector that owns no parcels', async () => {
    await db.zone.create({
      data: { name: 'قطاع فارغ', code: 'EMPT', color: '#EF4444', parcelNumbers: [] },
    });
    const zone = await db.zone.findFirstOrThrow({ where: { code: 'EMPT' } });

    // The true answer, and the one a naive implementation gets backwards: an
    // empty parcel list must match no buildings, never all of them.
    const listed = await buildings.list({ zoneId: zone.id, limit: 500 });
    expect(listed.buildings).toHaveLength(0);
    expect(listed.total).toBe(0);
    expect(listed.summary.buildings).toBe(0);
  });

  it('composes the sector filter with an explicit parcel rather than replacing it', async () => {
    await db.zone.create({
      data: { name: 'قطاع التركيب', code: 'COMP', color: '#10B981', parcelNumbers: ['9410'] },
    });
    await createBuilding(
      { parcelNumber: '9410', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    await createBuilding(
      { parcelNumber: '9411', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    const zone = await db.zone.findFirstOrThrow({ where: { code: 'COMP' } });

    const matching = await buildings.list({ zoneId: zone.id, parcelNumber: '9410', limit: 500 });
    expect(matching.total).toBe(1);

    /*
      A parcel outside the chosen sector yields nothing — the two clauses AND
      together. Assigned rather than ANDed, this would have returned parcel
      9411's building while the sector filter beside it said otherwise.
    */
    const contradictory = await buildings.list({
      zoneId: zone.id,
      parcelNumber: '9411',
      limit: 500,
    });
    expect(contradictory.total).toBe(0);
  });

  it('filters on the current damage level, and narrows total with it', async () => {
    const repaired = await createBuilding(
      { parcelNumber: '9420', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    const unsafe = await createBuilding(
      { parcelNumber: '9421', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );

    await damage.record(
      {
        buildingId: repaired.building.id,
        level: 'UNSAFE_EVACUATE',
        source: 'FIELD_VISIT',
        assessedAt: new Date('2024-10-01'),
      },
      actor(),
    );
    await damage.record(
      {
        buildingId: repaired.building.id,
        level: 'SAFE_MINOR_DAMAGE',
        source: 'FIELD_VISIT',
        assessedAt: new Date('2026-03-01'),
      },
      actor(),
    );
    await damage.record(
      { buildingId: unsafe.building.id, level: 'UNSAFE_EVACUATE', source: 'FIELD_VISIT' },
      actor(),
    );

    const listed = await buildings.list({ damageLevel: 'UNSAFE_EVACUATE', limit: 500 });
    const ids = listed.buildings.map((row) => row.id);

    // The building repaired in 2026 keeps its 2024 row and stops matching.
    expect(ids).toContain(unsafe.building.id);
    expect(ids).not.toContain(repaired.building.id);

    /*
      `total` counts the same predicate the rows came from. Filtered after the
      page instead — which is what this did before Phase 3 — it would have
      counted every building in the schema, so a ledger showing four unsafe
      buildings would state a total in the hundreds beneath them.
    */
    expect(listed.total).toBe(listed.buildings.length);
    expect(listed.summary.buildings).toBe(listed.total);
  });

  it('carries each row’s current damage level for the ledger column', async () => {
    const { building } = await createBuilding(
      { parcelNumber: '9430', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    await damage.record(
      { buildingId: building.id, level: 'RESTRICTED_USE', source: 'OFFICIAL_REPORT' },
      actor(),
    );

    const listed = await buildings.list({ parcelNumber: '9430', limit: 10 });
    expect(listed.buildings[0]).toEqual(
      expect.objectContaining({ id: building.id, damageLevel: 'RESTRICTED_USE' }),
    );
  });

  it('summarises units and damage over the filtered set, not the page', async () => {
    const { building } = await createBuilding(
      { parcelNumber: '9440', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 3 },
      actor(),
    );
    const { units } = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 2, unitsPerFloor: 2, unitType: 'APARTMENT' },
      actor(),
    );
    await buildings.updateUnit(units[0]!.id, { surveyStatus: 'COMPLETE' }, actor());
    await buildings.updateUnit(units[1]!.id, { surveyStatus: 'VACANT_CONFIRMED' }, actor());
    await damage.record(
      { buildingId: building.id, level: 'TOTAL_COLLAPSE', source: 'SATELLITE' },
      actor(),
    );

    // A page of one over a filtered set of one, so the tiles and the row have
    // to agree — the property that breaks first if `summary` is ever computed
    // from `buildings` rather than from the predicate.
    const listed = await buildings.list({ parcelNumber: '9440', limit: 1 });
    expect(listed.summary).toEqual({
      buildings: 1,
      unitsTotal: 6,
      unitsSurveyed: 2,
      unitsUnsurveyed: 4,
      // Nothing excluded: this building is `IN_USE`, so every unit it has is
      // counted. Asserted rather than omitted — `toEqual` over the whole shape
      // is what makes a silently added figure fail here instead of appearing
      // unexplained on a tile.
      unitsOutOfScope: 0,
      damaged: 1,
    });
  });

  it('does not count an undamaged assessment as damage', async () => {
    const { building } = await createBuilding(
      { parcelNumber: '9450', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    await damage.record(
      { buildingId: building.id, level: 'SAFE_MINOR_DAMAGE', source: 'FIELD_VISIT' },
      actor(),
    );

    // Confirming that a building is fine must not make the damaged figure rise.
    const listed = await buildings.list({ parcelNumber: '9450', limit: 10 });
    expect(listed.summary.damaged).toBe(0);
    expect(listed.buildings[0]?.damageLevel).toBe('SAFE_MINOR_DAMAGE');
  });

  it('counts a unit-level assessment against its building', async () => {
    const { building } = await createBuilding(
      { parcelNumber: '9460', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    const { units } = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 2, unitType: 'APARTMENT' },
      actor(),
    );
    await damage.record(
      { unitId: units[0]!.id, level: 'UNSAFE_EVACUATE', source: 'FIELD_VISIT' },
      actor(),
    );

    // "Top three floors gone, ground floor shop still trading" is an
    // observation about the structure, so the ledger has to see it.
    const listed = await buildings.list({ parcelNumber: '9460', limit: 10 });
    expect(listed.buildings[0]?.damageLevel).toBe('UNSAFE_EVACUATE');
    expect(listed.summary.damaged).toBe(1);
  });
  // ────────────────────────────  Unit visits  ────────────────────────────

  /**
   * P4-T1's acceptance is «٣ محاولات» visible on the unit, and the count is the
   * only part of it that cannot be inferred from the unit's own row: three
   * fruitless visits and one both leave `surveyStatus = VISITED_NO_ANSWER`.
   * These check the count, the status the visit sets, and the two rules that
   * keep the pair honest.
   */
  it('counts three attempts on one unit and leaves the status at the last outcome', async () => {
    const { building } = await createBuilding(
      { parcelNumber: '9500', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    const { units } = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 1, unitType: 'APARTMENT' },
      actor(),
    );
    const unitId = units[0]!.id;

    for (const day of ['2026-08-01', '2026-08-08', '2026-08-15']) {
      await buildings.logVisit(
        { unitId, outcome: 'VISITED_NO_ANSWER', visitedAt: new Date(day) },
        actor(),
      );
    }

    const detail = await buildings.get(building.id);
    const unit = detail.units.find((candidate) => candidate.id === unitId);

    expect(unit?.visitCount).toBe(3);
    expect(unit?.surveyStatus).toBe('VISITED_NO_ANSWER');
    // Newest first — the matrix panel reads top-down and the last attempt is
    // the one that decides what happens next.
    expect(unit?.visits.map((visit) => visit.visitedAt.toISOString().slice(0, 10))).toEqual([
      '2026-08-15',
      '2026-08-08',
      '2026-08-01',
    ]);
  });

  it('moves the unit to the outcome of the visit, including out of a finding', async () => {
    const { building } = await createBuilding(
      { parcelNumber: '9510', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    const { units } = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 1, unitType: 'APARTMENT' },
      actor(),
    );
    const unitId = units[0]!.id;

    await buildings.logVisit({ unitId, outcome: 'VACANT_CONFIRMED' }, actor());
    expect((await buildings.get(building.id)).units[0]?.surveyStatus).toBe('VACANT_CONFIRMED');

    /*
      A later visit that finds somebody home overrides it, and that is the
      difference from `recordOccupancy`'s narrow lift: this is an officer
      stating a finding directly rather than a side effect of some other action,
      and a finding replaces the previous one.
    */
    const result = await buildings.logVisit({ unitId, outcome: 'COMPLETE' }, actor());
    expect(result.visitCount).toBe(2);
    expect((await buildings.get(building.id)).units[0]?.surveyStatus).toBe('COMPLETE');
  });

  it('records who made the visit and keeps it after they are gone', async () => {
    const { building } = await createBuilding(
      { parcelNumber: '9520', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    const { units } = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 1, unitType: 'APARTMENT' },
      actor(),
    );

    const leaverId = randomUUID();
    await db.user.create({
      data: {
        id: leaverId,
        kind: 'STAFF',
        tenantSlug: 'census',
        email: `leaver-${leaverId}@census.gov.lb`,
        firstName: 'موظف',
        lastName: 'سابق',
        role: 'FIELD_INSPECTOR',
      },
    });

    await buildings.logVisit(
      { unitId: units[0]!.id, outcome: 'REFUSED', notes: 'رفض صاحب العلاقة' },
      { id: leaverId, role: 'FIELD_INSPECTOR' },
    );

    const before = await buildings.visits(units[0]!.id);
    expect(before[0]).toEqual(
      expect.objectContaining({ officerName: 'موظف سابق', notes: 'رفض صاحب العلاقة' }),
    );

    /*
      The officer leaves. The visit stays — `officerId` is `SetNull`, not
      cascade, because a visit is a thing that happened and the municipality's
      evidence that a door was tried is exactly what a resident disputing a
      notice asks to see.
    */
    await db.user.delete({ where: { id: leaverId } });

    const after = await buildings.visits(units[0]!.id);
    expect(after).toHaveLength(1);
    expect(after[0]?.officerId).toBeNull();
    expect(after[0]?.outcome).toBe('REFUSED');
  });

  it('refuses a visit outcome of NOT_SURVEYED', () => {
    // Enforced by the schema rather than the service: `NOT_SURVEYED` means
    // nobody went, so a *visit* carrying it is a contradiction, and the
    // controller must never reach `logVisit` with one.
    expect(logVisitSchema.safeParse({ unitId: randomUUID(), outcome: 'NOT_SURVEYED' }).success).toBe(
      false,
    );
    expect(logVisitSchema.safeParse({ unitId: randomUUID(), outcome: 'COMPLETE' }).success).toBe(
      true,
    );
  });

  it('refuses a visit dated in the future', () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(
      logVisitSchema.safeParse({
        unitId: randomUUID(),
        outcome: 'COMPLETE',
        visitedAt: tomorrow,
      }).success,
    ).toBe(false);
  });

  // ──────────────────────  The duplicate guard (P5-T3)  ──────────────────────

  it('refuses a second structure on a parcel until the officer says it is a different one', async () => {
    await createBuilding(
      {
        parcelNumber: 'DUP-1',
        structureType: 'RESIDENTIAL_BUILDING',
        floorsCount: 1,
        name: 'بناية النور',
        latitude: 33.26,
        longitude: 35.26,
      },
      actor(),
    );

    /*
      The failure this exists for is invisible without it: two officers walking
      one block from the street and from the alley each create a building, the
      advisory lock hands them A and B, and the census now holds one structure
      twice with nothing anywhere reading as wrong.
    */
    await expect(
      buildings.create(
        {
          parcelNumber: 'DUP-1',
          structureType: 'RESIDENTIAL_BUILDING',
          lifecycleStatus: 'IN_USE',
          floorsCount: 1,
          latitude: 33.2601,
          longitude: 35.2601,
        },
        actor(),
      ),
    ).rejects.toThrow(/DUP-1/);

    expect(await db.building.count({ where: { parcelNumber: 'DUP-1' } })).toBe(1);
  });

  it('carries the structures already on the parcel back with the refusal', async () => {
    await createBuilding(
      {
        parcelNumber: 'DUP-2',
        structureType: 'RESIDENTIAL_BUILDING',
        floorsCount: 1,
        name: 'بناية الزهراء',
        latitude: 33.26,
        longitude: 35.26,
      },
      actor(),
    );

    const refusal = await refusalFrom(() =>
      buildings.create(
        {
          parcelNumber: 'DUP-2',
          structureType: 'RESIDENTIAL_BUILDING',
          lifecycleStatus: 'IN_USE',
          floorsCount: 1,
          // Roughly 15 m away — close enough that "is this the same block?" is
          // a real question rather than a formality.
          latitude: 33.26013,
          longitude: 35.26,
        },
        actor(),
      ),
    );

    const details = refusal.details as {
      parcelNumber: string;
      candidates: Array<{ name: string | null; distanceMetres: number | null }>;
    };

    expect(details.parcelNumber).toBe('DUP-2');
    expect(details.candidates).toHaveLength(1);
    expect(details.candidates[0]?.name).toBe('بناية الزهراء');
    /*
      The distance is the whole point of sending the candidates rather than a
      count. "There is another building here" is a shrug; "there is another
      building fifteen metres away called بناية الزهراء" is a decision.
    */
    expect(details.candidates[0]?.distanceMetres).toBeGreaterThan(5);
    expect(details.candidates[0]?.distanceMetres).toBeLessThan(40);
  });

  it('reports no distance when either building has no pin', async () => {
    await createBuilding(
      { parcelNumber: 'DUP-3', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );

    const refusal = await refusalFrom(() =>
      buildings.create(
        {
          parcelNumber: 'DUP-3',
          structureType: 'RESIDENTIAL_BUILDING',
          lifecycleStatus: 'IN_USE',
          floorsCount: 1,
          latitude: 33.26,
          longitude: 35.26,
        },
        actor(),
      ),
    );

    const candidates = (refusal.details as { candidates: Array<{ distanceMetres: number | null }> })
      .candidates;

    /*
      Null, never 0. "We cannot tell how far apart these are" and "they are in
      the same place" are opposite findings, and the second is the one that
      would talk an officer out of recording a building that really exists.
    */
    expect(candidates[0]?.distanceMetres).toBeNull();
  });

  it('allows the second structure once it is acknowledged', async () => {
    await createBuilding(
      { parcelNumber: 'DUP-4', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );

    const second = await buildings.create(
      {
        parcelNumber: 'DUP-4',
        structureType: 'WAREHOUSE_HANGAR',
        lifecycleStatus: 'IN_USE',
        floorsCount: 1,
        acknowledgedDuplicates: true,
      },
      actor(),
    );

    // A confirmation, not a validation rule: the answer is always allowed to be
    // yes. What is not allowed is never being asked.
    expect(second.building.codeSuffix).toBe('B');
  });

  it('does not ask about the first structure on a parcel', async () => {
    const first = await buildings.create(
      {
        parcelNumber: 'DUP-5',
        structureType: 'RESIDENTIAL_BUILDING',
        lifecycleStatus: 'IN_USE',
        floorsCount: 1,
      },
      actor(),
    );

    expect(first.building.codeSuffix).toBe('A');
  });

  it('still recognises a re-delivered offline creation without acknowledgement', async () => {
    const clientSubmissionId = randomUUID();
    const input = {
      parcelNumber: 'DUP-6',
      structureType: 'RESIDENTIAL_BUILDING' as const,
      lifecycleStatus: 'IN_USE' as const,
      floorsCount: 1,
      clientSubmissionId,
    };

    const first = await buildings.create(input, actor());

    /*
      The order of the two guards matters and this is what pins it.

      Deduplication is checked *before* the duplicate prompt. Were it the other
      way round, a phone re-sending a creation it had already delivered would be
      told the parcel is occupied — by the very building it made — and an
      officer would either acknowledge it into a second structure or give up on
      a record that was already safely stored.
    */
    const retry = await buildings.create(input, actor());

    expect(retry.deduplicated).toBe(true);
    expect(retry.building.id).toBe(first.building.id);
    expect(await db.building.count({ where: { parcelNumber: 'DUP-6' } })).toBe(1);
  });

  // ─────────────────────  The lifecycle denominator (P5-T2)  ─────────────────

  it('keeps a structure that cannot hold households out of the survey figures', async () => {
    const standing = await createBuilding(
      { parcelNumber: 'LIFE-1', structureType: 'RESIDENTIAL_BUILDING', floorsCount: 1 },
      actor(),
    );
    const shell = await createBuilding(
      {
        parcelNumber: 'LIFE-2',
        structureType: 'RESIDENTIAL_BUILDING',
        floorsCount: 2,
        lifecycleStatus: 'UNDER_CONSTRUCTION',
      },
      actor(),
    );

    await buildings.generateUnits(
      standing.building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 1, unitsPerFloor: 2, unitType: 'APARTMENT' },
      actor(),
    );
    await buildings.generateUnits(
      shell.building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 1, unitsPerFloor: 2, unitType: 'APARTMENT' },
      actor(),
    );

    const listed = await buildings.list({ parcelNumbers: ['LIFE-1', 'LIFE-2'], limit: 500 });

    // Both buildings are listed — the ledger shows what is there.
    expect(listed.summary.buildings).toBe(2);
    /*
      But only the standing one's flats are work. Counting the shell's four
      would hold «غير ممسوحة» permanently above zero and keep proposing visits
      to a building with no doors hung yet.
    */
    expect(listed.summary.unitsTotal).toBe(4);
    expect(listed.summary.unitsUnsurveyed).toBe(4);
    // Reported rather than silently dropped, so a percentage that looks too
    // good can be explained on the screen showing it.
    expect(listed.summary.unitsOutOfScope).toBe(4);
  });

  it('withholds the survey colour from a structure nobody can be inside', async () => {
    const shell = await createBuilding(
      {
        parcelNumber: 'LIFE-3',
        structureType: 'RESIDENTIAL_BUILDING',
        floorsCount: 1,
        lifecycleStatus: 'UNDER_CONSTRUCTION',
        latitude: 33.27,
        longitude: 35.27,
      },
      actor(),
    );
    await buildings.generateUnits(
      shell.building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 2, unitType: 'APARTMENT' },
      actor(),
    );

    const pins = await buildings.mapPins();
    const pin = pins.find((row) => row.id === shell.building.id);

    /*
      Its units really are `NOT_SURVEYED`, and `rollupOf` would say so — in the
      one colour on this map that means "send somebody". Null instead, so the
      map draws it in the lifecycle's muted channel.
    */
    expect(pin?.surveyRollup).toBeNull();
    expect(pin?.lifecycleStatus).toBe('UNDER_CONSTRUCTION');
  });

  it('filters the ledger by lifecycle', async () => {
    await createBuilding(
      {
        parcelNumber: 'LIFE-4',
        structureType: 'RESIDENTIAL_BUILDING',
        floorsCount: 1,
        lifecycleStatus: 'NOT_REALISED',
      },
      actor(),
    );

    const listed = await buildings.list({ lifecycleStatus: 'NOT_REALISED', limit: 500 });
    expect(listed.buildings.map((row) => row.parcelNumber)).toContain('LIFE-4');
    expect(listed.buildings.every((row) => row.lifecycleStatus === 'NOT_REALISED')).toBe(true);
  });
});

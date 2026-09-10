import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { CasesService } from '../cases/cases.service';
import { PrismaCaseRepository } from '../../../infrastructure/repositories/case.repository';
import { ReportingService } from '../reporting/reporting.service';
import { BuildingsService } from './buildings.service';
import { CensusSyncService } from './census-sync.service';

/**
 * The registration → census write path (P5-T1), against a real Postgres.
 *
 * ## Why this file exists at all
 *
 * `census-link.spec.ts` proves the link *survives validation* — that
 * `buildingId` and `unitId` are not silently dropped by `branchFieldsOnly` on
 * their way through the submission schema. It was the right test and it was
 * testing the wrong half of the problem: the fields arrived, were written to
 * their columns, and nothing ever read them.
 *
 * So P3-T6 passed its acceptance criterion — "register into a specific unit" —
 * while the thing an officer actually saw after registering into a specific unit
 * was a matrix showing the flat empty, a unit still reading «غير ممسوحة», a map
 * pin still coloured unvisited, and the حالة that sent them there still open.
 *
 * Every assertion below is about that gap, and every one of them spans tables:
 * the occupancy, the unit's status, the visit log and the case are four rows in
 * four tables, and the rule that moves them is only true if the database says
 * so. A mocked client would let all of it pass while none of it worked, which is
 * precisely how this shipped.
 *
 * Set `TEST_DATABASE_URL` to run it; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_census_sync_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

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

describeIfDb('CensusSyncService', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let buildings: BuildingsService;
  let census: CensusSyncService;
  let cases: CasesService;
  let reporting: ReportingService;
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
    cases = new CasesService(
      new PrismaCaseRepository(context),
      { findById: async () => ({ id: officerId, kind: 'CITIZEN' }) } as never,
      events,
    );

    buildings = new BuildingsService(context, cases, events);
    census = new CensusSyncService(context, cases, events);

    /*
      A cache that never hits and a config that answers one key.

      `getRegisteredParcels` memoises through Redis, and a spec asserting what a
      *query* returns must not be answered from a previous test's snapshot.
    */
    reporting = new ReportingService(
      context,
      events,
      { get: async () => null, set: async () => undefined } as never,
      { get: () => undefined } as never,
    );

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

  // Isolation comes from new rows and fresh parcel numbers, not from cleanup —
  // the rule `payment-ledger.integration.spec.ts` states and this suite follows.
  const citizen = async (firstName: string): Promise<string> => {
    const id = randomUUID();
    await db.user.create({
      data: { id, kind: 'CITIZEN', tenantSlug: 'census', firstName, lastName: 'نصرالله' },
    });
    return id;
  };

  /** A building with a generated matrix, which is what an officer surveys into. */
  const surveyedBlock = async (parcelNumber: string, unitsPerFloor = 3) => {
    const { building } = await buildings.create(
      {
        parcelNumber,
        structureType: 'RESIDENTIAL_BUILDING',
        lifecycleStatus: 'IN_USE',
        floorsCount: 1,
      },
      actor(),
    );
    const { units } = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor, unitType: 'APARTMENT' },
      actor(),
    );
    return { building, units };
  };

  /**
   * The rows the registration path leaves behind, written directly.
   *
   * Going through `RegistrationService.submit` would drag a tenant config, the
   * cadastre and the whole submission schema into a spec about what happens
   * *after* all of that — and the sync reads committed rows, so committed rows
   * are exactly the right fixture. What is asserted below is what the sync does
   * with them, which is the part that was missing.
   */
  const registrationFor = async (input: {
    citizenId: string;
    propertyType: 'BUILDING' | 'HOUSE' | 'LAND';
    occupancyType?: 'OWNER' | 'TENANT' | 'FREE_OCCUPANT';
    buildingId?: string;
    buildingName?: string;
    parcelNumber: string;
    unitIds?: readonly string[];
    /**
     * What the cadastre lookup gives a real card: the *parcel centroid*.
     *
     * Only the map tests set it, and they set it to a point deliberately
     * different from the building's own pin — the gap between the two is the
     * defect these tests are about.
     */
    latitude?: number;
    longitude?: number;
  }): Promise<string> => {
    const registration = await db.registration.create({
      data: {
        citizenId: input.citizenId,
        referenceNumber: `REG-${randomUUID().slice(0, 8)}`,
      },
      select: { id: true },
    });

    await db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: input.occupancyType ?? 'OWNER',
        propertyType: input.propertyType,
        neighborhood: 'الحي الشرقي',
        propertyNumber: input.parcelNumber,
        buildingName: input.buildingName ?? null,
        buildingId: input.buildingId ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        units: {
          create: (input.unitIds ?? []).map((unitId) => ({
            unitType: 'APARTMENT',
            floor: 'الأرضي',
            unitArea: 95,
            unitId,
          })),
        },
      },
    });

    return registration.id;
  };

  // ───────────────────  What the officer expected to happen  ───────────────────

  it('records the household in the unit it was registered into', async () => {
    const { units } = await surveyedBlock('SYNC-1');
    const citizenId = await citizen('علي');
    const registrationId = await registrationFor({
      citizenId,
      propertyType: 'BUILDING',
      parcelNumber: 'SYNC-1',
      buildingId: units[0]!.buildingId,
      unitIds: [units[0]!.id],
    });

    const result = await census.syncRegistration({ registrationId, citizenId, actor: actor() });

    expect(result.occupanciesCreated).toBe(1);

    const occupancy = await db.unitOccupancy.findFirstOrThrow({
      where: { unitId: units[0]!.id, citizenId },
    });
    expect(occupancy.role).toBe('OWNER');
    expect(occupancy.toDate).toBeNull();
    // The link back to the file that established it — and the scope
    // `endUnclaimed` uses to know which rows this path may touch.
    expect(occupancy.registrationId).toBe(registrationId);
  });

  it('carries the card’s occupancy type through as the unit role', async () => {
    const { units } = await surveyedBlock('SYNC-2');
    const citizenId = await citizen('سمير');
    const registrationId = await registrationFor({
      citizenId,
      propertyType: 'BUILDING',
      occupancyType: 'TENANT',
      parcelNumber: 'SYNC-2',
      buildingId: units[0]!.buildingId,
      unitIds: [units[0]!.id],
    });

    await census.syncRegistration({ registrationId, citizenId, actor: actor() });

    // `OccupancyType` and `OccupancyRole` are separate enums with the same
    // three values, and the mapping between them is stated rather than cast —
    // a مستأجر filing a card is a TENANT on the matrix, not an owner.
    const occupancy = await db.unitOccupancy.findFirstOrThrow({ where: { citizenId } });
    expect(occupancy.role).toBe('TENANT');
  });

  it('lifts the unit out of «غير ممسوحة» and logs the visit that got the answer', async () => {
    const { units } = await surveyedBlock('SYNC-3');
    const citizenId = await citizen('حسن');
    const registrationId = await registrationFor({
      citizenId,
      propertyType: 'BUILDING',
      parcelNumber: 'SYNC-3',
      buildingId: units[0]!.buildingId,
      unitIds: [units[0]!.id],
    });

    const result = await census.syncRegistration({ registrationId, citizenId, actor: actor() });

    expect(result.unitsSurveyed).toBe(1);
    const unit = await db.unit.findUniqueOrThrow({ where: { id: units[0]!.id } });
    expect(unit.surveyStatus).toBe('COMPLETE');

    const visits = await db.unitVisit.findMany({ where: { unitId: units[0]!.id } });
    expect(visits).toHaveLength(1);
    expect(visits[0]?.outcome).toBe('COMPLETE');
    expect(visits[0]?.officerId).toBe(officerId);
  });

  it('moves the building’s surveyed counter, which is what colours the map', async () => {
    const { building, units } = await surveyedBlock('SYNC-4');
    const citizenId = await citizen('مريم');
    const registrationId = await registrationFor({
      citizenId,
      propertyType: 'BUILDING',
      parcelNumber: 'SYNC-4',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });

    const before = await db.building.findUniqueOrThrow({ where: { id: building.id } });
    expect(before.unitsSurveyed).toBe(0);

    await census.syncRegistration({ registrationId, citizenId, actor: actor() });

    /*
      Maintained by `sync_building_unit_counts`, not by this codebase — which is
      exactly why it is asserted here and could not be asserted anywhere else.
      This counter is what the ledger's percentage and the map's fill both read.
    */
    const after = await db.building.findUniqueOrThrow({ where: { id: building.id } });
    expect(after.unitsSurveyed).toBe(1);
    expect(after.unitsTotal).toBe(3);
  });

  it('closes the حالة that sent the officer to the door', async () => {
    const { building, units } = await surveyedBlock('SYNC-5');
    const citizenId = await citizen('كريم');

    const logged = await cases.create(
      {
        notes: 'لم يرد أحد',
        propertyNumber: 'SYNC-5',
        caseType: 'UNIT_UNREACHABLE',
        buildingId: building.id,
        unitId: units[0]!.id,
      },
      actor(),
    );

    const registrationId = await registrationFor({
      citizenId,
      propertyType: 'BUILDING',
      parcelNumber: 'SYNC-5',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });

    const result = await census.syncRegistration({ registrationId, citizenId, actor: actor() });

    /*
      P2-T5 put auto-resolve inside `recordOccupancy` — "the moment the thing the
      case was waiting on happened". The registration form never called it, so
      the one path an officer actually uses to register the household a case was
      raised about left the case open and the dispatch list re-proposed the visit.
    */
    expect(result.casesResolved).toBe(1);
    const closed = await db.case.findUniqueOrThrow({ where: { id: logged.id } });
    expect(closed.status).toBe('RESOLVED');
    expect(closed.resolvedCitizenId).toBe(citizenId);
  });

  // ─────────────────────────  Names, shared upward  ─────────────────────────

  it('teaches the census a building’s name when it had none', async () => {
    const { building, units } = await surveyedBlock('SYNC-6');
    const citizenId = await citizen('ابراهيم');
    const registrationId = await registrationFor({
      citizenId,
      propertyType: 'BUILDING',
      parcelNumber: 'SYNC-6',
      buildingId: building.id,
      buildingName: 'بناية النور',
      unitIds: [units[0]!.id],
    });

    const result = await census.syncRegistration({ registrationId, citizenId, actor: actor() });

    expect(result.buildingsNamed).toBe(1);
    // The officer in the stairwell is the person who knows what residents call
    // the block. Before this, their answer stayed on one citizen's card and the
    // next tenant typed a near-identical string onto their own.
    const named = await db.building.findUniqueOrThrow({ where: { id: building.id } });
    expect(named.name).toBe('بناية النور');
  });

  it('never overwrites a name the register already holds', async () => {
    const { building, units } = await surveyedBlock('SYNC-7');
    await buildings.update(building.id, { name: 'بناية الزهراء' }, actor());

    const citizenId = await citizen('نور');
    const registrationId = await registrationFor({
      citizenId,
      propertyType: 'BUILDING',
      parcelNumber: 'SYNC-7',
      buildingId: building.id,
      buildingName: 'بنايه الزهرا',
      unitIds: [units[0]!.id],
    });

    const result = await census.syncRegistration({ registrationId, citizenId, actor: actor() });

    /*
      The register is the authority once it has an answer — and the card's field
      is mirrored read-only from it in the form, so this misspelling can only
      reach the database on a card filed before the link existed. Promoting it
      would let one stale row rename a building for everybody in it.
    */
    expect(result.buildingsNamed).toBe(0);
    const unchanged = await db.building.findUniqueOrThrow({ where: { id: building.id } });
    expect(unchanged.name).toBe('بناية الزهراء');
  });

  // ────────────────────────  Corrections and re-runs  ────────────────────────

  it('is safe to run twice, and does not log a second visit for the same spell', async () => {
    const { building, units } = await surveyedBlock('SYNC-8');
    const citizenId = await citizen('زينب');
    const registrationId = await registrationFor({
      citizenId,
      propertyType: 'BUILDING',
      parcelNumber: 'SYNC-8',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });

    await census.syncRegistration({ registrationId, citizenId, actor: actor() });
    const second = await census.syncRegistration({ registrationId, citizenId, actor: actor() });

    /*
      A queued submission replayed, or an officer correcting a phone number a
      week later. Neither is a second doorstep, and a «٣ محاولات» count that
      rises when somebody opens a form is a count nobody can dispatch against.
    */
    expect(second.occupanciesCreated).toBe(0);
    expect(second.occupanciesRefreshed).toBe(1);
    expect(await db.unitOccupancy.count({ where: { unitId: units[0]!.id, citizenId } })).toBe(1);
    expect(await db.unitVisit.count({ where: { unitId: units[0]!.id } })).toBe(1);
  });

  it('ends the spell when the officer unticks the flat', async () => {
    const { building, units } = await surveyedBlock('SYNC-9');
    const citizenId = await citizen('جمال');
    const registrationId = await registrationFor({
      citizenId,
      propertyType: 'BUILDING',
      parcelNumber: 'SYNC-9',
      buildingId: building.id,
      unitIds: [units[0]!.id, units[1]!.id],
    });

    await census.syncRegistration({ registrationId, citizenId, actor: actor() });
    expect(
      await db.unitOccupancy.count({ where: { citizenId, registrationId, toDate: null } }),
    ).toBe(2);

    // The edit path replaces a card's unit rows wholesale; unticking flat 2 is
    // the officer saying the household is not in it.
    await db.buildingUnit.deleteMany({ where: { unitId: units[1]!.id } });

    const result = await census.syncRegistration({ registrationId, citizenId, actor: actor() });

    expect(result.occupanciesEnded).toBe(1);
    const dropped = await db.unitOccupancy.findFirstOrThrow({
      where: { unitId: units[1]!.id, citizenId },
    });
    // Ended, not deleted (D2). Somebody who moved out is history the
    // municipality needs, and P2-T8 stops billing them either way.
    expect(dropped.toDate).not.toBeNull();
  });

  it('never touches an occupancy somebody recorded from the matrix', async () => {
    const { building, units } = await surveyedBlock('SYNC-10');
    const matrixCitizen = await citizen('سلمى');
    const formCitizen = await citizen('رامي');

    // An officer walking the stairwell, before either person had a file.
    await buildings.recordOccupancy(
      { unitId: units[1]!.id, citizenId: matrixCitizen, role: 'TENANT' },
      actor(),
    );

    const registrationId = await registrationFor({
      citizenId: formCitizen,
      propertyType: 'BUILDING',
      parcelNumber: 'SYNC-10',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });

    await census.syncRegistration({
      registrationId,
      citizenId: formCitizen,
      actor: actor(),
    });

    /*
      `endUnclaimed` is scoped to rows carrying *this* registrationId, and this
      is what that scope is for. Without it, saving one household's card would
      evict everyone a stairwell survey had recorded in the rest of the block —
      silently, and in the same transaction as a phone-number correction.
    */
    const untouched = await db.unitOccupancy.findFirstOrThrow({
      where: { unitId: units[1]!.id, citizenId: matrixCitizen },
    });
    expect(untouched.toDate).toBeNull();
    expect(untouched.registrationId).toBeNull();
  });

  // ─────────────────────────  What it declines to do  ─────────────────────────

  it('attaches a منزل to the single unit of the structure it names', async () => {
    const { building } = await buildings.create(
      {
        parcelNumber: 'SYNC-11',
        structureType: 'INDEPENDENT_HOUSE',
        lifecycleStatus: 'IN_USE',
        floorsCount: 1,
      },
      actor(),
    );
    const { units } = await buildings.generateUnits(
      building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 1, unitType: 'INDEPENDENT_HOUSE' },
      actor(),
    );

    const citizenId = await citizen('أبو علي');
    const registrationId = await registrationFor({
      citizenId,
      propertyType: 'HOUSE',
      parcelNumber: 'SYNC-11',
      buildingId: building.id,
    });

    const result = await census.syncRegistration({ registrationId, citizenId, actor: actor() });

    /*
      A منزل card has no units array to tick — the picker's unit list renders
      for مبنى only — so without this a house linked to its own single-unit
      shell could never record who lives in it.
    */
    expect(result.occupanciesCreated).toBe(1);
    expect(
      await db.unitOccupancy.count({ where: { unitId: units[0]!.id, citizenId } }),
    ).toBe(1);
  });

  it('refuses to guess which flat a مبنى card holds', async () => {
    const { building } = await surveyedBlock('SYNC-12', 1);
    const citizenId = await citizen('فادي');
    const registrationId = await registrationFor({
      citizenId,
      propertyType: 'BUILDING',
      parcelNumber: 'SYNC-12',
      buildingId: building.id,
    });

    const result = await census.syncRegistration({ registrationId, citizenId, actor: actor() });

    /*
      Even with exactly one unit in the matrix. P2-T8 went down this road and
      reverted: a matrix says what flats exist, never how many of them one
      citizen holds, and a building with one unit today can have twelve once
      somebody finishes the survey. The officer ticks them, or nothing is
      claimed.
    */
    expect(result.occupanciesCreated).toBe(0);
    expect(await db.unitOccupancy.count({ where: { citizenId } })).toBe(0);
  });

  it('leaves a أرض card alone', async () => {
    const citizenId = await citizen('هدى');
    const registrationId = await registrationFor({
      citizenId,
      propertyType: 'LAND',
      parcelNumber: 'SYNC-13',
    });

    const result = await census.syncRegistration({ registrationId, citizenId, actor: actor() });

    // A أرض never gets a building and never gets one (§3.6, Q2). The sync's
    // query filters on `buildingId: not null`, so a land card is not even read.
    expect(result.occupanciesCreated).toBe(0);
    expect(result.buildingsNamed).toBe(0);
  });

  it('does not overwrite a finding that contradicts it', async () => {
    const { building, units } = await surveyedBlock('SYNC-14');
    await buildings.logVisit({ unitId: units[0]!.id, outcome: 'DEMOLISHED' }, actor());

    const citizenId = await citizen('وسام');
    const registrationId = await registrationFor({
      citizenId,
      propertyType: 'BUILDING',
      parcelNumber: 'SYNC-14',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });

    const result = await census.syncRegistration({ registrationId, citizenId, actor: actor() });

    /*
      The occupancy is still recorded — somebody filed a card naming this flat
      and that is a fact. What is not done is quietly flipping «مهدومة» to
      «مكتملة»: two officers have made contradictory statements about the same
      unit, and that is for a person to look at rather than for a side effect of
      somebody saving a form to resolve.
    */
    expect(result.occupanciesCreated).toBe(1);
    expect(result.unitsSurveyed).toBe(0);
    const unit = await db.unit.findUniqueOrThrow({ where: { id: units[0]!.id } });
    expect(unit.surveyStatus).toBe('DEMOLISHED');
  });

  it('skips a link whose unit has since been corrected away', async () => {
    const { building, units } = await surveyedBlock('SYNC-15');
    const citizenId = await citizen('ليلى');
    const registrationId = await registrationFor({
      citizenId,
      propertyType: 'BUILDING',
      parcelNumber: 'SYNC-15',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });

    // Reachable on a phone that queued the submission three days ago: the id it
    // carries was real when it was given, and `BuildingUnit.unitId` is SetNull.
    await db.unit.delete({ where: { id: units[0]!.id } });

    const result = await census.syncRegistration({ registrationId, citizenId, actor: actor() });

    // Skipped quietly. The citizen's own card is untouched and still says what
    // they filed, which is the record that matters.
    expect(result.occupanciesCreated).toBe(0);
  });

  // ─────────────  Where the map draws the household (P5-T5 → P5-T7)  ─────────────

  it('draws one marker per parcel, whatever is censused on it', async () => {
    const first = await surveyedBlock('MAP-2');
    await buildings.update(
      first.building.id,
      { latitude: 33.3101, longitude: 35.4101 },
      actor(),
    );

    const secondBuilding = await buildings.create(
      {
        parcelNumber: 'MAP-2',
        structureType: 'RESIDENTIAL_BUILDING',
        lifecycleStatus: 'IN_USE',
        floorsCount: 1,
        latitude: 33.3102,
        longitude: 35.4102,
        acknowledgedDuplicates: true,
      },
      actor(),
    );
    const second = await buildings.generateUnits(
      secondBuilding.building.id,
      { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 2, unitType: 'APARTMENT' },
      actor(),
    );

    const a = await citizen('سعاد');
    const b = await citizen('طارق');
    await registrationFor({
      citizenId: a,
      propertyType: 'BUILDING',
      parcelNumber: 'MAP-2',
      buildingId: first.building.id,
      unitIds: [first.units[0]!.id],
      latitude: 33.31,
      longitude: 35.41,
    });
    await registrationFor({
      citizenId: b,
      propertyType: 'BUILDING',
      parcelNumber: 'MAP-2',
      buildingId: secondBuilding.building.id,
      unitIds: [second.units[0]!.id],
      latitude: 33.31,
      longitude: 35.41,
    });

    const mine = (await reporting.getRegisteredParcels()).filter(
      (row) => row.propertyNumber === 'MAP-2',
    );

    /*
      Two censused blocks, still **one** blue dot.

      P5-T5 split this per structure so that each household sat on its own
      building. It was reverted because the map already draws the buildings —
      `mapPins` gives each one an icon at its own entrance, coloured by survey
      status — and a registration dot on top of each said the same thing twice.

      This marker is about the *plot*, and both households are registered on
      عقار MAP-2.
    */
    expect(mine).toHaveLength(1);
    expect(mine[0]?.latitude).toBeCloseTo(33.31, 6);
    expect(mine[0]?.longitude).toBeCloseTo(35.41, 6);
    // Everyone on the parcel, under the one dot.
    expect(mine[0]?.registrants.map((r) => r.citizenId).sort()).toEqual([a, b].sort());
  });

  it('keeps a linked card and an unlinked one under the same parcel marker', async () => {
    const { building, units } = await surveyedBlock('MAP-4');
    await buildings.update(building.id, { latitude: 33.3301, longitude: 35.4301 }, actor());

    const linked = await citizen('وفاء');
    const loose = await citizen('نبيل');

    await registrationFor({
      citizenId: linked,
      propertyType: 'BUILDING',
      parcelNumber: 'MAP-4',
      buildingId: building.id,
      unitIds: [units[0]!.id],
      latitude: 33.33,
      longitude: 35.43,
    });
    // A منزل on the same plot that nobody has censused.
    await registrationFor({
      citizenId: loose,
      propertyType: 'HOUSE',
      parcelNumber: 'MAP-4',
      latitude: 33.33,
      longitude: 35.43,
    });

    const mine = (await reporting.getRegisteredParcels()).filter(
      (row) => row.propertyNumber === 'MAP-4',
    );

    // Whether a card names a censused structure changes nothing here: the
    // question this layer answers is who is on the plot.
    expect(mine).toHaveLength(1);
    expect(mine[0]?.registrants).toHaveLength(2);
    expect(mine[0]?.structureCount).toBe(2);
    expect(mine[0]?.latitude).toBeCloseTo(33.33, 6);
  });

  it('reports failure as null rather than costing the municipality a registration', async () => {
    // A registration id that does not exist is the cheapest reachable stand-in
    // for "the census write failed" — what matters is the contract: the caller
    // has already committed a citizen, and this must never throw at it.
    const result = await census.syncQuietly({
      registrationId: randomUUID(),
      citizenId: randomUUID(),
      actor: actor(),
    });

    // An empty sync, not an error — there is nothing linked to act on.
    expect(result).toEqual(
      expect.objectContaining({ occupanciesCreated: 0, casesResolved: 0 }),
    );
  });
});

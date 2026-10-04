import { randomUUID } from 'node:crypto';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaCaseRepository } from '../../../infrastructure/repositories/case.repository';
import { CasesService } from '../cases/cases.service';
import { BuildingsService } from './buildings.service';
import { CensusSyncService } from './census-sync.service';
import { ParcelCorrectionService } from './parcel-correction.service';

/**
 * «تصحيح رقم العقار», against a real Postgres.
 *
 * A building filed under the wrong parcel keeps its id, units and history and
 * takes the right parcel's suffix and code; the old code is retired — still
 * searchable, never reused; and what copies the parcel follows it. Each test
 * is one of those facts across the tables that hold them.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_parcel_correction_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('ParcelCorrectionService', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let buildings: BuildingsService;
  let census: CensusSyncService;
  let correction: ParcelCorrectionService;
  let events: EventEmitter2;
  let officerId: string;

  const actor = () => ({ id: officerId, role: 'FIELD_INSPECTOR' });
  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-parcel', tenantSlug: 'parcel', schemaName: SCHEMA, prisma: db }, work);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    events = new EventEmitter2();
    const cases = new CasesService(
      new PrismaCaseRepository(context),
      { findById: async () => ({ id: officerId, kind: 'CITIZEN' }) } as never,
      events,
    );
    buildings = new BuildingsService(context, cases, events);
    census = new CensusSyncService(context, cases, events);
    correction = new ParcelCorrectionService(context, buildings, events, new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never));

    officerId = randomUUID();
    await db.user.create({
      data: {
        id: officerId,
        kind: 'STAFF',
        tenantSlug: 'parcel',
        email: `officer-${officerId}@parcel.gov.lb`,
        firstName: 'موظف',
        lastName: 'البلدية',
        role: 'FIELD_INSPECTOR',
      },
    });

    // A small cadastre: PC-B sits around the pin every building below is given.
    const square = (lng: number, lat: number, half: number) => ({
      type: 'Polygon',
      coordinates: [
        [
          [lng - half, lat - half],
          [lng + half, lat - half],
          [lng + half, lat + half],
          [lng - half, lat + half],
          [lng - half, lat - half],
        ],
      ],
    });
    await db.parcel.createMany({
      data: [
        { parcelNumber: 'PC-B', latitude: 33.2537, longitude: 35.2698, boundary: square(35.2698, 33.2537, 0.0005) },
        { parcelNumber: 'PC-F', latitude: 33.3, longitude: 35.3, boundary: square(35.3, 33.3, 0.0005) },
      ] as never,
    });
    await db.zone.create({ data: { name: 'القطاع الثاني', code: 'Z-2', parcelNumbers: ['PC-B'] } });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  // ─────────────────────────────  Fixtures  ─────────────────────────────

  const PIN = { latitude: 33.2537, longitude: 35.2698 };

  const building = (parcelNumber: string, over: Record<string, unknown> = {}) =>
    within(async () => {
      const { building: created } = await buildings.create(
        {
          parcelNumber,
          structureType: 'RESIDENTIAL_BUILDING',
          lifecycleStatus: 'IN_USE',
          floorsCount: 1,
          acknowledgedDuplicates: true,
          ...PIN,
          ...over,
        } as never,
        actor(),
      );
      const { units } = await buildings.generateUnits(
        created.id,
        { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 2, unitType: 'APARTMENT' },
        actor(),
      );
      return { building: created, units: [...units].sort((a, b) => a.sequence - b.sequence) };
    });

  /** A citizen's card on the building, linked, naming `propertyNumber`, synced into the census. */
  const card = async (input: {
    buildingId: string;
    propertyNumber: string;
    unitId: string;
    occupancyType?: 'OWNER' | 'TENANT';
    ended?: boolean;
  }) => {
    const citizenId = randomUUID();
    await db.user.create({
      data: {
        id: citizenId,
        kind: 'CITIZEN',
        tenantSlug: 'parcel',
        firstName: 'مواطن',
        middleName: 'علي',
        lastName: 'تجربة',
        phone: `+96171${String(Math.floor(100_000 + Math.random() * 899_999))}`,
      },
    });
    const registration = await db.registration.create({
      data: { citizenId, referenceNumber: `REF-${randomUUID().slice(0, 10)}` },
      select: { id: true },
    });
    const entry = await db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: input.occupancyType ?? 'OWNER',
        ...(input.occupancyType === 'TENANT' ? { landlordName: 'مالك', landlordPhone: '+96171000000' } : {}),
        propertyType: 'BUILDING',
        neighborhood: 'الحي',
        propertyNumber: input.propertyNumber,
        buildingId: input.buildingId,
        units: { create: [{ unitType: 'APARTMENT', floor: '0', unitArea: 100, unitId: input.unitId }] },
        ...(input.ended ? { endedAt: new Date(), endReason: 'MOVED_OUT' } : {}),
      },
      select: { id: true },
    });
    if (!input.ended) {
      await within(() => census.syncRegistration({ registrationId: registration.id, citizenId, actor: actor() }));
    }
    return { citizenId, cardId: entry.id };
  };

  const correct = (id: string, parcelNumber: string, over: Record<string, unknown> = {}) =>
    within(() => correction.correct(id, { parcelNumber, reason: 'رقم العقار في الصحيفة العقارية', ...over } as never, actor()));

  // ─────────────────────────────  The correction  ─────────────────────────────

  it('moves the building to the right parcel, keeps everything in it, and retires the old code', async () => {
    const { building: wrong, units } = await building('PC-A1');
    const owner = await card({ buildingId: wrong.id, propertyNumber: 'PC-A1', unitId: units[0]!.id });
    const occupanciesBefore = await db.unitOccupancy.count({ where: { unit: { buildingId: wrong.id } } });

    const result = await correct(wrong.id, 'PC-B');

    // Same building: same id, same units, same occupants.
    const after = await db.building.findUniqueOrThrow({ where: { id: wrong.id } });
    expect(after.parcelNumber).toBe('PC-B');
    expect(after.codeSuffix).toBe('A');
    expect(after.code).toBe('Z-2-PC-B-A');
    expect(result.previousCode).toBe(wrong.code);
    expect(await db.unit.count({ where: { buildingId: wrong.id } })).toBe(2);
    expect(await db.unitOccupancy.count({ where: { unit: { buildingId: wrong.id } } })).toBe(occupanciesBefore);

    // The old code is retired against this building, with its reason.
    const alias = await db.buildingCodeAlias.findFirstOrThrow({ where: { buildingId: wrong.id } });
    expect([alias.code, alias.parcelNumber, alias.codeSuffix, alias.reason]).toEqual([
      wrong.code,
      'PC-A1',
      'A',
      'رقم العقار في الصحيفة العقارية',
    ]);

    // The owner's card follows, with the right parcel's cadastre point.
    const entry = await db.propertyEntry.findUniqueOrThrow({ where: { id: owner.cardId } });
    expect(entry.propertyNumber).toBe('PC-B');
    expect([entry.latitude, entry.longitude]).toEqual([33.2537, 35.2698]);
    expect(result).toMatchObject({ cardsCorrected: 1, citizensAffected: 1, pinInsideNewParcel: true });
  });

  it('finds the building by its old code, and never gives that code to another building', async () => {
    const { building: wrong } = await building('PC-A2');
    await correct(wrong.id, 'PC-C2');

    const found = await within(() => buildings.list({ search: wrong.code } as never));
    expect(found.buildings.map((row) => row.id)).toEqual([wrong.id]);
    // The row says which retired code the search matched.
    expect(found.buildings[0]!.matchedPreviousCode).toBe(wrong.code);

    const detail = await within(() => buildings.get(wrong.id));
    expect(detail.previousCodes.map((row) => row.code)).toEqual([wrong.code]);

    // A new building on the old parcel skips the retired suffix — and the editor is told so.
    const listed = await within(() => buildings.list({ parcelNumber: 'PC-A2' } as never));
    expect(listed.retiredSuffixes).toEqual(['A']);
    const { building: fresh } = await building('PC-A2');
    expect(fresh.codeSuffix).toBe('B');
    expect(fresh.code).not.toBe(wrong.code);
  });

  it('follows the parcel on every card and case that copies it, and nothing else', async () => {
    const { building: wrong, units } = await building('PC-A3', { sharedParcelNumbers: ['PC-S3'] });
    const current = await card({ buildingId: wrong.id, propertyNumber: 'PC-A3', unitId: units[0]!.id });
    const ended = await card({ buildingId: wrong.id, propertyNumber: 'PC-A3', unitId: units[1]!.id, ended: true });
    const shared = await card({ buildingId: wrong.id, propertyNumber: 'PC-S3', unitId: units[1]!.id });
    // Not linked to the building: it may be another property on the old parcel.
    const loose = await db.propertyEntry.create({
      data: {
        registrationId: (await db.registration.findFirstOrThrow({ where: { citizenId: shared.citizenId } })).id,
        occupancyType: 'OWNER',
        propertyType: 'LAND',
        neighborhood: 'الحي',
        propertyNumber: 'PC-A3',
      },
      select: { id: true },
    });
    const onBuilding = await db.case.create({
      data: { notes: 'تحقق', propertyNumber: 'PC-A3', buildingId: wrong.id, status: 'RESOLVED' },
    });
    const onUnit = await db.case.create({ data: { notes: 'تحقق', propertyNumber: 'PC-A3', unitId: units[0]!.id } });
    const elsewhere = await db.case.create({ data: { notes: 'تحقق', propertyNumber: 'PC-A3' } });

    const preview = await within(() => correction.preview(wrong.id, 'PC-C3'));
    expect(preview.cards).toMatchObject({ toRewrite: 2, current: 1, underSharedParcel: 1, otherNumber: 0 });
    expect(preview.unlinkedOnOldParcel).toBe(1);
    expect(preview.cases).toBe(2);

    const result = await correct(wrong.id, 'PC-C3');
    expect(result).toMatchObject({ cardsCorrected: 2, casesCorrected: 2 });

    const number = async (id: string) =>
      (await db.propertyEntry.findUniqueOrThrow({ where: { id } })).propertyNumber;
    expect(await number(current.cardId)).toBe('PC-C3');
    expect(await number(ended.cardId)).toBe('PC-C3');
    expect(await number(shared.cardId)).toBe('PC-S3');
    expect(await number(loose.id)).toBe('PC-A3');
    // Not in the cadastre: no point, as a card saved with that number would have.
    expect((await db.propertyEntry.findUniqueOrThrow({ where: { id: current.cardId } })).latitude).toBeNull();

    const caseNumber = async (id: string) => (await db.case.findUniqueOrThrow({ where: { id } })).propertyNumber;
    expect(await caseNumber(onBuilding.id)).toBe('PC-C3');
    expect(await caseNumber(onUnit.id)).toBe('PC-C3');
    expect(await caseNumber(elsewhere.id)).toBe('PC-A3');
  });

  it('asks before correcting onto a parcel that already carries a structure', async () => {
    const { building: there } = await building('PC-D4');
    const { building: wrong } = await building('PC-A4');

    const preview = await within(() => correction.preview(wrong.id, 'PC-D4'));
    expect(preview.neighbours.map((row) => row.id)).toEqual([there.id]);
    expect(preview.next.codeSuffix).toBe('B');

    await expect(correct(wrong.id, 'PC-D4')).rejects.toMatchObject({ code: 'PARCEL_HAS_OTHER_BUILDINGS' });
    expect((await db.building.findUniqueOrThrow({ where: { id: wrong.id } })).parcelNumber).toBe('PC-A4');

    const result = await correct(wrong.id, 'PC-D4', { acknowledgedDuplicates: true });
    expect(result.building.codeSuffix).toBe('B');
  });

  it('takes its own old code back when a correction is corrected', async () => {
    const { building: wrong } = await building('PC-A5');
    const first = await correct(wrong.id, 'PC-E5');
    expect(first.building.code).not.toBe(wrong.code);

    const back = await correct(wrong.id, 'PC-A5');
    expect(back).toMatchObject({ reclaimedOwnCode: true });
    expect(back.building.code).toBe(wrong.code);
    // The code it holds again is live, not retired; the one it left is.
    const aliases = await db.buildingCodeAlias.findMany({ where: { buildingId: wrong.id } });
    expect(aliases.map((row) => [row.parcelNumber, row.codeSuffix])).toEqual([['PC-E5', 'A']]);
  });

  it('keeps the old parcel as a shared one when asked, and leaves the cards naming it', async () => {
    const { building: wrong, units } = await building('PC-A6');
    const holder = await card({ buildingId: wrong.id, propertyNumber: 'PC-A6', unitId: units[0]!.id });

    await correct(wrong.id, 'PC-F', { keepOldAsShared: true });

    const after = await db.building.findUniqueOrThrow({ where: { id: wrong.id } });
    expect(after.parcelNumber).toBe('PC-F');
    expect(after.sharedParcelNumbers).toEqual(['PC-A6']);
    expect((await db.propertyEntry.findUniqueOrThrow({ where: { id: holder.cardId } })).propertyNumber).toBe('PC-A6');
  });

  it('reports a pin outside the right parcel, and refuses a stale screen and the same number', async () => {
    const { building: wrong } = await building('PC-A7');

    const preview = await within(() => correction.preview(wrong.id, 'PC-F'));
    expect(preview.cadastre).toMatchObject({ known: true, pinInside: false });
    const unknown = await within(() => correction.preview(wrong.id, 'NOT-IN-CADASTRE'));
    expect(unknown.cadastre).toMatchObject({ known: false, pinInside: null });

    await expect(correct(wrong.id, 'PC-A7')).rejects.toMatchObject({ code: 'PARCEL_NUMBER_UNCHANGED' });
    await expect(
      correct(wrong.id, 'PC-F', { expectedUpdatedAt: new Date(Date.now() - 86_400_000).toISOString() }),
    ).rejects.toThrow(/بعد أن فتحتَه/);

    // PC-F already carries the building an earlier test corrected onto it: answered here.
    const result = await correct(wrong.id, 'PC-F', {
      expectedUpdatedAt: preview.building.updatedAt,
      acknowledgedDuplicates: true,
    });
    expect(result.pinInsideNewParcel).toBe(false);
  });

  it('writes one audit row with both sides and the reason, and one on each holder’s file', async () => {
    const { building: wrong, units } = await building('PC-A8');
    const holder = await card({ buildingId: wrong.id, propertyNumber: 'PC-A8', unitId: units[0]!.id });
    const seen: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const listen = (name: string) => (payload: Record<string, unknown>) => seen.push({ name, payload });
    const onBuilding = listen('building.changed');
    const onCitizen = listen('citizen.changed');
    events.on('building.changed', onBuilding);
    events.on('citizen.changed', onCitizen);
    try {
      await correct(wrong.id, 'PC-G8');
    } finally {
      events.off('building.changed', onBuilding);
      events.off('citizen.changed', onCitizen);
    }

    const row = seen.find((event) => event.payload.action === 'BUILDING_PARCEL_CORRECTED')!;
    expect(row.payload.before).toMatchObject({ parcelNumber: 'PC-A8', code: wrong.code });
    expect(row.payload.after).toMatchObject({
      parcelNumber: 'PC-G8',
      reason: 'رقم العقار في الصحيفة العقارية',
      cardsCorrected: [holder.cardId],
    });
    const citizenRow = seen.find((event) => event.payload.action === 'PROPERTY_NUMBER_CORRECTED')!;
    expect(citizenRow.payload).toMatchObject({ citizenId: holder.citizenId });
  });
});

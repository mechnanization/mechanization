import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { UnitCorrectionService } from './unit-correction.service';

/**
 * «دمج كدوبلكس» (decision D28) against a real tenant schema.
 *
 * The fixture is B-1-352-A as it stood on 2026-10-14 after the hand repair:
 * one owner-occupier, نافع, recorded in 0001 and in 0101 above it, both rows on
 * one «مبنى» card, 170 m² each — one home on two levels recorded as two flats.
 * Synthetic names. The merge must leave one unit on two levels with both
 * areas, the upper flat's line closed «سُجِّل بالخطأ», its visit moved down,
 * and two audit rows — or, refused, nothing at all.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_duplex_merge_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('«دمج كدوبلكس»', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let events: { emit: jest.Mock };
  let service: UnitCorrectionService;
  const officerId = randomUUID();
  const adminId = randomUUID();
  const admin = { id: adminId, role: 'SUPER_ADMIN' };

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-dm', tenantSlug: 'dm', schemaName: SCHEMA, prisma: db }, work);
  const refusal = (promise: Promise<unknown>) => promise.then(() => null, (caught: unknown) => caught);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    events = { emit: jest.fn() };
    service = new UnitCorrectionService(context, events as unknown as EventEmitter2, new PrismaAuditRepository(context));
    await db.user.createMany({
      data: [
        { id: officerId, kind: 'STAFF', tenantSlug: 'dm', firstName: 'علي', lastName: 'المراقب', role: 'FIELD_INSPECTOR' as never },
        { id: adminId, kind: 'STAFF', tenantSlug: 'dm', firstName: 'مدير', lastName: 'النظام', role: 'SUPER_ADMIN' as never },
      ],
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  beforeEach(() => events.emit.mockClear());

  /** B-1-352-A, fresh per test. `upperHolder` puts somebody else upstairs instead. */
  async function seed(options: { upperHolder?: 'SAME' | 'OTHER'; upperArea?: number | null } = {}) {
    const tag = randomUUID().slice(0, 8);
    const nafe = (await db.user.create({ data: { kind: 'CITIZEN', tenantSlug: 'dm', firstName: 'نافع', lastName: tag } })).id;
    const other = (await db.user.create({ data: { kind: 'CITIZEN', tenantSlug: 'dm', firstName: 'جار', lastName: tag } })).id;
    const building = await db.building.create({
      data: {
        parcelNumber: `352${tag}`,
        codeSuffix: 'A',
        code: `B-1-352-${tag}`,
        structureType: 'RESIDENTIAL_BUILDING' as never,
        floorsCount: 2,
        createdById: officerId,
      },
    });
    const flat = (unitCode: string, floor: number, unitArea: number | null) =>
      db.unit.create({
        data: {
          buildingId: building.id,
          unitCode,
          floor,
          sequence: 1,
          startCol: 1,
          endCol: 1,
          unitType: 'APARTMENT' as never,
          unitArea,
          unitStatus: 'OWNER_OCCUPIED' as never,
          surveyStatus: 'COMPLETE' as never,
        },
      });
    const lower = await flat('0001', 0, 170);
    const upper = await flat('0101', 1, options.upperArea === undefined ? 170 : options.upperArea);

    const registration = await db.registration.create({
      data: { citizenId: nafe, referenceNumber: `DM-${randomUUID()}`, createdById: officerId },
    });
    const card = await db.propertyEntry.create({
      data: { registrationId: registration.id, occupancyType: 'OWNER' as never, propertyType: 'BUILDING' as never, buildingId: building.id },
    });
    const lowerLine = await db.buildingUnit.create({
      data: { propertyEntryId: card.id, unitId: lower.id, unitType: 'APARTMENT' as never, floor: '0', unitArea: 170, unitStatus: 'OWNER_OCCUPIED' as never },
    });
    const upperHolder = options.upperHolder === 'OTHER' ? other : nafe;
    let upperLine: { id: string } | null = null;
    if (upperHolder === nafe) {
      upperLine = await db.buildingUnit.create({
        data: { propertyEntryId: card.id, unitId: upper.id, unitType: 'APARTMENT' as never, floor: '1', unitArea: 170, unitStatus: 'OWNER_OCCUPIED' as never },
      });
    }
    await db.unitOccupancy.createMany({
      data: [
        { unitId: lower.id, citizenId: nafe, role: 'OWNER' as never, registrationId: registration.id },
        { unitId: upper.id, citizenId: upperHolder, role: 'OWNER' as never, registrationId: upperHolder === nafe ? registration.id : null },
      ],
    });
    const visit = await db.unitVisit.create({
      data: { unitId: upper.id, officerId, outcome: 'COMPLETE' as never },
    });
    return { building, lower, upper, card, lowerLine, upperLine, visit, nafe };
  }

  it('folds 0101 into 0001: one home on two levels, both areas, the upper line recorded in error', async () => {
    const { building, lower, upper, card, lowerLine, upperLine, visit, nafe } = await seed();

    const preview = await within(() => service.previewMerge(lower.id));
    expect(preview).toMatchObject({
      lower: { unitCode: '0001', levels: 1 },
      upper: { unitCode: '0101' },
      blockers: [],
      levelsAfter: 2,
      areaAfter: '340.00',
      visitsMoved: 1,
      occupanciesRemoved: 1,
    });

    const result = await within(() =>
      service.applyMerge(lower.id, { fingerprint: preview.fingerprint, reason: 'دوبلكس سُجِّل شقتين بالخطأ', confirmCode: '0101' }, admin),
    );
    expect(result).toMatchObject({ unitCode: '0001', removedUnitCode: '0101', levels: 2, unitArea: '340.00', linesEnded: 1 });

    const home = await db.unit.findUniqueOrThrow({ where: { id: lower.id } });
    expect(home.levels).toBe(2);
    expect(home.unitArea?.toFixed(2)).toBe('340.00');
    expect(await db.unit.count({ where: { id: upper.id } })).toBe(0);

    // The card goes on, its line on the home widened; the upper line kept as history.
    expect((await db.propertyEntry.findUniqueOrThrow({ where: { id: card.id } })).endedAt).toBeNull();
    expect((await db.buildingUnit.findUniqueOrThrow({ where: { id: lowerLine.id } })).unitArea?.toFixed(2)).toBe('340.00');
    expect(await db.buildingUnit.findUniqueOrThrow({ where: { id: upperLine!.id } })).toMatchObject({
      unitId: null,
      endReason: 'RECORDED_IN_ERROR',
    });

    // The attempt made upstairs is the home's now; نافع is still in his home.
    expect((await db.unitVisit.findUniqueOrThrow({ where: { id: visit.id } })).unitId).toBe(lower.id);
    expect(await db.unitOccupancy.count({ where: { unitId: lower.id, citizenId: nafe, toDate: null } })).toBe(1);

    // One unit fewer in the building's counters, and a trail on the building and the file.
    expect((await db.building.findUniqueOrThrow({ where: { id: building.id } })).unitsTotal).toBe(1);
    const trail = await db.auditLogEntry.findMany({ where: { action: 'UNITS_MERGED_AS_DUPLEX', entityId: { in: [building.id, nafe] } } });
    expect(trail.map((row) => row.entityType).sort()).toEqual(['Building', 'User']);
  });

  it('refuses when somebody else is recorded upstairs — that is another household', async () => {
    const { lower, upper } = await seed({ upperHolder: 'OTHER' });
    const preview = await within(() => service.previewMerge(lower.id));
    expect(preview.blockers.map((blocker) => blocker.kind)).toEqual(['OTHER_HOUSEHOLD']);

    const caught = await refusal(
      within(() => service.applyMerge(lower.id, { fingerprint: preview.fingerprint, reason: 'محاولة دمج خاطئة', confirmCode: '0101' }, admin)),
    );
    expect(caught).toMatchObject({ code: 'DUPLEX_MERGE_BLOCKED' });
    expect(await db.unit.count({ where: { id: upper.id } })).toBe(1);
  });

  it('asks for the whole area when a flat has none, and takes it when given', async () => {
    const { lower } = await seed({ upperArea: null });
    const preview = await within(() => service.previewMerge(lower.id));
    expect(preview.blockers.map((blocker) => blocker.kind)).toEqual(['AREA_UNKNOWN']);

    const result = await within(() =>
      service.applyMerge(
        lower.id,
        { fingerprint: preview.fingerprint, reason: 'المساحة الكاملة مقيسة', confirmCode: '0101', totalArea: 310 },
        admin,
      ),
    );
    expect(result.unitArea).toBe('310.00');
  });

  it('changes nothing on a stale preview or a wrong code', async () => {
    const { lower, upper } = await seed();
    const preview = await within(() => service.previewMerge(lower.id));

    expect(
      await refusal(within(() => service.applyMerge(lower.id, { fingerprint: preview.fingerprint, reason: 'رمز خاطئ للتجربة', confirmCode: '0001' }, admin))),
    ).toMatchObject({ code: 'UNIT_CONFIRM_CODE_MISMATCH' });

    await db.unit.update({ where: { id: lower.id }, data: { unitArea: 180 } });
    expect(
      await refusal(within(() => service.applyMerge(lower.id, { fingerprint: preview.fingerprint, reason: 'معاينة قديمة للتجربة', confirmCode: '0101' }, admin))),
    ).toMatchObject({ code: 'UNIT_CORRECTION_PREVIEW_STALE' });
    expect(await db.unit.count({ where: { id: upper.id } })).toBe(1);
    expect((await db.unit.findUniqueOrThrow({ where: { id: lower.id } })).levels).toBe(1);
  });

  it('finds no pair when nothing stands above in the same columns', async () => {
    const { upper } = await seed();
    expect(await refusal(within(() => service.previewMerge(upper.id)))).toMatchObject({ code: 'DUPLEX_MERGE_NO_UPPER' });
  });
});

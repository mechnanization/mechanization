import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import type { AuditLogEntry } from '../../../domain/entities/audit-log-entry.entity';
import { ConflictError, ValidationError } from '../../../domain/errors/domain-error';
import { UnitCorrectionService } from './unit-correction.service';

/**
 * «حذف تصحيحي» against a real tenant schema: every migration applied, the units
 * trigger, the cascades and the append-only audit table all live.
 *
 * The fixture is building A2-424-A as production held it on 2026-09-28, with
 * synthetic people: an owner of 0001 and B101, a free occupant of B101 linked
 * to that owner, and an owner whose card holds B102 beside 0101.
 *
 * What this proves beyond the plan's unit tests is the transaction: the
 * success path leaves exactly what the plan says, and every failure — a stale
 * preview, a wrong code, a blocker, a failure halfway through the writes, a
 * record locked by somebody else — leaves the database exactly as it was.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_unit_correction_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('UnitCorrectionService', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let events: { emit: jest.Mock };
  let audit: PrismaAuditRepository;
  let service: UnitCorrectionService;
  const officerId = randomUUID();
  const adminId = randomUUID();
  const admin = { id: adminId, role: 'SUPER_ADMIN' };

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-uc', tenantSlug: 'uc', schemaName: SCHEMA, prisma: db }, work);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    events = { emit: jest.fn() };
    audit = new PrismaAuditRepository(context);
    service = new UnitCorrectionService(context, events as unknown as EventEmitter2, audit);

    await db.user.createMany({
      data: [
        { id: officerId, kind: 'STAFF', tenantSlug: 'uc', firstName: 'علي', lastName: 'المراقب', role: 'FIELD_INSPECTOR' as never },
        { id: adminId, kind: 'STAFF', tenantSlug: 'uc', firstName: 'مدير', lastName: 'النظام', role: 'SUPER_ADMIN' as never },
      ],
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  });

  beforeEach(() => events.emit.mockClear());

  /** A fresh copy of A2-424-A per test, so no test depends on another's leftovers. */
  async function seed() {
    const tag = randomUUID().slice(0, 8);
    const citizen = async (first: string) =>
      (
        await db.user.create({
          data: { kind: 'CITIZEN', tenantSlug: 'uc', firstName: first, middleName: 'تجربة', lastName: tag },
        })
      ).id;
    const owner = await citizen('مالك');
    const occupant = await citizen('شاغل');
    const other = await citizen('آخر');

    const building = await db.building.create({
      data: {
        parcelNumber: `424${tag}`,
        codeSuffix: 'A',
        code: `A2-424-${tag}`,
        structureType: 'MIXED_USE' as never,
        floorsCount: 4,
        basementsCount: 1,
        createdById: officerId,
      },
    });
    const unit = (unitCode: string, floor: number, sequence: number, unitType: string, surveyStatus = 'COMPLETE') =>
      db.unit.create({
        data: { buildingId: building.id, unitCode, floor, sequence, unitType: unitType as never, surveyStatus: surveyStatus as never },
      });
    const u0001 = await unit('0001', 0, 1, 'SHOP');
    const b101 = await unit('B101', -1, 1, 'WAREHOUSE');
    const b102 = await unit('B102', -1, 2, 'GARAGE');
    const u0101 = await unit('0101', 1, 1, 'APARTMENT');
    await unit('0005', 0, 5, 'SHOP', 'NOT_SURVEYED');

    const registration = (citizenId: string) =>
      db.registration.create({ data: { citizenId, referenceNumber: `UC-${randomUUID()}`, createdById: officerId } });
    const ownerReg = await registration(owner);
    const occupantReg = await registration(occupant);
    const otherReg = await registration(other);

    const ownerCard = await db.propertyEntry.create({
      data: { registrationId: ownerReg.id, occupancyType: 'OWNER' as never, propertyType: 'BUILDING' as never, buildingId: building.id },
    });
    const ownerLine0001 = await db.buildingUnit.create({
      data: { propertyEntryId: ownerCard.id, unitId: u0001.id, unitType: 'SHOP' as never, unitArea: 90 },
    });
    const ownerLineB101 = await db.buildingUnit.create({
      data: { propertyEntryId: ownerCard.id, unitId: b101.id, unitType: 'WAREHOUSE' as never },
    });

    const occupantOwnerOccupancy = randomUUID();
    const occupantCard = await db.propertyEntry.create({
      data: {
        registrationId: occupantReg.id,
        occupancyType: 'FREE_OCCUPANT' as never,
        propertyType: 'BUILDING' as never,
        buildingId: building.id,
        landlordCitizenId: owner,
        landlordName: 'مالك',
        landlordPhone: '+96170000000',
        landlordLinkFootprint: {
          v: 1,
          units: [
            {
              unitId: b101.id,
              unitCode: 'B101',
              occupancyId: occupantOwnerOccupancy,
              row: { propertyEntryId: ownerCard.id, snapshot: { unitType: 'WAREHOUSE' } },
              cases: [],
            },
          ],
          ownerId: owner,
          mintedCardIds: [],
        },
      },
    });
    const occupantLine = await db.buildingUnit.create({
      data: { propertyEntryId: occupantCard.id, unitId: b101.id, unitType: 'WAREHOUSE' as never, unitArea: 30 },
    });

    const otherCard = await db.propertyEntry.create({
      data: { registrationId: otherReg.id, occupancyType: 'OWNER' as never, propertyType: 'BUILDING' as never, buildingId: building.id },
    });
    const otherLine0101 = await db.buildingUnit.create({
      data: { propertyEntryId: otherCard.id, unitId: u0101.id, unitType: 'APARTMENT' as never, unitArea: 150 },
    });
    const otherLineB102 = await db.buildingUnit.create({
      data: { propertyEntryId: otherCard.id, unitId: b102.id, unitType: 'GARAGE' as never, unitArea: 40 },
    });

    await db.unitOccupancy.createMany({
      data: [
        { unitId: u0001.id, citizenId: owner, role: 'OWNER' as never },
        { unitId: b101.id, citizenId: occupant, role: 'FREE_OCCUPANT' as never, registrationId: occupantReg.id },
        { id: occupantOwnerOccupancy, unitId: b101.id, citizenId: owner, role: 'OWNER' as never },
        { unitId: b102.id, citizenId: other, role: 'OWNER' as never, registrationId: otherReg.id },
        { unitId: u0101.id, citizenId: other, role: 'OWNER' as never },
      ],
    });
    await db.unitVisit.createMany({
      data: [
        { unitId: b101.id, officerId, outcome: 'COMPLETE' as never },
        { unitId: b102.id, officerId, outcome: 'COMPLETE' as never },
      ],
    });

    return {
      building,
      units: { u0001, b101, b102, u0101 },
      citizens: { owner, occupant, other },
      cards: { ownerCard, occupantCard, otherCard },
      lines: { ownerLine0001, ownerLineB101, occupantLine, otherLine0101, otherLineB102 },
      registrations: { ownerReg, occupantReg, otherReg },
    };
  }

  /** Every row the correction could touch, read back as a comparable picture. */
  async function picture(fixture: Awaited<ReturnType<typeof seed>>) {
    const [building, units, occupancies, visits, lines, cards, registrations, trail] = await Promise.all([
      db.building.findUnique({ where: { id: fixture.building.id }, select: { unitsTotal: true, unitsSurveyed: true } }),
      db.unit.findMany({ where: { buildingId: fixture.building.id }, orderBy: { unitCode: 'asc' } }),
      db.unitOccupancy.findMany({ where: { unit: { buildingId: fixture.building.id } }, orderBy: { id: 'asc' } }),
      db.unitVisit.findMany({ where: { unit: { buildingId: fixture.building.id } }, orderBy: { id: 'asc' } }),
      db.buildingUnit.findMany({
        where: { propertyEntryId: { in: Object.values(fixture.cards).map((card) => card.id) } },
        orderBy: { id: 'asc' },
      }),
      db.propertyEntry.findMany({
        where: { id: { in: Object.values(fixture.cards).map((card) => card.id) } },
        orderBy: { id: 'asc' },
      }),
      db.registration.findMany({
        where: { id: { in: Object.values(fixture.registrations).map((row) => row.id) } },
        orderBy: { id: 'asc' },
      }),
      db.auditLogEntry.count({ where: { action: { startsWith: 'UNIT_CORRECTION' } } }),
    ]);
    return JSON.parse(JSON.stringify({ building, units, occupancies, visits, lines, cards, registrations, trail }));
  }

  const input = (fingerprint: string, confirmCode = 'B101') => ({
    fingerprint,
    reason: 'مستودع رُسم في القبو بالخطأ، لا وجود له',
    confirmCode,
  });

  it('previews exactly what the delete of B101 would do', async () => {
    const fixture = await seed();
    const preview = await within(() => service.preview(fixture.units.b101.id));

    expect(preview.blockers).toEqual([]);
    expect(preview.removed.occupancies).toHaveLength(2);
    expect(preview.removed.visits).toHaveLength(1);
    expect(preview.counters).toEqual({ totalBefore: 5, totalAfter: 4, surveyedBefore: 4, surveyedAfter: 3 });
    expect(preview.pay).toEqual([{ officerId, officerName: 'علي المراقب', unitsLost: 1 }]);

    const byCitizen = Object.fromEntries(preview.files.map((file) => [file.citizenId, file]));
    expect(byCitizen[fixture.citizens.owner]!.cards[0]!.cardEnds).toBe(false);
    expect(byCitizen[fixture.citizens.occupant]!.cards[0]).toMatchObject({ cardEnds: true, landlordLink: 'CLEARED' });
  });

  it('deletes B101, ends every line naming it, and writes the trail in the same transaction', async () => {
    const fixture = await seed();
    const preview = await within(() => service.preview(fixture.units.b101.id));
    const result = await within(() => service.apply(fixture.units.b101.id, input(preview.fingerprint), admin));

    expect(result).toMatchObject({
      unitCode: 'B101',
      deleted: { occupancies: 2, visits: 1, vacancies: 0 },
      linesEnded: 2,
      linesReclassified: 0,
      cardsEnded: 1,
      landlordLinksChanged: 1,
      citizensAffected: 2,
      auditEntries: 3,
    });

    const after = await picture(fixture);
    expect(after.units.map((row: { unitCode: string }) => row.unitCode)).toEqual(['0001', '0005', '0101', 'B102']);
    expect(after.building).toEqual({ unitsTotal: 4, unitsSurveyed: 3 });

    const line = (id: string) => after.lines.find((row: { id: string }) => row.id === id);
    for (const id of [fixture.lines.ownerLineB101.id, fixture.lines.occupantLine.id]) {
      expect(line(id)).toMatchObject({ unitId: null, endReason: 'RECORDED_IN_ERROR' });
      expect(line(id).endedAt).not.toBeNull();
    }
    // Untouched: the owner's 0001, and the other owner's card entirely.
    expect(line(fixture.lines.ownerLine0001.id)).toMatchObject({ endedAt: null, endReason: null });
    expect(line(fixture.lines.otherLineB102.id)).toMatchObject({ endedAt: null, unitId: fixture.units.b102.id });

    const card = (id: string) => after.cards.find((row: { id: string }) => row.id === id);
    expect(card(fixture.cards.occupantCard.id)).toMatchObject({
      endReason: 'RECORDED_IN_ERROR',
      landlordCitizenId: null,
      landlordLinkFootprint: null,
      landlordName: 'مالك',
    });
    expect(card(fixture.cards.ownerCard.id)).toMatchObject({ endedAt: null, endReason: null });

    // The trail: one row on the building, one on each file, the admin as actor.
    const trail = await db.auditLogEntry.findMany({
      where: { action: { startsWith: 'UNIT_CORRECTION' }, createdAt: { gte: new Date(Date.now() - 60_000) } },
      orderBy: { entityType: 'asc' },
    });
    const mine = trail.filter(
      (row) => row.entityId === fixture.building.id || Object.values(fixture.citizens).includes(row.entityId ?? ''),
    );
    expect(mine.map((row) => [row.action, row.entityType, row.actorId, row.actorType])).toEqual([
      ['UNIT_CORRECTION_DELETED', 'Building', adminId, 'STAFF'],
      ['UNIT_CORRECTION_FILE_ENDED', 'User', adminId, 'STAFF'],
      ['UNIT_CORRECTION_FILE_ENDED', 'User', adminId, 'STAFF'],
    ]);
    const buildingRow = mine[0]!;
    const snapshot = (buildingRow.before as { snapshot: { occupancies: unknown[]; visits: unknown[]; cards: Array<{ landlordPhone: string }> } }).snapshot;
    expect(snapshot.occupancies).toHaveLength(2);
    expect(snapshot.visits).toHaveLength(1);
    // The snapshot keeps the link it cleared, and the audit redaction still holds.
    const occupantSnapshot = snapshot.cards.find((row) => (row as unknown as { id: string }).id === fixture.cards.occupantCard.id)!;
    expect(occupantSnapshot.landlordPhone).toBe('[redacted]');
    expect((buildingRow.after as { note: string }).note).toBe('مستودع رُسم في القبو بالخطأ، لا وجود له');

    // Caches are told after the commit, and told not to write a second trail row.
    expect(events.emit).toHaveBeenCalledWith(
      'building.changed',
      expect.objectContaining({ buildingId: fixture.building.id, alreadyAudited: true }),
    );
    expect(events.emit.mock.calls.filter(([name]) => name === 'citizen.changed')).toHaveLength(2);
  });

  it('refuses a stale preview and changes nothing', async () => {
    const fixture = await seed();
    const preview = await within(() => service.preview(fixture.units.b101.id));
    // An officer edits the occupant's line after the admin opened the preview.
    await db.buildingUnit.update({ where: { id: fixture.lines.occupantLine.id }, data: { unitArea: 31 } });
    const before = await picture(fixture);

    const attempt = within(() => service.apply(fixture.units.b101.id, input(preview.fingerprint), admin));
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toMatchObject({ details: { reason: 'PREVIEW_STALE' } });

    expect(await picture(fixture)).toEqual(before);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('refuses a mistyped unit code and changes nothing', async () => {
    const fixture = await seed();
    const preview = await within(() => service.preview(fixture.units.b101.id));
    const before = await picture(fixture);

    await expect(
      within(() => service.apply(fixture.units.b101.id, input(preview.fingerprint, 'B102'), admin)),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await picture(fixture)).toEqual(before);
  });

  it('refuses when a damage assessment would be erased', async () => {
    const fixture = await seed();
    await db.damageAssessment.create({
      // A unit's assessment names the unit alone (damage_assessments_target_check).
      data: {
        unitId: fixture.units.b102.id,
        level: 'SAFE_MINOR_DAMAGE' as never,
        source: 'FIELD_VISIT' as never,
      },
    });
    const preview = await within(() => service.preview(fixture.units.b102.id));
    expect(preview.blockers).toEqual([{ kind: 'DAMAGE_ASSESSMENT', count: 1 }]);
    const before = await picture(fixture);

    await expect(
      within(() => service.apply(fixture.units.b102.id, input(preview.fingerprint, 'B102'), admin)),
    ).rejects.toMatchObject({ details: { reason: 'BLOCKED' } });
    expect(await picture(fixture)).toEqual(before);
  });

  it('rolls everything back when the trail fails halfway — nothing is deleted without its audit row', async () => {
    const fixture = await seed();
    const preview = await within(() => service.preview(fixture.units.b101.id));
    const before = await picture(fixture);

    // The building row is written, then the first citizen's row fails.
    let calls = 0;
    const failing = {
      ...audit,
      append: async (entry: AuditLogEntry) => {
        calls += 1;
        if (calls === 2) throw new Error('simulated audit failure');
        return audit.append(entry);
      },
    } as unknown as PrismaAuditRepository;
    const fragile = new UnitCorrectionService(context, events as unknown as EventEmitter2, failing);

    await expect(
      within(() => fragile.apply(fixture.units.b101.id, input(preview.fingerprint), admin)),
    ).rejects.toThrow('simulated audit failure');

    // The unit, its occupancies and visit, every line and card, and the trail: exactly as before.
    expect(await picture(fixture)).toEqual(before);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('gives way to somebody editing the unit right now, and changes nothing', async () => {
    const fixture = await seed();
    const preview = await within(() => service.preview(fixture.units.b101.id));
    const before = await picture(fixture);

    const officer = new Client({ connectionString: TEST_DATABASE_URL });
    await officer.connect();
    try {
      await officer.query('BEGIN');
      await officer.query(`SELECT id FROM "${SCHEMA}".units WHERE id = $1 FOR UPDATE`, [fixture.units.b101.id]);

      await expect(
        within(() => service.apply(fixture.units.b101.id, input(preview.fingerprint), admin)),
      ).rejects.toMatchObject({ details: { reason: 'BUSY' } });
    } finally {
      await officer.query('ROLLBACK');
      await officer.end();
    }
    expect(await picture(fixture)).toEqual(before);
  });

  it('re-marks an ended line on the unit and keeps its date', async () => {
    const fixture = await seed();
    const endedAt = new Date('2026-09-20T10:00:00.000Z');
    await db.buildingUnit.update({
      where: { id: fixture.lines.otherLineB102.id },
      data: { endedAt, endReason: 'MOVED_OUT' as never },
    });
    const preview = await within(() => service.preview(fixture.units.b102.id));
    await within(() => service.apply(fixture.units.b102.id, input(preview.fingerprint, 'B102'), admin));

    const row = await db.buildingUnit.findUnique({ where: { id: fixture.lines.otherLineB102.id } });
    expect(row).toMatchObject({ unitId: null, endReason: 'RECORDED_IN_ERROR', endedAt });
    // The card still holds 0101, so it goes on.
    const card = await db.propertyEntry.findUnique({ where: { id: fixture.cards.otherCard.id } });
    expect(card).toMatchObject({ endedAt: null });
  });
});

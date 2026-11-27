import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  municipalToday,
  type CreateFeeNotice,
  type FeeMatrixBracket,
  type FeeNoticePreviewInput,
} from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { BuildingsService } from '../buildings/buildings.service';
import { FeeExemptionService } from '../buildings/fee-exemption.service';
import { DataQualityService } from '../quality/data-quality.service';
import { assessCitizen, FeesService } from './fees.service';
import { feeServices } from './fee-services.testing';
import type { FeeNoticesService } from './fee-notices.service';
import { UnitsService } from '../buildings/units.service';

/**
 * «قائمة الإعفاء من الرسوم» against a real tenant schema (migrations 0077 and
 * 0104; the user's decisions of 2026-11-16).
 *
 * The exemption belongs to a unit, never to a person: a citizen who holds three
 * flats, one exempt, is billed for two — under PER_UNIT, PER_AREA and
 * TIERED_AREA alike, and the preview says so before the issue does. A flat's
 * exemption lets off every co-owner. A lift needs its reason, closes the
 * period, and the next run bills the flat. An exemption that ran past its last
 * day is billed; one still running is not. The list searches and pages, names
 * the people on the units, and sees only its own municipality.
 *
 * Synthetic people only. Set `TEST_DATABASE_URL` to a throwaway Postgres 17.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_fee_whitelist_spec';
const OTHER_SCHEMA = 'tenant_fee_whitelist_other_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const FLATS_ONLY: FeeMatrixBracket[] = [
  { code: 'A', labelAr: 'شقة', unitTypes: ['APARTMENT'], levels: 1, minArea: 0, maxArea: null, amount: 5_000 },
];

describeIfDb('the fee whitelist', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let other: TenantPrismaClient;
  let context: TenantContextService;
  let fees: FeesService;
  let feeNotices: FeeNoticesService;
  let exemptions: FeeExemptionService;
  let buildings: BuildingsService;
  let unitsService: UnitsService;
  let quality: DataQualityService;
  const adminId = randomUUID();
  const admin = { id: adminId, role: 'SUPER_ADMIN' };

  const within = <T>(work: () => Promise<T>, schemaName = SCHEMA, prisma = db): Promise<T> =>
    context.run({ tenantId: schemaName, tenantSlug: 'fw', schemaName, prisma }, work);

  let parcel = 0;
  /** A building with `count` flats of 100 m², each `unitType`. */
  async function block(count: number, unitType = 'APARTMENT', prisma = db) {
    const tag = ++parcel;
    const building = await prisma.building.create({
      data: {
        parcelNumber: `5${tag}`,
        codeSuffix: 'A',
        code: `W-1-5${tag}-A`,
        structureType: 'RESIDENTIAL_BUILDING' as never,
        floorsCount: count,
        createdById: adminId,
      },
    });
    const units = [];
    for (let floor = 0; floor < count; floor++) {
      units.push(
        await prisma.unit.create({
          data: {
            buildingId: building.id,
            unitCode: `0${floor}01`,
            floor,
            sequence: 1,
            unitType: unitType as never,
            unitArea: 100,
            unitStatus: 'OWNER_OCCUPIED' as never,
            surveyStatus: 'COMPLETE' as never,
          },
        }),
      );
    }
    return { building, units };
  }

  /** A citizen who owns `unitIds` through one مبنى card on `buildingId`. */
  async function owner(firstName: string, buildingId: string, unitIds: string[], prisma = db) {
    const citizenId = randomUUID();
    await prisma.user.create({ data: { id: citizenId, kind: 'CITIZEN', tenantSlug: 'fw', firstName, lastName: 'المالك' } });
    const registration = await prisma.registration.create({
      data: { citizenId, referenceNumber: `FW-${randomUUID()}`, createdById: adminId },
    });
    const card = await prisma.propertyEntry.create({
      data: { registrationId: registration.id, occupancyType: 'OWNER' as never, propertyType: 'BUILDING' as never, buildingId },
    });
    for (const unitId of unitIds) {
      await prisma.buildingUnit.create({
        data: { propertyEntryId: card.id, unitId, unitType: 'APARTMENT' as never, unitArea: 100, unitStatus: 'OWNER_OCCUPIED' as never },
      });
      await prisma.unitOccupancy.create({ data: { unitId, citizenId, role: 'OWNER' as never, registrationId: registration.id } });
    }
    return citizenId;
  }

  const forOne = (citizenId: string, notice: Partial<FeeNoticePreviewInput>): FeeNoticePreviewInput =>
    ({
      title: `رسم ${randomUUID().slice(0, 8)}`,
      amount: 1_000,
      basis: 'PER_UNIT',
      bearer: 'OWNER',
      frequency: 'ONCE',
      targetType: 'INDIVIDUAL_CITIZEN',
      targetCitizenId: citizenId,
      dueDate: '2026-12-31',
      ...notice,
    }) as FeeNoticePreviewInput;

  /** Previews, then issues, the same notice; answers both, and the issued bill's amount. */
  async function previewThenIssue(notice: FeeNoticePreviewInput) {
    const preview = await within(() => feeNotices.previewNotice(notice));
    const issued = await within(() => feeNotices.issue({ ...notice, clientRequestId: randomUUID() } as CreateFeeNotice, admin));
    const bills = await db.citizenPayment.findMany({ where: { feeNoticeId: issued.noticeId }, select: { amount: true } });
    return { preview, billed: bills.reduce((sum, bill) => sum + Number(bill.amount), 0) };
  }

  /** What billing would charge `citizenId` today, read the way a run reads it. */
  async function billToday(citizenId: string) {
    return within(async () => {
      for await (const batch of fees.holdingsOf([citizenId], { exemptOn: municipalToday() })) {
        return assessCitizen(batch[0]!.entries, { amount: 1_000, basis: 'PER_UNIT', bearer: 'OWNER' });
      }
      throw new Error('no holdings');
    });
  }

  const yesterday = () => new Date(new Date(`${municipalToday()}T00:00:00.000Z`).getTime() - 86_400_000);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    for (const schema of [SCHEMA, OTHER_SCHEMA]) {
      await ddl.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await migrateTenantSchema(ddl, schema);
    }
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    other = tenantTestClient(TEST_DATABASE_URL!, OTHER_SCHEMA);
    context = new TenantContextService();
    const emitter = new EventEmitter2();
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    ({ fees, feeNotices } = feeServices(
      context,
      emitter,
      {} as never,
      { get: jest.fn().mockResolvedValue(null), set: jest.fn(), invalidatePrefix: jest.fn() } as never,
      {} as never,
      {} as never,
    ));
    exemptions = new FeeExemptionService(context, audit, emitter);
    buildings = new BuildingsService(context, emitter);
    unitsService = new UnitsService(context, emitter, buildings);
    quality = new DataQualityService(
      context,
      { proposals: jest.fn().mockResolvedValue({ total: 0, items: [] }) } as never,
      emitter,
      { get: jest.fn().mockResolvedValue(null), set: jest.fn(), invalidatePrefix: jest.fn() } as never,
      { getOrThrow: () => 0 } as never,
      fees,
    );
    for (const prisma of [db, other]) {
      await prisma.user.create({
        data: { id: adminId, kind: 'STAFF', tenantSlug: 'fw', email: `${adminId}@fw.gov.lb`, firstName: 'مدير', lastName: 'البلدية', role: 'SUPER_ADMIN' as never },
      });
    }
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await other?.$disconnect();
    for (const schema of [SCHEMA, OTHER_SCHEMA]) await ddl?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  describe('a citizen with three flats, one exempt', () => {
    let citizenId: string;
    let units: Array<{ id: string }>;

    beforeAll(async () => {
      const three = await block(3);
      units = three.units;
      citizenId = await owner('سليم', three.building.id, units.map((unit) => unit.id));
      await within(() =>
        exemptions.set(units[1]!.id, { reason: 'PUBLIC_FACILITY', decisionRef: '12/2026', note: 'مستوصف البلدية' }, admin),
      );
    }, SETUP_TIMEOUT_MS);

    it.each([
      ['PER_UNIT', { basis: 'PER_UNIT', amount: 1_000 }, 2_000],
      ['PER_AREA', { basis: 'PER_AREA', amount: 10 }, 2_000],
      ['TIERED_AREA', { basis: 'TIERED_AREA', amount: 0, matrixBrackets: FLATS_ONLY }, 10_000],
    ] as const)('is billed for two under %s, and the preview says so first', async (_basis, notice, expected) => {
      const { preview, billed } = await previewThenIssue(forOne(citizenId, notice as Partial<FeeNoticePreviewInput>));
      expect(billed).toBe(expected);
      expect(preview.expectedRevenue).toBe(expected);
      expect(preview.notCharged).toMatchObject({ feeExemptUnits: 1 });
    });

    it('still pays a FLAT category notice once while any of the three is billed, and not once all are exempt', async () => {
      const flat = forOne(citizenId, { basis: 'FLAT', amount: 7_000, targetType: 'BUILDING_CATEGORY', targetCategory: 'APARTMENT', targetCitizenId: undefined });
      const preview = await within(() => feeNotices.previewNotice(flat));
      const issued = await within(() => feeNotices.issue({ ...flat, clientRequestId: randomUUID() } as CreateFeeNotice, admin));
      const bill = await db.citizenPayment.findFirst({ where: { feeNoticeId: issued.noticeId, citizenId } });
      expect(Number(bill?.amount)).toBe(7_000);
      expect(preview.billedCitizens).toBe(issued.issued);
    });
  });

  it('lets off every co-owner of an exempt flat', async () => {
    const { building, units } = await block(1);
    const first = await owner('أمين', building.id, [units[0]!.id]);
    const second = await owner('أمينة', building.id, [units[0]!.id]);
    await within(() => exemptions.set(units[0]!.id, { reason: 'PLACE_OF_WORSHIP' }, admin));
    for (const citizenId of [first, second]) {
      expect(await billToday(citizenId)).toMatchObject({ kind: 'assessed', amount: 0, assessment: { exemptUnitCount: 1 } });
    }
  });

  it('lifts only with a reason, closes the period, and bills the flat on the next run', async () => {
    const { building, units } = await block(1);
    const citizenId = await owner('خليل', building.id, [units[0]!.id]);
    await within(() => exemptions.set(units[0]!.id, { reason: 'OTHER', note: 'قاعة اجتماعات' }, admin));
    expect(await billToday(citizenId)).toMatchObject({ amount: 0 });

    await expect(within(() => exemptions.set(units[0]!.id, { reason: null }, admin))).rejects.toMatchObject({
      code: 'FEE_EXEMPTION_LIFT_REASON_REQUIRED',
    });

    const view = await within(() => exemptions.set(units[0]!.id, { reason: null, liftReason: 'انتهى استعمالها العام' }, admin));
    expect(view.current).toBeNull();
    expect(view.history).toEqual([
      expect.objectContaining({ reason: 'OTHER', liftReason: 'انتهى استعمالها العام', liftedBy: expect.objectContaining({ id: adminId }) }),
    ]);
    const unit = await db.unit.findUniqueOrThrow({ where: { id: units[0]!.id } });
    expect([unit.feeExemption, unit.feeExemptionNote, unit.feeExemptionValidUntil]).toEqual([null, null, null]);
    expect(await billToday(citizenId)).toMatchObject({ amount: 1_000 });

    // A second grant opens a second period; the first stays as history.
    await within(() => exemptions.set(units[0]!.id, { reason: 'PUBLIC_FACILITY' }, admin));
    expect(await db.unitFeeExemption.count({ where: { unitId: units[0]!.id } })).toBe(2);
  });

  it('writes the decision number, the last day and the lift reason into the audit row — never the note', async () => {
    const { building, units } = await block(1);
    const today = municipalToday();
    await within(() =>
      exemptions.set(units[0]!.id, { reason: 'OTHER', note: 'ملاحظة لا تُسجَّل', decisionRef: '7/2026', validUntil: today }, admin),
    );
    await within(() => exemptions.set(units[0]!.id, { reason: null, liftReason: 'قرار جديد' }, admin));
    const rows = await db.auditLogEntry.findMany({ where: { entityId: building.id }, orderBy: { createdAt: 'asc' } });
    const [granted, lifted] = rows.map((row) => ({ action: row.action, after: row.after as Record<string, unknown>, before: row.before as Record<string, unknown> }));
    expect(granted).toMatchObject({ action: 'UNIT_FEE_EXEMPTION_SET', after: { decisionRef: '7/2026', validUntil: today } });
    expect(lifted).toMatchObject({ action: 'UNIT_FEE_EXEMPTION_LIFTED', after: { liftReason: 'قرار جديد' } });
    expect(JSON.stringify(rows)).not.toContain('ملاحظة لا تُسجَّل');
  });

  describe('the last day', () => {
    it('refuses a last day already gone', async () => {
      const { units } = await block(1);
      const gone = yesterday().toISOString().slice(0, 10);
      await expect(
        within(() => exemptions.set(units[0]!.id, { reason: 'PUBLIC_FACILITY', validUntil: gone }, admin)),
      ).rejects.toMatchObject({ code: 'FEE_EXEMPTION_VALID_UNTIL_PAST' });
    });

    it('keeps a running exemption off the bill, bills an ended one, and lists the ended one for «ملاحظات الجودة»', async () => {
      const { building, units } = await block(2);
      const citizenId = await owner('رامي', building.id, units.map((unit) => unit.id));
      await within(() => exemptions.set(units[0]!.id, { reason: 'PUBLIC_FACILITY', validUntil: municipalToday() }, admin));
      await within(() => exemptions.set(units[1]!.id, { reason: 'PUBLIC_FACILITY', validUntil: municipalToday() }, admin));
      expect(await billToday(citizenId)).toMatchObject({ amount: 0, assessment: { exemptUnitCount: 2 } });

      // Time passes for the second: its last day was yesterday.
      await db.unit.update({ where: { id: units[1]!.id }, data: { feeExemptionValidUntil: yesterday() } });
      await db.unitFeeExemption.updateMany({ where: { unitId: units[1]!.id, liftedAt: null }, data: { validUntil: yesterday() } });

      expect(await billToday(citizenId)).toMatchObject({ amount: 1_000, assessment: { exemptUnitCount: 1 } });
      const preview = await within(() => feeNotices.previewNotice(forOne(citizenId, {})));
      expect(preview).toMatchObject({ expectedRevenue: 1_000, notCharged: { feeExemptUnits: 1 } });

      const findings = (await within(() => quality.findings())).items.filter((finding) => finding.kind === 'FEE_EXEMPTION_ENDED');
      expect(findings.map((finding) => finding.subjectKey)).toEqual([units[1]!.id]);

      const listed = await within(() => exemptions.list({ q: building.code, status: 'OPEN', page: 1, pageSize: 10 }, admin));
      expect(listed.items.map((item) => [item.unitId, item.ended])).toEqual(
        expect.arrayContaining([
          [units[0]!.id, false],
          [units[1]!.id, true],
        ]),
      );
    });
  });

  describe('the list', () => {
    let building: { id: string; code: string; parcelNumber: string };
    let units: Array<{ id: string; unitCode: string }>;

    beforeAll(async () => {
      ({ building, units } = await block(3));
      await owner('ناديا', building.id, [units[0]!.id]);
      await owner('فؤاد', building.id, [units[1]!.id]);
      for (const unit of units) await within(() => exemptions.set(unit.id, { reason: 'PLACE_OF_WORSHIP' }, admin));
      await within(() => exemptions.set(units[2]!.id, { reason: null, liftReason: 'سجّل بالخطأ' }, admin));
    }, SETUP_TIMEOUT_MS);

    const list = (q: string, extra: object = {}) =>
      within(() => exemptions.list({ q, status: 'OPEN', page: 1, pageSize: 25, ...extra }, admin));

    it('finds a unit by its full reference, its building, its parcel and the name of who holds it', async () => {
      expect((await list(`${building.code}-${units[0]!.unitCode}`)).items.map((item) => item.unitId)).toEqual([units[0]!.id]);
      expect((await list(building.code)).total).toBe(2);
      expect((await list(building.parcelNumber)).items.every((item) => item.building.id === building.id)).toBe(true);
      const byName = await list('ناديا');
      expect(byName.items.map((item) => item.unitId)).toEqual([units[0]!.id]);
      expect(byName.items[0]!.holders).toEqual([expect.objectContaining({ name: expect.stringContaining('ناديا'), role: 'OWNER' })]);
    });

    it('pages, and shows the lifted periods apart', async () => {
      const first = await list(building.code, { pageSize: 1 });
      const second = await list(building.code, { pageSize: 1, page: 2 });
      expect([first.total, first.items.length, second.items.length]).toEqual([2, 1, 1]);
      expect(first.items[0]!.unitId).not.toBe(second.items[0]!.unitId);
      const lifted = await list(building.code, { status: 'LIFTED' });
      expect(lifted.items.map((item) => [item.unitId, item.period.liftReason])).toEqual([[units[2]!.id, 'سجّل بالخطأ']]);
    });

    it('sees only its own municipality', async () => {
      const elsewhere = await block(1, 'APARTMENT', other);
      await within(() => exemptions.set(elsewhere.units[0]!.id, { reason: 'PLACE_OF_WORSHIP' }, admin), OTHER_SCHEMA, other);
      const here = await list('');
      expect(here.items.some((item) => item.unitId === elsewhere.units[0]!.id)).toBe(false);
      const there = await within(() => exemptions.list({ status: 'OPEN', page: 1, pageSize: 25 }, admin), OTHER_SCHEMA, other);
      expect(there.items.map((item) => item.unitId)).toEqual([elsewhere.units[0]!.id]);
    });
  });

  it('lists every unit a person holds, structural floors left out, with each one\'s exemption', async () => {
    const { building, units } = await block(2);
    const pilotis = await db.unit.create({
      data: { buildingId: building.id, unitCode: '0901', floor: 9, sequence: 1, unitType: 'PILOTIS' as never },
    });
    const citizenId = await owner('هالة', building.id, units.map((unit) => unit.id));
    await db.unitOccupancy.create({ data: { unitId: pilotis.id, citizenId, role: 'OWNER' as never } });
    await within(() => exemptions.set(units[0]!.id, { reason: 'PUBLIC_FACILITY' }, admin));

    const held = await within(() => exemptions.citizenUnits(citizenId));
    expect(held.units.map((unit) => [unit.unitId, unit.exemptToday, unit.role])).toEqual([
      [units[0]!.id, true, 'OWNER'],
      [units[1]!.id, false, 'OWNER'],
    ]);
    const found = await within(() => exemptions.unitByReference(`${building.code.toLowerCase()}-${units[1]!.unitCode}`));
    expect(found.unitId).toBe(units[1]!.id);
  });

  it('refuses to delete a unit or a building that has an exemption history, with a code', async () => {
    const { building, units } = await block(1);
    await within(() => exemptions.set(units[0]!.id, { reason: 'PUBLIC_FACILITY' }, admin));
    await within(() => exemptions.set(units[0]!.id, { reason: null, liftReason: 'رُفع' }, admin));
    await expect(within(() => unitsService.deleteUnit(units[0]!.id, admin))).rejects.toMatchObject({
      code: 'UNIT_HAS_FEE_EXEMPTION_HISTORY',
    });
    await expect(within(() => buildings.remove(building.id, admin))).rejects.toMatchObject({
      code: 'UNIT_HAS_FEE_EXEMPTION_HISTORY',
    });
  });

  it('closes a period the build before 0104 left open, and opens one it never wrote', async () => {
    const { units } = await block(2);
    // A grant through the unit's columns alone, then a lift the same way.
    await db.unit.update({ where: { id: units[0]!.id }, data: { feeExemption: 'PLACE_OF_WORSHIP' as never, feeExemptedAt: new Date() } });
    await within(() => exemptions.set(units[0]!.id, { reason: 'PLACE_OF_WORSHIP', decisionRef: '3/2026' }, admin));
    expect(await db.unitFeeExemption.findMany({ where: { unitId: units[0]!.id } })).toEqual([
      expect.objectContaining({ reason: 'PLACE_OF_WORSHIP', decisionRef: '3/2026', liftedAt: null }),
    ]);

    await within(() => exemptions.set(units[1]!.id, { reason: 'PUBLIC_FACILITY' }, admin));
    await db.unit.update({ where: { id: units[1]!.id }, data: { feeExemption: null, feeExemptedAt: null, feeExemptedById: null } });
    await within(() => exemptions.set(units[1]!.id, { reason: 'OTHER', note: 'مدرسة' }, admin));
    const periods = await db.unitFeeExemption.findMany({ where: { unitId: units[1]!.id }, orderBy: { grantedAt: 'asc' } });
    expect(periods.map((period) => [period.reason, period.liftedAt === null])).toEqual([
      ['PUBLIC_FACILITY', false],
      ['OTHER', true],
    ]);
  });
});

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaCaseRepository } from '../../../infrastructure/repositories/case.repository';
import { PrismaUserRepository } from '../../../infrastructure/repositories/user.repository';
import { CasesService } from '../cases/cases.service';
import { BuildingsService } from '../buildings/buildings.service';
import { CensusSyncService } from '../buildings/census-sync.service';
import { adminCreateCitizenSubmissionSchema } from '@mechanization/shared-schemas';
import { ConflictError } from '../../common/exceptions';
import { CitizenMergeService } from './citizen-merge.service';
import { CitizensService } from './citizens.service';

/**
 * «دمج ملفين» against a real Postgres — every table a person reaches.
 *
 * One man filed twice by two officers: the kept file (officer A) records flat
 * 1; the other (officer B, later) records flats 1 and 2, a plot, two bills —
 * one of them for the same notice and period as a bill on the kept file — a
 * case, and a tenant who named him as landlord. Each test is one fact that has
 * to hold across tables after the merge, after the next edit, and after the
 * undo.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_citizen_merge_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('CitizenMergeService', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let buildings: BuildingsService;
  let census: CensusSyncService;
  let merges: CitizenMergeService;
  let users: PrismaUserRepository;
  let adminId: string;

  const actor = () => ({ id: adminId, role: 'SUPER_ADMIN' });
  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-merge', tenantSlug: 'merge', schemaName: SCHEMA, prisma: db }, work);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const events = new EventEmitter2();
    const cases = new CasesService(
      new PrismaCaseRepository(context),
      { findById: async () => ({ id: adminId, kind: 'CITIZEN' }) } as never,
      events,
    );
    buildings = new BuildingsService(context, cases, events);
    census = new CensusSyncService(context, cases, events);
    merges = new CitizenMergeService(context, events);
    users = new PrismaUserRepository(context);

    adminId = await staff('مدير', 'SUPER_ADMIN');
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  // ─────────────────────────────  Fixtures  ─────────────────────────────

  async function staff(firstName: string, role: 'SUPER_ADMIN' | 'FIELD_INSPECTOR') {
    const id = randomUUID();
    await db.user.create({
      data: { id, kind: 'STAFF', tenantSlug: 'merge', email: `${id}@merge.gov.lb`, firstName, lastName: 'موظف', role },
    });
    return id;
  }

  const citizen = async (over: Record<string, unknown>) => {
    const id = randomUUID();
    await db.user.create({
      data: {
        id,
        kind: 'CITIZEN',
        tenantSlug: 'merge',
        firstName: 'حسين',
        middleName: 'علي',
        lastName: 'وطفى',
        referenceNumber: `BZR-2609-${randomUUID().slice(0, 6).toUpperCase()}`,
        ...over,
      },
    });
    return id;
  };

  const earnings = async (officerId: string) =>
    within(async () => (await users.listStaff()).find((row) => row.id === officerId)?.totalEarnings ?? 0);

  /** The one man, filed twice. */
  async function filedTwice() {
    const officerA = await staff('أ', 'FIELD_INSPECTOR');
    const officerB = await staff('ب', 'FIELD_INSPECTOR');
    const parcel = `M-${randomUUID().slice(0, 6)}`;

    const { building, units } = await within(async () => {
      const { building } = await buildings.create(
        { parcelNumber: parcel, structureType: 'RESIDENTIAL_BUILDING', lifecycleStatus: 'IN_USE', floorsCount: 1 },
        actor(),
      );
      const { units } = await buildings.generateUnits(
        building.id,
        { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 3, unitType: 'APARTMENT' },
        actor(),
      );
      return { building, units: [...units].sort((a, b) => a.sequence - b.sequence) };
    });
    const [u1, u2] = [units[0]!.id, units[1]!.id];

    const keepId = await citizen({ phone: '+96176000001', motherName: null });
    const absorbId = await citizen({ middleName: 'على', phone: '+96176000001', motherName: 'كاملة كنعان' });

    const keepReg = await db.registration.create({
      data: {
        citizenId: keepId,
        referenceNumber: `R-${randomUUID().slice(0, 10)}`,
        createdById: officerA,
        submittedAt: new Date('2026-09-01T09:00:00Z'),
        status: 'REQUIRES_REVIEW',
        flaggedFields: [{ path: 'personal.motherName', kind: 'UNESTABLISHED', reason: 'لم يُعرف' }],
      },
      select: { id: true },
    });
    const keepCard = await db.propertyEntry.create({
      data: {
        registrationId: keepReg.id,
        occupancyType: 'OWNER',
        propertyType: 'BUILDING',
        neighborhood: 'الحي',
        propertyNumber: parcel,
        buildingId: building.id,
        createdAt: new Date('2026-09-01T09:00:00Z'),
        units: { create: [{ unitType: 'APARTMENT', floor: '0', unitArea: 100, unitStatus: 'OWNER_OCCUPIED', unitId: u1 }] },
      },
      select: { id: true },
    });
    await within(() => census.syncRegistration({ registrationId: keepReg.id, citizenId: keepId, actor: actor() }));

    const absorbReg = await db.registration.create({
      data: {
        citizenId: absorbId,
        referenceNumber: `R-${randomUUID().slice(0, 10)}`,
        createdById: officerB,
        submittedAt: new Date('2026-09-20T09:00:00Z'),
      },
      select: { id: true },
    });
    const absorbCard = await db.propertyEntry.create({
      data: {
        registrationId: absorbReg.id,
        occupancyType: 'OWNER',
        propertyType: 'BUILDING',
        neighborhood: 'الحي',
        propertyNumber: parcel,
        buildingId: building.id,
        createdAt: new Date('2026-09-20T09:00:00Z'),
        units: {
          create: [
            { unitType: 'APARTMENT', floor: '0', unitArea: 100, unitStatus: 'OWNER_OCCUPIED', unitId: u1, createdAt: new Date('2026-09-20T09:00:00Z') },
            { unitType: 'APARTMENT', floor: '0', unitArea: 90, unitStatus: 'RENTED', unitId: u2, createdAt: new Date('2026-09-20T09:00:01Z') },
          ],
        },
      },
      select: { id: true, units: { orderBy: { createdAt: 'asc' }, select: { id: true, unitId: true } } },
    });
    const land = await db.propertyEntry.create({
      data: {
        registrationId: absorbReg.id,
        occupancyType: 'OWNER',
        propertyType: 'LAND',
        neighborhood: 'الحي',
        propertyNumber: '777',
        createdAt: new Date('2026-09-20T09:00:02Z'),
      },
      select: { id: true },
    });
    await within(() =>
      census.syncRegistration({ registrationId: absorbReg.id, citizenId: absorbId, actor: actor(), scope: 'REGISTRATION' }),
    );

    // Bills: one per file for the same notice and period, and one only the absorbed file carries.
    const notice = async (title: string) =>
      db.feeNotice.create({
        data: { title, amount: 1000, currency: 'LBP', frequency: 'ONCE', targetType: 'ALL_CITIZENS', dueDate: new Date('2026-12-31') },
        select: { id: true },
      });
    const shared = await notice(`رسم ${randomUUID().slice(0, 6)}`);
    const own = await notice(`رسم ${randomUUID().slice(0, 6)}`);
    const bill = (citizenId: string, feeNoticeId: string) =>
      db.citizenPayment.create({
        data: { citizenId, feeNoticeId, title: 'رسم', amount: 1000, currency: 'LBP', dueDate: new Date('2026-12-31'), periodKey: '2026' },
        select: { id: true },
      });
    const keepBill = await bill(keepId, shared.id);
    const twinBill = await bill(absorbId, shared.id);
    const ownBill = await bill(absorbId, own.id);

    // A tenant who named the absorbed file as landlord, through a link.
    const tenantId = await citizen({ firstName: 'مستأجر', middleName: null, lastName: 'تجربة' });
    const tenantReg = await db.registration.create({
      data: { citizenId: tenantId, referenceNumber: `R-${randomUUID().slice(0, 10)}` },
      select: { id: true },
    });
    const tenantCard = await db.propertyEntry.create({
      data: {
        registrationId: tenantReg.id,
        occupancyType: 'TENANT',
        propertyType: 'BUILDING',
        neighborhood: 'الحي',
        propertyNumber: parcel,
        buildingId: building.id,
        landlordCitizenId: absorbId,
        landlordLinkFootprint: { v: 1, ownerId: absorbId, linkedAt: new Date().toISOString(), actorId: adminId, units: [], mintedCardIds: [] },
        landlordLinkDismissedIds: [],
      },
      select: { id: true },
    });
    const dismissed = await db.propertyEntry.create({
      data: {
        registrationId: tenantReg.id,
        occupancyType: 'TENANT',
        propertyType: 'LAND',
        neighborhood: 'الحي',
        propertyNumber: '778',
        landlordLinkDismissedIds: [absorbId],
      },
      select: { id: true },
    });
    const kase = await db.case.create({
      data: { notes: 'حالة', status: 'RESOLVED', caseType: 'GENERAL_NOTE', resolvedCitizenId: absorbId },
      select: { id: true },
    });

    return {
      officerA,
      officerB,
      u1,
      u2,
      keepId,
      absorbId,
      keepReg: keepReg.id,
      absorbReg: absorbReg.id,
      keepCard: keepCard.id,
      absorbCard: absorbCard.id,
      absorbRows: absorbCard.units,
      land: land.id,
      keepBill: keepBill.id,
      twinBill: twinBill.id,
      ownBill: ownBill.id,
      tenantCard: tenantCard.id,
      dismissed: dismissed.id,
      kase: kase.id,
    };
  }

  const mergeIt = async (f: Awaited<ReturnType<typeof filedTwice>>) => {
    const preview = await within(() => merges.preview({ keepId: f.keepId, absorbId: f.absorbId }));
    const result = await within(() =>
      merges.merge({
        keepId: f.keepId,
        absorbId: f.absorbId,
        reason: 'الشخص نفسه — الاسم واسم الأم والهاتف والسجل متطابقة',
        expected: { keep: preview.keep.version, absorb: preview.absorb.version },
        tenantSlug: 'merge',
        actor: actor(),
      }),
    );
    return { preview, result };
  };

  // ─────────────────────────────  The merge  ─────────────────────────────

  it('previews what it will do, including the officer who loses a duplicate dollar', async () => {
    const f = await filedTwice();
    const preview = await within(() => merges.preview({ keepId: f.keepId, absorbId: f.absorbId }));

    expect(preview.blocks).toEqual([]);
    expect(preview.newestFiling).toMatchObject({ id: f.absorbReg, from: 'absorb' });
    expect(preview.cardsMoved.map((line) => line.cardId)).toEqual([f.keepCard]);
    expect(preview.duplicates).toHaveLength(1);
    expect(preview.pay).toEqual([expect.objectContaining({ officerId: f.officerB, delta: -1 })]);
    expect(preview.billsLeftBehind.map((bill) => bill.paymentId)).toEqual([f.twinBill]);
    expect(preview.fills).toEqual(expect.arrayContaining([{ field: 'motherName', value: 'كاملة كنعان' }]));
    expect(preview.counts).toMatchObject({ registrations: 1, bills: 1, cases: 1, tenantLinks: 1, spellsEnded: 1 });
  });

  it('moves everything onto one file, keeps each officer paid for their own work, and undoes exactly', async () => {
    const f = await filedTwice();
    const before = { a: await earnings(f.officerA), b: await earnings(f.officerB) };
    expect(before).toEqual({ a: 1, b: 2 });

    await mergeIt(f);

    // The person.
    const absorbed = await db.user.findUniqueOrThrow({ where: { id: f.absorbId } });
    const kept = await db.user.findUniqueOrThrow({ where: { id: f.keepId } });
    expect(absorbed.isActive).toBe(false);
    expect(kept.motherName).toBe('كاملة كنعان');
    expect(kept.middleName).toBe('علي');

    // The file: the newest filing, carrying every current card.
    expect((await db.registration.findUniqueOrThrow({ where: { id: f.absorbReg } })).citizenId).toBe(f.keepId);
    const moved = await db.propertyEntry.findUniqueOrThrow({ where: { id: f.keepCard } });
    expect(moved).toMatchObject({ registrationId: f.absorbReg, filedRegistrationId: f.keepReg });
    const current = await db.buildingUnit.findMany({
      where: { propertyEntry: { registrationId: f.absorbReg, endedAt: null }, endedAt: null },
      select: { unitId: true },
    });
    expect(current.map((row) => row.unitId).sort()).toEqual([f.u1, f.u2].sort());
    const duplicateRow = await db.buildingUnit.findUniqueOrThrow({ where: { id: f.absorbRows[0]!.id } });
    expect(duplicateRow.endReason).toBe('RECORDED_IN_ERROR');

    // The census: one current spell per flat, all his.
    const spells = await db.unitOccupancy.findMany({ where: { citizenId: f.keepId, toDate: null } });
    expect(spells.map((spell) => spell.unitId).sort()).toEqual([f.u1, f.u2].sort());
    expect(await db.unitOccupancy.count({ where: { citizenId: f.absorbId } })).toBe(0);

    // Money, a case, a tenant's link and their «ليس هذا المالك».
    expect((await db.citizenPayment.findUniqueOrThrow({ where: { id: f.ownBill } })).citizenId).toBe(f.keepId);
    expect((await db.citizenPayment.findUniqueOrThrow({ where: { id: f.twinBill } })).citizenId).toBe(f.absorbId);
    expect((await db.case.findUniqueOrThrow({ where: { id: f.kase } })).resolvedCitizenId).toBe(f.keepId);
    const link = await db.propertyEntry.findUniqueOrThrow({ where: { id: f.tenantCard } });
    expect(link.landlordCitizenId).toBe(f.keepId);
    expect((link.landlordLinkFootprint as { ownerId: string }).ownerId).toBe(f.keepId);
    expect((await db.propertyEntry.findUniqueOrThrow({ where: { id: f.dismissed } })).landlordLinkDismissedIds).toEqual([f.keepId]);

    // Pay: A keeps the card that moved; B loses only the duplicate copy.
    expect({ a: await earnings(f.officerA), b: await earnings(f.officerB) }).toEqual({ a: 1, b: 1 });

    // And back.
    const { into } = await within(() => merges.mergesOf(f.absorbId));
    expect(into).not.toBeNull();
    expect((await within(() => merges.unmergePreview(into!.id))).blocks).toEqual([]);
    await within(() =>
      merges.unmerge({ mergeId: into!.id, reason: 'دُمجا خطأً — أخوان', tenantSlug: 'merge', actor: actor() }),
    );

    expect((await db.user.findUniqueOrThrow({ where: { id: f.absorbId } })).isActive).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: f.keepId } })).motherName).toBeNull();
    expect((await db.registration.findUniqueOrThrow({ where: { id: f.absorbReg } })).citizenId).toBe(f.absorbId);
    expect(await db.propertyEntry.findUniqueOrThrow({ where: { id: f.keepCard } })).toMatchObject({
      registrationId: f.keepReg,
      filedRegistrationId: null,
    });
    expect((await db.buildingUnit.findUniqueOrThrow({ where: { id: f.absorbRows[0]!.id } })).endReason).toBeNull();
    expect(await db.unitOccupancy.count({ where: { citizenId: f.absorbId, toDate: null } })).toBe(2);
    expect((await db.citizenPayment.findUniqueOrThrow({ where: { id: f.ownBill } })).citizenId).toBe(f.absorbId);
    expect((await db.propertyEntry.findUniqueOrThrow({ where: { id: f.tenantCard } })).landlordCitizenId).toBe(f.absorbId);
    expect((await db.propertyEntry.findUniqueOrThrow({ where: { id: f.dismissed } })).landlordLinkDismissedIds).toEqual([f.absorbId]);
    expect((await db.registration.findUniqueOrThrow({ where: { id: f.keepReg } })).status).toBe('REQUIRES_REVIEW');
    expect({ a: await earnings(f.officerA), b: await earnings(f.officerB) }).toEqual(before);
  });

  it("survives the kept file's next edit: the census sync ends nothing it merged", async () => {
    const f = await filedTwice();
    await mergeIt(f);

    const sync = await within(() =>
      census.syncRegistration({ registrationId: f.absorbReg, citizenId: f.keepId, actor: actor() }),
    );
    expect(sync.occupanciesEnded).toBe(0);
    const spells = await db.unitOccupancy.findMany({ where: { citizenId: f.keepId, toDate: null } });
    expect(spells.map((spell) => spell.unitId).sort()).toEqual([f.u1, f.u2].sort());
  });

  it('refuses an undo once the file has changed since', async () => {
    const f = await filedTwice();
    await mergeIt(f);
    await db.propertyEntry.update({ where: { id: f.land }, data: { propertyNumber: '779' } });

    const { into } = await within(() => merges.mergesOf(f.absorbId));
    const { blocks } = await within(() => merges.unmergePreview(into!.id));
    expect(blocks.map((block) => block.code)).toEqual(['CHANGED_SINCE']);
    await expect(
      within(() => merges.unmerge({ mergeId: into!.id, reason: 'محاولة تراجع', tenantSlug: 'merge', actor: actor() })),
    ).rejects.toThrow();
  });

  it('refuses a merge whose preview has gone stale, and writes nothing', async () => {
    const f = await filedTwice();
    const preview = await within(() => merges.preview({ keepId: f.keepId, absorbId: f.absorbId }));
    await db.user.update({ where: { id: f.absorbId }, data: { phone: '+96176000099' } });

    await expect(
      within(() =>
        merges.merge({
          keepId: f.keepId,
          absorbId: f.absorbId,
          reason: 'الشخص نفسه — تحقق من السجل',
          expected: { keep: preview.keep.version, absorb: preview.absorb.version },
          tenantSlug: 'merge',
          actor: actor(),
        }),
      ),
    ).rejects.toThrow(/تغيّر أحد الملفين/);
    expect((await db.user.findUniqueOrThrow({ where: { id: f.absorbId } })).isActive).toBe(true);
    expect(await db.citizenMerge.count({ where: { absorbedId: f.absorbId } })).toBe(0);
  });

  // ─────────────────────────────  What the review found  ─────────────────────────────

  const undoOf = async (absorbedId: string) => {
    const { into } = await within(() => merges.mergesOf(absorbedId));
    return within(() => merges.unmerge({ mergeId: into!.id, reason: 'تراجع للاختبار', tenantSlug: 'merge', actor: actor() }));
  };

  it('undoes a chain of merges in reverse order', async () => {
    const f = await filedTwice();
    await mergeIt(f);
    // The kept file is itself folded into a third one.
    const thirdId = await citizen({ motherName: 'كاملة كنعان', phone: '+96176000077' });
    const preview = await within(() => merges.preview({ keepId: thirdId, absorbId: f.keepId }));
    await within(() =>
      merges.merge({
        keepId: thirdId,
        absorbId: f.keepId,
        reason: 'الشخص نفسه مرة ثالثة — للاختبار',
        expected: { keep: preview.keep.version, absorb: preview.absorb.version },
        tenantSlug: 'merge',
        actor: actor(),
      }),
    );

    // The first merge waits for the second to be undone…
    const { into } = await within(() => merges.mergesOf(f.absorbId));
    expect((await within(() => merges.unmergePreview(into!.id))).blocks.map((block) => block.code)).toEqual(['MERGED_AGAIN']);
    await undoOf(f.keepId);
    // …and then goes through, because an undo restores what it moved to the letter.
    expect((await within(() => merges.unmergePreview(into!.id))).blocks).toEqual([]);
    await undoOf(f.absorbId);
    expect((await db.registration.findUniqueOrThrow({ where: { id: f.absorbReg } })).citizenId).toBe(f.absorbId);
    expect((await db.user.findUniqueOrThrow({ where: { id: f.keepId } })).isActive).toBe(true);
  });

  it('undoes only its own change to a «ليس هذا المالك» list, keeping answers given since', async () => {
    const f = await filedTwice();
    await mergeIt(f);
    const someoneElse = await citizen({ firstName: 'آخر', middleName: null, lastName: 'تجربة' });
    await db.propertyEntry.update({
      where: { id: f.dismissed },
      data: { landlordLinkDismissedIds: [f.keepId, someoneElse] },
    });
    await undoOf(f.absorbId);
    const ids = (await db.propertyEntry.findUniqueOrThrow({ where: { id: f.dismissed } })).landlordLinkDismissedIds;
    expect(ids.sort()).toEqual([f.absorbId, someoneElse].sort());
  });

  it('keeps a «غير مؤكَّد» flag on the same flat when the rows were saved in one go', async () => {
    const f = await filedTwice();
    // Rows written by one nested create share `createdAt`: the form's order among them is the database's.
    const tied = await db.propertyEntry.create({
      data: {
        registrationId: f.absorbReg,
        occupancyType: 'OWNER',
        propertyType: 'BUILDING',
        neighborhood: 'الحي',
        propertyNumber: 'TIED',
        units: {
          create: [
            { unitType: 'APARTMENT', floor: '1', unitArea: 80, unitId: null },
            { unitType: 'APARTMENT', floor: '2', unitArea: 90, unitId: null },
          ],
        },
      },
      select: { id: true },
    });
    const formOrder = async (registrationId: string) =>
      (
        await db.registration.findUniqueOrThrow({
          where: { id: registrationId },
          select: {
            properties: {
              where: { endedAt: null },
              orderBy: { createdAt: 'asc' },
              select: { id: true, units: { where: { endedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } } },
            },
          },
        })
      ).properties;
    const before = await formOrder(f.absorbReg);
    const cardAt = before.findIndex((card) => card.id === tied.id);
    const target = before[cardAt]!.units[1]!.id;
    await db.registration.update({
      where: { id: f.absorbReg },
      data: { flaggedFields: [{ path: `properties.${cardAt}.units.1.unitArea`, kind: 'UNESTABLISHED', reason: 'لم تُقَس' }] },
    });

    await mergeIt(f);

    const after = await formOrder(f.absorbReg);
    const flags = (await db.registration.findUniqueOrThrow({ where: { id: f.absorbReg } })).flaggedFields as Array<{
      path: string;
    }>;
    const area = flags.find((flag) => flag.path.endsWith('.unitArea'))!;
    const [, card, unit] = /^properties\.(\d+)\.units\.(\d+)\./.exec(area.path)!;
    expect(after[Number(card)]!.units[Number(unit)]!.id).toBe(target);
  });

  it('refuses to write anything against a file folded away — the flat, reactivation, deletion', async () => {
    const f = await filedTwice();
    await mergeIt(f);
    const citizens = new CitizensService(
      context,
      {} as never,
      {} as never,
      {} as never,
      census,
      {} as never,
      new EventEmitter2(),
    );
    const refusal = (work: () => Promise<unknown>) => within(work).then(() => null, (caught: unknown) => caught);

    const occupancy = await refusal(() =>
      buildings.recordOccupancy({ unitId: f.u2, citizenId: f.absorbId, role: 'OWNER' } as never, actor()),
    );
    expect((occupancy as ConflictError).details).toMatchObject({ code: 'MERGED_AWAY', survivorId: f.keepId });

    const reactivate = await refusal(() =>
      citizens.setActive({ tenantSlug: 'merge', citizenId: f.absorbId, isActive: true, actor: actor() }),
    );
    expect((reactivate as ConflictError).details).toMatchObject({ code: 'MERGED_AWAY' });

    for (const citizenId of [f.absorbId, f.keepId]) {
      const removal = await refusal(() => citizens.remove({ tenantSlug: 'merge', citizenId, actor: actor() }));
      expect((removal as ConflictError).details).toMatchObject({ code: 'MERGED' });
    }
    expect((await db.user.findUniqueOrThrow({ where: { id: f.absorbId } })).isActive).toBe(false);
  });

  // ─────────────────────────────  Stopped, not asked  ─────────────────────────────

  describe('creating a file for somebody already on it', () => {
    const household = (over: Record<string, unknown> = {}) =>
      adminCreateCitizenSubmissionSchema.parse({
        residence: 'RESIDENT',
        personal: {
          firstName: 'حسين',
          middleName: 'على',
          lastName: 'وطفى',
          motherName: 'كاملة كنعان',
          gender: 'MALE',
          civilRecordNumber: '٤٠',
          nationality: 'لبناني',
          isLebanese: true,
          residentStatus: 'VILLAGE_RESIDENT',
          ...over,
        },
        contact: { maritalStatus: 'MARRIED', phone: '76 000 999', whatsappSameAsPhone: true, actualHouseholdMembers: '4' },
        properties: [],
        flags: [],
      });

    /** Both files of the pair under one family name no other test uses. */
    const isolate = async (f: Awaited<ReturnType<typeof filedTwice>>, lastName: string, mother: string) => {
      await db.user.update({ where: { id: f.keepId }, data: { lastName, motherName: mother, civilRecordNumber: '40' } });
      await db.user.update({ where: { id: f.absorbId }, data: { lastName } });
    };

    const service = (submit: jest.Mock) =>
      new CitizensService(
        context,
        { submit } as never,
        { resolve: async () => ({ allowsPropertyType: () => true, referencePrefix: 'MRG' }) } as never,
        { findManyByNumber: async () => new Map(), count: async () => 0 } as never,
        census,
        {} as never,
        new EventEmitter2(),
      );

    it('refuses an officer outright — from the form and from the offline queue alike — and writes nothing', async () => {
      const f = await filedTwice();
      await isolate(f, 'عساف', 'كاملة كنعان');
      const submit = jest.fn();
      const officer = { id: f.officerA, role: 'FIELD_INSPECTOR' };

      for (const reviewDuplicates of [true, false]) {
        const refusal = await within(() =>
          service(submit).create({
            tenantSlug: 'merge',
            payload: {
              ...household({ lastName: 'عساف' }),
              reviewDuplicates,
              // «شخص آخر» from an officer does not get past a certain match.
              duplicateReview: { differentFrom: [f.keepId], sharedPhoneWith: [], sharedPhoneWithLandlord: false, reason: 'شخص آخر حسب قوله' },
            } as never,
            actor: officer,
          }),
        ).catch((caught: unknown) => caught);
        expect(refusal).toBeInstanceOf(ConflictError);
        expect((refusal as ConflictError).details).toMatchObject({ code: 'DUPLICATE_BLOCKED' });
        expect((refusal as Error).message).toContain('هذا الشخص مسجَّل مسبقاً');
      }
      expect(submit).not.toHaveBeenCalled();
    });

    it('lets an administrator file past it, naming the record as a different person', async () => {
      const f = await filedTwice();
      await isolate(f, 'حمدان', 'سعاد حمدان');
      const submit = jest.fn().mockResolvedValue({ registrationId: 'r', citizenId: 'c', referenceNumber: 'x', propertyIds: [], deduplicated: true });
      await within(() =>
        service(submit).create({
          tenantSlug: 'merge',
          payload: {
            ...household({ lastName: 'حمدان', motherName: 'سعاد حمدان' }),
            reviewDuplicates: true,
            duplicateReview: { differentFrom: [f.keepId, f.absorbId], sharedPhoneWith: [], sharedPhoneWithLandlord: false, reason: 'توأم بالاسم نفسه — تحقّق المختار' },
          } as never,
          actor: { id: adminId, role: 'SUPER_ADMIN' },
        }),
      ).catch(() => undefined);
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('still only asks when the mother on file is a lone first name', async () => {
      const f = await filedTwice();
      await isolate(f, 'زين الدين', 'كاملة');
      const refusal = await within(() =>
        service(jest.fn()).create({
          tenantSlug: 'merge',
          payload: { ...household({ lastName: 'زين الدين' }), reviewDuplicates: true } as never,
          actor: { id: f.officerA, role: 'FIELD_INSPECTOR' },
        }),
      ).catch((caught: unknown) => caught);
      expect(refusal).toBeInstanceOf(ConflictError);
      expect((refusal as ConflictError).details).not.toMatchObject({ code: 'DUPLICATE_BLOCKED' });
      expect((refusal as ConflictError).details).toHaveProperty('duplicateReview');
    });
  });

  it('refuses to fold a file into one that is itself folded away, and a second merge of the same file', async () => {
    const f = await filedTwice();
    await mergeIt(f);
    const again = await within(() => merges.preview({ keepId: f.keepId, absorbId: f.absorbId }));
    expect(again.blocks.map((block) => block.code)).toEqual(expect.arrayContaining(['INACTIVE', 'ALREADY_MERGED']));
  });
});

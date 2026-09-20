import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaCaseRepository } from '../../../infrastructure/repositories/case.repository';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { ConflictError, ValidationError } from '../../../domain/errors/domain-error';
import { AuditService } from '../audit/audit.service';
import { CasesService } from '../cases/cases.service';
import { BuildingsService } from '../buildings/buildings.service';
import { LandlordLinkService } from '../citizens/landlord-link.service';
import { DataQualityService } from './data-quality.service';
import { RecordReviewService } from './record-review.service';

/**
 * «مراجعة الجودة» against a real Postgres: migration 0049, the review states,
 * the four-eyes rule, the re-check sample, the derived findings and the audit
 * rows as a screen reads them.
 *
 * Set `TEST_DATABASE_URL` to run it (a throwaway Postgres 17 — never staging).
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_quality_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('Quality review', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let events: EventEmitter2;
  let reviews: RecordReviewService;
  let quality: DataQualityService;
  let audit: AuditService;
  let buildings: BuildingsService;

  const staff: Record<'jawad' | 'hussein' | 'auditor' | 'collector', string> = {
    jawad: '',
    hussein: '',
    auditor: '',
    collector: '',
  };
  const ROLE_OF = { jawad: 'FIELD_INSPECTOR', hussein: 'FIELD_INSPECTOR', auditor: 'AUDITOR', collector: 'COLLECTOR' };
  const as = (who: keyof typeof staff, role: string = ROLE_OF[who]) => ({ id: staff[who], role });

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-quality', tenantSlug: 'quality', schemaName: SCHEMA, prisma: db }, work);

  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    events = new EventEmitter2();

    /*
      Always a miss, so every assertion below reads the register rather than
      whatever a previous case left behind. `DataQualityService` caches its
      eight scans in production; a test that shared them could not tell a
      finding that was fixed from one that was merely remembered.
    */
    const cache = {
      get: async () => null,
      set: async () => undefined,
      invalidatePrefix: async () => undefined,
    };
    audit = new AuditService(new PrismaAuditRepository(context), context, cache as never, { get: () => 0 } as never);
    events.on('building.changed', (payload) => audit.onBuildingChanged(payload));
    events.on('citizen.changed', (payload) => audit.onCitizenChanged(payload));
    events.on('quality.changed', (payload) => audit.onQualityChanged(payload));

    const cases = new CasesService(new PrismaCaseRepository(context), {} as never, events);
    buildings = new BuildingsService(context, cases, events);
    const links = new LandlordLinkService(context, buildings, events);
    reviews = new RecordReviewService(context, events, cache as never, { get: () => 0 } as never);
    quality = new DataQualityService(context, links, events, cache as never, { get: () => 0 } as never);
    events.on('citizen.changed', (payload) => reviews.onCitizenChanged(payload));

    for (const [key, first, role] of [
      ['jawad', 'جواد', 'FIELD_INSPECTOR'],
      ['hussein', 'حسين', 'FIELD_INSPECTOR'],
      ['auditor', 'مدقق', 'AUDITOR'],
      ['collector', 'جابي', 'COLLECTOR'],
    ] as const) {
      const id = randomUUID();
      staff[key] = id;
      await db.user.create({
        data: {
          id,
          kind: 'STAFF',
          tenantSlug: 'quality',
          email: `${key}-${id}@quality.gov.lb`,
          firstName: first,
          lastName: 'موظف',
          role,
        },
      });
    }
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  /** A citizen and one registration filed by `by`. */
  const filing = async (
    by: string,
    person: { firstName: string; middleName?: string; lastName: string; phone?: string; motherName?: string },
    submittedAt = new Date(),
  ) => {
    const citizenId = randomUUID();
    await db.user.create({
      data: { id: citizenId, kind: 'CITIZEN', tenantSlug: 'quality', ...person },
    });
    const registration = await db.registration.create({
      data: {
        citizenId,
        referenceNumber: `QLT-${randomUUID().slice(0, 8)}`,
        createdById: by,
        submittedAt,
      },
      select: { id: true },
    });
    return { citizenId, registrationId: registration.id };
  };

  // ─────────────────────────────  Reviews  ─────────────────────────────

  it('returns a record to its officer, closes the return on their save, and approves it', async () => {
    const { citizenId, registrationId } = await filing(staff.jawad, { firstName: 'ريم', lastName: 'مراجعة' });

    const queued = await within(() => reviews.queue({ states: ['NEW'], officerId: staff.jawad }));
    expect(queued.items.map((item) => item.registrationId)).toContain(registrationId);

    // The four-eyes rule: nobody reviews their own filing.
    await expect(within(() => reviews.approve(registrationId, as('jawad')))).rejects.toBeInstanceOf(ConflictError);

    await within(() =>
      reviews.returnToOfficer(registrationId, { reason: 'اسم الأم ناقص', fields: ['MOTHER_NAME'] }, as('auditor')),
    );
    await expect(
      within(() => reviews.returnToOfficer(registrationId, { reason: 'مرة ثانية', fields: ['OTHER'] }, as('auditor'))),
    ).rejects.toBeInstanceOf(ConflictError);

    const tasks = await within(() => reviews.tasksFor(as('jawad')));
    expect(tasks.returned).toEqual([
      expect.objectContaining({ citizenId, reason: 'اسم الأم ناقص', fields: ['MOTHER_NAME'], by: 'مدقق موظف' }),
    ]);
    expect((await within(() => reviews.openReturnFor(citizenId)))?.reason).toBe('اسم الأم ناقص');

    // The officer saves the record: the edit form's own event closes the return.
    await within(async () => {
      await db.registration.update({ where: { id: registrationId }, data: { notes: 'أُضيف اسم الأم' } });
      await reviews.onCitizenChanged({ citizenId, action: 'CITIZEN_UPDATED', actorId: staff.jawad });
    });
    const corrected = await within(() => reviews.queue({ states: ['CORRECTED'], officerId: staff.jawad }));
    expect(corrected.items.map((item) => item.registrationId)).toContain(registrationId);
    expect(await within(() => reviews.openReturnFor(citizenId))).toBeNull();

    await within(() => reviews.approve(registrationId, as('auditor')));
    const approved = await within(() => reviews.queue({ states: ['APPROVED'], officerId: staff.jawad }));
    const item = approved.items.find((row) => row.registrationId === registrationId);
    expect(item?.history.map((entry) => entry.outcome)).toEqual(['APPROVED', 'RETURNED']);
    expect(approved.counts.APPROVED).toBeGreaterThanOrEqual(1);

    // Edited after approval: back in front of the reviewer.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await db.registration.update({ where: { id: registrationId }, data: { notes: 'تعديل لاحق' } });
    const changed = await within(() => reviews.queue({ states: ['CHANGED'], officerId: staff.jawad }));
    expect(changed.items.map((row) => row.registrationId)).toContain(registrationId);

    await settle();
    const trail = await within(() => audit.query({ entityType: 'User', entityId: citizenId, limit: 20, offset: 0 }));
    expect(trail.items.map((row) => row.action)).toEqual(
      expect.arrayContaining(['RECORD_RETURNED', 'RECORD_CORRECTED', 'RECORD_APPROVED']),
    );
    const returned = trail.items.find((row) => row.action === 'RECORD_RETURNED')!;
    expect(returned.actor).toMatchObject({ kind: 'STAFF', name: 'مدقق موظف', role: 'AUDITOR' });
    expect(returned.target).toMatchObject({ type: 'User', label: 'ريم مراجعة', link: { kind: 'citizen', id: citizenId } });
  });

  // ─────────────────────────────  Sample  ─────────────────────────────

  it("draws a per-officer sample, never lets an officer check their own filing, and scores the result", async () => {
    const day = new Date('2026-08-10T10:00:00Z');
    for (let i = 0; i < 10; i += 1) {
      await filing(staff.jawad, { firstName: `عينة${i}`, lastName: 'جواد' }, day);
    }
    for (let i = 0; i < 3; i += 1) {
      await filing(staff.hussein, { firstName: `عينة${i}`, lastName: 'حسين' }, day);
    }

    const drawn = await within(() =>
      reviews.drawSample(
        { from: new Date('2026-08-10T00:00:00Z'), to: new Date('2026-08-10T00:00:00Z'), percent: 10 },
        as('auditor'),
      ),
    );
    expect(drawn.perOfficer).toEqual(
      expect.arrayContaining([
        { officerId: staff.jawad, filed: 10, sampled: 1, inSample: 1 },
        { officerId: staff.hussein, filed: 3, sampled: 1, inSample: 1 },
      ]),
    );
    // Drawn again over the same day, nothing new is sampled.
    const again = await within(() =>
      reviews.drawSample(
        { from: new Date('2026-08-10T00:00:00Z'), to: new Date('2026-08-10T00:00:00Z'), percent: 10 },
        as('auditor'),
      ),
    );
    expect(again.sampled).toBe(0);

    const jawadsCheck = (await within(() => reviews.listChecks({ status: 'OPEN', officerId: staff.jawad })))[0]!;
    await expect(
      within(() => reviews.complete(jawadsCheck.id, { result: 'MATCHES', differences: [] }, as('jawad'))),
    ).rejects.toBeInstanceOf(ConflictError);

    // Offered to Hussein, who did not file it.
    const offered = await within(() => reviews.tasksFor(as('hussein')));
    expect(offered.checks.map((check) => check.id)).toContain(jawadsCheck.id);

    await within(() =>
      reviews.complete(
        jawadsCheck.id,
        { result: 'DIFFERS', differences: ['PHONE'], notes: 'الرقم يخص المالك' },
        as('hussein'),
      ),
    );
    const scores = await within(() => quality.officerQuality({ officerId: staff.jawad }));
    expect(scores.officers[0]).toMatchObject({ checks: { done: 1, differs: 1, differsRate: 100 } });
  });

  /**
   * A collector's profile used to list unassigned re-checks with a form whose
   * submit the endpoint refused them, and a reviewer could name a collector
   * for a check they could then never record.
   */
  it('offers and hands re-checks only to roles that can record the result', async () => {
    const day = new Date('2026-07-01T10:00:00Z');
    const { citizenId } = await filing(staff.hussein, { firstName: 'تحقق', lastName: 'الأدوار' }, day);
    await within(() =>
      reviews.drawSample(
        { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-07-01T00:00:00Z'), percent: 50 },
        as('auditor'),
      ),
    );
    const check = (await within(() => reviews.listChecks({ status: 'OPEN', officerId: staff.hussein }))).find(
      (row) => row.citizen.id === citizenId,
    )!;

    expect((await within(() => reviews.tasksFor(as('collector')))).checks).toEqual([]);
    await expect(
      within(() => reviews.assign(check.id, { assignedToId: staff.collector }, as('auditor'))),
    ).rejects.toBeInstanceOf(ValidationError);

    await within(() => reviews.assign(check.id, { assignedToId: staff.jawad }, as('auditor')));
    const offered = await within(() => reviews.tasksFor(as('jawad')));
    expect(offered.checks.map((row) => row.id)).toContain(check.id);
  });

  // ─────────────────────────────  Findings  ─────────────────────────────

  /**
   * «سجل مشابه» is answered on the edit form, which owns a citizen's newest
   * registration — and the finding cannot be dismissed. Read from every
   * registration, a flag left on an older one stood for good.
   */
  it('reads a held duplicate from the newest registration only', async () => {
    const flag = [{ path: 'personal.possibleDuplicate', kind: 'UNVERIFIED', reason: 'قد يكون: شخص آخر' }];
    const older = await filing(staff.jawad, { firstName: 'قديم', lastName: 'معلَّق' }, new Date('2026-06-01T10:00:00Z'));
    await db.registration.update({ where: { id: older.registrationId }, data: { flaggedFields: flag } });
    const newer = await db.registration.create({
      data: {
        citizenId: older.citizenId,
        referenceNumber: `QLT-${randomUUID().slice(0, 8)}`,
        createdById: staff.jawad,
        submittedAt: new Date('2026-06-02T10:00:00Z'),
      },
      select: { id: true },
    });

    const held = async () =>
      (await within(() => quality.findings())).items
        .filter((finding) => finding.kind === 'HELD_AS_POSSIBLE_DUPLICATE')
        .map((finding) => finding.subjectKey);

    expect(await held()).not.toContain(older.registrationId);

    await db.registration.update({ where: { id: newer.id }, data: { flaggedFields: flag } });
    expect(await held()).toContain(newer.id);
  });

  it('finds the same person twice, a copied landlord phone, near buildings and a contradicted status', async () => {
    const phone = `+96171${String(Date.now()).slice(-6)}`;
    const a = await filing(staff.jawad, { firstName: 'علي', middleName: 'حسين', lastName: 'بسام', phone, motherName: 'نظمية سرور' });
    const b = await filing(staff.jawad, { firstName: 'علي', middleName: 'حسين', lastName: 'بسام', phone, motherName: 'نظمية سرور' });

    // An occupant whose own number is the landlord number on their card.
    const occupant = await filing(staff.hussein, { firstName: 'نور', lastName: 'عياش', phone: '+9613642399' });
    await db.propertyEntry.create({
      data: {
        registrationId: occupant.registrationId,
        occupancyType: 'FREE_OCCUPANT',
        propertyType: 'HOUSE',
        propertyNumber: 'DQ-1',
        landlordName: 'محمد حدرج',
        landlordPhone: '+9613642399',
      },
    });

    // Two pinned buildings 3 m apart on one parcel.
    const first = await within(() =>
      buildings.create(
        { parcelNumber: 'DQ-56', structureType: 'MIXED_USE', lifecycleStatus: 'IN_USE', floorsCount: 1, latitude: 33.2, longitude: 35.26 },
        as('jawad'),
      ),
    );
    const second = await within(() =>
      buildings.create(
        {
          parcelNumber: 'DQ-56',
          structureType: 'MIXED_USE',
          lifecycleStatus: 'IN_USE',
          floorsCount: 1,
          latitude: 33.20003,
          longitude: 35.26,
          acknowledgedDuplicates: true,
          duplicateReason: 'مبنى آخر خلفه',
        },
        as('hussein'),
      ),
    );

    // Unit says vacant, owner's own card says owner-occupied.
    const { units } = await within(() =>
      buildings.generateUnits(
        first.building.id,
        { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 1, unitType: 'APARTMENT' },
        as('jawad'),
      ),
    );
    await db.unit.update({ where: { id: units[0]!.id }, data: { unitStatus: 'VACANT' } });
    const owner = await filing(staff.jawad, { firstName: 'جهاد', lastName: 'نسر' });
    const card = await db.propertyEntry.create({
      data: {
        registrationId: owner.registrationId,
        occupancyType: 'OWNER',
        propertyType: 'BUILDING',
        propertyNumber: 'DQ-56',
        buildingId: first.building.id,
      },
      select: { id: true },
    });
    await db.buildingUnit.create({
      data: { propertyEntryId: card.id, unitType: 'APARTMENT', floor: '0', unitId: units[0]!.id, unitStatus: 'OWNER_OCCUPIED' },
    });

    const found = await within(() => quality.findings());
    const of = (kind: string) => found.items.filter((finding) => finding.kind === kind);

    expect(of('DUPLICATE_CITIZEN').map((finding) => finding.subjectKey)).toContain(
      [a.citizenId, b.citizenId].sort().join(','),
    );
    expect(of('OCCUPANT_HAS_LANDLORD_PHONE').flatMap((finding) => finding.subjects.map((s) => s.id))).toContain(
      occupant.citizenId,
    );
    const near = of('NEAR_DUPLICATE_BUILDINGS').find((finding) =>
      finding.subjects.some((subject) => subject.id === second.building.id),
    );
    expect(near?.officers.map((officer) => officer.name).sort()).toEqual(['جواد موظف', 'حسين موظف']);
    expect(of('UNIT_STATUS_CONTRADICTION').some((finding) => finding.detail.includes('VACANT'))).toBe(true);

    // «ليست مشكلة», with a reason, hides it — and restoring brings it back.
    await within(() =>
      quality.dismiss({ kind: 'NEAR_DUPLICATE_BUILDINGS', subjectKey: near!.subjectKey, reason: 'مبنيان منفصلان فعلاً' }, as('auditor')),
    );
    expect((await within(() => quality.findings())).items.some((finding) => finding.subjectKey === near!.subjectKey)).toBe(false);
    const withDismissed = await within(() => quality.findings({ includeDismissed: true }));
    expect(withDismissed.items.find((finding) => finding.subjectKey === near!.subjectKey)?.dismissal).toMatchObject({
      reason: 'مبنيان منفصلان فعلاً',
      by: 'مدقق موظف',
    });
    await within(() => quality.restore('NEAR_DUPLICATE_BUILDINGS', near!.subjectKey, as('auditor')));
    expect((await within(() => quality.findings())).items.some((finding) => finding.subjectKey === near!.subjectKey)).toBe(true);

    // Per officer: Hussein acknowledged a structure a few metres away.
    const hussein = (await within(() => quality.officerQuality({ officerId: staff.hussein }))).officers[0];
    expect(hussein?.acknowledgedDuplicateBuildings.count).toBe(1);
    expect(hussein?.acknowledgedDuplicateBuildings.nearestMetres).toBeLessThan(10);

    // The building's creation reads as who did it, not «النظام».
    await settle();
    const created = await within(() =>
      audit.query({ entityType: 'Building', entityId: second.building.id, limit: 5, offset: 0 }),
    );
    expect(created.items[0]).toMatchObject({
      action: 'BUILDING_CREATED',
      actor: { kind: 'STAFF', name: 'حسين موظف' },
      target: { link: { kind: 'building', id: second.building.id } },
    });
    expect((created.items[0]!.after as Record<string, unknown>).duplicateReason).toBe('مبنى آخر خلفه');
  });

  it('hides a phone number inside a hand-written audit snapshot when the row is read', async () => {
    await db.auditLogEntry.create({
      data: {
        actorType: 'SYSTEM',
        action: 'DATA_CORRECTION',
        entityType: 'User',
        before: { citizen: { phone: '+9613000000', firstName: 'اختبار' } },
        after: { note: 'تصحيح يدوي' },
      },
    });
    const rows = await within(() => audit.query({ actions: ['DATA_CORRECTION'], limit: 5, offset: 0 }));
    expect((rows.items[0]!.before as { citizen: { phone: string } }).citizen.phone).toBe('[redacted]');
    expect(rows.items[0]!.actor.kind).toBe('SYSTEM');
  });
});

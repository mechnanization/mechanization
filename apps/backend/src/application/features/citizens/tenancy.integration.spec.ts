import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { adminUpdateCitizenSubmissionSchema } from '@mechanization/shared-schemas';
import type { CreateFeeNotice } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaCaseRepository } from '../../../infrastructure/repositories/case.repository';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { ValidationError } from '../../../domain/errors/domain-error';
import { AuditService } from '../audit/audit.service';
import { CasesService } from '../cases/cases.service';
import { BuildingsService } from '../buildings/buildings.service';
import { CensusSyncService } from '../buildings/census-sync.service';
import { FeesService } from '../fees/fees.service';
import { CitizensService } from './citizens.service';
import { LandlordLinkService, readFootprint } from './landlord-link.service';
import { TenancyService } from './tenancy.service';

/**
 * Ending a tenancy, against a real Postgres.
 *
 * ## The defect this pins down
 *
 * «إنهاء الإشغال» on the unit matrix ended the tenant's spell and left their
 * card on their file as current — still naming the flat, still billing them for
 * it — while the flat kept «مؤجرة» and its owner stayed exempt. Every assertion
 * below is one of those facts, and each spans tables: the spell, the card, its
 * row, the owner's records, the flat, a vacancy, a case and an invoice.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17 — migration 0044 needs it).
 * Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_tenancy_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('TenancyService', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let buildings: BuildingsService;
  let census: CensusSyncService;
  let links: LandlordLinkService;
  let tenancy: TenancyService;
  let citizens: CitizensService;
  let fees: FeesService;
  let officerId: string;

  const actor = () => ({ id: officerId, role: 'SUPER_ADMIN' });

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run(
      { tenantId: 'tenant-tenancy', tenantSlug: 'tenancy', schemaName: SCHEMA, prisma: db },
      work,
    );

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();

    const events = new EventEmitter2();
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    events.on('building.changed', (payload) => audit.onBuildingChanged(payload));
    events.on('citizen.changed', (payload) => audit.onCitizenChanged(payload));

    const cases = new CasesService(
      new PrismaCaseRepository(context),
      { findById: async () => ({ id: officerId, kind: 'CITIZEN' }) } as never,
      events,
    );
    buildings = new BuildingsService(context, cases, events);
    census = new CensusSyncService(context, cases, events);
    links = new LandlordLinkService(context, buildings, events);
    tenancy = new TenancyService(context, buildings, cases, links, events);
    citizens = new CitizensService(
      context,
      {} as never,
      { resolve: async () => ({ allowsPropertyType: () => true, referencePrefix: 'TNC' }) } as never,
      { findManyByNumber: async () => new Map(), count: async () => 0 } as never,
      census,
      links,
      events,
    );
    fees = new FeesService(
      context,
      events,
      {} as never,
      {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        invalidatePrefix: jest.fn().mockResolvedValue(undefined),
      } as never,
      {} as never,
    );

    officerId = randomUUID();
    await db.user.create({
      data: {
        id: officerId,
        kind: 'STAFF',
        tenantSlug: 'tenancy',
        email: `officer-${officerId}@tenancy.gov.lb`,
        firstName: 'موظف',
        lastName: 'البلدية',
        role: 'SUPER_ADMIN',
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  // ─────────────────────────────  Fixtures  ─────────────────────────────

  const freshPhone = () => {
    const digits = String(Math.floor(1_000_000 + Math.random() * 8_999_999));
    return { typed: `71 ${digits.slice(0, 3)} ${digits.slice(3, 6)}`, stored: `+96171${digits.slice(0, 6)}` };
  };

  const citizen = async (firstName: string, over: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await db.user.create({
      data: {
        id,
        kind: 'CITIZEN',
        tenantSlug: 'tenancy',
        firstName,
        middleName: 'علي',
        lastName: 'نصرالله',
        phone: freshPhone().stored,
        ...over,
      },
    });
    return id;
  };

  const block = async (parcelNumber: string, unitsPerFloor = 3, unitType = 'APARTMENT') =>
    within(async () => {
      const { building } = await buildings.create(
        { parcelNumber, structureType: 'RESIDENTIAL_BUILDING', lifecycleStatus: 'IN_USE', floorsCount: 1 },
        actor(),
      );
      const { units } = await buildings.generateUnits(
        building.id,
        { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor, unitType: unitType as never },
        actor(),
      );
      return { building, units };
    });

  /** A tenant's filing on some flats, synced into the census like a real one. */
  const tenantOn = async (input: {
    parcelNumber: string;
    buildingId: string;
    unitIds: string[];
    landlordPhone: string;
    extraCards?: number;
  }) => {
    const tenantId = await citizen('مستأجر');
    const registration = await db.registration.create({
      data: { citizenId: tenantId, referenceNumber: `REF-${randomUUID().slice(0, 10)}` },
      select: { id: true },
    });
    for (let extra = 0; extra < (input.extraCards ?? 0); extra += 1) {
      await db.propertyEntry.create({
        data: {
          registrationId: registration.id,
          occupancyType: 'OWNER',
          propertyType: 'LAND',
          propertyNumber: `${input.parcelNumber}-LAND-${extra}`,
          neighborhood: 'الحي الشرقي',
          unitArea: 200,
        },
      });
    }
    const card = await db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: 'TENANT',
        landlordName: 'مالك المبنى',
        landlordPhone: input.landlordPhone,
        propertyType: 'BUILDING',
        neighborhood: 'الحي الشرقي',
        propertyNumber: input.parcelNumber,
        buildingName: 'بناية الاختبار',
        buildingId: input.buildingId,
        units: {
          create: input.unitIds.map((unitId) => ({
            unitType: 'APARTMENT',
            floor: '0',
            unitArea: 90,
            unitId,
          })),
        },
      },
      select: { id: true },
    });
    await within(() =>
      census.syncRegistration({ registrationId: registration.id, citizenId: tenantId, actor: actor() }),
    );
    return { tenantId, registrationId: registration.id, entryId: card.id };
  };

  /** A registered owner linked to the tenant's card — the full owner link. */
  const linkedTenancy = async (parcelNumber: string, unitCount = 1) => {
    const { building, units } = await block(parcelNumber, Math.max(unitCount, 2));
    const phone = freshPhone();
    const tenancyFiling = await tenantOn({
      parcelNumber,
      buildingId: building.id,
      unitIds: units.slice(0, unitCount).map((unit) => unit.id),
      landlordPhone: phone.stored,
    });
    const ownerId = await citizen('مالك', { phone: phone.stored });
    await db.registration.create({
      data: { citizenId: ownerId, referenceNumber: `REF-${randomUUID().slice(0, 10)}` },
    });
    await within(() =>
      links.confirm({ propertyEntryId: tenancyFiling.entryId, citizenId: ownerId, actor: actor() }),
    );
    return { ...tenancyFiling, ownerId, building, units };
  };

  const spell = (citizenId: string, unitId: string) =>
    db.unitOccupancy.findFirstOrThrow({ where: { citizenId, unitId }, orderBy: { createdAt: 'desc' } });

  /** What a per-unit fee borne by the given party charges this citizen. */
  const bill = async (citizenId: string, bearer: 'OWNER' | 'OCCUPANT'): Promise<number> => {
    const notice = {
      title: `رسم ${randomUUID().slice(0, 8)}`,
      amount: 1000,
      basis: 'PER_UNIT',
      bearer,
      frequency: 'ONCE',
      targetType: 'INDIVIDUAL_CITIZEN',
      targetCitizenId: citizenId,
      dueDate: '2026-12-31',
    } as CreateFeeNotice;
    try {
      const issued = await within(() => fees.issue(notice, actor()));
      const invoice = await db.citizenPayment.findFirst({
        where: { citizenId, feeNoticeId: issued.noticeId },
      });
      return Number(invoice?.amount ?? 0);
    } catch {
      return 0;
    }
  };

  // ─────────────────────────────  The matrix  ─────────────────────────────

  it('ends the card with the spell, keeps it as history, and leaves the owner as owner', async () => {
    const linked = await linkedTenancy('TNC-1');
    const unitId = linked.units[0]!.id;

    expect(await bill(linked.tenantId, 'OCCUPANT')).toBe(1000);

    const tenantSpell = await spell(linked.tenantId, unitId);
    await within(() =>
      tenancy.endOccupancy(
        tenantSpell.id,
        { reason: 'MOVED_OUT', afterStatus: 'VACANT', vacancyBasis: 'FIELD_INSPECTION' },
        actor(),
      ),
    );

    // The spell, dated and with its reason.
    const ended = await db.unitOccupancy.findUniqueOrThrow({ where: { id: tenantSpell.id } });
    expect(ended).toMatchObject({ endReason: 'MOVED_OUT' });
    expect(ended.toDate).not.toBeNull();

    // The card and its row: ended, kept, still naming the flat.
    const card = await db.propertyEntry.findUniqueOrThrow({
      where: { id: linked.entryId },
      include: { units: true },
    });
    expect(card.endedAt).not.toBeNull();
    expect(card.endReason).toBe('MOVED_OUT');
    expect(card.units).toEqual([expect.objectContaining({ unitId, endReason: 'MOVED_OUT' })]);

    // The link is history: who the landlord was stays; nothing is left to revert.
    expect(card.landlordCitizenId).toBe(linked.ownerId);
    expect(card.landlordLinkFootprint).toBeNull();

    // The owner still owns the flat, and the card the link made is now simply theirs.
    const ownerSpell = await spell(linked.ownerId, unitId);
    expect(ownerSpell.toDate).toBeNull();
    const ownerCards = await db.propertyEntry.findMany({
      where: { registration: { citizenId: linked.ownerId } },
    });
    expect(ownerCards).toHaveLength(1);
    expect(ownerCards[0]!.landlordLinkMint).toBeNull();

    // The flat is what the officer said: confirmed empty, on a recorded basis.
    expect((await db.unit.findUniqueOrThrow({ where: { id: unitId } })).unitStatus).toBe('VACANT');
    expect(
      await db.unitVacancyConfirmation.count({ where: { unitId, endedAt: null, basis: 'FIELD_INSPECTION' } }),
    ).toBe(1);

    // The ex-tenant is billed for nothing.
    expect(await bill(linked.tenantId, 'OCCUPANT')).toBe(0);

    /*
      And the trail has every step — including the vacancy, which is emitted at
      the very end of the transaction and was the audit row lost to a closed
      transaction before listeners waited for the commit.
    */
    await new Promise((resolve) => setTimeout(resolve, 400));
    const actions = (
      await db.auditLogEntry.findMany({ where: { entityId: linked.building.id }, select: { action: true } })
    ).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(['OCCUPANCY_ENDED', 'UNIT_VACANCY_CONFIRMED', 'UNIT_STATUS_AFTER_TENANCY']),
    );
    expect(
      await db.auditLogEntry.count({ where: { entityId: linked.tenantId, action: 'TENANCY_ENDED' } }),
    ).toBe(1);
  });

  it('never re-opens an ended tenancy when the household’s file is synced again', async () => {
    const linked = await linkedTenancy('TNC-2');
    const unitId = linked.units[0]!.id;
    const tenantSpell = await spell(linked.tenantId, unitId);
    await within(() =>
      tenancy.endOccupancy(
        tenantSpell.id,
        { reason: 'MOVED_OUT', afterStatus: 'OWNER_OCCUPIED' },
        actor(),
      ),
    );

    await within(() =>
      census.syncRegistration({ registrationId: linked.registrationId, citizenId: linked.tenantId, actor: actor() }),
    );

    expect(
      await db.unitOccupancy.count({ where: { citizenId: linked.tenantId, unitId, toDate: null } }),
    ).toBe(0);
    // Nor is it offered as an owner claim, nor loaded into the edit form.
    expect(
      (await within(() => links.proposals({ limit: 100, offset: 0 }))).items.map((item) => item.propertyEntryId),
    ).not.toContain(linked.entryId);
    const editable = await within(() => citizens.getEditable(linked.tenantId));
    expect(editable?.properties).toEqual([]);
  });

  it('refuses to end a tenancy without saying what the flat is now, writing nothing', async () => {
    const linked = await linkedTenancy('TNC-3');
    const tenantSpell = await spell(linked.tenantId, linked.units[0]!.id);

    await expect(
      within(() => tenancy.endOccupancy(tenantSpell.id, { reason: 'MOVED_OUT' }, actor())),
    ).rejects.toBeInstanceOf(ValidationError);

    expect((await db.unitOccupancy.findUniqueOrThrow({ where: { id: tenantSpell.id } })).toDate).toBeNull();
    expect((await db.propertyEntry.findUniqueOrThrow({ where: { id: linked.entryId } })).endedAt).toBeNull();
  });

  // ─────────────────────────────  What the flat is now  ─────────────────────────────

  it('bills the owner the occupancy fee once they live there', async () => {
    const linked = await linkedTenancy('TNC-4');

    // While the tenant rents it, the owner is exempt and the tenant pays.
    expect(await bill(linked.ownerId, 'OCCUPANT')).toBe(0);

    await within(() =>
      tenancy.endCard(linked.entryId, { reason: 'MOVED_OUT', afterStatus: 'OWNER_OCCUPIED' }, actor()),
    );

    expect((await db.unit.findUniqueOrThrow({ where: { id: linked.units[0]!.id } })).unitStatus).toBe(
      'OWNER_OCCUPIED',
    );
    expect(await bill(linked.ownerId, 'OCCUPANT')).toBe(1000);
    expect(await bill(linked.tenantId, 'OCCUPANT')).toBe(0);
  });

  it('clears a status nobody knows and opens a case to go and check', async () => {
    const linked = await linkedTenancy('TNC-5');
    const unitId = linked.units[0]!.id;

    const result = await within(() =>
      tenancy.endCard(linked.entryId, { reason: 'MOVED_OUT', afterStatus: 'UNKNOWN' }, actor()),
    );

    expect(result.casesOpened).toBe(1);
    expect((await db.unit.findUniqueOrThrow({ where: { id: unitId } })).unitStatus).toBeNull();
    expect(
      await db.case.count({ where: { unitId, caseType: 'VACANT_UNCONFIRMED', status: 'OPEN' } }),
    ).toBe(1);
    // Presumed occupied until somebody confirms otherwise: the owner is billed.
    expect(await bill(linked.ownerId, 'OCCUPANT')).toBe(1000);
  });

  /**
   * One «شاغرة قيد التحقق» per door is a rule for officers opening cases by
   * hand. It used to reach this path too, where it refused inside the
   * transaction — so the second tenant of a flat whose status was already
   * being checked could not be moved out at all.
   */
  it('ends the tenancy when a vacancy check is already open on the flat, without a second case', async () => {
    const linked = await linkedTenancy('TNC-5B');
    const unitId = linked.units[0]!.id;
    await db.case.create({
      data: {
        notes: 'سُئل عنها قبل اليوم',
        caseType: 'VACANT_UNCONFIRMED',
        buildingId: linked.building.id,
        unitId,
        createdById: officerId,
      },
    });

    const result = await within(() =>
      tenancy.endCard(linked.entryId, { reason: 'MOVED_OUT', afterStatus: 'UNKNOWN' }, actor()),
    );

    expect(result.casesOpened).toBe(0);
    expect((await spell(linked.tenantId, unitId)).toDate).not.toBeNull();
    expect(
      await db.case.count({ where: { unitId, caseType: 'VACANT_UNCONFIRMED', status: 'OPEN' } }),
    ).toBe(1);
  });

  it('keeps a flat let to somebody new «مؤجرة» and opens a case to register them', async () => {
    const linked = await linkedTenancy('TNC-6');
    const unitId = linked.units[0]!.id;

    await within(() =>
      tenancy.endCard(linked.entryId, { reason: 'MOVED_OUT', afterStatus: 'RENTED_TO_OTHER' }, actor()),
    );

    expect((await db.unit.findUniqueOrThrow({ where: { id: unitId } })).unitStatus).toBe('RENTED');
    expect(await db.case.count({ where: { unitId, caseType: 'GENERAL_NOTE', status: 'OPEN' } })).toBe(1);
  });

  it('does not ask about a flat somebody else still lives in', async () => {
    const { building, units } = await block('TNC-7');
    const phone = freshPhone();
    const first = await tenantOn({
      parcelNumber: 'TNC-7',
      buildingId: building.id,
      unitIds: [units[0]!.id],
      landlordPhone: phone.stored,
    });
    await tenantOn({
      parcelNumber: 'TNC-7',
      buildingId: building.id,
      unitIds: [units[0]!.id],
      landlordPhone: phone.stored,
    });

    const preview = await within(() => tenancy.previewCard(first.entryId));
    expect(preview.units).toEqual([expect.objectContaining({ needsStatus: false, othersRemain: true })]);

    const result = await within(() => tenancy.endCard(first.entryId, { reason: 'MOVED_OUT' }, actor()));
    expect(result.statusApplied).toBeNull();
    expect((await db.unit.findUniqueOrThrow({ where: { id: units[0]!.id } })).unitStatus).toBe('RENTED');
  });

  it('refuses to record a non-resident owner as living in a dwelling', async () => {
    const linked = await linkedTenancy('TNC-8');
    await db.user.update({ where: { id: linked.ownerId }, data: { residence: 'NON_RESIDENT_OWNER' } });

    await expect(
      within(() =>
        tenancy.endCard(linked.entryId, { reason: 'MOVED_OUT', afterStatus: 'OWNER_OCCUPIED' }, actor()),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await db.propertyEntry.findUniqueOrThrow({ where: { id: linked.entryId } })).endedAt).toBeNull();
  });

  // ─────────────────────────────  Recorded in error  ─────────────────────────────

  it('reverts what the owner link made when the tenancy never existed', async () => {
    const linked = await linkedTenancy('TNC-9');
    const unitId = linked.units[0]!.id;

    await within(() =>
      tenancy.endCard(linked.entryId, { reason: 'RECORDED_IN_ERROR', afterStatus: 'UNKNOWN' }, actor()),
    );

    const card = await db.propertyEntry.findUniqueOrThrow({ where: { id: linked.entryId } });
    expect(card).toMatchObject({ endReason: 'RECORDED_IN_ERROR', landlordCitizenId: null });
    expect((await spell(linked.ownerId, unitId)).endReason).toBe('RECORDED_IN_ERROR');
    expect(await db.propertyEntry.count({ where: { registration: { citizenId: linked.ownerId } } })).toBe(0);
  });

  // ─────────────────────────────  Part of a tenancy  ─────────────────────────────

  it('lets a tenant give up one of two flats and keep the other', async () => {
    const linked = await linkedTenancy('TNC-10', 2);
    const [kept, left] = [linked.units[0]!.id, linked.units[1]!.id];

    expect(await bill(linked.tenantId, 'OCCUPANT')).toBe(2000);

    await within(() =>
      tenancy.endCard(
        linked.entryId,
        { reason: 'MOVED_OUT', unitIds: [left], afterStatus: 'VACANT', vacancyBasis: 'OWNER_STATEMENT' },
        actor(),
      ),
    );

    const card = await db.propertyEntry.findUniqueOrThrow({
      where: { id: linked.entryId },
      include: { units: true },
    });
    expect(card.endedAt).toBeNull();
    expect(card.units.find((row) => row.unitId === left)?.endedAt).not.toBeNull();
    expect(card.units.find((row) => row.unitId === kept)?.endedAt).toBeNull();
    expect(await bill(linked.tenantId, 'OCCUPANT')).toBe(1000);

    // The link keeps covering the flat still rented, and no longer the one left.
    const footprint = readFootprint(card.landlordLinkFootprint, linked.ownerId)!;
    expect(footprint.units.map((unit) => unit.unitId)).toEqual([kept]);

    // An edit of the file afterwards keeps the ended row rather than wiping it.
    const tenant = await db.user.findUniqueOrThrow({ where: { id: linked.tenantId } });
    const payload = adminUpdateCitizenSubmissionSchema.parse({
      personal: {
        firstName: tenant.firstName,
        middleName: 'علي',
        lastName: tenant.lastName,
        motherName: 'فاطمة خليل',
        gender: 'MALE',
        civilRecordNumber: '7',
        nationality: 'لبناني',
        isLebanese: true,
        residentStatus: 'VILLAGE_RESIDENT',
      },
      contact: { maritalStatus: 'MARRIED', phone: tenant.phone, whatsappSameAsPhone: true, actualHouseholdMembers: '3' },
      properties: [
        {
          id: linked.entryId,
          occupancyType: 'TENANT',
          landlordName: 'مالك المبنى',
          landlordPhone: card.landlordPhone,
          propertyType: 'BUILDING',
          neighborhood: 'الحي الشرقي',
          propertyNumber: 'TNC-10',
          buildingName: 'بناية الاختبار',
          buildingId: linked.building.id,
          units: [{ unitType: 'APARTMENT', floor: '0', unitArea: '90', unitId: kept }],
        },
      ],
      flags: [],
    });
    await within(() =>
      citizens.update({ tenantSlug: 'tenancy', citizenId: linked.tenantId, payload, actor: actor() }),
    );

    const after = await db.buildingUnit.findMany({ where: { propertyEntryId: linked.entryId } });
    expect(after).toHaveLength(2);
    expect(after.find((row) => row.unitId === left)?.endReason).toBe('MOVED_OUT');
  });

  it('moves the flags of later cards down when a card ends', async () => {
    const { building, units } = await block('TNC-11');
    const tenant = await tenantOn({
      parcelNumber: 'TNC-11',
      buildingId: building.id,
      unitIds: [units[0]!.id],
      landlordPhone: freshPhone().stored,
      extraCards: 1,
    });
    // Card 0 is the land, card 1 the tenancy; a third card after it carries a flag.
    await db.propertyEntry.create({
      data: {
        registrationId: tenant.registrationId,
        occupancyType: 'OWNER',
        propertyType: 'LAND',
        propertyNumber: 'TNC-11-LATER',
        unitArea: 120,
      },
    });
    await db.registration.update({
      where: { id: tenant.registrationId },
      data: {
        flaggedFields: [
          { path: 'properties.1.landlordPhone', reason: 'الرقم مع الأهل', kind: 'UNESTABLISHED' },
          { path: 'properties.2.neighborhood', reason: 'غير معروف بعد', kind: 'UNESTABLISHED' },
        ],
      },
    });

    await within(() =>
      tenancy.endCard(tenant.entryId, { reason: 'MOVED_OUT', afterStatus: 'UNKNOWN' }, actor()),
    );

    const registration = await db.registration.findUniqueOrThrow({ where: { id: tenant.registrationId } });
    expect(registration.flaggedFields).toEqual([
      { path: 'properties.1.neighborhood', reason: 'غير معروف بعد', kind: 'UNESTABLISHED' },
    ]);
    // The ended card's own flag is not lost: it is in the audit row for the ending.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const trail = await db.auditLogEntry.findFirstOrThrow({
      where: { entityId: tenant.tenantId, action: 'TENANCY_ENDED' },
    });
    expect(JSON.stringify(trail.after)).toContain('الرقم مع الأهل');
  });
});

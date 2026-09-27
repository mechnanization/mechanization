import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { CreateFeeNotice } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaCaseRepository } from '../../../infrastructure/repositories/case.repository';
import { CasesService } from '../cases/cases.service';
import { BuildingsService } from '../buildings/buildings.service';
import { CensusSyncService } from '../buildings/census-sync.service';
import { FeesService } from '../fees/fees.service';
import { LandlordLinkService } from './landlord-link.service';
import { OwnershipService } from './ownership.service';
import { TenancyService } from './tenancy.service';

/**
 * Ending an ownership, against a real Postgres.
 *
 * The defect: a sale recorded on the matrix closed the owner's spell and
 * *unlinked* their card's row, which stayed current and went on billing the
 * seller. Each test below is one fact that has to hold across tables — the
 * spell, the row, the card, a tenant's link, the buyer, a case, a bill.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_ownership_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('OwnershipService', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let buildings: BuildingsService;
  let census: CensusSyncService;
  let links: LandlordLinkService;
  let ownership: OwnershipService;
  let tenancy: TenancyService;
  let fees: FeesService;
  let officerId: string;

  const actor = () => ({ id: officerId, role: 'SUPER_ADMIN' });
  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-ownership', tenantSlug: 'ownership', schemaName: SCHEMA, prisma: db }, work);

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
      { findById: async () => ({ id: officerId, kind: 'CITIZEN' }) } as never,
      events,
    );
    buildings = new BuildingsService(context, cases, events);
    census = new CensusSyncService(context, cases, events);
    links = new LandlordLinkService(context, buildings, events);
    ownership = new OwnershipService(context, buildings, cases, links, events);
    tenancy = new TenancyService(context, buildings, cases, links, events, ownership);
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
        tenantSlug: 'ownership',
        email: `officer-${officerId}@ownership.gov.lb`,
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

  const phone = () => `+96171${String(Math.floor(100_000 + Math.random() * 899_999))}`;

  const citizen = async (firstName: string, over: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await db.user.create({
      data: { id, kind: 'CITIZEN', tenantSlug: 'ownership', firstName, middleName: 'علي', lastName: 'تجربة', phone: phone(), ...over },
    });
    return id;
  };

  const block = (parcelNumber: string, unitsPerFloor = 3) =>
    within(async () => {
      const { building } = await buildings.create(
        { parcelNumber, structureType: 'RESIDENTIAL_BUILDING', lifecycleStatus: 'IN_USE', floorsCount: 1 },
        actor(),
      );
      const { units } = await buildings.generateUnits(
        building.id,
        { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor, unitType: 'APARTMENT' },
        actor(),
      );
      return { building, units: [...units].sort((a, b) => a.sequence - b.sequence) };
    });

  /** An owner's own filing on some flats, synced into the census. */
  const ownerOn = async (input: {
    parcelNumber: string;
    buildingId: string;
    unitIds: string[];
    unitStatus?: 'RENTED' | 'OWNER_OCCUPIED';
    ownerId?: string;
  }) => {
    const ownerId = input.ownerId ?? (await citizen('مالك'));
    const registration = await db.registration.create({
      data: { citizenId: ownerId, referenceNumber: `REF-${randomUUID().slice(0, 10)}` },
      select: { id: true },
    });
    const card = await db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: 'OWNER',
        propertyType: 'BUILDING',
        neighborhood: 'الحي',
        propertyNumber: input.parcelNumber,
        buildingId: input.buildingId,
        units: {
          create: input.unitIds.map((unitId, index) => ({
            unitType: 'APARTMENT',
            floor: '0',
            unitArea: 100,
            unitStatus: input.unitStatus ?? 'RENTED',
            unitId,
            createdAt: new Date(Date.now() + index),
          })),
        },
      },
      select: { id: true, units: { orderBy: { createdAt: 'asc' }, select: { id: true, unitId: true } } },
    });
    await within(() => census.syncRegistration({ registrationId: registration.id, citizenId: ownerId, actor: actor() }));
    return { ownerId, registrationId: registration.id, cardId: card.id, rows: card.units };
  };

  const ownerSpell = (citizenId: string, unitId: string) =>
    db.unitOccupancy.findFirstOrThrow({ where: { citizenId, unitId, role: 'OWNER' }, orderBy: { createdAt: 'desc' } });

  /** What an owner-borne, per-unit fee charges this citizen. */
  const ownerBill = async (citizenId: string): Promise<number> => {
    const notice = {
      title: `رسم ${randomUUID().slice(0, 8)}`,
      amount: 1000,
      basis: 'PER_UNIT',
      bearer: 'OWNER',
      frequency: 'ONCE',
      targetType: 'INDIVIDUAL_CITIZEN',
      targetCitizenId: citizenId,
      dueDate: '2026-12-31',
    } as CreateFeeNotice;
    try {
      const issued = await within(() => fees.issue(notice, actor()));
      const invoice = await db.citizenPayment.findFirst({ where: { citizenId, feeNoticeId: issued.noticeId } });
      return Number(invoice?.amount ?? 0);
    } catch {
      return 0;
    }
  };

  const today = () => new Date(new Date().toISOString().slice(0, 10));

  // ─────────────────────────────  A sale  ─────────────────────────────

  it('stops billing the seller and keeps the ownership as history', async () => {
    const { building, units } = await block('OWN-1');
    const owner = await ownerOn({ parcelNumber: 'OWN-1', buildingId: building.id, unitIds: [units[0]!.id] });
    expect(await ownerBill(owner.ownerId)).toBe(1000);

    const spell = await ownerSpell(owner.ownerId, units[0]!.id);
    await within(() =>
      tenancy.endOccupancy(spell.id, { reason: 'OWNERSHIP_TRANSFERRED', endedAt: today() }, actor()),
    );

    const ended = await db.unitOccupancy.findUniqueOrThrow({ where: { id: spell.id } });
    expect(ended.endReason).toBe('OWNERSHIP_TRANSFERRED');

    // The row ends and keeps naming its flat — not the NULL-ed link it used to leave.
    const row = await db.buildingUnit.findUniqueOrThrow({ where: { id: owner.rows[0]!.id } });
    expect(row.endReason).toBe('OWNERSHIP_TRANSFERRED');
    expect(row.unitId).toBe(units[0]!.id);

    const card = await db.propertyEntry.findUniqueOrThrow({ where: { id: owner.cardId } });
    expect(card.endReason).toBe('OWNERSHIP_TRANSFERRED');
    expect(await ownerBill(owner.ownerId)).toBe(0);

    // Nobody recorded as the buyer: somebody is asked to.
    const cases = await db.case.findMany({ where: { unitId: units[0]!.id } });
    expect(cases.some((row) => /سجِّل المالك الجديد/.test(row.notes ?? ''))).toBe(true);
  });

  it('records a registered buyer as owner from the day of the sale', async () => {
    const { building, units } = await block('OWN-2');
    const owner = await ownerOn({ parcelNumber: 'OWN-2', buildingId: building.id, unitIds: [units[0]!.id] });
    const buyerId = await citizen('مشترٍ');
    const soldOn = today();

    const result = await within(() =>
      ownership.endCard(owner.cardId, { reason: 'OWNERSHIP_TRANSFERRED', endedAt: soldOn, newOwnerId: buyerId }, actor()),
    );

    expect(result.newOwnerRecorded).toBe(true);
    const buyerSpell = await ownerSpell(buyerId, units[0]!.id);
    expect(buyerSpell.toDate).toBeNull();
    expect(buyerSpell.fromDate.toISOString().slice(0, 10)).toBe(soldOn.toISOString().slice(0, 10));

    const cases = await db.case.findMany({ where: { unitId: units[0]!.id } });
    expect(cases.some((row) => /سجِّل المالك الجديد/.test(row.notes ?? ''))).toBe(false);
  });

  it('asks what a flat the seller lived in is now, and acts on the answer', async () => {
    const { building, units } = await block('OWN-3');
    const owner = await ownerOn({
      parcelNumber: 'OWN-3',
      buildingId: building.id,
      unitIds: [units[0]!.id],
      unitStatus: 'OWNER_OCCUPIED',
    });

    await expect(
      within(() => ownership.endCard(owner.cardId, { reason: 'OWNERSHIP_TRANSFERRED' }, actor())),
    ).rejects.toThrow(/من يسكن الوحدة/);

    await within(() =>
      ownership.endCard(owner.cardId, { reason: 'OWNERSHIP_TRANSFERRED', afterStatus: 'UNKNOWN' }, actor()),
    );
    const unit = await db.unit.findUniqueOrThrow({ where: { id: units[0]!.id } });
    expect(unit.unitStatus).toBeNull();
    const check = await db.case.findFirst({ where: { unitId: units[0]!.id, caseType: 'VACANT_UNCONFIRMED' } });
    expect(check).not.toBeNull();
  });

  // ─────────────────────────────  Tenants  ─────────────────────────────

  /** A tenant whose card is linked to a registered owner — the full owner link. */
  const linkedTenancy = async (parcelNumber: string) => {
    const { building, units } = await block(parcelNumber);
    const ownerPhone = phone();
    const ownerId = await citizen('مالك', { phone: ownerPhone });
    await db.registration.create({ data: { citizenId: ownerId, referenceNumber: `REF-${randomUUID().slice(0, 10)}` } });

    const tenantId = await citizen('مستأجر');
    const registration = await db.registration.create({
      data: { citizenId: tenantId, referenceNumber: `REF-${randomUUID().slice(0, 10)}` },
      select: { id: true },
    });
    const card = await db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: 'TENANT',
        landlordName: 'مالك المبنى',
        landlordPhone: ownerPhone,
        propertyType: 'BUILDING',
        neighborhood: 'الحي',
        propertyNumber: parcelNumber,
        buildingId: building.id,
        units: { create: [{ unitType: 'APARTMENT', floor: '0', unitArea: 90, unitId: units[0]!.id }] },
      },
      select: { id: true },
    });
    await within(() => census.syncRegistration({ registrationId: registration.id, citizenId: tenantId, actor: actor() }));
    await within(() => links.confirm({ propertyEntryId: card.id, citizenId: ownerId, actor: actor() }));
    return { ownerId, tenantId, tenantRegistrationId: registration.id, tenantCardId: card.id, unitId: units[0]!.id };
  };

  it('releases a tenant’s link to the seller, so no later save puts the seller back', async () => {
    const linked = await linkedTenancy('OWN-4');
    const spell = await ownerSpell(linked.ownerId, linked.unitId);

    const result = await within(() =>
      tenancy.endOccupancy(spell.id, { reason: 'OWNERSHIP_TRANSFERRED' }, actor()),
    );
    expect('tenantsReleased' in result && result.tenantsReleased.map((row) => row.tenantId)).toEqual([linked.tenantId]);

    const card = await db.propertyEntry.findUniqueOrThrow({ where: { id: linked.tenantCardId } });
    expect(card.landlordCitizenId).toBeNull();
    expect(card.landlordLinkDismissedIds).toContain(linked.ownerId);
    // Who the landlord was stays written on the card.
    expect(card.landlordName).toBeTruthy();
    expect(card.endedAt).toBeNull();

    // The tenant's next save: nothing re-attaches the seller.
    await within(() => links.reconcileRegistration(linked.tenantRegistrationId, actor()));
    const current = await db.unitOccupancy.count({
      where: { unitId: linked.unitId, citizenId: linked.ownerId, role: 'OWNER', toDate: null },
    });
    expect(current).toBe(0);

    // The tenant still lives there.
    const tenantSpell = await db.unitOccupancy.count({
      where: { unitId: linked.unitId, citizenId: linked.tenantId, toDate: null },
    });
    expect(tenantSpell).toBe(1);
  });

  it('refuses a correction while a tenant’s link names this person as the landlord', async () => {
    const linked = await linkedTenancy('OWN-5');
    const spell = await ownerSpell(linked.ownerId, linked.unitId);

    await expect(
      within(() => tenancy.endOccupancy(spell.id, { reason: 'RECORDED_IN_ERROR' }, actor())),
    ).rejects.toThrow(/ألغِ الربط/);

    const untouched = await db.unitOccupancy.findUniqueOrThrow({ where: { id: spell.id } });
    expect(untouched.toDate).toBeNull();
  });

  // ─────────────────────────────  A buyer already on the flat  ─────────────────────────────

  it('keeps a co-owner who buys the other share on the ownership they already held', async () => {
    const { building, units } = await block('OWN-9');
    const seller = await ownerOn({ parcelNumber: 'OWN-9', buildingId: building.id, unitIds: [units[0]!.id] });
    const coOwner = await ownerOn({ parcelNumber: 'OWN-9', buildingId: building.id, unitIds: [units[0]!.id] });
    const heldSince = new Date('2020-01-01T00:00:00.000Z');
    const held = await ownerSpell(coOwner.ownerId, units[0]!.id);
    await db.unitOccupancy.update({ where: { id: held.id }, data: { fromDate: heldSince } });

    const preview = await within(() => ownership.previewCard(seller.cardId));
    expect(preview.units[0]!.otherOwnerIds).toEqual([coOwner.ownerId]);

    const result = await within(() =>
      ownership.endCard(seller.cardId, { reason: 'OWNERSHIP_TRANSFERRED', newOwnerId: coOwner.ownerId }, actor()),
    );
    expect(result.newOwnerRecorded).toBe(true);

    // Their own ownership is not re-dated to the sale, nor recorded twice.
    const spells = await db.unitOccupancy.findMany({ where: { unitId: units[0]!.id, citizenId: coOwner.ownerId } });
    expect(spells.map((row) => [row.id, row.fromDate.toISOString(), row.toDate])).toEqual([
      [held.id, heldSince.toISOString(), null],
    ]);
  });

  it('refuses a buyer who rents the flat, and writes nothing, until that tenancy is ended', async () => {
    const linked = await linkedTenancy('OWN-10');
    const spell = await ownerSpell(linked.ownerId, linked.unitId);

    const preview = await within(() => ownership.previewOccupancy(spell.id));
    expect(preview.units[0]!.occupantIds).toContain(linked.tenantId);

    await expect(
      within(() =>
        tenancy.endOccupancy(spell.id, { reason: 'OWNERSHIP_TRANSFERRED', newOwnerId: linked.tenantId }, actor()),
      ),
    ).rejects.toThrow(/أنهِ إشغاله أولاً/);

    // Refused after the seller's side was written, so this is the rollback being checked.
    expect((await db.unitOccupancy.findUniqueOrThrow({ where: { id: spell.id } })).toDate).toBeNull();
    const tenantSpells = await db.unitOccupancy.findMany({ where: { unitId: linked.unitId, citizenId: linked.tenantId } });
    expect(tenantSpells.map((row) => [row.role, row.toDate])).toEqual([['TENANT', null]]);
    const card = await db.propertyEntry.findUniqueOrThrow({ where: { id: linked.tenantCardId } });
    expect(card.landlordCitizenId).toBe(linked.ownerId);
  });

  // ─────────────────────────────  Corrections and scope  ─────────────────────────────

  it('records a correction as an error, on the spell and the row', async () => {
    const { building, units } = await block('OWN-6');
    const owner = await ownerOn({ parcelNumber: 'OWN-6', buildingId: building.id, unitIds: [units[0]!.id] });

    await within(() => ownership.endCard(owner.cardId, { reason: 'RECORDED_IN_ERROR' }, actor()));

    const spell = await ownerSpell(owner.ownerId, units[0]!.id);
    expect(spell.endReason).toBe('RECORDED_IN_ERROR');
    const row = await db.buildingUnit.findUniqueOrThrow({ where: { id: owner.rows[0]!.id } });
    expect(row.endReason).toBe('RECORDED_IN_ERROR');
  });

  it('ends only the flats ticked on a card that holds several', async () => {
    const { building, units } = await block('OWN-7');
    const owner = await ownerOn({
      parcelNumber: 'OWN-7',
      buildingId: building.id,
      unitIds: [units[0]!.id, units[1]!.id],
    });

    await expect(
      within(() => ownership.endCard(owner.cardId, { reason: 'OWNERSHIP_TRANSFERRED' }, actor())),
    ).rejects.toThrow(/حدِّد الوحدات/);

    await within(() =>
      ownership.endCard(owner.cardId, { reason: 'OWNERSHIP_TRANSFERRED', rowIds: [owner.rows[0]!.id] }, actor()),
    );

    const card = await db.propertyEntry.findUniqueOrThrow({ where: { id: owner.cardId } });
    expect(card.endedAt).toBeNull();
    expect((await ownerSpell(owner.ownerId, units[0]!.id)).toDate).not.toBeNull();
    expect((await ownerSpell(owner.ownerId, units[1]!.id)).toDate).toBeNull();
  });

  it('will not end one flat of a card that covers the whole building without naming flats', async () => {
    const { building, units } = await block('OWN-8');
    const ownerId = await citizen('مالك');
    const registration = await db.registration.create({
      data: { citizenId: ownerId, referenceNumber: `REF-${randomUUID().slice(0, 10)}` },
      select: { id: true },
    });
    await db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: 'OWNER',
        propertyType: 'BUILDING',
        neighborhood: 'الحي',
        propertyNumber: 'OWN-8',
        buildingId: building.id,
      },
    });
    const spell = await db.unitOccupancy.create({
      data: { unitId: units[0]!.id, citizenId: ownerId, role: 'OWNER', registrationId: registration.id },
    });

    await expect(
      within(() => tenancy.endOccupancy(spell.id, { reason: 'OWNERSHIP_TRANSFERRED' }, actor())),
    ).rejects.toThrow(/تشمل المبنى كله/);
  });
});

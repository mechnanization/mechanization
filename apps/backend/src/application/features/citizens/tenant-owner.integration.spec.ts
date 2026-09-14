import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { adminUpdateCitizenSubmissionSchema } from '@mechanization/shared-schemas';
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
import { CensusSyncService } from '../buildings/census-sync.service';
import { CitizensService } from './citizens.service';
import { LandlordLinkService, readFootprint } from './landlord-link.service';
import { TenancyService } from './tenancy.service';

/**
 * A tenant and the owner they rent from, against a real Postgres.
 *
 * ## The defect this pins down
 *
 * On staging, a tenant renting flat 0001 from one owner was added on the unit
 * matrix to flat 0101 of another. Nothing asked who the owner was, and the flat
 * was ticked onto the tenant's existing card — the card linked to the first
 * owner. Their file then said 0101 was rented from the wrong person, ending the
 * tenancy recorded the ending against that person, and the next save of the
 * tenant's file would have put the first owner on the second owner's flat and
 * ended their real ownership of 0001.
 *
 * Separately, «إنهاء الإيجار» on a card with a flat linked to سجل المباني and a
 * line that never was (a shop typed on the form) showed only the flat and ended
 * both.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17 — migration 0044 needs it).
 * Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_owner_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('A tenant and the owner they rent from', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let buildings: BuildingsService;
  let census: CensusSyncService;
  let links: LandlordLinkService;
  let tenancy: TenancyService;
  let citizens: CitizensService;
  let officerId: string;

  const actor = () => ({ id: officerId, role: 'SUPER_ADMIN' });

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run(
      { tenantId: 'tenant-owner', tenantSlug: 'owners', schemaName: SCHEMA, prisma: db },
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
      { resolve: async () => ({ allowsPropertyType: () => true, referencePrefix: 'OWN' }) } as never,
      { findManyByNumber: async () => new Map(), count: async () => 0 } as never,
      census,
      links,
      events,
    );

    officerId = randomUUID();
    await db.user.create({
      data: {
        id: officerId,
        kind: 'STAFF',
        tenantSlug: 'owners',
        email: `officer-${officerId}@owners.gov.lb`,
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

  const freshPhone = () => `+96171${String(Math.floor(100_000 + Math.random() * 899_999))}`;

  /** A citizen with a file (a registration), as everyone the matrix records has. */
  const person = async (firstName: string, over: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await db.user.create({
      data: {
        id,
        kind: 'CITIZEN',
        tenantSlug: 'owners',
        firstName,
        middleName: 'علي',
        lastName: 'نصرالله',
        phone: freshPhone(),
        ...over,
      },
    });
    const registration = await db.registration.create({
      data: { citizenId: id, referenceNumber: `REF-${randomUUID().slice(0, 10)}` },
      select: { id: true },
    });
    return { id, registrationId: registration.id };
  };

  const block = async (parcelNumber: string, unitsPerFloor = 3) =>
    within(async () => {
      const { building } = await buildings.create(
        { parcelNumber, structureType: 'RESIDENTIAL_BUILDING', lifecycleStatus: 'IN_USE', floorsCount: 1 },
        actor(),
      );
      const { units } = await buildings.generateUnits(
        building.id,
        { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor, unitType: 'APARTMENT' as never },
        actor(),
      );
      return { building, units };
    });

  /** «إضافة شخص إلى الوحدة», as the matrix sends it. */
  const add = (input: Record<string, unknown>) =>
    within(() => tenancy.recordOccupancy(input as never, actor()));

  const spellOf = (citizenId: string, unitId: string) =>
    db.unitOccupancy.findFirstOrThrow({ where: { citizenId, unitId }, orderBy: { createdAt: 'desc' } });

  const tenancyCards = (citizenId: string) =>
    db.propertyEntry.findMany({
      where: { registration: { citizenId }, occupancyType: 'TENANT' },
      orderBy: { createdAt: 'asc' },
      include: { units: { orderBy: { createdAt: 'asc' } } },
    });

  const pause = () => new Promise((resolve) => setTimeout(resolve, 400));

  // ─────────────────────────────  Recording  ─────────────────────────────

  it('links a tenant to the owner recorded on the flat before them', async () => {
    const { building, units } = await block('OWN-1');
    const flat = units[0]!.id;
    const owner = await person('هشام');
    const tenant = await person('مستأجر');

    await add({ unitId: flat, citizenId: owner.id, role: 'OWNER', unitStatus: 'RENTED' });
    const result = await add({ unitId: flat, citizenId: tenant.id, role: 'TENANT', landlordCitizenId: owner.id });

    expect(result.ownerLink).toMatchObject({ linked: true, split: false });
    const [card] = await tenancyCards(tenant.id);
    expect(card).toMatchObject({ landlordCitizenId: owner.id, buildingId: building.id });
    // A tenancy card has to carry a name and number to be saved from the form.
    const ownerRow = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(card!.landlordPhone).toBe(ownerRow.phone);
    expect(card!.landlordName).toBe('هشام علي نصرالله');

    // The owner was already on the flat: the link opened nothing to undo later.
    const footprint = readFootprint(card!.landlordLinkFootprint, owner.id)!;
    expect(footprint.units).toEqual([expect.objectContaining({ unitId: flat, occupancyId: null })]);
    expect(await db.unitOccupancy.count({ where: { unitId: flat, citizenId: owner.id, toDate: null } })).toBe(1);

    const detail = await within(() => buildings.get(building.id));
    const shown = detail.units.find((unit) => unit.id === flat)!.occupants.find(
      (row) => row.citizenId === tenant.id,
    )!;
    expect(shown.ownerLink).toMatchObject({ state: 'LINKED', ownerId: owner.id });
  });

  it('keeps a shop and the flat above it, rented from two owners, as two tenancies', async () => {
    const { building, units } = await block('OWN-2');
    const [shop, flat] = [units[0]!.id, units[1]!.id];
    const shopOwner = await person('صاحب المحل');
    const flatOwner = await person('صاحب الشقة');
    const tenant = await person('مستأجر');

    await add({ unitId: shop, citizenId: shopOwner.id, role: 'OWNER', unitStatus: 'RENTED' });
    await add({ unitId: flat, citizenId: flatOwner.id, role: 'OWNER', unitStatus: 'RENTED' });
    await add({ unitId: shop, citizenId: tenant.id, role: 'TENANT', landlordCitizenId: shopOwner.id });
    await add({ unitId: flat, citizenId: tenant.id, role: 'TENANT', landlordCitizenId: flatOwner.id });

    const cards = await tenancyCards(tenant.id);
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => [card.landlordCitizenId, card.units.map((row) => row.unitId)])).toEqual([
      [shopOwner.id, [shop]],
      [flatOwner.id, [flat]],
    ]);
    // Neither owner was put on the other's flat.
    expect(await db.unitOccupancy.count({ where: { unitId: flat, citizenId: shopOwner.id } })).toBe(0);
    expect(await db.unitOccupancy.count({ where: { unitId: shop, citizenId: flatOwner.id } })).toBe(0);

    // Leaving the shop ends that tenancy only, and says so on the shop's owner alone.
    await within(() =>
      tenancy.endCard(cards[0]!.id, { reason: 'MOVED_OUT', afterStatus: 'OWNER_OCCUPIED' }, actor()),
    );
    const after = await tenancyCards(tenant.id);
    expect(after[0]!.endedAt).not.toBeNull();
    expect(after[1]).toMatchObject({ endedAt: null, landlordCitizenId: flatOwner.id });
    expect((await spellOf(tenant.id, flat)).toDate).toBeNull();

    await pause();
    expect(
      await db.auditLogEntry.count({ where: { entityId: shopOwner.id, action: 'LANDLORD_TENANCY_ENDED' } }),
    ).toBe(1);
    expect(
      await db.auditLogEntry.count({ where: { entityId: flatOwner.id, action: 'LANDLORD_TENANCY_ENDED' } }),
    ).toBe(0);
    void building;
  });

  it('keeps an owner of one flat who rents the shop below from someone else on two cards of their own capacities', async () => {
    const { units } = await block('OWN-12');
    const [shop, flat] = [units[0]!.id, units[1]!.id];
    const shopOwner = await person('صاحب المحل');
    const neighbour = await person('جار');

    await add({ unitId: shop, citizenId: shopOwner.id, role: 'OWNER', unitStatus: 'RENTED' });
    await add({ unitId: shop, citizenId: neighbour.id, role: 'TENANT', landlordCitizenId: shopOwner.id });
    await add({ unitId: flat, citizenId: neighbour.id, role: 'OWNER', unitStatus: 'OWNER_OCCUPIED' });

    const cards = await db.propertyEntry.findMany({
      where: { registration: { citizenId: neighbour.id } },
      orderBy: { createdAt: 'asc' },
      include: { units: true },
    });
    // Rows bill in their card's capacity: the owned flat is never on the tenancy.
    expect(cards.map((card) => [card.occupancyType, card.units.map((row) => row.unitId)])).toEqual([
      ['TENANT', [shop]],
      ['OWNER', [flat]],
    ]);
    expect(cards[0]!.landlordCitizenId).toBe(shopOwner.id);
  });

  it('links one co-owner, and leaves the other listed on the flat', async () => {
    const { building, units } = await block('OWN-3');
    const flat = units[0]!.id;
    const brother = await person('أحمد');
    const sister = await person('سعاد');
    const tenant = await person('مستأجر');

    await add({ unitId: flat, citizenId: brother.id, role: 'OWNER', shares: 1200, unitStatus: 'RENTED' });
    await add({ unitId: flat, citizenId: sister.id, role: 'OWNER', shares: 1200 });
    await add({ unitId: flat, citizenId: tenant.id, role: 'TENANT', landlordCitizenId: sister.id });

    const [card] = await tenancyCards(tenant.id);
    expect(card!.landlordCitizenId).toBe(sister.id);
    // Both still own it.
    expect(
      await db.unitOccupancy.count({ where: { unitId: flat, role: 'OWNER', toDate: null } }),
    ).toBe(2);
    const detail = await within(() => buildings.get(building.id));
    const row = detail.units.find((unit) => unit.id === flat)!.occupants.find(
      (occupant) => occupant.citizenId === tenant.id,
    )!;
    expect(row.ownerLink?.state).toBe('LINKED');
  });

  it('refuses a picked owner who is not recorded on the flat, and records nothing', async () => {
    const { units } = await block('OWN-4');
    const flat = units[0]!.id;
    const stranger = await person('غريب');
    const tenant = await person('مستأجر');

    await expect(
      add({ unitId: flat, citizenId: tenant.id, role: 'TENANT', landlordCitizenId: stranger.id }),
    ).rejects.toBeInstanceOf(ValidationError);

    // One write: the tenant was not recorded without the owner they were given.
    expect(await db.unitOccupancy.count({ where: { unitId: flat, citizenId: tenant.id } })).toBe(0);
    expect(await tenancyCards(tenant.id)).toHaveLength(0);
  });

  it('links an owner recorded after the tenant only once the officer confirms it', async () => {
    const { units } = await block('OWN-5');
    const flat = units[0]!.id;
    const owner = await person('مالك');
    const tenant = await person('مستأجر');

    // The staging case: tenant first with no owner named, owner added a minute later.
    await add({ unitId: flat, citizenId: tenant.id, role: 'TENANT' });
    await add({ unitId: flat, citizenId: owner.id, role: 'OWNER' });
    const tenantSpell = await spellOf(tenant.id, flat);

    const refused = await within(() => tenancy.linkOccupancyOwner(tenantSpell.id, owner.id, actor())).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ConflictError);
    expect((refused as ConflictError).details).toMatchObject({ recordedAfter: true });
    expect((await tenancyCards(tenant.id))[0]!.landlordCitizenId).toBeNull();

    const linked = await within(() => tenancy.linkOccupancyOwner(tenantSpell.id, owner.id, actor(), true));
    expect(linked).toMatchObject({ linked: true });
    expect((await tenancyCards(tenant.id))[0]!.landlordCitizenId).toBe(owner.id);

    await pause();
    const trail = await db.auditLogEntry.findFirstOrThrow({
      where: { entityId: tenant.id, action: 'LANDLORD_LINKED' },
    });
    expect(trail.after).toMatchObject({ via: 'RECORDED_OWNER', recordedAfterTenant: true });
  });

  it('writes a typed owner on the tenancy card, where the owner-link queue finds them', async () => {
    const { units } = await block('OWN-6');
    const tenant = await person('مستأجر');
    const phone = freshPhone();

    await add({
      unitId: units[0]!.id,
      citizenId: tenant.id,
      role: 'TENANT',
      landlordName: 'سعيد حرب',
      landlordPhone: phone,
    });
    const owner = await person('سعيد', { phone });

    const [card] = await tenancyCards(tenant.id);
    expect(card).toMatchObject({ landlordName: 'سعيد حرب', landlordPhone: phone, landlordCitizenId: null });
    const proposals = await within(() => links.claimsNaming(owner.id));
    expect(proposals.map((proposal) => proposal.propertyEntryId)).toEqual([card!.id]);
  });

  // ─────────────────────────────  Existing cards  ─────────────────────────────

  it('moves a flat onto its own card when linking it, if the card holds flats of other owners', async () => {
    const { building, units } = await block('OWN-7');
    const [mine, theirs] = [units[0]!.id, units[1]!.id];
    const owner = await person('مالك الأولى');
    const otherOwner = await person('مالك الثانية');
    await add({ unitId: mine, citizenId: owner.id, role: 'OWNER' });
    await add({ unitId: theirs, citizenId: otherOwner.id, role: 'OWNER' });

    // A card filed on the form naming both flats, as one tenancy.
    const tenant = await person('مستأجر');
    const card = await db.propertyEntry.create({
      data: {
        registrationId: tenant.registrationId,
        occupancyType: 'TENANT',
        landlordName: 'غير معروف',
        landlordPhone: freshPhone(),
        propertyType: 'BUILDING',
        neighborhood: 'الحي',
        propertyNumber: 'OWN-7',
        buildingId: building.id,
        units: {
          create: [
            { unitType: 'APARTMENT', floor: '0', unitArea: 90, unitId: theirs, createdAt: new Date(Date.now() - 2000) },
            { unitType: 'APARTMENT', floor: '0', unitArea: 80, unitId: mine, createdAt: new Date(Date.now() - 1000) },
          ],
        },
      },
      include: { units: true },
    });
    await db.registration.update({
      where: { id: tenant.registrationId },
      data: {
        flaggedFields: [{ path: 'properties.0.units.1.side', reason: 'لم يُعرف', kind: 'UNESTABLISHED' }],
      },
    });
    await within(() =>
      census.syncRegistration({ registrationId: tenant.registrationId, citizenId: tenant.id, actor: actor() }),
    );
    const mineRow = card.units.find((row) => row.unitId === mine)!;

    const tenantSpell = await spellOf(tenant.id, mine);
    const result = await within(() => tenancy.linkOccupancyOwner(tenantSpell.id, owner.id, actor()));

    expect(result).toMatchObject({ linked: true, split: true });
    const cards = await tenancyCards(tenant.id);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ id: card.id, landlordCitizenId: null });
    expect(cards[0]!.units.map((row) => row.unitId)).toEqual([theirs]);
    expect(cards[1]).toMatchObject({ id: result.propertyEntryId, landlordCitizenId: owner.id });
    // The same row, moved — and its flag with it.
    expect(cards[1]!.units.map((row) => row.id)).toEqual([mineRow.id]);
    const registration = await db.registration.findUniqueOrThrow({ where: { id: tenant.registrationId } });
    expect(registration.flaggedFields).toEqual([
      { path: 'properties.1.units.0.side', reason: 'لم يُعرف', kind: 'UNESTABLISHED' },
    ]);
  });

  it('never hands one owner another owner’s flat when the tenant’s file is saved', async () => {
    const { building, units } = await block('OWN-8');
    const [first, second] = [units[0]!.id, units[1]!.id];
    const firstOwner = await person('المالك الأول');
    const secondOwner = await person('المالك الثاني');
    const tenant = await person('مستأجر');

    await add({ unitId: first, citizenId: firstOwner.id, role: 'OWNER', unitStatus: 'RENTED' });
    await add({ unitId: second, citizenId: secondOwner.id, role: 'OWNER', unitStatus: 'RENTED' });
    await add({ unitId: first, citizenId: tenant.id, role: 'TENANT', landlordCitizenId: firstOwner.id });

    // The state the old matrix left: the second flat ticked onto the first owner's tenancy.
    const [card] = await tenancyCards(tenant.id);
    await db.buildingUnit.create({
      data: { propertyEntryId: card!.id, unitId: second, unitType: 'APARTMENT', floor: '0' },
    });

    const reconciled = await within(() => links.reconcileRegistration(tenant.registrationId, actor()));

    expect(reconciled.blocked).toEqual([
      expect.objectContaining({ block: expect.objectContaining({ code: 'UNIT_OWNED_BY_OTHER' }) }),
    ]);
    expect(await db.unitOccupancy.count({ where: { unitId: second, citizenId: firstOwner.id } })).toBe(0);
    expect((await spellOf(firstOwner.id, first)).toDate).toBeNull();
    void building;
  });

  // ─────────────────────────────  Ending exactly what was left  ─────────────────────────────

  const mixedCard = async (parcelNumber: string) => {
    const { building, units } = await block(parcelNumber);
    const tenant = await person('مستأجر');
    const base = Date.now() - 5000;
    const card = await db.propertyEntry.create({
      data: {
        registrationId: tenant.registrationId,
        occupancyType: 'TENANT',
        landlordName: 'مالك المبنى',
        landlordPhone: freshPhone(),
        propertyType: 'BUILDING',
        neighborhood: 'الحي',
        propertyNumber: parcelNumber,
        buildingId: building.id,
        units: {
          create: [
            // A shop typed on the form, never linked to a unit.
            { unitType: 'SHOP', floor: '0', unitArea: 40, createdAt: new Date(base) },
            { unitType: 'APARTMENT', floor: '0', unitArea: 90, unitId: units[0]!.id, createdAt: new Date(base + 1) },
          ],
        },
      },
      include: { units: { orderBy: { createdAt: 'asc' } } },
    });
    await within(() =>
      census.syncRegistration({ registrationId: tenant.registrationId, citizenId: tenant.id, actor: actor() }),
    );
    return { tenant, card, flat: units[0]!.id, building };
  };

  it('shows every row when ending, and refuses to guess which rows were left', async () => {
    const { card } = await mixedCard('OWN-9');

    const preview = await within(() => tenancy.previewCard(card.id));
    expect(preview.rows).toEqual([
      expect.objectContaining({ rowId: card.units[0]!.id, unitId: null, unitType: 'SHOP', needsStatus: false }),
      expect.objectContaining({ rowId: card.units[1]!.id, unitCode: expect.any(String), needsStatus: true }),
    ]);

    await expect(
      within(() => tenancy.endCard(card.id, { reason: 'MOVED_OUT', afterStatus: 'UNKNOWN' }, actor())),
    ).rejects.toBeInstanceOf(ValidationError);
    const untouched = await db.buildingUnit.count({ where: { propertyEntryId: card.id, endedAt: null } });
    expect(untouched).toBe(2);
  });

  it('ends the flat that was left and keeps the shop typed beside it', async () => {
    const { card, tenant, flat } = await mixedCard('OWN-10');
    await db.registration.update({
      where: { id: tenant.registrationId },
      data: {
        flaggedFields: [
          { path: 'properties.0.units.0.side', reason: 'لم تُعرف الجهة', kind: 'UNESTABLISHED' },
          { path: 'properties.0.units.1.side', reason: 'جهة الشقة', kind: 'UNESTABLISHED' },
        ],
      },
    });

    const result = await within(() =>
      tenancy.endCard(
        card.id,
        { reason: 'MOVED_OUT', rowIds: [card.units[1]!.id], afterStatus: 'OWNER_OCCUPIED' },
        actor(),
      ),
    );

    expect(result.endedRowIds).toEqual([card.units[1]!.id]);
    const rows = await db.buildingUnit.findMany({ where: { propertyEntryId: card.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((row) => [row.unitType, row.endedAt === null])).toEqual([
      ['SHOP', true],
      ['APARTMENT', false],
    ]);
    expect((await db.propertyEntry.findUniqueOrThrow({ where: { id: card.id } })).endedAt).toBeNull();
    expect((await spellOf(tenant.id, flat)).toDate).not.toBeNull();
    // The shop's flag stays on the shop; the flat's left with the flat.
    const registration = await db.registration.findUniqueOrThrow({ where: { id: tenant.registrationId } });
    expect(registration.flaggedFields).toEqual([
      { path: 'properties.0.units.0.side', reason: 'لم تُعرف الجهة', kind: 'UNESTABLISHED' },
    ]);
  });

  it('refuses an edit form that still holds a flat ended since it was opened, and keeps rows by identity', async () => {
    const { card, tenant, flat, building } = await mixedCard('OWN-11');
    const [shopRow, flatRow] = card.units;
    const stored = await db.user.findUniqueOrThrow({ where: { id: tenant.id } });

    const payload = (units: Array<Record<string, unknown>>) =>
      adminUpdateCitizenSubmissionSchema.parse({
        personal: {
          firstName: stored.firstName,
          middleName: 'علي',
          lastName: stored.lastName,
          motherName: 'فاطمة خليل',
          gender: 'MALE',
          civilRecordNumber: '7',
          nationality: 'لبناني',
          isLebanese: true,
          residentStatus: 'VILLAGE_RESIDENT',
        },
        contact: { maritalStatus: 'MARRIED', phone: stored.phone, whatsappSameAsPhone: true, actualHouseholdMembers: '3' },
        properties: [
          {
            id: card.id,
            occupancyType: 'TENANT',
            landlordName: 'مالك المبنى',
            landlordPhone: card.landlordPhone,
            propertyType: 'BUILDING',
            neighborhood: 'الحي',
            propertyNumber: 'OWN-11',
            buildingName: 'بناية',
            buildingId: building.id,
            units,
          },
        ],
        flags: [],
      });

    const asLoaded = [
      { id: shopRow!.id, unitType: 'SHOP', floor: '0', unitArea: '45' },
      { id: flatRow!.id, unitType: 'APARTMENT', floor: '0', unitArea: '90', unitId: flat },
    ];

    // An ordinary save keeps both rows as the same rows.
    await within(() =>
      citizens.update({ tenantSlug: 'owners', citizenId: tenant.id, payload: payload(asLoaded), actor: actor() }),
    );
    const kept = await db.buildingUnit.findMany({ where: { propertyEntryId: card.id }, orderBy: { createdAt: 'asc' } });
    expect(kept.map((row) => row.id)).toEqual([shopRow!.id, flatRow!.id]);
    expect(Number(kept[0]!.unitArea)).toBe(45);

    // The flat ends from the file page while the form is still open elsewhere…
    await within(() =>
      tenancy.endCard(card.id, { reason: 'MOVED_OUT', rowIds: [flatRow!.id], afterStatus: 'UNKNOWN' }, actor()),
    );

    // …and that form's save is refused rather than bringing the flat back.
    await expect(
      within(() =>
        citizens.update({ tenantSlug: 'owners', citizenId: tenant.id, payload: payload(asLoaded), actor: actor() }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      await db.buildingUnit.count({ where: { propertyEntryId: card.id, unitId: flat, endedAt: null } }),
    ).toBe(0);
    expect(await db.unitOccupancy.count({ where: { citizenId: tenant.id, unitId: flat, toDate: null } })).toBe(0);
  });
});

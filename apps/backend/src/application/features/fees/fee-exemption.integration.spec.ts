import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { DamageService } from '../buildings/damage.service';
import { FeeExemptionService } from '../buildings/fee-exemption.service';
import { DataQualityService } from '../quality/data-quality.service';
import { ReportingService } from '../reporting/reporting.service';
import { assessCitizen, FeesService } from './fees.service';

/**
 * The two ways a unit is charged nothing (the user's decisions of 2026-10-07),
 * against a real tenant schema with 0077 applied: «معفاة من الرسوم» granted and
 * lifted through `FeeExemptionService`, and «غير صالحة للسكن» on a building whose
 * label says uninhabited — read back through `holdingsOf` + `assessCitizen`,
 * the path a billing run takes, and through «مراجعة الجودة».
 *
 * The fixture is a waqf parcel like Z-2-19-A «جامع الساحة», with synthetic
 * people: the mosque itself, and a shop beside it rented to a tenant.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_fee_exemption_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('units charged nothing', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let fees: FeesService;
  let exemptions: FeeExemptionService;
  let damage: DamageService;
  let quality: DataQualityService;
  let events: { emit: jest.Mock };
  const adminId = randomUUID();
  const admin = { id: adminId, role: 'SUPER_ADMIN' };

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-fx', tenantSlug: 'fx', schemaName: SCHEMA, prisma: db }, work);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    events = { emit: jest.fn() };
    const emitter = new EventEmitter2();
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    fees = new FeesService(
      context,
      emitter,
      {} as never,
      {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        invalidatePrefix: jest.fn().mockResolvedValue(undefined),
      } as never,
      {} as never,
      {} as never,
    );
    exemptions = new FeeExemptionService(context, audit, events as unknown as EventEmitter2);
    damage = new DamageService(context, emitter);
    quality = new DataQualityService(
      context,
      { proposals: jest.fn().mockResolvedValue({ total: 0, items: [] }) } as never,
      emitter,
      { get: jest.fn().mockResolvedValue(null), set: jest.fn(), invalidatePrefix: jest.fn() } as never,
      { get: () => 0 } as never,
    );

    await db.user.create({
      data: {
        id: adminId,
        kind: 'STAFF',
        tenantSlug: 'fx',
        email: `admin-${adminId}@fx.gov.lb`,
        firstName: 'مدير',
        lastName: 'النظام',
        role: 'SUPER_ADMIN' as never,
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  beforeEach(() => events.emit.mockClear());

  /** A citizen whose newest file holds one card with one line on `unitId`. */
  async function holder(buildingId: string, unitId: string, occupancyType: string, area: number, unitType: string) {
    const citizenId = randomUUID();
    await db.user.create({
      data: { id: citizenId, kind: 'CITIZEN', tenantSlug: 'fx', firstName: 'مواطن', lastName: citizenId.slice(0, 6) },
    });
    const registration = await db.registration.create({
      data: { citizenId, referenceNumber: `FX-${randomUUID()}`, createdById: adminId },
    });
    const card = await db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: occupancyType as never,
        propertyType: 'BUILDING' as never,
        buildingId,
        propertyNumber: '19',
      },
    });
    await db.buildingUnit.create({
      data: {
        propertyEntryId: card.id,
        unitId,
        unitType: unitType as never,
        unitArea: area,
        unitStatus: (occupancyType === 'OWNER' ? 'OWNER_OCCUPIED' : null) as never,
      },
    });
    await db.unitOccupancy.create({
      data: {
        unitId,
        citizenId,
        role: (occupancyType === 'OWNER' ? 'OWNER' : 'TENANT') as never,
        registrationId: registration.id,
      },
    });
    return citizenId;
  }

  async function waqfParcel(lifecycleStatus = 'IN_USE') {
    const tag = randomUUID().slice(0, 8);
    const building = await db.building.create({
      data: {
        parcelNumber: `19${tag}`,
        codeSuffix: 'A',
        code: `Z-2-19-${tag}`,
        structureType: 'MIXED_USE' as never,
        lifecycleStatus: lifecycleStatus as never,
        floorsCount: 1,
        createdById: adminId,
      },
    });
    const unit = (unitCode: string, sequence: number, unitType: string, unitStatus: string) =>
      db.unit.create({
        data: {
          buildingId: building.id,
          unitCode,
          floor: 0,
          sequence,
          unitType: unitType as never,
          unitArea: unitType === 'SHOP' ? 30 : 400,
          unitStatus: unitStatus as never,
          surveyStatus: 'COMPLETE' as never,
        },
      });
    const mosque = await unit('0001', 1, 'OFFICE', 'OWNER_OCCUPIED');
    const shop = await unit('0002', 2, 'SHOP', 'RENTED');
    const waqf = await holder(building.id, mosque.id, 'OWNER', 400, 'OFFICE');
    const tenant = await holder(building.id, shop.id, 'TENANT', 30, 'SHOP');
    return { building, mosque, shop, waqf, tenant };
  }

  async function bill(citizenId: string, bearer: 'OWNER' | 'OCCUPANT') {
    return within(async () => {
      for await (const batch of fees.holdingsOf([citizenId])) {
        return assessCitizen(batch[0]!.entries, { amount: 1000, basis: 'PER_AREA', bearer });
      }
      throw new Error('no holdings');
    });
  }

  it('charges the mosque nothing once exempt, under either bearer, and still bills the rented shop', async () => {
    const parcel = await waqfParcel();
    expect(await bill(parcel.waqf, 'OWNER')).toMatchObject({ kind: 'assessed', amount: 400_000 });

    const state = await within(() =>
      exemptions.set(parcel.mosque.id, { reason: 'PLACE_OF_WORSHIP', note: 'المسجد الجامع' }, admin),
    );
    expect(state).toMatchObject({ feeExemption: 'PLACE_OF_WORSHIP', feeExemptionNote: 'المسجد الجامع', feeExemptedById: adminId });

    for (const bearer of ['OWNER', 'OCCUPANT'] as const) {
      expect(await bill(parcel.waqf, bearer)).toMatchObject({
        kind: 'assessed',
        amount: 0,
        assessment: { exemptUnitCount: 1 },
      });
    }
    expect(await bill(parcel.tenant, 'OCCUPANT')).toMatchObject({ kind: 'assessed', amount: 30_000 });

    const rows = await db.auditLogEntry.findMany({
      where: { action: 'UNIT_FEE_EXEMPTION_SET', entityId: parcel.building.id },
    });
    expect(rows).toHaveLength(1);
    expect((rows[0]!.after as { citizens: string[] }).citizens).toEqual([parcel.waqf]);
    expect(events.emit).toHaveBeenCalledWith('building.changed', expect.objectContaining({ alreadyAudited: true }));
  });

  it('bills the mosque again once the exemption is lifted, and records the lifting', async () => {
    const parcel = await waqfParcel();
    await within(() => exemptions.set(parcel.mosque.id, { reason: 'PUBLIC_FACILITY' }, admin));
    await within(() => exemptions.set(parcel.mosque.id, { reason: null }, admin));

    const unit = await db.unit.findUniqueOrThrow({ where: { id: parcel.mosque.id } });
    expect([unit.feeExemption, unit.feeExemptionNote, unit.feeExemptedById, unit.feeExemptedAt]).toEqual([null, null, null, null]);
    expect(await bill(parcel.waqf, 'OWNER')).toMatchObject({ kind: 'assessed', amount: 400_000 });
    expect(
      await db.auditLogEntry.count({ where: { action: 'UNIT_FEE_EXEMPTION_LIFTED', entityId: parcel.building.id } }),
    ).toBe(1);
  });

  it('writes nothing when the same exemption is saved again', async () => {
    const parcel = await waqfParcel();
    await within(() => exemptions.set(parcel.mosque.id, { reason: 'PLACE_OF_WORSHIP' }, admin));
    await within(() => exemptions.set(parcel.mosque.id, { reason: 'PLACE_OF_WORSHIP' }, admin));
    expect(
      await db.auditLogEntry.count({ where: { action: 'UNIT_FEE_EXEMPTION_SET', entityId: parcel.building.id } }),
    ).toBe(1);
  });

  it('refuses «سبب آخر» with no reason in words at the database, whatever the caller sent', async () => {
    const parcel = await waqfParcel();
    await expect(within(() => exemptions.set(parcel.mosque.id, { reason: 'OTHER' }, admin))).rejects.toThrow();
    const unit = await db.unit.findUniqueOrThrow({ where: { id: parcel.mosque.id } });
    expect(unit.feeExemption).toBeNull();
  });

  it('refuses to exempt a structural floor', async () => {
    const parcel = await waqfParcel();
    const pilotis = await db.unit.create({
      data: { buildingId: parcel.building.id, unitCode: '0003', floor: 0, sequence: 3, unitType: 'PILOTIS' as never },
    });
    await expect(
      within(() => exemptions.set(pilotis.id, { reason: 'PLACE_OF_WORSHIP' }, admin)),
    ).rejects.toMatchObject({ code: 'FEE_EXEMPTION_STRUCTURAL_UNIT' });
  });

  it('lets a holder off a FLAT notice aimed at a category when all they hold of it is exempt — and bills them once lifted', async () => {
    const parcel = await waqfParcel();
    const store = await db.unit.create({
      data: { buildingId: parcel.building.id, unitCode: '0004', floor: 0, sequence: 4, unitType: 'WAREHOUSE' as never, unitArea: 100 },
    });
    const owner = await holder(parcel.building.id, store.id, 'OWNER', 100, 'WAREHOUSE');
    await within(() => exemptions.set(store.id, { reason: 'PUBLIC_FACILITY' }, admin));

    const notice = {
      title: `رسم المستودعات ${randomUUID().slice(0, 6)}`,
      amount: 50_000,
      basis: 'FLAT',
      bearer: 'OWNER',
      frequency: 'ONCE',
      targetType: 'BUILDING_CATEGORY',
      targetCategory: 'WAREHOUSE',
      dueDate: '2026-12-31',
    } as never;
    await expect(within(() => fees.issue(notice, admin))).rejects.toMatchObject({
      code: 'FEE_NOTHING_TO_CHARGE',
      params: expect.objectContaining({ feeExempt: 1 }),
    });

    await within(() => exemptions.set(store.id, { reason: null }, admin));
    await within(() => fees.issue(notice, admin));
    const bills = await db.citizenPayment.findMany({ where: { citizenId: owner } });
    expect(bills.map((bill) => Number(bill.amount))).toEqual([50_000]);
  });

  it("shows «معفاة» on the file for a منزل's flat and a census flat, which have no unit line", async () => {
    const tag = randomUUID().slice(0, 8);
    const house = await db.building.create({
      data: {
        parcelNumber: `20${tag}`,
        codeSuffix: 'A',
        code: `Z-2-20-${tag}`,
        structureType: 'INDEPENDENT_HOUSE' as never,
        floorsCount: 1,
        createdById: adminId,
      },
    });
    const flat = await db.unit.create({
      data: { buildingId: house.id, unitCode: '0001', floor: 0, sequence: 1, unitType: 'INDEPENDENT_HOUSE' as never },
    });
    const parcel = await waqfParcel();
    const citizenId = randomUUID();
    await db.user.create({
      data: { id: citizenId, kind: 'CITIZEN', tenantSlug: 'fx', firstName: 'مواطن', lastName: tag },
    });
    const registration = await db.registration.create({
      data: { citizenId, referenceNumber: `FX-${randomUUID()}`, createdById: adminId },
    });
    const houseCard = await db.propertyEntry.create({
      data: { registrationId: registration.id, occupancyType: 'OWNER' as never, propertyType: 'HOUSE' as never, buildingId: house.id, propertyNumber: '20' },
    });
    // A مبنى card with no lines: the census recorded this person on the shop.
    const blockCard = await db.propertyEntry.create({
      data: { registrationId: registration.id, occupancyType: 'OWNER' as never, propertyType: 'BUILDING' as never, buildingId: parcel.building.id, propertyNumber: '19' },
    });
    await db.unitOccupancy.create({ data: { unitId: parcel.shop.id, citizenId, role: 'OWNER' as never, registrationId: registration.id } });
    await within(() => exemptions.set(flat.id, { reason: 'OTHER', note: 'سكن الناطور البلدي' }, admin));
    await within(() => exemptions.set(parcel.shop.id, { reason: 'PUBLIC_FACILITY' }, admin));

    const reporting = new ReportingService(
      context,
      new EventEmitter2(),
      { get: async () => null, set: async () => undefined } as never,
      { get: () => undefined } as never,
    );
    const profile = await within(() => reporting.getCitizenProfile(citizenId));
    const cards = new Map(profile!.registrations[0]!.properties.map((card) => [card.id, card]));

    expect(cards.get(houseCard.id)!.heldUnits).toEqual([
      { unitId: flat.id, unitCode: '0001', feeExemption: 'OTHER', ownerBilling: null },
    ]);
    // The shop and nothing else of the building: the mosque is not this person's.
    expect(cards.get(blockCard.id)!.heldUnits).toEqual([
      expect.objectContaining({ unitId: parcel.shop.id, feeExemption: 'PUBLIC_FACILITY' }),
    ]);
    // Its only owner on record (the other spell is a tenant's): nothing to divide.
    expect(cards.get(blockCard.id)!.heldUnits[0]!.ownerBilling).toBeNull();
  });

  describe('a building labelled uninhabited', () => {
    it('is listed in «مراجعة الجودة» while its units are billed, and exempt — and cleared — once read «غير صالحة للسكن»', async () => {
      const parcel = await waqfParcel('WAR_DAMAGED_UNINHABITED');
      const listed = async () =>
        (await within(() => quality.findings())).items.filter(
          (finding) =>
            finding.kind === 'UNINHABITED_WITHOUT_READING' && finding.subjects.some((s) => s.id === parcel.building.id),
        );

      // The label alone exempts nothing: the tenant is still billed, and the building is listed.
      expect(await bill(parcel.tenant, 'OCCUPANT')).toMatchObject({ kind: 'assessed', amount: 30_000 });
      const findings = await listed();
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity: 'HIGH' });

      await within(() =>
        damage.record(
          { buildingId: parcel.building.id, level: 'RESTRICTED_USE', habitable: false, source: 'FIELD_VISIT' } as never,
          admin,
        ),
      );

      // «غير صالحة للسكن» exempts every fee — the owner-borne one too (decision of 2026-10-07).
      expect(await bill(parcel.tenant, 'OCCUPANT')).toMatchObject({ kind: 'assessed', amount: 0 });
      expect(await bill(parcel.waqf, 'OWNER')).toMatchObject({
        kind: 'assessed',
        amount: 0,
        assessment: { uninhabitableUnitCount: 1 },
      });
      expect(await listed()).toHaveLength(0);
    });

    it('is not listed for a unit only an archived file is still recorded on — nobody is billed for it', async () => {
      const parcel = await waqfParcel('WAR_DAMAGED_UNINHABITED');
      const listed = async () =>
        (await within(() => quality.findings())).items.filter(
          (finding) =>
            finding.kind === 'UNINHABITED_WITHOUT_READING' && finding.subjects.some((s) => s.id === parcel.building.id),
        );
      expect(await listed()).toHaveLength(1);

      // Archiving a file leaves its spells open; billing reads active files only.
      await db.user.updateMany({ where: { id: { in: [parcel.waqf, parcel.tenant] } }, data: { isActive: false } });

      expect(await listed()).toHaveLength(0);
    });
  });
});

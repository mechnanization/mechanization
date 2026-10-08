import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { CreateFeeNotice } from '@mechanization/shared-schemas';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { PrismaCaseRepository } from '../../../infrastructure/repositories/case.repository';
import { ValidationError } from '../../../domain/errors/domain-error';
import { AuditService } from '../audit/audit.service';
import { CasesService } from '../cases/cases.service';
import { BuildingsService } from '../buildings/buildings.service';
import { OwnerBillingService } from '../buildings/owner-billing.service';
import { assessCitizen, FeesService } from './fees.service';

/**
 * «توزيع الرسم على المالكين» against a real tenant schema (migration 0075
 * applied): the choice saved through `OwnerBillingService`, and each owner's
 * bill read back through `holdingsOf` + `assessCitizen` — exactly the path a
 * billing run takes.
 *
 * The fixture is A2-420-A/0005 as production held it on 2026-10-07, with
 * synthetic people: a 300 m² shop, four brothers, each brother's own file
 * claiming it, «مشغولة من المالك». Before 0075 each was billed the whole shop.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_co_owner_billing_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('co-owner billing', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let fees: FeesService;
  let buildings: BuildingsService;
  let ownerBilling: OwnerBillingService;
  let events: { emit: jest.Mock };
  const officerId = randomUUID();
  const actor = { id: officerId, role: 'FIELD_INSPECTOR' };

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-cob', tenantSlug: 'cob', schemaName: SCHEMA, prisma: db }, work);

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
    const cases = new CasesService(
      new PrismaCaseRepository(context),
      { findById: async () => ({ id: officerId, kind: 'STAFF' }) } as never,
      emitter,
    );
    buildings = new BuildingsService(context, cases, emitter);
    ownerBilling = new OwnerBillingService(context, fees, audit, events as unknown as EventEmitter2);

    await db.user.create({
      data: {
        id: officerId,
        kind: 'STAFF',
        tenantSlug: 'cob',
        email: `officer-${officerId}@cob.gov.lb`,
        firstName: 'علي',
        lastName: 'المراقب',
        role: 'FIELD_INSPECTOR' as never,
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  beforeEach(() => events.emit.mockClear());

  /** A fresh A2-420-A per test: the shop, the four brothers, each with a file claiming it. */
  async function seed(options: { withFile?: boolean[] } = {}) {
    const tag = randomUUID().slice(0, 8);
    const building = await db.building.create({
      data: {
        parcelNumber: `420${tag}`,
        codeSuffix: 'A',
        code: `A2-420-${tag}`,
        structureType: 'MIXED_USE' as never,
        floorsCount: 1,
        createdById: officerId,
      },
    });
    const shop = await db.unit.create({
      data: {
        buildingId: building.id,
        unitCode: '0005',
        floor: 0,
        sequence: 5,
        unitType: 'SHOP' as never,
        unitArea: 300,
        unitStatus: 'OWNER_OCCUPIED' as never,
        surveyStatus: 'COMPLETE' as never,
      },
    });

    const names = ['علي', 'معروف', 'عارف', 'حسين'];
    const brothers: string[] = [];
    for (const [index, first] of names.entries()) {
      const citizenId = randomUUID();
      brothers.push(citizenId);
      await db.user.create({
        data: { id: citizenId, kind: 'CITIZEN', tenantSlug: 'cob', firstName: first, middleName: 'حسن', lastName: `سرور${tag}` },
      });
      const registration = await db.registration.create({
        data: { citizenId, referenceNumber: `COB-${randomUUID()}`, createdById: officerId },
      });
      if (options.withFile?.[index] !== false) {
        const card = await db.propertyEntry.create({
          data: {
            registrationId: registration.id,
            occupancyType: 'OWNER' as never,
            propertyType: 'BUILDING' as never,
            buildingId: building.id,
            propertyNumber: building.parcelNumber,
          },
        });
        await db.buildingUnit.create({
          data: {
            propertyEntryId: card.id,
            unitId: shop.id,
            unitType: 'SHOP' as never,
            unitArea: 300,
            unitStatus: 'OWNER_OCCUPIED' as never,
          },
        });
      }
      await db.unitOccupancy.create({
        data: { unitId: shop.id, citizenId, role: 'OWNER' as never, registrationId: registration.id },
      });
    }
    return { building, shop, brothers };
  }

  /** What one brother's bill would be under a 10,000-per-m² owner-borne notice. */
  async function billOf(
    citizenId: string,
    notice: { amount: number; basis: 'PER_AREA' | 'PER_UNIT'; bearer: 'OWNER' | 'OCCUPANT' } = {
      amount: 10_000,
      basis: 'PER_AREA',
      bearer: 'OWNER',
    },
  ) {
    return within(async () => {
      for await (const batch of fees.holdingsOf([citizenId])) {
        return assessCitizen(batch[0]!.entries, notice);
      }
      throw new Error('no holdings');
    });
  }

  async function amounts(brothers: string[]) {
    const outcomes = await Promise.all(brothers.map((id) => billOf(id)));
    return outcomes.map((outcome) => (outcome.kind === 'assessed' ? outcome.amount : outcome.reason));
  }

  it('splits the shop equally between the four brothers by default — the whole shop once, not four times', async () => {
    const { brothers } = await seed();
    expect(await amounts(brothers)).toEqual([750_000, 750_000, 750_000, 750_000]);
  });

  it('bills علي the whole shop once he is named responsible, and his brothers nothing', async () => {
    const { shop, brothers } = await seed();
    const ali = brothers[0]!;

    const state = await within(() =>
      ownerBilling.set(shop.id, { mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: ali }, actor),
    );
    expect(state).toMatchObject({ mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: ali, effectiveMode: 'RESPONSIBLE_OWNER' });
    expect(await amounts(brothers)).toEqual([3_000_000, 0, 0, 0]);

    const brother = await billOf(brothers[1]!);
    expect(brother.kind === 'assessed' && brother.assessment.coOwnerPaidUnitCount).toBe(1);

    // Audited inside the transaction, naming every co-owner so their bills are traced.
    const rows = await db.auditLogEntry.findMany({ where: { action: 'UNIT_OWNER_BILLING_SET', entityId: shop.buildingId } });
    expect(rows).toHaveLength(1);
    expect((rows[0]!.after as { citizens: string[] }).citizens.sort()).toEqual([...brothers].sort());
    expect(events.emit).toHaveBeenCalledWith('building.changed', expect.objectContaining({ alreadyAudited: true }));
  });

  it('tells a clerk who bills a brother the responsible owner pays for why nothing was issued', async () => {
    /*
      He is matched — he owns the shop — and owes nothing for it: the notice
      bills nobody because another owner pays, not because nobody matched.
      «لا يوجد مواطنون مطابقون لهذه الفئة» sent the clerk to the wrong place.
    */
    const { shop, brothers } = await seed();
    await within(() => ownerBilling.set(shop.id, { mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: brothers[0]! }, actor));
    const issuing = within(() =>
      fees.issue(
        {
          title: `رسم الأرصفة ${randomUUID().slice(0, 8)}`,
          amount: 10_000,
          basis: 'PER_AREA',
          bearer: 'OWNER',
          frequency: 'ONCE',
          targetType: 'INDIVIDUAL_CITIZEN',
          targetCitizenId: brothers[1]!,
          dueDate: '2026-12-31',
        } as CreateFeeNotice,
        actor,
      ),
    );
    await expect(issuing).rejects.toMatchObject({
      code: 'FEE_NOTHING_TO_CHARGE',
      params: { held: 0, uninhabitable: 0, exempted: 0, coOwnerPaid: 1, unassessable: 0 },
    });
    expect(await db.citizenPayment.count({ where: { citizenId: brothers[1]! } })).toBe(0);
  });

  it('divides by أسهم recorded in the same save', async () => {
    const { shop, brothers } = await seed();
    await within(() =>
      ownerBilling.set(
        shop.id,
        {
          mode: 'BY_SHARES',
          shares: [
            { citizenId: brothers[0]!, shares: 1200 },
            { citizenId: brothers[1]!, shares: 400 },
            { citizenId: brothers[2]!, shares: 400 },
            { citizenId: brothers[3]!, shares: 400 },
          ],
        },
        actor,
      ),
    );
    expect(await amounts(brothers)).toEqual([1_500_000, 500_000, 500_000, 500_000]);
    const spells = await db.unitOccupancy.findMany({ where: { unitId: shop.id }, select: { shares: true } });
    expect(spells.map((spell) => spell.shares).sort()).toEqual([1200, 400, 400, 400].sort());
  });

  it('refuses a responsible owner whose own file does not claim the shop — billing could not charge him', async () => {
    const { shop, brothers } = await seed({ withFile: [false, true, true, true] });
    await expect(
      within(() => ownerBilling.set(shop.id, { mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: brothers[0]! }, actor)),
    ).rejects.toMatchObject({ code: 'OWNER_BILLING_RESPONSIBLE_NOT_BILLED' });
    const unit = await db.unit.findUniqueOrThrow({ where: { id: shop.id } });
    expect(unit.ownerBillingMode).toBeNull();
    expect(await db.auditLogEntry.count({ where: { action: 'UNIT_OWNER_BILLING_SET', entityId: shop.buildingId } })).toBe(0);
  });

  it('refuses «حسب الأسهم» with an owner’s أسهم missing, and changes nothing', async () => {
    const { shop, brothers } = await seed();
    const attempt = within(() =>
      ownerBilling.set(shop.id, { mode: 'BY_SHARES', shares: [{ citizenId: brothers[0]!, shares: 600 }] }, actor),
    );
    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toMatchObject({ code: 'OWNER_BILLING_SHARES_MISSING' });
    const spells = await db.unitOccupancy.findMany({ where: { unitId: shop.id }, select: { shares: true } });
    expect(spells.every((spell) => spell.shares === null)).toBe(true);
  });

  it('falls back to the equal split between those left when the responsible owner’s ownership ends', async () => {
    const { shop, brothers } = await seed();
    await within(() => ownerBilling.set(shop.id, { mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: brothers[0]! }, actor));
    await db.unitOccupancy.updateMany({
      where: { unitId: shop.id, citizenId: brothers[0]! },
      data: { toDate: new Date(), endReason: 'OWNERSHIP_TRANSFERRED' as never },
    });
    const rest = await amounts(brothers.slice(1));
    expect(rest).toEqual([1_000_000, 1_000_000, 1_000_000]);
  });

  it('keeps an owner’s أسهم when the drawer re-records him with the box empty', async () => {
    const { shop, brothers } = await seed();
    await within(() =>
      ownerBilling.set(
        shop.id,
        { mode: 'BY_SHARES', shares: brothers.map((citizenId) => ({ citizenId, shares: 600 })) },
        actor,
      ),
    );
    await within(() =>
      buildings.recordOccupancy({ unitId: shop.id, citizenId: brothers[2]!, role: 'OWNER' } as never, actor),
    );
    const spell = await db.unitOccupancy.findFirstOrThrow({
      where: { unitId: shop.id, citizenId: brothers[2]!, toDate: null },
      select: { shares: true },
    });
    expect(spell.shares).toBe(600);
    expect(await amounts(brothers)).toEqual([750_000, 750_000, 750_000, 750_000]);
  });

  it('leaves a let co-owned shop to its tenant: no owner pays its occupancy fee', async () => {
    const { shop, brothers } = await seed();
    await db.unit.update({ where: { id: shop.id }, data: { unitStatus: 'RENTED' as never } });
    await db.buildingUnit.updateMany({ where: { unitId: shop.id }, data: { unitStatus: 'RENTED' as never } });
    const outcomes = await Promise.all(
      brothers.map((id) => billOf(id, { amount: 100_000, basis: 'PER_UNIT', bearer: 'OCCUPANT' })),
    );
    expect(outcomes.map((outcome) => outcome.kind === 'assessed' && outcome.amount)).toEqual([0, 0, 0, 0]);
  });

  it('leaves an archived owner out: the open files carry the flat, and an archived responsible owner falls back', async () => {
    const { shop, brothers } = await seed();
    await within(() => ownerBilling.set(shop.id, { mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: brothers[0]! }, actor));
    // «أرشفة الملف» on the responsible owner: billing targets open files only, so he would pay nothing.
    await db.user.update({ where: { id: brothers[0]! }, data: { isActive: false } });
    expect(await amounts(brothers.slice(1))).toEqual([1_000_000, 1_000_000, 1_000_000]);

    // And he cannot be named again while his file is archived.
    await expect(
      within(() => ownerBilling.set(shop.id, { mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: brothers[0]! }, actor)),
    ).rejects.toMatchObject({ code: 'OWNER_BILLING_RESPONSIBLE_NOT_OWNER' });
  });

  it('divides between the open files when a co-owner is archived under the default split', async () => {
    const { brothers } = await seed();
    await db.user.update({ where: { id: brothers[3]! }, data: { isActive: false } });
    expect(await amounts(brothers.slice(0, 3))).toEqual([1_000_000, 1_000_000, 1_000_000]);
  });
});

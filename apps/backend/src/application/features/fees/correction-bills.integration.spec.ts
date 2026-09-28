import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { CreateFeeNotice } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import type { WhishGateway } from '../../../domain/interfaces/whish-gateway.interface';
import { ConflictError } from '../../common/exceptions';
import { CorrectionBillsService } from './correction-bills.service';
import { FeesService } from './fees.service';
import { PaymentLedgerService } from './payment-ledger.service';

/**
 * «فواتير تأثّرت بتصحيحات», end to end: the open bills, today's figure through
 * the billing run's own reading of the register, the trail since each bill, and
 * the accountant's review.
 *
 * The register is changed directly and the trail rows written in the shapes the
 * features write them (`bill-corrections.spec.ts` covers the rules on those
 * shapes). What this proves is the reading: which rows are fetched, for whom,
 * since when — and that nothing here writes to a bill.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_correction_bills_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('CorrectionBillsService', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let fees: FeesService;
  let bills: CorrectionBillsService;
  const clerkId = randomUUID();
  const actor = () => ({ id: clerkId, role: 'ACCOUNTANT' });

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-corrections', tenantSlug: 'corrections', schemaName: SCHEMA, prisma: db }, work);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    fees = new FeesService(
      context,
      { emit: jest.fn() } as unknown as EventEmitter2,
      {} as WhishGateway,
      {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        invalidatePrefix: jest.fn().mockResolvedValue(undefined),
      } as unknown as RedisCacheService,
      {} as PaymentLedgerService,
    );
    bills = new CorrectionBillsService(context, fees, new PrismaAuditRepository(context));

    await db.user.create({
      data: {
        id: clerkId,
        kind: 'STAFF',
        tenantSlug: 'corrections',
        email: `accountant-${clerkId}@corrections.gov.lb`,
        firstName: 'محاسبة',
        lastName: 'البلدية',
        role: 'ACCOUNTANT',
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  let parcel = 8800;

  /** A building of `count` units of one type, and a citizen whose card holds them all. */
  const holder = async (unitType: string, count: number, unitArea = 50) => {
    parcel += 1;
    const building = await db.building.create({
      data: { parcelNumber: String(parcel), codeSuffix: 'A', code: `X-${parcel}-A`, structureType: 'RESIDENTIAL_BUILDING' },
    });
    const units = [];
    for (let sequence = 1; sequence <= count; sequence += 1) {
      units.push(
        await db.unit.create({
          data: {
            buildingId: building.id,
            floor: 1,
            sequence,
            unitCode: `X-${parcel}-A-10${sequence}`,
            unitType: unitType as never,
            unitArea,
          },
        }),
      );
    }
    const citizenId = randomUUID();
    await db.user.create({
      data: { id: citizenId, kind: 'CITIZEN', tenantSlug: 'corrections', firstName: 'مالك', lastName: `${parcel}` },
    });
    const registration = await db.registration.create({
      data: {
        citizenId,
        referenceNumber: `REF-${randomUUID().slice(0, 12)}`,
        properties: {
          create: {
            occupancyType: 'OWNER',
            propertyType: 'BUILDING',
            propertyNumber: String(parcel),
            buildingId: building.id,
            units: {
              create: units.map((unit) => ({
                unitType: unitType as never,
                floor: '1',
                unitArea,
                unitId: unit.id,
              })),
            },
          },
        },
      },
      include: { properties: { include: { units: true } } },
    });
    return { building, units, citizenId, lines: registration.properties[0]!.units };
  };

  const issue = async (citizenId: string, over: Partial<CreateFeeNotice> = {}) => {
    const issued = await within(() =>
      fees.issue(
        {
          title: `رسم ${randomUUID().slice(0, 8)}`,
          amount: 1000,
          basis: 'PER_UNIT',
          bearer: 'OCCUPANT',
          frequency: 'ONCE',
          targetType: 'INDIVIDUAL_CITIZEN',
          targetCitizenId: citizenId,
          dueDate: '2026-12-31',
          ...over,
        } as CreateFeeNotice,
        actor(),
      ),
    );
    return db.citizenPayment.findFirstOrThrow({ where: { citizenId, feeNoticeId: issued.noticeId } });
  };

  /** A trail row, written a second after the bill so it is plainly "since". */
  const trail = (bill: { createdAt: Date }, row: Record<string, unknown>) =>
    db.auditLogEntry.create({
      data: {
        actorId: clerkId,
        actorType: 'STAFF',
        actorRole: 'FIELD_INSPECTOR',
        createdAt: new Date(bill.createdAt.getTime() + 1000),
        ...row,
      } as never,
    });

  const endLine = (id: string) => db.buildingUnit.update({ where: { id }, data: { endedAt: new Date() } });

  const listed = async (paymentId: string, includeReviewed = false) =>
    (await within(() => bills.list({ includeReviewed, limit: 100, offset: 0 }))).items.find(
      (item) => item.paymentId === paymentId,
    );

  it('lists a bill whose card a correction shrank, with today’s figure and the correction', async () => {
    const { citizenId, lines } = await holder('SHOP', 2);
    const bill = await issue(citizenId);
    expect(Number(bill.amount)).toBe(2000);

    await endLine(lines[1]!.id);
    await trail(bill, {
      action: 'CITIZEN_UPDATED',
      entityType: 'User',
      entityId: citizenId,
      after: {
        cards: [{ cardId: 'c', kind: 'changed', rows: { added: 0, removed: 1, changed: 0 } }],
        reason: 'المحل الثاني سُجّل خطأً',
      },
    });

    const item = await listed(bill.id);
    expect(item).toMatchObject({
      citizenId,
      amount: 2000,
      now: { kind: 'ASSESSED', amount: 1000 },
      difference: -1000,
      review: null,
    });
    expect(item!.lines!.removed).toHaveLength(1);
    expect(item!.changes).toHaveLength(1);
    expect(item!.changes[0]).toMatchObject({ kind: 'CORRECTION', entry: { action: 'CITIZEN_UPDATED' } });
    // The bill itself is untouched.
    const after = await db.citizenPayment.findUniqueOrThrow({ where: { id: bill.id } });
    expect(Number(after.amount)).toBe(2000);
    expect(after.assessment).toEqual(bill.assessment);
  });

  it('leaves out a real change that took effect after the bill, and keeps one the register recorded late', async () => {
    const sold = await holder('SHOP', 2);
    const soldBill = await issue(sold.citizenId);
    const late = await holder('SHOP', 2);
    const lateBill = await issue(late.citizenId);

    for (const [who, bill, endedAt] of [
      [sold, soldBill, new Date(soldBill.createdAt.getTime() + 86_400_000)],
      [late, lateBill, new Date('2026-01-15T00:00:00.000Z')],
    ] as const) {
      await endLine(who.lines[0]!.id);
      await trail(bill, {
        action: 'OWNERSHIP_ENDED',
        entityType: 'User',
        entityId: who.citizenId,
        after: { reason: 'OWNERSHIP_TRANSFERRED', endedAt: endedAt.toISOString(), unitCodes: [who.units[0]!.unitCode] },
      });
      // The building's copy of the same ending, which the file's row already tells.
      await trail(bill, {
        action: 'OCCUPANCY_ENDED',
        entityType: 'Building',
        entityId: who.building.id,
        before: { unitCode: who.units[0]!.unitCode, citizenId: who.citizenId },
        after: { reason: 'OWNERSHIP_TRANSFERRED', toDate: endedAt.toISOString(), via: 'OWNERSHIP_ENDED' },
      });
    }

    expect(await listed(soldBill.id)).toBeUndefined();
    const item = await listed(lateBill.id);
    expect(item?.difference).toBe(-1000);
    expect(item?.changes.map((change) => [change.kind, change.entry.action])).toEqual([['DATED_CHANGE', 'OWNERSHIP_ENDED']]);
    expect(item?.changes[0]!.effectiveOn).toBe('2026-01-15T00:00:00.000Z');
  });

  it('traces a unit corrected on the matrix to its holder’s bill, and not a neighbour’s edit', async () => {
    const { building, units, citizenId } = await holder('SHOP', 1, 100);
    const bill = await issue(citizenId, { basis: 'PER_AREA', amount: 10 });
    expect(Number(bill.amount)).toBe(1000);

    const neighbour = await db.unit.create({
      data: { buildingId: building.id, floor: 2, sequence: 1, unitCode: `${units[0]!.unitCode}-N`, unitType: 'SHOP', unitArea: 30 },
    });
    await db.unit.update({ where: { id: units[0]!.id }, data: { unitArea: 80 } });
    await trail(bill, {
      action: 'UNIT_UPDATED',
      entityType: 'Building',
      entityId: building.id,
      before: { unitArea: 100, unitCode: units[0]!.unitCode },
      after: { unitArea: 80, unitCode: units[0]!.unitCode, changedFields: ['unitArea'] },
    });
    await trail(bill, {
      action: 'UNIT_UPDATED',
      entityType: 'Building',
      entityId: building.id,
      before: { unitArea: 30, unitCode: neighbour.unitCode },
      after: { unitArea: 35, unitCode: neighbour.unitCode, changedFields: ['unitArea'] },
    });

    const item = await listed(bill.id);
    expect(item).toMatchObject({ now: { kind: 'ASSESSED', amount: 800 }, difference: -200 });
    expect(item!.changes).toHaveLength(1);
    expect(item!.changes[0]!.entry.after).toMatchObject({ unitCode: units[0]!.unitCode, unitArea: 80 });
  });

  it('does not list a bill whose difference no recorded change explains', async () => {
    const { citizenId, lines } = await holder('SHOP', 2);
    const bill = await issue(citizenId);
    await endLine(lines[0]!.id);
    // Only a phone number changed on the file.
    await trail(bill, {
      action: 'CITIZEN_UPDATED',
      entityType: 'User',
      entityId: citizenId,
      after: { changed: ['phone'] },
    });
    expect(await listed(bill.id)).toBeUndefined();
  });

  it('a flat charge to a category: listed once the citizen holds none of it', async () => {
    const { citizenId, lines } = await holder('CLINIC', 1);
    await issue(citizenId, { basis: 'FLAT', amount: 5000, targetType: 'BUILDING_CATEGORY', targetCategory: 'CLINIC', targetCitizenId: undefined });
    const bill = await db.citizenPayment.findFirstOrThrow({ where: { citizenId, title: { startsWith: 'رسم' } }, orderBy: { createdAt: 'desc' } });
    expect(Number(bill.amount)).toBe(5000);
    await endLine(lines[0]!.id);
    await trail(bill, {
      action: 'CITIZEN_UPDATED',
      entityType: 'User',
      entityId: citizenId,
      after: { cards: [{ cardId: 'c', kind: 'changed', rows: { added: 0, removed: 1, changed: 0 } }], reason: 'ليست عيادة' },
    });
    expect(await listed(bill.id)).toMatchObject({ now: { kind: 'NOT_TARGETED' }, difference: -5000 });
  });

  it('a review hides the bill at the figure it saw, refuses a figure it did not, and a later correction reopens it', async () => {
    const { citizenId, lines } = await holder('SHOP', 3);
    const bill = await issue(citizenId);
    await endLine(lines[2]!.id);
    await trail(bill, {
      action: 'CITIZEN_UPDATED',
      entityType: 'User',
      entityId: citizenId,
      after: { cards: [{ cardId: 'c', kind: 'changed' }], reason: 'تصحيح' },
    });
    expect(await listed(bill.id)).toMatchObject({ now: { amount: 2000 } });

    const stale = await within(() => bills.review(bill.id, { note: 'أُبلغ المواطن', figure: 'ASSESSED:1000' }, actor())).catch((error) => error);
    expect(stale).toBeInstanceOf(ConflictError);
    expect(stale.details).toMatchObject({ code: 'FIGURE_CHANGED', figure: 'ASSESSED:2000' });

    await within(() => bills.review(bill.id, { note: 'أُبلغ المواطن بالفرق', figure: 'ASSESSED:2000' }, actor()));
    expect(await listed(bill.id)).toBeUndefined();
    expect(await listed(bill.id, true)).toMatchObject({
      review: { note: 'أُبلغ المواطن بالفرق', by: 'محاسبة البلدية', current: true },
    });
    const written = await db.auditLogEntry.findFirstOrThrow({ where: { action: 'BILL_BASIS_REVIEWED', entityId: bill.id } });
    expect(written).toMatchObject({ entityType: 'Payment', actorId: clerkId });

    // Another correction moves the figure: the bill is back, its old review shown as stale.
    await endLine(lines[1]!.id);
    await trail({ createdAt: new Date(Date.now()) }, {
      action: 'CITIZEN_UPDATED',
      entityType: 'User',
      entityId: citizenId,
      after: { cards: [{ cardId: 'c', kind: 'changed' }], reason: 'تصحيح ثانٍ' },
    });
    expect(await listed(bill.id)).toMatchObject({ now: { amount: 1000 }, review: { current: false } });
  });

  it('a settled bill is not listed, and cannot be reviewed', async () => {
    const { citizenId, lines } = await holder('SHOP', 2);
    const bill = await issue(citizenId);
    await endLine(lines[0]!.id);
    await trail(bill, {
      action: 'CITIZEN_UPDATED',
      entityType: 'User',
      entityId: citizenId,
      after: { cards: [{ cardId: 'c', kind: 'removed' }], reason: 'تصحيح' },
    });
    await db.citizenPayment.update({ where: { id: bill.id }, data: { paymentStatus: 'PAID', paidAmount: 2000, paidAt: new Date() } });

    expect(await listed(bill.id, true)).toBeUndefined();
    const refused = await within(() => bills.review(bill.id, { note: 'مراجعة', figure: 'ASSESSED:1000' }, actor())).catch((error) => error);
    expect(refused).toBeInstanceOf(ConflictError);
    expect(refused.details).toMatchObject({ code: 'NOT_OPEN' });
  });
});

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { CreateFeeNotice } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import type { WhishGateway } from '../../../domain/interfaces/whish-gateway.interface';
import { FeesService } from './fees.service';
import { PaymentLedgerService } from './payment-ledger.service';

/**
 * Billing over the census, end to end — the query, not the arithmetic.
 *
 * `assessment.spec.ts` covers what `billableUnits` and `assessCitizen` decide,
 * against hand-built objects. What it cannot cover is the half of P2-T8 that
 * only exists as a Prisma `select`: whether the rows those functions are handed
 * at runtime are the rows they were designed for. A join that names the wrong
 * relation, filters the wrong way, or hands back a `Decimal` where a number was
 * expected produces a bill that is quietly wrong, and every unit test in the
 * project would still pass.
 *
 * Two joins are at risk and both are new:
 *
 *  - each card line's linked `Unit`, which now outranks the card field by field;
 *  - each citizen's `UnitOccupancy` rows, which are what make a مبنى card that
 *    itemises nothing assessable at all.
 *
 * Going through `issue()` rather than the assessment in isolation is deliberate:
 * it exercises `resolveTargets` too, so a citizen who is assessed correctly but
 * never *selected* — the silent under-billing the superset in `resolveTargets`
 * exists to prevent — fails here rather than in production.
 *
 * Set `TEST_DATABASE_URL` to run it; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_billing_census_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);

describeIfDb('billing over the census', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let fees: FeesService;
  let clerkId: string;

  const actor = () => ({ id: clerkId, role: 'SUPER_ADMIN' });

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);

    fees = new FeesService(
      {
        get prisma() {
          return db;
        },
        tenantSlug: 'census-billing',
        tenantId: 'tenant-1',
      } as unknown as TenantContextService,
      { emit: jest.fn() } as unknown as EventEmitter2,
      {} as WhishGateway,
      {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        invalidatePrefix: jest.fn().mockResolvedValue(undefined),
      } as unknown as RedisCacheService,
      {} as PaymentLedgerService,
    );

    clerkId = randomUUID();
    await db.user.create({
      data: {
        id: clerkId,
        kind: 'STAFF',
        tenantSlug: 'census-billing',
        email: `clerk-${clerkId}@census.gov.lb`,
        firstName: 'موظف',
        lastName: 'الجباية',
        role: 'SUPER_ADMIN',
      },
    });
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  });

  /**
   * Every notice issued here targets one citizen, so the assertions are about
   * that citizen's bill and nothing else — no test depends on being the only
   * one in the file.
   */
  const notice = (over: Partial<CreateFeeNotice> = {}): CreateFeeNotice =>
    ({
      title: `رسم ${randomUUID().slice(0, 8)}`,
      amount: 1000,
      basis: 'PER_UNIT',
      bearer: 'OCCUPANT',
      frequency: 'ONCE',
      targetType: 'INDIVIDUAL_CITIZEN',
      dueDate: '2026-12-31',
      ...over,
    }) as CreateFeeNotice;

  /** A citizen with one registration and one property card on it. */
  const citizenWith = async (card: {
    propertyType: string;
    propertyNumber: string;
    occupancyType?: string;
    unitType?: string | null;
    unitArea?: number | null;
    buildingId?: string | null;
    units?: Array<{
      unitType: string | null;
      floor: string;
      unitArea: number | null;
      unitId?: string | null;
    }>;
  }): Promise<{ citizenId: string; propertyEntryId: string }> => {
    const citizenId = randomUUID();
    await db.user.create({
      data: {
        id: citizenId,
        kind: 'CITIZEN',
        tenantSlug: 'census-billing',
        firstName: 'مالك',
        lastName: randomUUID().slice(0, 8),
      },
    });

    const registration = await db.registration.create({
      data: {
        citizenId,
        referenceNumber: `REF-${randomUUID().slice(0, 12)}`,
        properties: {
          create: {
            occupancyType: (card.occupancyType ?? 'OWNER') as never,
            propertyType: card.propertyType as never,
            propertyNumber: card.propertyNumber,
            unitType: (card.unitType ?? null) as never,
            unitArea: card.unitArea ?? null,
            buildingId: card.buildingId ?? null,
            units: {
              create: (card.units ?? []).map((unit) => ({
                unitType: (unit.unitType ?? null) as never,
                floor: unit.floor,
                unitArea: unit.unitArea,
                unitId: unit.unitId ?? null,
              })),
            },
          },
        },
      },
      include: { properties: { select: { id: true } } },
    });

    return { citizenId, propertyEntryId: registration.properties[0]!.id };
  };

  /** A building with `count` flats on floor 1, returned newest-code-first. */
  const buildingWithUnits = async (
    parcelNumber: string,
    units: Array<{ unitType: string; unitArea: number | null; sequence: number }>,
  ) => {
    const building = await db.building.create({
      data: {
        parcelNumber,
        codeSuffix: 'A',
        code: `X-${parcelNumber}-A`,
        structureType: 'RESIDENTIAL_BUILDING',
      },
    });

    const created = [];
    for (const unit of units) {
      created.push(
        await db.unit.create({
          data: {
            buildingId: building.id,
            floor: 1,
            sequence: unit.sequence,
            unitCode: `010${unit.sequence}`,
            unitType: unit.unitType as never,
            unitArea: unit.unitArea,
          },
        }),
      );
    }
    return { building, units: created };
  };

  /** The single invoice a notice raised for one citizen. */
  const invoiceFor = async (citizenId: string, noticeId: string) =>
    db.citizenPayment.findFirst({ where: { citizenId, feeNoticeId: noticeId } });

  // ─────────────────  The link on a card's own unit rows  ─────────────────

  it('bills from the linked unit, not the stale card line', async () => {
    /*
      The card says 100 m² and APARTMENT; the matrix — corrected by an officer
      standing in it — says 250 m² and SHOP. Under a per-area fee the two differ
      by 150,000 LBP, so this is exactly the number a citizen would dispute.
    */
    const { units } = await buildingWithUnits('7701', [
      { unitType: 'SHOP', unitArea: 250, sequence: 1 },
    ]);

    const { citizenId } = await citizenWith({
      propertyType: 'BUILDING',
      propertyNumber: '7701',
      units: [{ unitType: 'APARTMENT', floor: '1', unitArea: 100, unitId: units[0]!.id }],
    });

    const issued = await fees.issue(
      notice({ basis: 'PER_AREA', amount: 1000, targetCitizenId: citizenId }),
      actor(),
    );

    const invoice = await invoiceFor(citizenId, issued.noticeId);
    expect(Number(invoice?.amount)).toBe(250_000);
  });

  it('falls back to the card’s area when the linked unit has none', async () => {
    // A generated matrix row nobody has measured. Taking the whole canonical
    // row would lose the officer's measurement and make the citizen
    // unassessable over a number the register already holds.
    const { units } = await buildingWithUnits('7702', [
      { unitType: 'APARTMENT', unitArea: null, sequence: 1 },
    ]);

    const { citizenId } = await citizenWith({
      propertyType: 'BUILDING',
      propertyNumber: '7702',
      units: [{ unitType: 'APARTMENT', floor: '1', unitArea: 120, unitId: units[0]!.id }],
    });

    const issued = await fees.issue(
      notice({ basis: 'PER_AREA', amount: 1000, targetCitizenId: citizenId }),
      actor(),
    );

    expect(Number((await invoiceFor(citizenId, issued.noticeId))?.amount)).toBe(120_000);
  });

  // ───────────────  Flats held through the census, not the card  ───────────────

  it('bills the flats a citizen is recorded in when their card itemises none', async () => {
    /*
      The question P2-T8 left open, proved against a real join.

      The card is a مبنى with no unit rows — before this it stopped the
      assessment entirely. The census says this citizen occupies two of the
      building's three flats, so that is what they are billed for: not one
      phantom unit, and not the building's whole matrix.
    */
    const { building, units } = await buildingWithUnits('7703', [
      { unitType: 'APARTMENT', unitArea: 100, sequence: 1 },
      { unitType: 'APARTMENT', unitArea: 100, sequence: 2 },
      { unitType: 'APARTMENT', unitArea: 100, sequence: 3 },
    ]);

    const { citizenId } = await citizenWith({
      propertyType: 'BUILDING',
      propertyNumber: '7703',
      buildingId: building.id,
      units: [],
    });

    await db.unitOccupancy.createMany({
      data: [
        { unitId: units[0]!.id, citizenId, role: 'OWNER' },
        { unitId: units[1]!.id, citizenId, role: 'OWNER' },
      ],
    });

    const issued = await fees.issue(
      notice({ basis: 'PER_UNIT', amount: 1000, targetCitizenId: citizenId }),
      actor(),
    );

    expect(Number((await invoiceFor(citizenId, issued.noticeId))?.amount)).toBe(2000);
  });

  it('ignores an occupancy the citizen has moved out of', async () => {
    // Billing a former tenant for a flat they left is the clearest possible way
    // to lose a resident's trust, so the join filters on `toDate: null`.
    const { building, units } = await buildingWithUnits('7704', [
      { unitType: 'APARTMENT', unitArea: 100, sequence: 1 },
      { unitType: 'APARTMENT', unitArea: 100, sequence: 2 },
    ]);

    const { citizenId } = await citizenWith({
      propertyType: 'BUILDING',
      propertyNumber: '7704',
      buildingId: building.id,
      units: [],
    });

    await db.unitOccupancy.createMany({
      data: [
        { unitId: units[0]!.id, citizenId, role: 'TENANT' },
        { unitId: units[1]!.id, citizenId, role: 'TENANT', toDate: new Date('2026-01-01') },
      ],
    });

    const issued = await fees.issue(
      notice({ basis: 'PER_UNIT', amount: 1000, targetCitizenId: citizenId }),
      actor(),
    );

    expect(Number((await invoiceFor(citizenId, issued.noticeId))?.amount)).toBe(1000);
  });

  it('takes the bearer decision from each occupancy’s own role', async () => {
    /*
      The card carries one role; the census says this person owns one flat and
      rents another, which a single card-level role cannot express. An
      owner-borne fee must reach only the owned one.
    */
    const { building, units } = await buildingWithUnits('7705', [
      { unitType: 'APARTMENT', unitArea: 100, sequence: 1 },
      { unitType: 'APARTMENT', unitArea: 100, sequence: 2 },
    ]);

    const { citizenId } = await citizenWith({
      propertyType: 'BUILDING',
      propertyNumber: '7705',
      buildingId: building.id,
      units: [],
    });

    await db.unitOccupancy.createMany({
      data: [
        { unitId: units[0]!.id, citizenId, role: 'OWNER' },
        { unitId: units[1]!.id, citizenId, role: 'TENANT' },
      ],
    });

    const issued = await fees.issue(
      notice({ basis: 'PER_UNIT', amount: 1000, bearer: 'OWNER', targetCitizenId: citizenId }),
      actor(),
    );

    expect(Number((await invoiceFor(citizenId, issued.noticeId))?.amount)).toBe(1000);
  });

  it('never adds a card’s own units to its occupancies', async () => {
    // The double-count that would bill a landlord twice for one building.
    const { building, units } = await buildingWithUnits('7706', [
      { unitType: 'APARTMENT', unitArea: 100, sequence: 1 },
      { unitType: 'APARTMENT', unitArea: 100, sequence: 2 },
    ]);

    const { citizenId } = await citizenWith({
      propertyType: 'BUILDING',
      propertyNumber: '7706',
      buildingId: building.id,
      units: [
        { unitType: 'APARTMENT', floor: '1', unitArea: 100, unitId: units[0]!.id },
        { unitType: 'APARTMENT', floor: '1', unitArea: 100, unitId: units[1]!.id },
      ],
    });

    await db.unitOccupancy.createMany({
      data: [
        { unitId: units[0]!.id, citizenId, role: 'OWNER' },
        { unitId: units[1]!.id, citizenId, role: 'OWNER' },
      ],
    });

    const issued = await fees.issue(
      notice({ basis: 'PER_UNIT', amount: 1000, targetCitizenId: citizenId }),
      actor(),
    );

    expect(Number((await invoiceFor(citizenId, issued.noticeId))?.amount)).toBe(2000);
  });

  it('still refuses a building nobody is recorded in', async () => {
    // An empty occupancy list is "nobody has been inside", which is the case
    // the guard was written for — the citizen is reported by name, not billed.
    const { building } = await buildingWithUnits('7707', []);

    const { citizenId } = await citizenWith({
      propertyType: 'BUILDING',
      propertyNumber: '7707',
      buildingId: building.id,
      units: [],
    });

    /*
      Refused outright rather than billed at zero, and the message is the point.

      When a notice ends up with nobody billable, `issue` tells the clerk *which
      of the three reasons* it was — here, that the targeted records need a
      field survey first. An invoice for zero would have been a letter telling
      someone they owe nothing, arriving with a due date; a silent success would
      have been a shortfall nobody could see.
    */
    await expect(
      fees.issue(notice({ basis: 'PER_UNIT', amount: 1000, targetCitizenId: citizenId }), actor()),
    ).rejects.toThrow(/جرد ميداني/);

    expect(await db.citizenPayment.count({ where: { citizenId } })).toBe(0);
  });

  // ───────────────────────────  Target selection  ───────────────────────────

  it('reaches a citizen whose only محل is one the census recorded them in', async () => {
    /*
      The under-selection `resolveTargets`' superset exists to prevent. This
      citizen's card names no unit type at all; the shop is known only from the
      matrix. Selected by card alone they would simply never be billed, and
      nothing downstream would report it.
    */
    const { building, units } = await buildingWithUnits('7708', [
      { unitType: 'SHOP', unitArea: 40, sequence: 1 },
    ]);

    const { citizenId } = await citizenWith({
      propertyType: 'BUILDING',
      propertyNumber: '7708',
      buildingId: building.id,
      units: [],
    });

    await db.unitOccupancy.create({
      data: { unitId: units[0]!.id, citizenId, role: 'OWNER' },
    });

    const issued = await fees.issue(
      notice({
        basis: 'PER_UNIT',
        amount: 500,
        targetType: 'BUILDING_CATEGORY',
        targetCategory: 'SHOP',
      }),
      actor(),
    );

    expect(Number((await invoiceFor(citizenId, issued.noticeId))?.amount)).toBe(500);
  });
});

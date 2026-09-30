import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaCaseRepository } from '../../../infrastructure/repositories/case.repository';
import { CasesService } from '../cases/cases.service';
import { assessCitizen, FeesService } from '../fees/fees.service';
import { LandlordLinkService } from '../citizens/landlord-link.service';
import { OwnershipService } from '../citizens/ownership.service';
import { TenancyService } from '../citizens/tenancy.service';
import { BuildingsService } from './buildings.service';
import { CensusSyncService } from './census-sync.service';
import { settleUnit, unitsUnderReview } from './unit-status';

/**
 * «حالة الوحدة» kept in step with who is recorded in the flat — against a real
 * Postgres, because every assertion spans the unit, the census spells, the
 * owner's card, the vacancy record, the case list and a bill.
 *
 * Each test is a shape the production audit of 2026-09-30 found (or the door it
 * came through): a seasonal home billed to its owner and the tenant registered
 * in it, flats left «مؤجرة» with nobody in them, a card whose own building link
 * was empty so the census never recorded its owner, and an old card answer
 * replayed over a newer finding on every save.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_unit_status_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('the one rule for «حالة الوحدة»', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let buildings: BuildingsService;
  let census: CensusSyncService;
  let tenancy: TenancyService;
  let fees: FeesService;
  let cases: CasesService;
  let officerId: string;

  const actor = () => ({ id: officerId, role: 'SUPER_ADMIN' });
  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-us', tenantSlug: 'us', schemaName: SCHEMA, prisma: db }, work);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const events = new EventEmitter2();
    cases = new CasesService(
      new PrismaCaseRepository(context),
      { findById: async () => ({ id: officerId, kind: 'CITIZEN' }) } as never,
      events,
    );
    buildings = new BuildingsService(context, cases, events);
    census = new CensusSyncService(context, cases, events);
    const links = new LandlordLinkService(context, buildings, events);
    const ownership = new OwnershipService(context, buildings, cases, links, events);
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
        tenantSlug: 'us',
        email: `officer-${officerId}@us.gov.lb`,
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

  const citizen = async (firstName: string) => {
    const id = randomUUID();
    await db.user.create({
      data: { id, kind: 'CITIZEN', tenantSlug: 'us', firstName, middleName: 'علي', lastName: 'نصرالله' },
    });
    return id;
  };

  const block = async (parcelNumber: string, unitsPerFloor = 2) =>
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
      return { building, units };
    });

  /** A filing — owner or tenant — on these flats, synced into the census like a real one. */
  const filing = async (input: {
    role: 'OWNER' | 'TENANT';
    parcelNumber: string;
    buildingId: string | null;
    units: Array<{ unitId: string; status?: string }>;
  }) => {
    const citizenId = await citizen(input.role === 'OWNER' ? 'مالك' : 'مستأجر');
    const registration = await db.registration.create({
      data: { citizenId, referenceNumber: `REF-${randomUUID().slice(0, 10)}` },
      select: { id: true },
    });
    const card = await db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: input.role,
        ...(input.role === 'TENANT' ? { landlordName: 'مالك المبنى', landlordPhone: '+96171000000' } : {}),
        propertyType: 'BUILDING',
        neighborhood: 'الحي الشرقي',
        propertyNumber: input.parcelNumber,
        buildingId: input.buildingId,
        units: {
          create: input.units.map((unit) => ({
            unitType: 'APARTMENT',
            floor: '0',
            unitArea: 90,
            unitId: unit.unitId,
            unitStatus: (unit.status ?? null) as never,
          })),
        },
      },
      select: { id: true, units: { select: { id: true, unitId: true } } },
    });
    await within(() =>
      census.syncRegistration({ registrationId: registration.id, citizenId, actor: actor() }),
    );
    return { citizenId, registrationId: registration.id, cardId: card.id, lines: card.units };
  };

  const unitStatus = async (unitId: string) =>
    (await db.unit.findUniqueOrThrow({ where: { id: unitId } })).unitStatus;

  const openReviews = (unitId: string) =>
    db.case.count({ where: { unitId, caseType: 'STATUS_CONFLICT', status: { in: ['OPEN', 'SCHEDULED'] } } });

  /** What a per-unit occupancy fee charges this citizen, and how many flats it held. */
  const occupancyBill = async (citizenId: string) =>
    within(async () => {
      for await (const batch of fees.holdingsOf([citizenId])) {
        const outcome = assessCitizen(batch[0]!.entries, { amount: 1000, basis: 'PER_UNIT', bearer: 'OCCUPANT' });
        if (outcome.kind !== 'assessed') return { amount: 0, held: 0 };
        return { amount: outcome.amount, held: outcome.assessment.heldUnitCount };
      }
      return { amount: 0, held: 0 };
    });

  // ─────────────────────────────  The rule  ─────────────────────────────

  it('makes a seasonal home «مؤجرة» when a tenant is filed in it, so only the tenant pays', async () => {
    /*
      Z-5-257-A/0201 on 2026-09-30: «مسكن موسمي» set on the matrix at 17:06, a
      tenant filed at 17:10. The fill that should have made it «مؤجرة» only
      wrote into an empty status, so the owner (billed while away from a
      seasonal home) and the tenant were both charged for one flat.
    */
    const { building, units } = await block('US-1');
    const unitId = units[0]!.id;
    const owner = await filing({ role: 'OWNER', parcelNumber: 'US-1', buildingId: building.id, units: [{ unitId }] });
    await within(() => buildings.updateUnit(unitId, { unitStatus: 'SEASONAL' } as never, actor()));
    expect(await unitStatus(unitId)).toBe('SEASONAL');

    const tenant = await filing({ role: 'TENANT', parcelNumber: 'US-1', buildingId: building.id, units: [{ unitId }] });

    expect(await unitStatus(unitId)).toBe('RENTED');
    expect(await openReviews(unitId)).toBe(0);
    expect(await occupancyBill(owner.citizenId)).toEqual({ amount: 0, held: 0 });
    expect(await occupancyBill(tenant.citizenId)).toEqual({ amount: 1000, held: 0 });
  });

  it('puts «مؤجرة» with nobody in it to review, holds the fee, and settles when a tenant is filed', async () => {
    const { building, units } = await block('US-2');
    const unitId = units[0]!.id;
    const owner = await filing({ role: 'OWNER', parcelNumber: 'US-2', buildingId: building.id, units: [{ unitId }] });
    const tenant = await filing({ role: 'TENANT', parcelNumber: 'US-2', buildingId: building.id, units: [{ unitId }] });
    expect(await unitStatus(unitId)).toBe('RENTED');

    // The tenant's file is saved without the flat — the untick that used to leave «مؤجرة» behind.
    await db.buildingUnit.deleteMany({ where: { propertyEntryId: tenant.cardId } });
    await within(() =>
      census.syncRegistration({ registrationId: tenant.registrationId, citizenId: tenant.citizenId, actor: actor() }),
    );

    expect(await unitStatus(unitId)).toBe('RENTED');
    expect(await openReviews(unitId)).toBe(1);
    const review = await within(() => unitsUnderReview(db, [unitId]));
    expect(review.get(unitId)?.conflicts).toEqual([{ kind: 'LET_WITHOUT_OCCUPANT', status: 'RENTED' }]);
    // Held, not charged to anybody: the owner is not billed on a guess.
    expect(await occupancyBill(owner.citizenId)).toEqual({ amount: 0, held: 1 });

    // Somebody records the tenant who is actually there: the review closes itself.
    const newTenant = await filing({ role: 'TENANT', parcelNumber: 'US-2', buildingId: building.id, units: [{ unitId }] });
    expect(await openReviews(unitId)).toBe(0);
    expect(await occupancyBill(owner.citizenId)).toEqual({ amount: 0, held: 0 });
    expect(await occupancyBill(newTenant.citizenId)).toEqual({ amount: 1000, held: 0 });
  });

  it('records an owner’s own «شاغرة» as a vacancy on their statement, and lifts it when they change it', async () => {
    const { building, units } = await block('US-3');
    const unitId = units[0]!.id;
    const owner = await filing({
      role: 'OWNER',
      parcelNumber: 'US-3',
      buildingId: building.id,
      units: [{ unitId, status: 'VACANT' }],
    });

    const vacancy = await db.unitVacancyConfirmation.findFirstOrThrow({ where: { unitId, endedAt: null } });
    expect(vacancy.basis).toBe('OWNER_STATEMENT');
    expect(await db.unit.findUniqueOrThrow({ where: { id: unitId } })).toMatchObject({
      unitStatus: 'VACANT',
      surveyStatus: 'VACANT_CONFIRMED',
    });
    // Exempt straight away (the user's decision): a تصريح بالشغور on the owner's responsibility.
    expect(await occupancyBill(owner.citizenId)).toEqual({ amount: 0, held: 0 });

    // The owner now says they live there — their own declaration ends their own vacancy.
    await db.buildingUnit.update({ where: { id: owner.lines[0]!.id }, data: { unitStatus: 'OWNER_OCCUPIED' } });
    await within(() =>
      census.syncRegistration({ registrationId: owner.registrationId, citizenId: owner.citizenId, actor: actor() }),
    );

    expect(await db.unitVacancyConfirmation.findUniqueOrThrow({ where: { id: vacancy.id } })).toMatchObject({
      endReason: 'NO_LONGER_VACANT',
    });
    expect(await unitStatus(unitId)).toBe('OWNER_OCCUPIED');
    expect(await occupancyBill(owner.citizenId)).toEqual({ amount: 1000, held: 0 });
  });

  it('does not replay an unchanged card answer over a newer finding on the matrix', async () => {
    const { building, units } = await block('US-4');
    const unitId = units[0]!.id;
    const owner = await filing({
      role: 'OWNER',
      parcelNumber: 'US-4',
      buildingId: building.id,
      units: [{ unitId, status: 'OWNER_OCCUPIED' }],
    });
    await within(() => buildings.updateUnit(unitId, { unitStatus: 'SEASONAL' } as never, actor()));

    // The owner's file saved again for something else — the card's answer did not change.
    await within(() =>
      census.syncRegistration({
        registrationId: owner.registrationId,
        citizenId: owner.citizenId,
        actor: actor(),
        unchangedStatements: new Set([owner.lines[0]!.id]),
      }),
    );
    expect(await unitStatus(unitId)).toBe('SEASONAL');

    expect(await openReviews(unitId)).toBe(0);

    // A changed answer that would call a seasonal home empty is not carried over — it goes to review.
    await db.buildingUnit.update({ where: { id: owner.lines[0]!.id }, data: { unitStatus: 'UNDER_CONSTRUCTION' } });
    await within(() =>
      census.syncRegistration({ registrationId: owner.registrationId, citizenId: owner.citizenId, actor: actor() }),
    );
    expect(await unitStatus(unitId)).toBe('SEASONAL');
    expect(await openReviews(unitId)).toBe(1);

    // A changed answer that is not refused is carried over, and the review closes with it.
    await db.buildingUnit.update({ where: { id: owner.lines[0]!.id }, data: { unitStatus: 'OWNER_OCCUPIED' } });
    await within(() =>
      census.syncRegistration({ registrationId: owner.registrationId, citizenId: owner.citizenId, actor: actor() }),
    );
    expect(await unitStatus(unitId)).toBe('OWNER_OCCUPIED');
    expect(await openReviews(unitId)).toBe(0);
  });

  it('records the owner of a card whose own building link is empty, from the flat its line names', async () => {
    // A3-1292-B/0001: the line named the flat, the card had no building, and the sync skipped it.
    const { units } = await block('US-5', 1);
    const unitId = units[0]!.id;
    const owner = await filing({
      role: 'OWNER',
      parcelNumber: 'US-5',
      buildingId: null,
      units: [{ unitId, status: 'OWNER_OCCUPIED' }],
    });

    const spell = await db.unitOccupancy.findFirst({ where: { unitId, citizenId: owner.citizenId, toDate: null } });
    expect(spell?.role).toBe('OWNER');
    expect(await db.unit.findUniqueOrThrow({ where: { id: unitId } })).toMatchObject({
      surveyStatus: 'COMPLETE',
      unitStatus: 'OWNER_OCCUPIED',
    });
  });

  it('refuses «مشغولة من المالك» in the unit editor over a registered tenant', async () => {
    const { building, units } = await block('US-6');
    const unitId = units[0]!.id;
    await filing({ role: 'TENANT', parcelNumber: 'US-6', buildingId: building.id, units: [{ unitId }] });

    await expect(
      within(() => buildings.updateUnit(unitId, { unitStatus: 'OWNER_OCCUPIED' } as never, actor())),
    ).rejects.toThrow(/مستأجر أو شاغل مسجَّل/);
    expect(await unitStatus(unitId)).toBe('RENTED');
  });

  it('opens the review when a tenancy ends into «مؤجرة لمستأجر آخر», as that one case', async () => {
    const { building, units } = await block('US-7');
    const unitId = units[0]!.id;
    await filing({ role: 'OWNER', parcelNumber: 'US-7', buildingId: building.id, units: [{ unitId }] });
    const tenant = await filing({ role: 'TENANT', parcelNumber: 'US-7', buildingId: building.id, units: [{ unitId }] });
    const spell = await db.unitOccupancy.findFirstOrThrow({ where: { unitId, citizenId: tenant.citizenId, toDate: null } });

    await within(() =>
      tenancy.endOccupancy(spell.id, { reason: 'MOVED_OUT', afterStatus: 'RENTED_TO_OTHER' } as never, actor()),
    );

    expect(await unitStatus(unitId)).toBe('RENTED');
    expect(await openReviews(unitId)).toBe(1);
    expect(await db.case.count({ where: { unitId, status: 'OPEN' } })).toBe(1);
  });

  it('settles what the old rules left, once, and bills by the settled status before anyone does', async () => {
    const { building, units } = await block('US-8');
    const [stale, empty] = [units[0]!.id, units[1]!.id];
    const owner = await filing({
      role: 'OWNER',
      parcelNumber: 'US-8',
      buildingId: building.id,
      units: [{ unitId: stale }, { unitId: empty }],
    });
    const tenantId = await citizen('مستأجر قديم');
    // Written as the old paths left them: «مشغولة من المالك» over a registered tenant, and «مؤجرة» over nobody.
    await db.unitOccupancy.create({ data: { unitId: stale, citizenId: tenantId, role: 'TENANT' } });
    await db.unit.update({ where: { id: stale }, data: { unitStatus: 'OWNER_OCCUPIED' } });
    await db.unit.update({ where: { id: empty }, data: { unitStatus: 'RENTED' } });

    // Billing already reads the rule: the stale flat is the tenant's to pay, the empty one is held.
    expect(await occupancyBill(owner.citizenId)).toEqual({ amount: 0, held: 1 });

    const first = await within(() => buildings.settleAllUnits(actor()));
    expect(first.statusesChanged).toBeGreaterThanOrEqual(1);
    expect(await unitStatus(stale)).toBe('RENTED');
    expect(await openReviews(empty)).toBe(1);

    const again = await within(() => buildings.settleAllUnits(actor()));
    expect(again.statusesChanged).toBe(0);
    expect(again.casesOpened).toBe(0);
    expect(await openReviews(empty)).toBe(1);
  });

  // ─────────────────────  What the review of this change found  ─────────────────────

  it('ends a tenancy into «شاغرة» without putting the flat to review over the owner’s old «مؤجرة»', async () => {
    const { building, units } = await block('US-9');
    const unitId = units[0]!.id;
    // The owner's line says «مؤجرة» — what a landlord link writes.
    const owner = await filing({ role: 'OWNER', parcelNumber: 'US-9', buildingId: building.id, units: [{ unitId, status: 'RENTED' }] });
    const tenant = await filing({ role: 'TENANT', parcelNumber: 'US-9', buildingId: building.id, units: [{ unitId }] });
    const spell = await db.unitOccupancy.findFirstOrThrow({ where: { unitId, citizenId: tenant.citizenId, toDate: null } });

    await within(() =>
      tenancy.endOccupancy(
        spell.id,
        { reason: 'MOVED_OUT', afterStatus: 'VACANT', vacancyBasis: 'FIELD_INSPECTION' } as never,
        actor(),
      ),
    );

    expect(await unitStatus(unitId)).toBe('VACANT');
    expect(await openReviews(unitId)).toBe(0);
    expect((await db.buildingUnit.findUniqueOrThrow({ where: { id: owner.lines[0]!.id } })).unitStatus).toBeNull();
  });

  it('clears the owner’s «شاغرة» when an officer lifts the vacancy, so the next save does not re-open it', async () => {
    const { building, units } = await block('US-10');
    const unitId = units[0]!.id;
    const owner = await filing({ role: 'OWNER', parcelNumber: 'US-10', buildingId: building.id, units: [{ unitId, status: 'VACANT' }] });

    await within(() => buildings.endVacancy(unitId, { reason: 'NO_LONGER_VACANT' } as never, actor()));
    expect((await db.buildingUnit.findUniqueOrThrow({ where: { id: owner.lines[0]!.id } })).unitStatus).toBeNull();

    // The owner's file saved again for something else.
    await within(() =>
      census.syncRegistration({ registrationId: owner.registrationId, citizenId: owner.citizenId, actor: actor() }),
    );
    expect(await db.unitVacancyConfirmation.count({ where: { unitId, endedAt: null } })).toBe(0);
    expect(await occupancyBill(owner.citizenId)).toEqual({ amount: 1000, held: 0 });
  });

  it('ends the vacancy an owner declared when they take the «شاغرة» back', async () => {
    const { building, units } = await block('US-11');
    const unitId = units[0]!.id;
    const owner = await filing({ role: 'OWNER', parcelNumber: 'US-11', buildingId: building.id, units: [{ unitId, status: 'VACANT' }] });
    const vacancy = await db.unitVacancyConfirmation.findFirstOrThrow({ where: { unitId, endedAt: null } });

    await db.buildingUnit.update({ where: { id: owner.lines[0]!.id }, data: { unitStatus: null } });
    await within(() =>
      census.syncRegistration({ registrationId: owner.registrationId, citizenId: owner.citizenId, actor: actor() }),
    );

    expect(await db.unitVacancyConfirmation.findUniqueOrThrow({ where: { id: vacancy.id } })).toMatchObject({
      endReason: 'RECORDED_IN_ERROR',
    });
    expect(await db.unit.findUniqueOrThrow({ where: { id: unitId } })).toMatchObject({ surveyStatus: 'COMPLETE' });
  });

  it('keeps one open review per flat when two saves settle it at once', async () => {
    const { units } = await block('US-12');
    const unitId = units[0]!.id;
    await db.unit.update({ where: { id: unitId }, data: { unitStatus: 'RENTED' } });

    await within(() =>
      Promise.all([
        settleUnit(db, { unitId, tenantSlug: 'us', actor: actor(), via: 'TEST' }),
        settleUnit(db, { unitId, tenantSlug: 'us', actor: actor(), via: 'TEST' }),
        settleUnit(db, { unitId, tenantSlug: 'us', actor: actor(), via: 'TEST' }),
      ]),
    );
    expect(await openReviews(unitId)).toBe(1);
  });

  it('lets an owner say their seasonal home is empty now, as a vacancy on their statement', async () => {
    const { building, units } = await block('US-13');
    const unitId = units[0]!.id;
    const owner = await filing({ role: 'OWNER', parcelNumber: 'US-13', buildingId: building.id, units: [{ unitId }] });
    await within(() => buildings.updateUnit(unitId, { unitStatus: 'SEASONAL' } as never, actor()));

    await within(() =>
      buildings.recordOccupancy(
        { unitId, citizenId: owner.citizenId, role: 'OWNER', unitStatus: 'VACANT' } as never,
        actor(),
        { fromMatrix: true },
      ),
    );

    expect(await db.unitVacancyConfirmation.findFirstOrThrow({ where: { unitId, endedAt: null } })).toMatchObject({
      basis: 'OWNER_STATEMENT',
      previousUnitStatus: 'SEASONAL',
    });
    expect(await unitStatus(unitId)).toBe('VACANT');
    expect(await openReviews(unitId)).toBe(0);
  });

  it('bills a منزل card that states nothing by its flat — not its owner beside a registered tenant', async () => {
    const { building, units } = await block('US-14', 1);
    const unitId = units[0]!.id;
    const ownerId = await citizen('مالك منزل');
    const registration = await db.registration.create({
      data: { citizenId: ownerId, referenceNumber: `REF-${randomUUID().slice(0, 10)}` },
      select: { id: true },
    });
    await db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: 'OWNER',
        propertyType: 'HOUSE',
        neighborhood: 'الحي الشرقي',
        propertyNumber: 'US-14',
        buildingId: building.id,
        unitArea: 120,
      },
    });
    await filing({ role: 'TENANT', parcelNumber: 'US-14', buildingId: building.id, units: [{ unitId }] });

    expect(await unitStatus(unitId)).toBe('RENTED');
    expect(await occupancyBill(ownerId)).toEqual({ amount: 0, held: 0 });
  });

  it('refuses a «تعارض في حالة الوحدة» opened by hand — the rule opens and closes it', async () => {
    const { building, units } = await block('US-15');
    await expect(
      within(() =>
        cases.create(
          { notes: 'تجربة', caseType: 'STATUS_CONFLICT', buildingId: building.id, unitId: units[0]!.id } as never,
          actor(),
        ),
      ),
    ).rejects.toThrow(/يُفتح تلقائياً/);
  });
});

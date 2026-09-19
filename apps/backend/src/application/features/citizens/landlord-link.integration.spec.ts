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
import { AuditService } from '../audit/audit.service';
import { ConflictError } from '../../../domain/errors/domain-error';
import { CasesService } from '../cases/cases.service';
import { BuildingsService } from '../buildings/buildings.service';
import { CensusSyncService } from '../buildings/census-sync.service';
import { FeesService } from '../fees/fees.service';
import { CitizensService } from './citizens.service';
import { LandlordLinkService, readFootprint } from './landlord-link.service';

/**
 * Owner links against a real Postgres — what a link writes, and that undoing
 * it removes exactly that.
 *
 * ## Why this suite exists
 *
 * A link writes into somebody else's records: an `OWNER` occupancy, a unit row
 * on the owner's card, sometimes the card itself, a case closed on the flat —
 * six tables, through three services, in one transaction. The promise that
 * «إلغاء الربط» reverts all of it and nothing else is only true if a database
 * says so. A stub would let a revert delete the wrong row and still pass.
 *
 * Every test starts from what happens in the field: a tenant filed first,
 * naming a number; the owner registered later on it.
 *
 * Set `TEST_DATABASE_URL` to run it; CI always does. Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_landlord_link_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

/** «03 123456», as `internationalPhone` stores it. */
const OWNER_PHONE_TYPED = '03 123456';

describeIfDb('LandlordLinkService', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let buildings: BuildingsService;
  let census: CensusSyncService;
  let links: LandlordLinkService;
  let citizens: CitizensService;
  let fees: FeesService;
  let officerId: string;

  const actor = () => ({ id: officerId, role: 'SUPER_ADMIN' });

  /**
   * Every service call runs inside a tenant scope, as a request does — which is
   * what lets `LandlordLinkService` re-enter it with a transaction client and
   * have `BuildingsService` write through that transaction.
   */
  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run(
      { tenantId: 'tenant-links', tenantSlug: 'links', schemaName: SCHEMA, prisma: db },
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
    /*
      The real audit subscriber, wired the way Nest wires it.

      A link's writes emit `building.changed` from *inside* its transaction.
      The subscriber queues its row until the transaction commits — see
      `runInTenantTransaction` — so these prove the audit row is written for a
      link that committed and never for one that rolled back, rather than being
      sent to an already-closed transaction and lost.
    */
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
    citizens = new CitizensService(
      context,
      {} as never,
      {
        resolve: async () => ({ allowsPropertyType: () => true, referencePrefix: 'LNK' }),
      } as never,
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
        tenantSlug: 'links',
        email: `officer-${officerId}@links.gov.lb`,
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

  /** Numbers are unique per test, so no test can match another's claims. */
  const freshPhone = () => {
    const digits = String(Math.floor(1_000_000 + Math.random() * 8_999_999));
    return { typed: `71 ${digits.slice(0, 3)} ${digits.slice(3, 6)}`, stored: `+96171${digits.slice(0, 6)}` };
  };

  const citizen = async (firstName: string, phone: string | null, over: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await db.user.create({
      data: {
        id,
        kind: 'CITIZEN',
        tenantSlug: 'links',
        firstName,
        middleName: 'علي',
        lastName: 'نصرالله',
        phone,
        ...over,
      },
    });
    return id;
  };

  /** A citizen with a file and nothing on it yet — an owner, registered. */
  const ownerWithFile = async (phone: string) => {
    const id = await citizen('ابراهيم', phone);
    const registration = await db.registration.create({
      data: { citizenId: id, referenceNumber: `REF-${randomUUID().slice(0, 10)}` },
      select: { id: true },
    });
    return { id, registrationId: registration.id };
  };

  const surveyedBlock = async (parcelNumber: string, unitsPerFloor = 3) =>
    within(async () => {
      const { building } = await buildings.create(
        {
          parcelNumber,
          structureType: 'RESIDENTIAL_BUILDING',
          lifecycleStatus: 'IN_USE',
          floorsCount: 1,
        },
        actor(),
      );
      const { units } = await buildings.generateUnits(
        building.id,
        { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor, unitType: 'APARTMENT' },
        actor(),
      );
      return { building, units };
    });

  /**
   * A مستأجر filing: the card naming the landlord's number and the flats, and
   * the census sync the registration path runs after it — so the tenant is in
   * the flat on the matrix exactly as a real filing leaves them.
   */
  const tenantFiling = async (input: {
    landlordPhone: string;
    parcelNumber: string;
    buildingId: string | null;
    unitIds: string[];
    landlordName?: string;
    occupancyType?: 'TENANT' | 'FREE_OCCUPANT';
  }) => {
    const tenantPhone = freshPhone();
    const tenantId = await citizen('مستأجر', tenantPhone.stored);
    const registration = await db.registration.create({
      data: {
        citizenId: tenantId,
        referenceNumber: `REF-${randomUUID().slice(0, 10)}`,
        properties: {
          create: {
            occupancyType: input.occupancyType ?? 'TENANT',
            landlordName: input.landlordName ?? 'ibrahim hashem nasrallah',
            landlordPhone: input.landlordPhone,
            propertyType: 'BUILDING',
            neighborhood: 'الحي الشرقي',
            propertyNumber: input.parcelNumber,
            buildingName: 'بيت ابراهيم نصرالله',
            buildingId: input.buildingId,
            units: {
              create: input.unitIds.map((unitId) => ({
                unitType: 'APARTMENT',
                floor: '0',
                unitArea: 95,
                unitId,
              })),
            },
          },
        },
      },
      select: { id: true, properties: { select: { id: true } } },
    });

    await within(() =>
      census.syncRegistration({ registrationId: registration.id, citizenId: tenantId, actor: actor() }),
    );

    return {
      tenantId,
      tenantPhone,
      registrationId: registration.id,
      entryId: registration.properties[0]!.id,
    };
  };

  const ownerSpells = (citizenId: string) =>
    db.unitOccupancy.findMany({ where: { citizenId, role: 'OWNER' }, orderBy: { createdAt: 'asc' } });

  const ownerCards = (citizenId: string) =>
    db.propertyEntry.findMany({
      where: { registration: { citizenId } },
      include: { units: true },
      orderBy: { createdAt: 'asc' },
    });

  /** Lets the audit subscriber's writes for events emitted after commit land. */
  const settleAudit = () => new Promise((resolve) => setTimeout(resolve, 300));

  const auditRows = (buildingId: string, action: string, citizenId: string) =>
    db.auditLogEntry.count({
      where: {
        entityType: 'Building',
        entityId: buildingId,
        action,
        after: { path: ['citizenId'], equals: citizenId },
      },
    });

  /** What an owner-borne, per-unit fee would charge this citizen. */
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
      const invoice = await db.citizenPayment.findFirst({
        where: { citizenId, feeNoticeId: issued.noticeId },
      });
      return Number(invoice?.amount ?? 0);
    } catch {
      return 0;
    }
  };

  // ────────────────  The owner who registers after the tenant  ────────────────

  it('finds the owner who registered months after their tenant, by the number alone', async () => {
    const { units, building } = await surveyedBlock('LNK-1');
    const phone = freshPhone();
    const { entryId, registrationId } = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-1',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });

    // Nobody is registered on the number yet: nothing to offer, nothing stored.
    expect(await within(() => links.claimsFiledBy(registrationId))).toEqual([]);

    const owner = await ownerWithFile(phone.stored);

    // The save of the owner's file asks, scoped to their numbers.
    const naming = await within(() => links.claimsNaming(owner.id));
    expect(naming).toHaveLength(1);
    expect(naming[0]).toMatchObject({
      propertyEntryId: entryId,
      blocked: null,
      units: [{ unitId: units[0]!.id }],
    });
    expect(naming[0]!.candidates).toEqual([
      expect.objectContaining({ id: owner.id, outcome: 'NEW_CARD', blocked: null }),
    ]);

    // And the queue shows it to whoever opens it, whenever they do.
    const queue = await within(() => links.proposals({ limit: 100, offset: 0 }));
    expect(queue.items.map((item) => item.propertyEntryId)).toContain(entryId);
  });

  // ─────────────────────────────  Confirming  ─────────────────────────────

  it('puts the flat on the owner’s file and bill, and records exactly what it wrote', async () => {
    const { units, building } = await surveyedBlock('LNK-2');
    const phone = freshPhone();
    const { entryId, tenantId } = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-2',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });
    const owner = await ownerWithFile(phone.stored);

    expect(await ownerBill(owner.id)).toBe(0);

    const result = await within(() =>
      links.confirm({ propertyEntryId: entryId, citizenId: owner.id, actor: actor() }),
    );
    expect(result).toMatchObject({ linked: true, unitsClaimed: 1, ownerCardCreated: true });

    const [spell] = await ownerSpells(owner.id);
    expect(spell).toMatchObject({ unitId: units[0]!.id, toDate: null });

    const [card] = await ownerCards(owner.id);
    expect(card).toMatchObject({ occupancyType: 'OWNER', buildingId: building.id });
    expect(card!.units.map((row) => row.unitId)).toEqual([units[0]!.id]);
    expect(card!.landlordLinkMint).toMatchObject({ sourceEntryId: entryId, ownerId: owner.id });

    const tenantCard = await db.propertyEntry.findUniqueOrThrow({ where: { id: entryId } });
    // The tenant's own words are kept; the link is what every screen shows.
    expect(tenantCard.landlordName).toBe('ibrahim hashem nasrallah');
    expect(tenantCard.landlordCitizenId).toBe(owner.id);
    const footprint = readFootprint(tenantCard.landlordLinkFootprint, owner.id)!;
    expect(footprint.units).toEqual([
      expect.objectContaining({
        unitId: units[0]!.id,
        occupancyId: spell!.id,
        row: expect.objectContaining({ propertyEntryId: card!.id }),
      }),
    ]);
    expect(footprint.mintedCardIds).toEqual([card!.id]);

    // The tenant is untouched on the matrix.
    const tenantSpell = await db.unitOccupancy.findFirstOrThrow({
      where: { citizenId: tenantId, unitId: units[0]!.id },
    });
    expect(tenantSpell.toDate).toBeNull();

    // The whole point: the owner is now billed for the flat.
    expect(await ownerBill(owner.id)).toBe(1000);

    // And the trail says so: the occupancy, written inside the transaction, and
    // the link, written after it.
    await settleAudit();
    expect(await auditRows(building.id, 'OCCUPANCY_RECORDED', owner.id)).toBe(1);
    expect(
      await db.auditLogEntry.count({
        where: { entityType: 'User', entityId: owner.id, action: 'LANDLORD_LINKED' },
      }),
    ).toBe(1);
  });

  it('shows the owner’s registered name on the tenant’s file while the link stands', async () => {
    const { units, building } = await surveyedBlock('LNK-3');
    const phone = freshPhone();
    const { entryId, tenantId } = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-3',
      buildingId: building.id,
      unitIds: [units[0]!.id],
      landlordName: 'ابو علي',
    });
    const owner = await ownerWithFile(phone.stored);
    await within(() => links.confirm({ propertyEntryId: entryId, citizenId: owner.id, actor: actor() }));

    const reporting = new (await import('../reporting/reporting.service')).ReportingService(
      context,
      new EventEmitter2(),
      { get: async () => null, set: async () => undefined } as never,
      { get: () => undefined } as never,
    );
    const profile = await within(() => reporting.getCitizenProfile(tenantId));
    const card = profile!.registrations[0]!.properties[0]!;
    expect(card.landlordName).toBe('ابراهيم علي نصرالله');
    expect(card.landlordNameAsTyped).toBe('ابو علي');

    const ownerProfile = await within(() => reporting.getCitizenProfile(owner.id));
    expect(ownerProfile!.landlordOf).toEqual([
      expect.objectContaining({ propertyEntryId: entryId, tenant: expect.objectContaining({ id: tenantId }) }),
    ]);
  });

  it('refuses a second clerk confirming a different person on a linked card', async () => {
    const { units, building } = await surveyedBlock('LNK-4');
    const phone = freshPhone();
    const { entryId } = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-4',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });
    const father = await ownerWithFile(phone.stored);
    const son = await ownerWithFile(phone.stored);

    await within(() => links.confirm({ propertyEntryId: entryId, citizenId: father.id, actor: actor() }));
    await expect(
      within(() => links.confirm({ propertyEntryId: entryId, citizenId: son.id, actor: actor() })),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await ownerSpells(son.id)).toEqual([]);
  });

  it('writes nothing at all when the second flat of a link fails', async () => {
    /*
      One transaction: before it, a failure on flat 2 left the link and flat 1
      committed and flat 2 missing, with nothing recording which.
    */
    const { units, building } = await surveyedBlock('LNK-ATOM');
    const phone = freshPhone();
    const { entryId } = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-ATOM',
      buildingId: building.id,
      unitIds: [units[0]!.id, units[1]!.id],
    });
    const owner = await ownerWithFile(phone.stored);

    const real = buildings.recordOccupancy.bind(buildings);
    const spy = jest
      .spyOn(buildings, 'recordOccupancy')
      .mockImplementationOnce((input, who) => real(input, who))
      .mockImplementationOnce(async () => {
        throw new Error('connection reset');
      });

    await expect(
      within(() => links.confirm({ propertyEntryId: entryId, citizenId: owner.id, actor: actor() })),
    ).rejects.toThrow('connection reset');
    spy.mockRestore();

    expect(await ownerSpells(owner.id)).toEqual([]);
    expect(await ownerCards(owner.id)).toEqual([]);
    const card = await db.propertyEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(card).toMatchObject({ landlordCitizenId: null, landlordLinkFootprint: null });

    // No trail of an occupancy that never happened.
    await settleAudit();
    expect(await auditRows(building.id, 'OCCUPANCY_RECORDED', owner.id)).toBe(0);
  });

  it('lets two clerks confirm the same card at once without writing it twice', async () => {
    const { units, building } = await surveyedBlock('LNK-RACE');
    const phone = freshPhone();
    const { entryId } = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-RACE',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });
    const owner = await ownerWithFile(phone.stored);

    const outcomes = await Promise.allSettled([
      within(() => links.confirm({ propertyEntryId: entryId, citizenId: owner.id, actor: actor() })),
      within(() => links.confirm({ propertyEntryId: entryId, citizenId: owner.id, actor: actor() })),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value.linked)).toHaveLength(1);
    expect(await ownerSpells(owner.id)).toHaveLength(1);
    expect(await ownerCards(owner.id)).toHaveLength(1);
  });

  it('files a tenanted منزل on the owner as «مؤجرة», and removes it on undo', async () => {
    /*
      A منزل bills its single unit from its own columns: a card left saying
      nothing reads as "nobody was asked", and the owner would be charged the
      occupancy fee the tenant already pays.
    */
    const { building } = await within(() =>
      buildings.create(
        { parcelNumber: 'LNK-HOUSE', structureType: 'INDEPENDENT_HOUSE', lifecycleStatus: 'IN_USE', floorsCount: 1 },
        actor(),
      ),
    );
    const onlyUnit = await db.unit.findFirst({ where: { buildingId: building.id } });
    const unitId =
      onlyUnit?.id ??
      (
        await within(() =>
          buildings.generateUnits(
            building.id,
            { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 1, unitType: 'APARTMENT' },
            actor(),
          ),
        )
      ).units[0]!.id;

    const phone = freshPhone();
    const tenantId = await citizen('مستأجر', freshPhone().stored);
    const registration = await db.registration.create({
      data: {
        citizenId: tenantId,
        referenceNumber: `REF-${randomUUID().slice(0, 10)}`,
        properties: {
          create: {
            occupancyType: 'TENANT',
            landlordName: 'مالك البيت',
            landlordPhone: phone.stored,
            propertyType: 'HOUSE',
            neighborhood: 'الحي الشرقي',
            propertyNumber: 'LNK-HOUSE',
            buildingId: building.id,
            unitType: 'APARTMENT',
            unitArea: 110,
          },
        },
      },
      select: { id: true, properties: { select: { id: true } } },
    });
    await within(() =>
      census.syncRegistration({ registrationId: registration.id, citizenId: tenantId, actor: actor() }),
    );
    const entryId = registration.properties[0]!.id;
    const owner = await ownerWithFile(phone.stored);

    await within(() => links.confirm({ propertyEntryId: entryId, citizenId: owner.id, actor: actor() }));
    const [card] = await ownerCards(owner.id);
    expect(card).toMatchObject({ propertyType: 'HOUSE', occupancyType: 'OWNER', unitStatus: 'RENTED' });
    expect((await ownerSpells(owner.id))[0]).toMatchObject({ unitId, toDate: null });

    const undone = await within(() => links.unlink({ propertyEntryId: entryId, actor: actor() }));
    expect(undone).toMatchObject({ cardsRemoved: 1, occupanciesEnded: 1, kept: [] });
    expect(await ownerCards(owner.id)).toEqual([]);
  });

  it('reopens a case the link closed, when the link is undone', async () => {
    const { units, building } = await surveyedBlock('LNK-CASE');
    const phone = freshPhone();
    const { entryId } = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-CASE',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });
    const owner = await ownerWithFile(phone.stored);
    const opened = await db.case.create({
      data: {
        notes: 'المالك غير معروف',
        propertyNumber: 'LNK-CASE',
        buildingId: building.id,
        unitId: units[0]!.id,
        createdById: officerId,
      },
    });

    await within(() => links.confirm({ propertyEntryId: entryId, citizenId: owner.id, actor: actor() }));
    expect((await db.case.findUniqueOrThrow({ where: { id: opened.id } })).status).toBe('RESOLVED');

    const undone = await within(() => links.unlink({ propertyEntryId: entryId, actor: actor() }));
    expect(undone.casesReopened).toBe(1);
    expect(await db.case.findUniqueOrThrow({ where: { id: opened.id } })).toMatchObject({
      status: 'OPEN',
      resolvedCitizenId: null,
      resolvedAt: null,
    });
  });

  // ─────────────────────────────  Blocks  ─────────────────────────────

  it('refuses a card that is not on a surveyed building, writing nothing', async () => {
    const phone = freshPhone();
    const { entryId } = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-5',
      buildingId: null,
      unitIds: [],
    });
    const owner = await ownerWithFile(phone.stored);

    const [proposal] = await within(() => links.claimsNaming(owner.id));
    expect(proposal!.blocked?.code).toBe('NOT_ON_SURVEY');

    await expect(
      within(() => links.confirm({ propertyEntryId: entryId, citizenId: owner.id, actor: actor() })),
    ).rejects.toBeInstanceOf(ConflictError);

    const card = await db.propertyEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(card.landlordCitizenId).toBeNull();
    expect(await ownerCards(owner.id)).toEqual([]);
  });

  it('refuses an owner whose own card for the parcel is not linked — it would bill twice', async () => {
    const { units, building } = await surveyedBlock('LNK-6');
    const phone = freshPhone();
    const { entryId } = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-6',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });
    const owner = await ownerWithFile(phone.stored);
    await db.propertyEntry.create({
      data: {
        registrationId: owner.registrationId,
        occupancyType: 'OWNER',
        propertyType: 'BUILDING',
        propertyNumber: 'LNK-6',
        buildingId: null,
        units: { create: [{ unitType: 'APARTMENT', floor: '0', unitArea: 95 }] },
      },
    });

    await expect(
      within(() => links.confirm({ propertyEntryId: entryId, citizenId: owner.id, actor: actor() })),
    ).rejects.toMatchObject({ details: { block: { code: 'OWNER_CARD_UNLINKED' } } });
    expect(await ownerSpells(owner.id)).toEqual([]);
  });

  // ─────────────────────────────  Undoing  ─────────────────────────────

  it('undoes a link exactly: the spell ended, the card it created removed, the claim back on the queue', async () => {
    const { units, building } = await surveyedBlock('LNK-7');
    const phone = freshPhone();
    const { entryId, tenantId } = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-7',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });
    const owner = await ownerWithFile(phone.stored);
    await within(() => links.confirm({ propertyEntryId: entryId, citizenId: owner.id, actor: actor() }));

    const preview = await within(() => links.unlinkPreview(entryId));
    expect(preview).toMatchObject({ linked: true, legacy: false, cardsCreated: 1 });

    const result = await within(() => links.unlink({ propertyEntryId: entryId, actor: actor() }));
    expect(result).toMatchObject({
      unlinked: true,
      legacy: false,
      occupanciesEnded: 1,
      rowsRemoved: 1,
      cardsRemoved: 1,
      kept: [],
    });

    // Ended, never deleted — the history is the point (D2).
    const [spell] = await ownerSpells(owner.id);
    expect(spell!.toDate).not.toBeNull();
    expect(spell!.endReason).toBe('RECORDED_IN_ERROR');
    expect(await ownerCards(owner.id)).toEqual([]);

    const card = await db.propertyEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(card).toMatchObject({ landlordCitizenId: null, landlordLinkFootprint: null });
    expect(card.landlordName).toBe('ibrahim hashem nasrallah');

    // The tenant is still in the flat, and the flat is still «مؤجرة».
    const tenantSpell = await db.unitOccupancy.findFirstOrThrow({
      where: { citizenId: tenantId, unitId: units[0]!.id },
    });
    expect(tenantSpell.toDate).toBeNull();
    expect((await db.unit.findUniqueOrThrow({ where: { id: units[0]!.id } })).unitStatus).toBe('RENTED');

    const [again] = await within(() => links.claimsNaming(owner.id));
    expect(again!.propertyEntryId).toBe(entryId);
    expect(await ownerBill(owner.id)).toBe(0);
  });

  it('adds to an ownership card the owner already filed, and removes only that row', async () => {
    const { units, building } = await surveyedBlock('LNK-8');
    const phone = freshPhone();
    const { entryId } = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-8',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });
    const owner = await ownerWithFile(phone.stored);
    const own = await db.propertyEntry.create({
      data: {
        registrationId: owner.registrationId,
        occupancyType: 'OWNER',
        propertyType: 'BUILDING',
        propertyNumber: 'LNK-8',
        buildingId: building.id,
        units: { create: [{ unitType: 'APARTMENT', floor: '0', unitArea: 120, unitId: units[1]!.id }] },
      },
    });

    const [proposal] = await within(() => links.claimsNaming(owner.id));
    expect(proposal!.candidates[0]!.outcome).toBe('ADDED_TO_CARD');

    await within(() => links.confirm({ propertyEntryId: entryId, citizenId: owner.id, actor: actor() }));
    let [card] = await ownerCards(owner.id);
    expect(card!.id).toBe(own.id);
    expect(card!.units.map((row) => row.unitId).sort()).toEqual([units[0]!.id, units[1]!.id].sort());

    const result = await within(() => links.unlink({ propertyEntryId: entryId, actor: actor() }));
    expect(result).toMatchObject({ rowsRemoved: 1, cardsRemoved: 0, occupanciesEnded: 1 });

    [card] = await ownerCards(owner.id);
    expect(card!.units.map((row) => row.unitId)).toEqual([units[1]!.id]);
    expect(Number(card!.units[0]!.unitArea)).toBe(120);
  });

  it('keeps a row a person has edited since, with its spell, and says so', async () => {
    const { units, building } = await surveyedBlock('LNK-9');
    const phone = freshPhone();
    const { entryId } = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-9',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });
    const owner = await ownerWithFile(phone.stored);
    await within(() => links.confirm({ propertyEntryId: entryId, citizenId: owner.id, actor: actor() }));

    const [card] = await ownerCards(owner.id);
    await db.buildingUnit.update({ where: { id: card!.units[0]!.id }, data: { unitArea: 140 } });

    const result = await within(() => links.unlink({ propertyEntryId: entryId, actor: actor() }));
    expect(result.kept).toEqual([expect.objectContaining({ reason: 'EDITED' })]);
    expect(result.occupanciesEnded).toBe(0);

    const [spell] = await ownerSpells(owner.id);
    expect(spell!.toDate).toBeNull();
    expect((await ownerCards(owner.id))[0]!.units).toHaveLength(1);
  });

  it('keeps what two co-tenants’ links share until the last of them is undone', async () => {
    const { units, building } = await surveyedBlock('LNK-10');
    const phone = freshPhone();
    const first = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-10',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });
    const second = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-10',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });
    const owner = await ownerWithFile(phone.stored);

    await within(() => links.confirm({ propertyEntryId: first.entryId, citizenId: owner.id, actor: actor() }));
    await within(() => links.confirm({ propertyEntryId: second.entryId, citizenId: owner.id, actor: actor() }));
    expect(await ownerSpells(owner.id)).toHaveLength(1);

    const undoFirst = await within(() => links.unlink({ propertyEntryId: first.entryId, actor: actor() }));
    expect(undoFirst.kept).toEqual([expect.objectContaining({ reason: 'SHARED' })]);
    expect((await ownerSpells(owner.id))[0]!.toDate).toBeNull();
    expect(await ownerCards(owner.id)).toHaveLength(1);

    // The shared rows now belong to the second link's footprint…
    const secondCard = await db.propertyEntry.findUniqueOrThrow({ where: { id: second.entryId } });
    const footprint = readFootprint(secondCard.landlordLinkFootprint, owner.id)!;
    expect(footprint.units[0]!.occupancyId).not.toBeNull();

    // …so undoing it removes them.
    const undoSecond = await within(() => links.unlink({ propertyEntryId: second.entryId, actor: actor() }));
    expect(undoSecond).toMatchObject({ occupanciesEnded: 1, cardsRemoved: 1 });
    expect((await ownerSpells(owner.id))[0]!.toDate).not.toBeNull();
    expect(await ownerCards(owner.id)).toEqual([]);
  });

  it('removes a created card without moving the flags on the cards after it', async () => {
    const { units, building } = await surveyedBlock('LNK-11');
    const phone = freshPhone();
    const { entryId } = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-11',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });
    const owner = await ownerWithFile(phone.stored);
    await within(() => links.confirm({ propertyEntryId: entryId, citizenId: owner.id, actor: actor() }));

    // A card the owner's officer added afterwards, with a «غير مؤكَّد» on it.
    await db.propertyEntry.create({
      data: {
        registrationId: owner.registrationId,
        occupancyType: 'OWNER',
        propertyType: 'LAND',
        propertyNumber: 'LNK-11-LAND',
        unitArea: 300,
      },
    });
    await db.registration.update({
      where: { id: owner.registrationId },
      data: { flaggedFields: [{ path: 'properties.1.neighborhood', reason: 'غير معروف بعد', kind: 'UNESTABLISHED' }] },
    });

    const result = await within(() => links.unlink({ propertyEntryId: entryId, actor: actor() }));
    expect(result.cardsRemoved).toBe(1);

    const registration = await db.registration.findUniqueOrThrow({ where: { id: owner.registrationId } });
    expect(registration.flaggedFields).toEqual([
      { path: 'properties.0.neighborhood', reason: 'غير معروف بعد', kind: 'UNESTABLISHED' },
    ]);
  });

  // ─────────────────────────────  Dismissals  ─────────────────────────────

  it('rejects the people shown, not the number — whoever registers later is still offered', async () => {
    const { units, building } = await surveyedBlock('LNK-12');
    const phone = freshPhone();
    const { entryId } = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-12',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });
    const father = await ownerWithFile(phone.stored);
    const son = await ownerWithFile(phone.stored);

    const offered = async () =>
      (await within(() => links.proposals({ limit: 100, offset: 0 }))).items
        .find((item) => item.propertyEntryId === entryId)
        ?.candidates.map((candidate) => candidate.id)
        .sort() ?? [];

    expect(await offered()).toEqual([father.id, son.id].sort());

    await within(() => links.dismiss({ propertyEntryId: entryId, candidateIds: [son.id], actor: actor() }));
    expect(await offered()).toEqual([father.id]);

    const realOwner = await ownerWithFile(phone.stored);
    expect(await offered()).toEqual([father.id, realOwner.id].sort());

    await within(() => links.undismiss({ propertyEntryId: entryId, candidateIds: [son.id], actor: actor() }));
    expect(await offered()).toEqual([father.id, son.id, realOwner.id].sort());
  });

  it('reads a dismissal from before per-person answers as rejecting only who existed then', async () => {
    const { units, building } = await surveyedBlock('LNK-13');
    const phone = freshPhone();
    const { entryId } = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-13',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });
    const shown = await ownerWithFile(phone.stored);
    await db.propertyEntry.update({
      where: { id: entryId },
      data: { landlordLinkDismissedAt: new Date(Date.now() + 1000) },
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const later = await ownerWithFile(phone.stored);

    const offered = async () =>
      (await within(() => links.claimsNaming(later.id)))
        .find((item) => item.propertyEntryId === entryId)
        ?.candidates.map((candidate) => candidate.id) ?? [];

    expect(await offered()).toEqual([later.id]);

    // Adding to the old dismissal must not bring back the person it hid.
    await within(() => links.dismiss({ propertyEntryId: entryId, candidateIds: [later.id], actor: actor() }));
    const card = await db.propertyEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect([...card.landlordLinkDismissedIds].sort()).toEqual([shown.id, later.id].sort());
    expect(await within(() => links.claimsNaming(shown.id))).toEqual([]);
  });

  // ─────────────────────────────  By name  ─────────────────────────────

  it('offers the owner a card names by name when its number is not theirs, and links on it', async () => {
    /*
      بسام حبيب نسر, 2026-09-15: registered, and named on five cards in his own
      building with a number that was not his. A distinctive name here so no
      other test's owners answer to it.
    */
    const { units, building } = await surveyedBlock('LNK-NAME');
    const ownerId = await citizen('وسيم', freshPhone().stored, { middleName: 'خليل', lastName: 'قصير' });
    await db.registration.create({
      data: { citizenId: ownerId, referenceNumber: `REF-${randomUUID().slice(0, 10)}` },
    });
    const { entryId } = await tenantFiling({
      landlordPhone: freshPhone().stored,
      landlordName: 'وسيم  قصير',
      parcelNumber: 'LNK-NAME',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });

    const queued = (await within(() => links.proposals({ limit: 100, offset: 0 }))).items.find(
      (item) => item.propertyEntryId === entryId,
    );
    expect(queued?.candidates.map((candidate) => [candidate.id, candidate.matchedBy])).toEqual([
      [ownerId, 'NAME'],
    ]);

    // The owner's own save finds it from the other side, with no number to go on.
    expect((await within(() => links.claimsNaming(ownerId))).map((item) => item.propertyEntryId)).toContain(
      entryId,
    );

    const result = await within(() => links.confirm({ propertyEntryId: entryId, citizenId: ownerId, actor: actor() }));
    expect(result.linked).toBe(true);
    await settleAudit();
    const audit = await db.auditLogEntry.findFirst({
      where: { action: 'LANDLORD_LINKED', entityId: ownerId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.after).toMatchObject({ matchedBy: 'NAME' });
  });

  // ─────────────────────────────  «هل هو مسجَّل مسبقاً؟»  ─────────────────────────────

  it('finds the same person by folded name and the same officer’s recent phone, against real rows', async () => {
    const phone = freshPhone();
    const existingId = await citizen('عبد الحسن', phone.stored, { middleName: 'ابراهيم', lastName: 'حدرج' });
    await db.registration.create({
      data: {
        citizenId: existingId,
        referenceNumber: `REF-${randomUUID().slice(0, 10)}`,
        createdById: officerId,
      },
    });

    // «عبدالحسن» with no space — the spelling the 2026-09-15 scan missed.
    const same = await within(() =>
      citizens.reviewDuplicates(
        {
          personal: { firstName: 'عبدالحسن', middleName: 'ابراهيم', lastName: 'حدرج' },
          contact: {},
          properties: [],
        } as never,
        { id: officerId },
      ),
    );
    expect(same.possibleDuplicates.map((row) => row.id)).toContain(existingId);

    // A different person on the number this officer filed minutes ago.
    const otherPerson = await within(() =>
      citizens.reviewDuplicates(
        {
          personal: { firstName: 'نور', middleName: 'حسين', lastName: 'عياش' },
          contact: { phone: phone.stored },
          properties: [{ occupancyType: 'FREE_OCCUPANT', landlordPhone: phone.stored, landlordName: 'عبد الحسن حدرج' }],
        } as never,
        { id: officerId },
      ),
    );
    expect(otherPerson.possibleDuplicates).toEqual([]);
    expect(otherPerson.phoneOwners.map((row) => row.id)).toEqual([existingId]);
    expect(otherPerson.landlordPhoneCards).toEqual([
      { index: 0, landlordName: 'عبد الحسن حدرج', field: 'phone' },
    ]);

    // Another officer, the same number: a household line, not a question.
    const elsewhere = await within(() =>
      citizens.reviewDuplicates(
        {
          personal: { firstName: 'نور', middleName: 'حسين', lastName: 'عياش' },
          contact: { phone: phone.stored },
          properties: [],
        } as never,
        { id: randomUUID() },
      ),
    );
    expect(elsewhere.phoneOwners).toEqual([]);
  });

  // ─────────────────────────────  Following the card  ─────────────────────────────

  it('moves the owner with the tenant’s corrected flat', async () => {
    const { units, building } = await surveyedBlock('LNK-14');
    const phone = freshPhone();
    const { entryId, registrationId, tenantId } = await tenantFiling({
      landlordPhone: phone.stored,
      parcelNumber: 'LNK-14',
      buildingId: building.id,
      unitIds: [units[0]!.id],
    });
    const owner = await ownerWithFile(phone.stored);
    await within(() => links.confirm({ propertyEntryId: entryId, citizenId: owner.id, actor: actor() }));

    // The officer corrects flat 1 to flat 2 on the tenant's card.
    await db.buildingUnit.updateMany({ where: { propertyEntryId: entryId }, data: { unitId: units[1]!.id } });
    await within(() => census.syncRegistration({ registrationId, citizenId: tenantId, actor: actor() }));

    const result = await within(() => links.reconcileRegistration(registrationId, actor()));
    expect(result).toEqual({ updated: 1, blocked: [] });

    const spells = await ownerSpells(owner.id);
    expect(spells.find((row) => row.unitId === units[0]!.id)?.toDate).not.toBeNull();
    expect(spells.find((row) => row.unitId === units[1]!.id)?.toDate).toBeNull();

    const [card] = await ownerCards(owner.id);
    expect(card!.units.map((row) => row.unitId)).toEqual([units[1]!.id]);

    const footprint = readFootprint(
      (await db.propertyEntry.findUniqueOrThrow({ where: { id: entryId } })).landlordLinkFootprint,
      owner.id,
    )!;
    expect(footprint.units.map((unit) => unit.unitId)).toEqual([units[1]!.id]);
  });

  // ─────────────────────────────  The tenant’s edit form  ─────────────────────────────

  describe('saving the tenant’s file', () => {
    const payloadFor = async (tenantId: string, cards: Array<Record<string, unknown>>) => {
      const tenant = await db.user.findUniqueOrThrow({ where: { id: tenantId } });
      return adminUpdateCitizenSubmissionSchema.parse({
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
        contact: {
          maritalStatus: 'MARRIED',
          phone: tenant.phone,
          whatsappSameAsPhone: true,
          actualHouseholdMembers: '4',
        },
        properties: cards,
        flags: [],
      });
    };

    const cardFor = (entryId: string, buildingId: string, unitId: string, over: Record<string, unknown> = {}) => ({
      id: entryId,
      occupancyType: 'TENANT',
      landlordName: 'اسم آخر تماماً',
      landlordPhone: OWNER_PHONE_TYPED,
      propertyType: 'BUILDING',
      neighborhood: 'الحي الشرقي',
      propertyNumber: 'LNK-UPD',
      buildingName: 'بيت ابراهيم نصرالله',
      buildingId,
      units: [{ unitType: 'APARTMENT', floor: '0', unitArea: '95', unitId }],
      ...over,
    });

    const linkedTenant = async () => {
      const { units, building } = await surveyedBlock(`LNK-UPD-${randomUUID().slice(0, 4)}`);
      /*
        A number unique to this test, typed the way an officer types it and
        stored the way the schema normalises it.
      */
      const phone = freshPhone();
      const filing = await tenantFiling({
        landlordPhone: phone.stored,
        parcelNumber: 'LNK-UPD',
        buildingId: building.id,
        unitIds: [units[0]!.id],
      });
      const owner = await ownerWithFile(phone.stored);
      await within(() =>
        links.confirm({ propertyEntryId: filing.entryId, citizenId: owner.id, actor: actor() }),
      );
      return { ...filing, owner, phone, building, units };
    };

    it('keeps the tenant’s words and the link when a stale form sends another name', async () => {
      const linked = await linkedTenant();
      const payload = await payloadFor(linked.tenantId, [
        cardFor(linked.entryId, linked.building.id, linked.units[0]!.id, { landlordPhone: linked.phone.typed }),
      ]);

      await within(() =>
        citizens.update({ tenantSlug: 'links', citizenId: linked.tenantId, payload, actor: actor() }),
      );

      const card = await db.propertyEntry.findUniqueOrThrow({ where: { id: linked.entryId } });
      expect(card.landlordName).toBe('ibrahim hashem nasrallah');
      expect(card.landlordCitizenId).toBe(linked.owner.id);
      expect((await ownerSpells(linked.owner.id))[0]!.toDate).toBeNull();
    });

    it('undoes the link, and what it wrote, when the number is corrected', async () => {
      const linked = await linkedTenant();
      const corrected = freshPhone();
      const payload = await payloadFor(linked.tenantId, [
        cardFor(linked.entryId, linked.building.id, linked.units[0]!.id, { landlordPhone: corrected.typed }),
      ]);

      const saved = await within(() =>
        citizens.update({ tenantSlug: 'links', citizenId: linked.tenantId, payload, actor: actor() }),
      );
      expect(saved.landlordLinkChanges.unlinked).toHaveLength(1);

      const card = await db.propertyEntry.findUniqueOrThrow({ where: { id: linked.entryId } });
      expect(card).toMatchObject({
        landlordCitizenId: null,
        landlordLinkFootprint: null,
        landlordPhone: corrected.stored,
      });
      expect((await ownerSpells(linked.owner.id))[0]!.toDate).not.toBeNull();
      expect(await ownerCards(linked.owner.id)).toEqual([]);
    });

    it('undoes the link, and what it wrote, when the card is removed from the file', async () => {
      const linked = await linkedTenant();
      const payload = await payloadFor(linked.tenantId, []);

      await within(() =>
        citizens.update({ tenantSlug: 'links', citizenId: linked.tenantId, payload, actor: actor() }),
      );

      expect(await db.propertyEntry.findUnique({ where: { id: linked.entryId } })).toBeNull();
      expect((await ownerSpells(linked.owner.id))[0]!.toDate).not.toBeNull();
      expect(await ownerCards(linked.owner.id)).toEqual([]);
    });

    it('refuses a save from a form opened before somebody else saved the file', async () => {
      /*
        2026-09-16: two officers on one registration for 45 minutes, each save
        replacing the other's. The second save now says who got there first.
      */
      const linked = await linkedTenant();
      const opened = await within(() => citizens.getEditable(linked.tenantId, officerId));
      const payload = await payloadFor(linked.tenantId, [
        cardFor(linked.entryId, linked.building.id, linked.units[0]!.id, { landlordPhone: linked.phone.typed }),
      ]);

      // A colleague saves first, from their own freshly opened form.
      const first = await within(() =>
        citizens.update({
          tenantSlug: 'links',
          citizenId: linked.tenantId,
          payload: { ...payload, expectedVersion: opened.version },
          actor: actor(),
        }),
      );
      expect(first.version).not.toBe(opened.version);
      await settleAudit();

      const stale = within(() =>
        citizens.update({
          tenantSlug: 'links',
          citizenId: linked.tenantId,
          payload: { ...payload, expectedVersion: opened.version },
          actor: actor(),
        }),
      );
      await expect(stale).rejects.toBeInstanceOf(ConflictError);
      await expect(stale).rejects.toMatchObject({
        details: { staleEdit: { version: first.version, lastEditedBy: 'موظف البلدية' } },
      });

      // «احفظ واستبدل» — the current version goes through.
      await expect(
        within(() =>
          citizens.update({
            tenantSlug: 'links',
            citizenId: linked.tenantId,
            payload: { ...payload, expectedVersion: first.version },
            actor: actor(),
          }),
        ),
      ).resolves.toMatchObject({ updated: true });
    });

    it('does not name a reviewer as the last person to edit the file', async () => {
      /*
        A return is logged against the citizen but changes nothing on the file.
        Counted as an edit, the officer opening the record to fix it was told
        the reviewer had changed it.
      */
      const linked = await linkedTenant();
      const payload = await payloadFor(linked.tenantId, [
        cardFor(linked.entryId, linked.building.id, linked.units[0]!.id, { landlordPhone: linked.phone.typed }),
      ]);
      await within(() =>
        citizens.update({ tenantSlug: 'links', citizenId: linked.tenantId, payload, actor: actor() }),
      );
      await settleAudit();

      const reviewerId = randomUUID();
      await db.user.create({
        data: {
          id: reviewerId,
          kind: 'STAFF',
          tenantSlug: 'links',
          email: `reviewer-${reviewerId}@links.gov.lb`,
          firstName: 'مدقق',
          lastName: 'الجودة',
          role: 'AUDITOR',
        },
      });
      await db.auditLogEntry.create({
        data: {
          actorId: reviewerId,
          actorType: 'STAFF',
          actorRole: 'AUDITOR',
          action: 'RECORD_RETURNED',
          entityType: 'User',
          entityId: linked.tenantId,
        },
      });

      const opened = await within(() => citizens.getEditable(linked.tenantId, reviewerId));
      expect(opened.lastStaffEdit).toMatchObject({ name: 'موظف البلدية', byViewer: false });
    });
  });
});

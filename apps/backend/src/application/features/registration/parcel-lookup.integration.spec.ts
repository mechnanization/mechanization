import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { adminCreateCitizenSubmissionSchema } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { parcelNumberKey } from '../../../domain/interfaces/parcel-repository.interface';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaParcelRepository } from '../../../infrastructure/repositories/parcel.repository';
import { PrismaRegistrationRepository } from '../../../infrastructure/repositories/registration.repository';
import { RegistrationService } from './registration.service';

/**
 * A رقم العقار typed in Arabic or Persian digits finds its Latin twin in the
 * cadastre and on the cards, and the other way round: both sides are stored as
 * typed, and every lookup compares them digit-normalised. Synthetic data only.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_parcel_lookup_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const arabic = (latin: string) => latin.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
const persian = (latin: string) => latin.replace(/[0-9]/g, (d) => String.fromCharCode(0x06f0 + Number(d)));

describeIfDb('looking a رقم العقار up whatever digits it was typed in', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let parcels: PrismaParcelRepository;
  let registrations: PrismaRegistrationRepository;
  let service: RegistrationService;

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-pl', tenantSlug: 'pl', schemaName: SCHEMA, prisma: db }, work);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    parcels = new PrismaParcelRepository(context);
    registrations = new PrismaRegistrationRepository(context);
    service = new RegistrationService(
      registrations,
      parcels,
      { resolve: async () => ({ allowsPropertyType: () => true, referencePrefix: 'PL' }) } as never,
      { emit: () => true } as never,
    );
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  /** A number no other test uses, so no test can find another's parcel. */
  let next = 1_000;
  const fresh = () => String((next += 100));

  const parcel = (parcelNumber: string, latitude = 33.3, longitude = 35.3) =>
    db.parcel.create({ data: { parcelNumber, latitude, longitude, pointCount: 1 } });

  const card = async (propertyNumber: string, ended = false) => {
    const citizenId = randomUUID();
    await db.user.create({
      data: { id: citizenId, kind: 'CITIZEN', tenantSlug: 'pl', firstName: 'سامي', lastName: 'تجربة' },
    });
    const registration = await db.registration.create({
      data: { citizenId, referenceNumber: `PL-${randomUUID()}` },
    });
    await db.propertyEntry.create({
      data: {
        registrationId: registration.id,
        occupancyType: 'OWNER',
        propertyType: 'LAND',
        propertyNumber,
        ...(ended ? { endedAt: new Date() } : {}),
      },
    });
  };

  it('finds a parcel stored in Latin digits from a number typed in Arabic or Persian digits', async () => {
    const latin = fresh();
    await parcel(latin, 33.25, 35.21);

    for (const typed of [arabic(latin), persian(latin), ` ${latin} `]) {
      const found = await within(() => parcels.findByNumber(typed));
      expect(found).toMatchObject({ parcelNumber: latin, latitude: 33.25, longitude: 35.21 });
    }
  });

  it('finds a parcel stored in Arabic digits from a number typed in Latin digits', async () => {
    const latin = fresh();
    await parcel(arabic(latin));

    const found = await within(() => parcels.findByNumber(latin));
    // The stored label is reported as it is stored.
    expect(found?.parcelNumber).toBe(arabic(latin));
  });

  it('keys the batched lookup by the normalised number, so the typed form reads it through parcelNumberKey', async () => {
    const one = fresh();
    const two = fresh();
    const absent = fresh();
    await parcel(one);
    await parcel(arabic(two));

    const found = await within(() => parcels.findManyByNumber([arabic(one), two, absent]));
    expect([...found.keys()].sort()).toEqual([one, two].sort());
    expect(found.get(parcelNumberKey(arabic(one)))?.parcelNumber).toBe(one);
    expect(found.get(parcelNumberKey(two))?.parcelNumber).toBe(arabic(two));
    expect(found.has(parcelNumberKey(absent))).toBe(false);
  });

  it('counts the cards on a parcel whatever digits each was typed in, and not the ended ones', async () => {
    const latin = fresh();
    await card(latin);
    await card(arabic(latin));
    await card(persian(latin));
    await card(arabic(latin), true);

    await expect(within(() => registrations.countRegistrationsForParcel(latin))).resolves.toBe(3);
    await expect(within(() => registrations.countRegistrationsForParcel(arabic(latin)))).resolves.toBe(3);
  });

  it('suggests neighbours of a number typed in Arabic digits, labels stored in Arabic digits among them', async () => {
    // Far above every other test's numbers, so the nearest are this test's own.
    await parcel('9000000');
    await parcel(arabic('9000003'));
    await parcel('9000010');

    const suggestions = await within(() => parcels.suggest(arabic('9000002'), 2));
    expect(suggestions).toEqual([arabic('9000003'), '9000000']);
  });

  it('places a card typed «١٥٥٣» on parcel 1553, saves it in Latin digits, and flags only the number the cadastre lacks', async () => {
    const latin = fresh();
    const unknown = fresh();
    await parcel(latin, 33.5, 35.5);

    const land = (propertyNumber: string) => ({
      occupancyType: 'OWNER',
      propertyType: 'LAND',
      propertyNumber,
      landType: 'AGRICULTURAL',
      unitArea: '500',
      shares: '2400',
    });
    const payload = adminCreateCitizenSubmissionSchema.parse({
      personal: {
        firstName: 'سامي',
        middleName: 'علي',
        lastName: 'تجربة',
        motherName: 'ليلى',
        gender: 'MALE',
        isLebanese: true,
        civilRecordNumber: '12',
        residentStatus: 'VILLAGE_RESIDENT',
        nationality: 'LB',
      },
      contact: {
        phone: '+96177000000',
        whatsappSameAsPhone: true,
        maritalStatus: 'MARRIED',
        actualHouseholdMembers: 3,
        totalRegisteredMembers: 3,
      },
      flags: [],
      properties: [land(arabic(latin)), land(arabic(unknown))],
    });

    const result = await within(() => service.submit({ tenantSlug: 'pl', payload }));

    const registration = await db.registration.findUniqueOrThrow({
      where: { id: result.registrationId },
      include: { properties: { orderBy: { propertyNumber: 'asc' } } },
    });
    const placed = registration.properties.find((entry) => entry.propertyNumber === latin);
    expect(placed).toMatchObject({ latitude: 33.5, longitude: 35.5 });
    // Saved in Latin digits (`propertyNumberField`, since 2026-10-14): the same parcel typed two ways is one number.
    expect(registration.properties.map((entry) => entry.propertyNumber).sort()).toEqual([latin, unknown].sort());
    expect(registration.flaggedFields).toEqual([
      expect.objectContaining({ path: 'properties.1.propertyNumber', kind: 'UNVERIFIED' }),
    ]);
  });

  it('answers the entry form’s live check for «١٥٥٣» with the parcel and the people on 1553', async () => {
    const latin = fresh();
    await parcel(latin, 33.4, 35.4);
    await card(latin);
    await card(arabic(latin));

    const check = await within(() => service.checkPropertyNumber(arabic(latin)));
    expect(check).toMatchObject({
      propertyNumber: arabic(latin),
      inCadastre: true,
      location: { latitude: 33.4, longitude: 35.4 },
      suggestions: [],
      registeredCount: 2,
    });
  });
});

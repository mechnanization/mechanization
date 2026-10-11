import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { adminUpdateCitizenSubmissionSchema, type ImportRow } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { ConflictError } from '../../../domain/errors/domain-error';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { PrismaCaseRepository } from '../../../infrastructure/repositories/case.repository';
import { PrismaParcelRepository } from '../../../infrastructure/repositories/parcel.repository';
import { PrismaRegistrationRepository } from '../../../infrastructure/repositories/registration.repository';
import { AuditService } from '../audit/audit.service';
import { BuildingsService } from '../buildings/buildings.service';
import { CensusSyncService } from '../buildings/census-sync.service';
import { CasesService } from '../cases/cases.service';
import { RegistrationService } from '../registration/registration.service';
import { CitizensService } from './citizens.service';
import { LandlordLinkService } from './landlord-link.service';

/**
 * Filing on a citizen's file against a real Postgres: what a save, a new
 * filing and an import are refused with, and that a refusal writes nothing.
 * Wired like the application, down to the registration repository, because
 * the refusals under test come from the database (a unique index) or from
 * the write path's own reads. Synthetic people only.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_citizen_filing_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('filing on a citizen file', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let citizens: CitizensService;
  let officerId: string;

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-cf', tenantSlug: 'cf', schemaName: SCHEMA, prisma: db }, work);
  const actor = () => ({ id: officerId, role: 'ADMINISTRATIVE_OFFICER' });

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();

    const events = new EventEmitter2();
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    events.on('citizen.changed', (payload) => audit.onCitizenChanged(payload));
    events.on('building.changed', (payload) => audit.onBuildingChanged(payload));

    const tenants = { resolve: async () => ({ allowsPropertyType: () => true, referencePrefix: 'CF' }) };
    const parcels = new PrismaParcelRepository(context);
    const cases = new CasesService(
      new PrismaCaseRepository(context),
      { findById: async () => ({ id: officerId, kind: 'STAFF' }) } as never,
      events,
    );
    const buildings = new BuildingsService(context, cases, events);
    citizens = new CitizensService(
      context,
      new RegistrationService(new PrismaRegistrationRepository(context), parcels, tenants as never, events),
      tenants as never,
      parcels,
      new CensusSyncService(context, cases, events),
      new LandlordLinkService(context, buildings, events, audit),
      events,
      audit,
    );

    officerId = randomUUID();
    await db.user.create({
      data: {
        id: officerId,
        kind: 'STAFF',
        tenantSlug: 'cf',
        email: `officer-${officerId}@cf.gov.lb`,
        firstName: 'موظف',
        lastName: 'البلدية',
        role: 'ADMINISTRATIVE_OFFICER',
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  /** A citizen with a file (one filing, no cards) — what the edit form opens. */
  const fileOf = async (over: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await db.user.create({
      data: {
        id,
        kind: 'CITIZEN',
        tenantSlug: 'cf',
        firstName: 'سامي',
        middleName: 'علي',
        lastName: `تجربة${randomUUID().slice(0, 4)}`,
        referenceNumber: `CF-${randomUUID().slice(0, 10)}`,
        ...over,
      },
    });
    await db.registration.create({ data: { citizenId: id, referenceNumber: `CF-R-${randomUUID().slice(0, 10)}` } });
    return id;
  };

  const thrown = async (work: Promise<unknown>): Promise<unknown> => {
    try {
      await work;
    } catch (error) {
      return error;
    }
    throw new Error('expected a refusal, but the call resolved');
  };

  describe('the import’s dry run asks the duplicate question the import will', () => {
    /** A household with a house, as a register typed up from paper has it. */
    const houseRow = (over: Partial<ImportRow>): ImportRow => ({
      firstName: 'علي',
      middleName: 'حسين',
      lastName: 'سرحان',
      motherName: 'فاطمة سرور',
      gender: 'ذكر',
      isLebanese: 'نعم',
      nationality: 'لبناني',
      residentStatus: 'من سكان الضيعة',
      civilRecordNumber: '12',
      maritalStatus: 'متزوج',
      phone: '03123456',
      totalRegisteredMembers: '5',
      actualHouseholdMembers: '5',
      occupancyType: 'مالك',
      neighborhood: 'الحي الشرقي',
      propertyNumber: '1024',
      propertyType: 'منزل',
      buildingName: 'منزل العائلة',
      unitArea: '180',
      ...over,
    });
    /** A Lebanese mobile no other test uses: typed, and as `lebanesePhone` stores it. */
    const mobile = () => {
      const digits = String(100_000 + Math.floor(Math.random() * 899_999));
      return { typed: `03${digits}`, stored: `+9613${digits}` };
    };
    const onFile = (data: Record<string, unknown>) =>
      db.user.create({
        data: {
          id: randomUUID(),
          kind: 'CITIZEN',
          tenantSlug: 'cf',
          referenceNumber: `CF-${randomUUID().slice(0, 10)}`,
          gender: 'MALE',
          isLebanese: true,
          ...data,
        } as never,
      });
    const importRows = (rows: ImportRow[], dryRun: boolean) =>
      within(() => citizens.importMany({ tenantSlug: 'cf', rows, startRow: 2, dryRun, actor: actor() }));

    it('fails a row that is certainly somebody on file, by code, as the import would', async () => {
      const phone = mobile();
      await onFile({
        firstName: 'علي',
        middleName: 'حسين',
        lastName: 'دبوق',
        motherName: 'فاطمة سرور',
        phone: phone.stored,
      });
      const row = houseRow({ lastName: 'دبوق', phone: phone.typed });
      const before = await db.user.count({ where: { kind: 'CITIZEN' } });

      const preview = await importRows([row], true);
      expect(preview).toMatchObject({ dryRun: true, created: 0, failed: 1 });
      expect(preview.results[0]).toMatchObject({ row: 2, ok: false, code: 'CITIZEN_DUPLICATE_BLOCKED' });
      expect(preview.results[0]!.params?.name).toContain('علي حسين دبوق');
      // The words are the screen's: no English log line rides along.
      expect(preview.results[0]!.error).toBeUndefined();
      expect(await db.user.count({ where: { kind: 'CITIZEN' } })).toBe(before);

      const imported = await importRows([row], false);
      expect(imported.results[0]).toMatchObject({ ok: false, code: 'CITIZEN_DUPLICATE_BLOCKED' });
      expect(await db.user.count({ where: { kind: 'CITIZEN' } })).toBe(before);
    });

    it('passes a row that only resembles somebody, and says whom', async () => {
      // The same three names, the father's compared: asked about, never refused.
      await onFile({ firstName: 'حسن', middleName: 'محمود', lastName: 'شرارة', phone: mobile().stored });

      const preview = await importRows(
        [houseRow({ firstName: 'حسن', middleName: 'محمود', lastName: 'شرارة', phone: mobile().typed })],
        true,
      );

      expect(preview).toMatchObject({ created: 1, failed: 0 });
      expect(preview.results[0]).toMatchObject({ ok: true, possibleDuplicateOf: ['حسن محمود شرارة'] });
    });

    it('says nothing about a row that resembles nobody', async () => {
      const preview = await importRows(
        [houseRow({ firstName: 'وسيم', middleName: 'كامل', lastName: 'بزي', phone: mobile().typed })],
        true,
      );

      expect(preview.results[0]).toEqual({ row: 2, ok: true, name: 'وسيم بزي' });
    });
  });

  describe('saving a file with a passport number another file holds', () => {
    const foreignerEdit = (identityDocNumber: string) =>
      adminUpdateCitizenSubmissionSchema.parse({
        personal: {
          firstName: 'Jean',
          middleName: 'Paul',
          lastName: 'Test',
          motherName: 'Marie',
          gender: 'MALE',
          isLebanese: false,
          nationality: 'FR',
          residentStatus: 'DISPLACED',
          identityDocNumber,
        },
        contact: {
          phone: '+96177000000',
          whatsappSameAsPhone: true,
          maritalStatus: 'SINGLE',
          actualHouseholdMembers: 1,
          totalRegisteredMembers: 1,
        },
        flags: [],
        properties: [],
      });

    it('is refused by code, naming nobody, and writes nothing', async () => {
      const number = `P${randomUUID().slice(0, 8).toUpperCase()}`;
      await fileOf({
        firstName: 'Holder',
        lastName: 'Somebody',
        isLebanese: false,
        identityDocType: 'PASSPORT',
        identityDocNumber: number,
      });
      const editing = await fileOf({ firstName: 'Jean', lastName: 'Test', isLebanese: false });

      const refusal = await thrown(
        within(() =>
          citizens.update({ tenantSlug: 'cf', citizenId: editing, payload: foreignerEdit(number), actor: actor() }),
        ),
      );

      expect(refusal).toBeInstanceOf(ConflictError);
      const conflict = refusal as ConflictError;
      expect(conflict.code).toBe('CITIZEN_IDENTITY_DOC_TAKEN');
      expect(conflict.params).toBeUndefined();
      expect(conflict.details).toBeUndefined();
      expect(conflict.message).not.toMatch(/Holder|Somebody/);
      expect(await db.user.findUniqueOrThrow({ where: { id: editing } })).toMatchObject({
        identityDocNumber: null,
        firstName: 'Jean',
      });
    });
  });
});

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { ArrearsTemplateCells } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { ARREARS_LINES_IMPORTED, ARREARS_TEMPLATE_EXPORTED, ArrearsService } from './arrears.service';
import { StaffActor } from '../../common/actor';

/**
 * Old debts against a real tenant schema (task 4, docs/old-debts-plan.md §4–§6):
 * the template's export (who is chosen, what each row carries, the retry key,
 * two exports never sharing a person), then the import's dry run, which writes
 * nothing, and its write into the DRAFT, refused whole while a line is refused.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_arrears_service_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('old debts: export, dry run, draft', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let service: ArrearsService;
  const accountantId = randomUUID();
  const accountant: StaffActor = { id: accountantId, role: 'ACCOUNTANT' };
  const zoneId = randomUUID();
  const outsideBuildingId = randomUUID();
  const people = {
    amal: randomUUID(), // a flat on 500
    bassem: randomUUID(), // a flat on 500 (read destroyed) and one on 501
    dalal: randomUUID(), // archived, a tenant on 501
    fadi: randomUUID(), // a card on 501 and no flat
    camil: randomUUID(), // a flat outside the zone
    elias: randomUUID(), // merged into Amal's file
  };
  let batchId: string;

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'arr', tenantSlug: 'arr', schemaName: SCHEMA, prisma: db }, work);

  const exportZone = (count: number, key = randomUUID()) =>
    within(() => service.exportTemplate({ zoneId, count, clientRequestId: key }, accountant));

  const importFile = (rows: ArrearsTemplateCells[], options: { dryRun?: boolean; drops?: never[]; batch?: string } = {}) =>
    within(() =>
      service.importLines(options.batch ?? batchId, { rows, startRow: 1, drops: options.drops ?? [], dryRun: options.dryRun ?? false }, accountant),
    );

  const lineCount = async (batch = batchId) => (await db.arrearsLine.count({ where: { batchId: batch } }));

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    service = new ArrearsService(context, new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never));

    const citizen = (id: string, firstName: string, isActive = true) => ({
      id, kind: 'CITIZEN' as const, tenantSlug: 'arr', firstName, middleName: 'محمد', lastName: 'حداد', isActive,
      referenceNumber: `REF-${id.slice(0, 8)}`, phone: '+96170123456',
    });
    await db.user.createMany({
      data: [
        { id: accountantId, kind: 'STAFF', tenantSlug: 'arr', email: `${accountantId}@arr.gov.lb`, firstName: 'محاسب', lastName: 'البلدية', role: 'ACCOUNTANT' as never },
        citizen(people.amal, 'أمل'),
        citizen(people.bassem, 'باسم'),
        citizen(people.dalal, 'دلال', false),
        citizen(people.fadi, 'فادي'),
        citizen(people.camil, 'كميل'),
        citizen(people.elias, 'إلياس'),
      ],
    });
    await db.systemSettings.create({ data: {} });
    await db.zone.create({ data: { id: zoneId, name: 'الحي الغربي', code: 'WEST', parcelNumbers: ['500', '501'] } });

    const building = (id: string, parcelNumber: string, code: string) =>
      db.building.create({ data: { id, parcelNumber, codeSuffix: 'A', code, structureType: 'MIXED_USE' as never, floorsCount: 1, createdById: accountantId } });
    const b500 = await building(randomUUID(), '500', 'W-1-500-A');
    const b501 = await building(randomUUID(), '501', 'W-1-501-A');
    await building(outsideBuildingId, '600', 'E-1-600-A');

    let sequence = 0;
    const unit = (buildingId: string, unitCode: string) =>
      db.unit.create({ data: { buildingId, unitCode, floor: 0, sequence: ++sequence, unitType: 'APARTMENT' as never } });
    const u500a = await unit(b500.id, '0001');
    const u500b = await unit(b500.id, '0002');
    const u501a = await unit(b501.id, '0001');
    const u600 = await unit(outsideBuildingId, '0001');
    const hold = (citizenId: string, unitId: string, role = 'OWNER') =>
      db.unitOccupancy.create({ data: { citizenId, unitId, role: role as never } });
    await hold(people.amal, u500a.id);
    await hold(people.bassem, u500b.id);
    await hold(people.bassem, u501a.id);
    await hold(people.dalal, u501a.id, 'TENANT');
    await hold(people.camil, u600.id);
    await hold(people.elias, u500a.id, 'TENANT');
    await db.citizenMerge.create({ data: { survivorId: people.amal, absorbedId: people.elias, reason: 'ملف مكرر', footprint: {} } });

    // Fadi holds no flat: a card on 501 only, on his latest registration.
    const registration = await db.registration.create({ data: { citizenId: people.fadi, referenceNumber: `REG-${randomUUID().slice(0, 8)}` } });
    await db.propertyEntry.create({
      data: { registrationId: registration.id, occupancyType: 'OWNER', propertyType: 'LAND' as never, propertyNumber: '501', buildingId: b501.id },
    });

    // Bassem's flat on 500 was destroyed.
    await db.damageAssessment.create({
      data: { unitId: u500b.id, level: 'TOTAL_COLLAPSE' as never, source: 'FIELD_VISIT' as never, assessedAt: new Date('2024-10-02T08:00:00.000Z') },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  describe('the export', () => {
    it('picks the zone’s people by رقم العقار then name — archived in, merged-away and outsiders out — with names, numbers and units only', async () => {
      const key = randomUUID();
      const result = await exportZone(10, key);
      batchId = result.batchId;
      expect(result).toMatchObject({ replayed: false, citizenCount: 4 });
      expect(result.rows).toEqual([
        { rowKey: 1, fullName: 'أمل محمد حداد', propertyNumber: '500', unitCode: 'W-1-500-A-0001' },
        { rowKey: 2, fullName: 'باسم محمد حداد', propertyNumber: '500', unitCode: 'W-1-500-A-0002' },
        { rowKey: 2, fullName: 'باسم محمد حداد', propertyNumber: '501', unitCode: 'W-1-501-A-0001' },
        { rowKey: 3, fullName: 'دلال محمد حداد', propertyNumber: '501', unitCode: 'W-1-501-A-0001' },
        { rowKey: 4, fullName: 'فادي محمد حداد', propertyNumber: '501', unitCode: null },
      ]);
      // No رقم مرجعي, phone or id reaches the file.
      expect(JSON.stringify(result)).not.toMatch(/REF-|\+961|70123456/);
      for (const row of result.rows) expect(Object.keys(row).sort()).toEqual(['fullName', 'propertyNumber', 'rowKey', 'unitCode']);

      const batch = await db.arrearsBatch.findUniqueOrThrow({ where: { id: batchId } });
      expect(batch).toMatchObject({ status: 'DRAFT', preparedById: accountantId, scope: { zoneId, count: 10 } });

      // The same press again is answered with the same batch; the key for another count is refused.
      expect(await exportZone(10, key)).toMatchObject({ batchId, replayed: true, citizenCount: 4 });
      await expect(exportZone(3, key)).rejects.toMatchObject({ code: 'ARREARS_EXPORT_REQUEST_REUSED' });
    });

    it('never hands the same person to two exports', async () => {
      await expect(exportZone(10)).rejects.toMatchObject({ code: 'ARREARS_EXPORT_NOTHING_LEFT' });
    });

    it('leaves an audit row with the batch and the count, and no name', async () => {
      const rows = await db.auditLogEntry.findMany({ where: { action: ARREARS_TEMPLATE_EXPORTED } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entityId: batchId, actorId: accountantId });
      expect(JSON.stringify(rows[0]!.after)).not.toMatch(/أمل|باسم|دلال|فادي/);
    });

    it('refuses a zone or a building that does not exist', async () => {
      await expect(within(() => service.exportTemplate({ zoneId: randomUUID(), count: 5, clientRequestId: randomUUID() }, accountant)))
        .rejects.toMatchObject({ code: 'ZONE_NOT_FOUND' });
      await expect(within(() => service.exportTemplate({ buildingId: randomUUID(), count: 5, clientRequestId: randomUUID() }, accountant)))
        .rejects.toMatchObject({ code: 'BUILDING_NOT_FOUND' });
    });
  });

  describe('the import', () => {
    const file = (): ArrearsTemplateCells[] => [
      { rowKey: '1', fullName: 'أمل محمد حداد', propertyNumber: '500', unitCode: 'W-1-500-A-0001', year: '2023', feeType: 'RENTAL_VALUE', principal: '300000', penalty: '30000' },
      { rowKey: '1', fullName: 'أمل محمد حداد', propertyNumber: '500', unitCode: 'W-1-500-A-0001', year: '2019', feeType: 'RENTAL_VALUE', principal: '250000' },
      { rowKey: '2', fullName: 'باسم محمد حداد', propertyNumber: '500', unitCode: 'W-1-500-A-0002', year: '2024', feeType: 'CLEANING', principal: '90000' },
      { rowKey: '2', fullName: 'باسم محمد حداد', propertyNumber: '501', unitCode: 'W-1-501-A-0001', year: '', feeType: '', principal: '' },
      { rowKey: '3', fullName: 'دلال محمد حداد', propertyNumber: '٥٠١', unitCode: 'w-1-501-a-0001', year: '2022', feeType: 'رسم النظافة', principal: '40,000' },
      { rowKey: '', fullName: 'سمير خليل', propertyNumber: '500', unitCode: '', year: '2023', feeType: 'RENTAL_VALUE', principal: '120000' },
    ];

    it('refuses every line while no cutoff is set: in the preview, line by line; in the write, outright', async () => {
      const preview = await importFile(file(), { dryRun: true });
      expect(preview.cutoffYear).toBeNull();
      expect(preview.lines.every((line) => line.status === 'REFUSED' && line.issues.includes('CUTOFF_NOT_SET'))).toBe(true);
      await expect(importFile(file())).rejects.toMatchObject({ code: 'ARREARS_CUTOFF_NOT_SET' });
      expect(await lineCount()).toBe(0);
    });

    it('checks the file in a dry run and writes nothing', async () => {
      await db.systemSettings.updateMany({ data: { arrearsCutoffYear: 2026 } });
      const preview = await importFile(file(), { dryRun: true });
      expect(preview).toMatchObject({ dryRun: true, cutoffYear: 2026, written: null });
      expect(preview.lines.map((line) => [line.row, line.component, line.status])).toEqual([
        [1, 'PRINCIPAL', 'KEEP'],
        [1, 'PENALTY', 'KEEP'],
        [2, 'PRINCIPAL', 'DROP'],
        [3, 'PRINCIPAL', 'KEEP'],
        [5, 'PRINCIPAL', 'KEEP'],
        [6, 'PRINCIPAL', 'UNMATCHED'],
      ]);
      expect(preview.lines[2]).toMatchObject({ dropReason: 'مرور الزمن', flags: { prescribed: true } });
      expect(preview.lines[3]!.flags.war).toMatchObject({ level: 'TOTAL_COLLAPSE', assessedAt: '2024-10-02T08:00:00.000Z' });
      expect(preview.lines[4]!.flags).toEqual({ archived: true });
      expect(preview.coverage).toEqual({ citizens: 4, withLines: 3, checkedNothingOwed: 0, notInFile: 1 });
      expect(preview.totals.fileTotal).toBe(830_000);
      expect(await lineCount()).toBe(0);
    });

    it('writes the draft’s lines, then replaces them with the next file’s', async () => {
      const written = await importFile(file());
      expect(written.written).toBe(6);
      const lines = await db.arrearsLine.findMany({ where: { batchId }, orderBy: [{ rowKey: 'asc' }, { year: 'desc' }, { component: 'asc' }] });
      expect(lines.map((line) => [line.citizenId, line.year, line.component, line.decision, Number(line.amount)])).toEqual([
        [people.amal, 2023, 'PRINCIPAL', 'KEEP', 300_000],
        [people.amal, 2023, 'PENALTY', 'KEEP', 30_000],
        [people.amal, 2019, 'PRINCIPAL', 'DROP', 250_000],
        [people.bassem, 2024, 'PRINCIPAL', 'KEEP', 90_000],
        [people.dalal, 2022, 'PRINCIPAL', 'KEEP', 40_000],
        [null, 2023, 'PRINCIPAL', 'KEEP', 120_000],
      ]);
      expect(lines.find((line) => line.citizenId === people.dalal)).toMatchObject({ propertyNumber: '501', unitCode: 'W-1-501-A-0001' });
      expect(lines.find((line) => line.citizenId === null)).toMatchObject({ sourceName: 'سمير خليل', rowKey: null });

      await importFile(file().slice(0, 1));
      expect(await lineCount()).toBe(2);

      const audit = await db.auditLogEntry.findMany({ where: { action: ARREARS_LINES_IMPORTED, entityId: batchId } });
      expect(audit).toHaveLength(2);
      expect(JSON.stringify(audit.map((row) => row.after))).not.toMatch(/أمل|سمير/);
    });

    it('refuses the whole file while a line is refused, and leaves the draft as it was', async () => {
      // A year the system bills: its principal and its penalty are both refused.
      const bad = [...file().slice(0, 1), { ...file()[0]!, year: '2026' }];
      await expect(importFile(bad)).rejects.toMatchObject({ code: 'ARREARS_IMPORT_HAS_REFUSED_ROWS', params: { count: 2 } });
      expect(await lineCount()).toBe(2);
    });

    it('refuses a debt another batch already holds', async () => {
      // A second draft holding Amal, as a single line would (task 5).
      const other = await db.arrearsBatch.create({ data: { preparedById: accountantId } });
      await db.arrearsBatchCitizen.create({ data: { batchId: other.id, citizenId: people.amal, rowKey: 1 } });
      const preview = await importFile(file().slice(0, 1), { dryRun: true, batch: other.id });
      expect(preview.lines.map((line) => line.issues)).toEqual([['DUPLICATE_LIVE_LINE'], ['DUPLICATE_LIVE_LINE']]);
      await expect(importFile(file().slice(0, 1), { batch: other.id })).rejects.toMatchObject({ code: 'ARREARS_IMPORT_HAS_REFUSED_ROWS' });
    });

    it('takes no file into a batch that is no longer a draft, and knows no batch it does not hold', async () => {
      await db.arrearsBatch.update({
        where: { id: batchId },
        data: { status: 'SUBMITTED', submittedAt: new Date(), submittedById: accountantId, controlTotal: 330_000 },
      });
      await expect(importFile(file(), { dryRun: true })).rejects.toMatchObject({ code: 'ARREARS_BATCH_NOT_DRAFT' });
      await expect(importFile(file(), { batch: randomUUID() })).rejects.toMatchObject({ code: 'ARREARS_BATCH_NOT_FOUND' });
    });
  });
});

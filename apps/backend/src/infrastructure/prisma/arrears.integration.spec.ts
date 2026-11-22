import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../generated/tenant-client';
import { migrateTenantSchema } from './tenant-migrator';
import { tenantTestClient } from './tenant-test-client';

/**
 * Migrations 0107 and 0108, old debts («متأخرات سنوات سابقة»,
 * docs/old-debts-plan.md §3): the rules the database holds, each proven by
 * watching a write that breaks it fail with the code that rule raises — 23505
 * for the one-live-line index, 23514 for a CHECK or a trigger — and the write
 * beside it that keeps it succeed, so a refusal can only be that rule's.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_arrears_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const MIGRATIONS = ['0107_arrears_enum_values', '0108_arrears'].map((name) =>
  readFileSync(join(__dirname, `tenant/migrations/${name}/migration.sql`), 'utf8'),
);

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

describeIfDb('migrations 0107 and 0108: old debts', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  const adminId = randomUUID();
  const accountantId = randomUUID();
  const citizenId = randomUUID();
  const otherCitizenId = randomUUID();
  let unitId: string;

  /** Runs `sql` in the spec schema, committed. */
  const run = async (sql: string, params: unknown[] = []) => {
    await ddl.query('BEGIN');
    try {
      await ddl.query(`SET LOCAL search_path TO "${SCHEMA}"`);
      const result = await ddl.query(sql, params);
      await ddl.query('COMMIT');
      return result;
    } catch (error) {
      await ddl.query('ROLLBACK');
      throw error;
    }
  };

  /** Runs `sql` in the spec schema, rolled back, and returns the Postgres error code it raised, or null. */
  const refusal = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    await ddl.query('BEGIN');
    try {
      await ddl.query(`SET LOCAL search_path TO "${SCHEMA}"`);
      await ddl.query(sql, params);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    } finally {
      await ddl.query('ROLLBACK');
    }
  };

  const draftBatch = async (): Promise<string> => {
    const { rows } = await run(`INSERT INTO arrears_batches ("preparedById") VALUES ($1) RETURNING "id"`, [accountantId]);
    return rows[0].id as string;
  };

  const submit = (batchId: string) =>
    run(
      `UPDATE arrears_batches SET "status" = 'SUBMITTED', "submittedAt" = now(), "submittedById" = $2, "controlTotal" = 0
        WHERE "id" = $1`,
      [batchId, accountantId],
    );

  const approve = (batchId: string) =>
    run(
      `UPDATE arrears_batches SET "status" = 'APPROVED', "approvedAt" = now(), "approvedById" = $2 WHERE "id" = $1`,
      [batchId, adminId],
    );

  const discard = (batchId: string) =>
    run(
      `UPDATE arrears_batches SET "status" = 'DISCARDED', "discardedAt" = now(), "discardedById" = $2 WHERE "id" = $1`,
      [batchId, adminId],
    );

  type Line = Partial<{
    citizenId: string | null;
    sourceName: string | null;
    propertyNumber: string;
    unitCode: string | null;
    unitId: string | null;
    year: number;
    feeType: string;
    feeTypeNote: string | null;
    component: 'PRINCIPAL' | 'PENALTY';
    amount: number;
    currency: string;
    decision: 'KEEP' | 'DROP';
    dropReason: string | null;
  }>;

  const lineSql = (batchId: string, line: Line): [string, unknown[]] => {
    const row = {
      citizenId,
      sourceName: null,
      propertyNumber: '420',
      unitCode: null,
      unitId: null,
      year: 2023,
      feeType: 'RENTAL_VALUE',
      feeTypeNote: null,
      component: 'PRINCIPAL',
      amount: 100_000,
      currency: 'LBP',
      decision: 'KEEP',
      dropReason: null,
      ...line,
    };
    return [
      `INSERT INTO arrears_lines ("batchId", "citizenId", "sourceName", "propertyNumber", "unitCode", "unitId", "year",
          "feeType", "feeTypeNote", "component", "amount", "currency", "decision", "dropReason")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::"ArrearsComponent", $11, $12, $13::"ArrearsLineDecision", $14)
       RETURNING "id"`,
      [
        batchId, row.citizenId, row.sourceName, row.propertyNumber, row.unitCode, row.unitId, row.year,
        row.feeType, row.feeTypeNote, row.component, row.amount, row.currency, row.decision, row.dropReason,
      ],
    ];
  };

  const addLine = async (batchId: string, line: Line = {}): Promise<string> => {
    const { rows } = await run(...lineSql(batchId, line));
    return rows[0].id as string;
  };

  const lineRefusal = (batchId: string, line: Line) => refusal(...lineSql(batchId, line));

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    await db.user.createMany({
      data: [
        { id: adminId, kind: 'STAFF', tenantSlug: 'arr', email: `${adminId}@arr.gov.lb`, firstName: 'مدير', lastName: 'النظام', role: 'SUPER_ADMIN' as never },
        { id: accountantId, kind: 'STAFF', tenantSlug: 'arr', email: `${accountantId}@arr.gov.lb`, firstName: 'محاسب', lastName: 'البلدية', role: 'ACCOUNTANT' as never },
        { id: citizenId, kind: 'CITIZEN', tenantSlug: 'arr', firstName: 'مواطن', lastName: 'أول' },
        { id: otherCitizenId, kind: 'CITIZEN', tenantSlug: 'arr', firstName: 'مواطن', lastName: 'ثان' },
      ],
    });
    const building = await db.building.create({
      data: { parcelNumber: '420', codeSuffix: 'A', code: 'Z-1-420-A', structureType: 'MIXED_USE' as never, floorsCount: 1, createdById: adminId },
    });
    const unit = await db.unit.create({
      data: { buildingId: building.id, unitCode: '0001', floor: 0, sequence: 1, unitType: 'OFFICE' as never },
    });
    unitId = unit.id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('replays both files without error and without a second copy of anything', async () => {
    const count = async () =>
      (await run(
        `SELECT (SELECT count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = $1)
              + (SELECT count(*) FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = $1 AND NOT tg.tgisinternal) AS n`,
        [SCHEMA],
      )).rows[0].n;
    const before = await count();
    for (const sql of MIGRATIONS) await run(sql);
    expect(await count()).toBe(before);
  });

  describe('one live line per debt', () => {
    it('refuses the same citizen, رقم العقار, unit, year, fee and component twice — across batches, and with the digits typed in Arabic', async () => {
      const first = await draftBatch();
      const second = await draftBatch();
      await addLine(first, { propertyNumber: '501', unitCode: 'a-1' });

      expect(await lineRefusal(second, { propertyNumber: ' ٥٠١ ', unitCode: 'A-1 ' })).toBe(UNIQUE_VIOLATION);
      // Each part of the key on its own makes it another debt.
      expect(await lineRefusal(second, { propertyNumber: '502', unitCode: 'A-1' })).toBeNull();
      expect(await lineRefusal(second, { propertyNumber: '501', unitCode: 'A-2' })).toBeNull();
      expect(await lineRefusal(second, { propertyNumber: '501', unitCode: 'A-1', year: 2022 })).toBeNull();
      expect(await lineRefusal(second, { propertyNumber: '501', unitCode: 'A-1', feeType: 'CLEANING' })).toBeNull();
      expect(await lineRefusal(second, { propertyNumber: '501', unitCode: 'A-1', component: 'PENALTY' })).toBeNull();
      expect(await lineRefusal(second, { propertyNumber: '501', unitCode: 'A-1', citizenId: otherCitizenId })).toBeNull();
    });

    it('lets a dropped line and an unmatched one sit beside a live one', async () => {
      const first = await draftBatch();
      const second = await draftBatch();
      await addLine(first, { propertyNumber: '601' });
      expect(await lineRefusal(second, { propertyNumber: '601', decision: 'DROP', dropReason: 'مرور الزمن' })).toBeNull();
      expect(await lineRefusal(second, { propertyNumber: '601', citizenId: null, sourceName: 'أحمد علي' })).toBeNull();
    });

    it('frees the debt when the batch holding it is discarded, by stamping its lines', async () => {
      const first = await draftBatch();
      const lineId = await addLine(first, { propertyNumber: '701' });
      const second = await draftBatch();
      expect(await lineRefusal(second, { propertyNumber: '701' })).toBe(UNIQUE_VIOLATION);

      await discard(first);
      const { rows } = await run(`SELECT "discardedAt" FROM arrears_lines WHERE "id" = $1`, [lineId]);
      expect(rows[0].discardedAt).not.toBeNull();
      expect(await lineRefusal(second, { propertyNumber: '701' })).toBeNull();
    });
  });

  describe("a line's CHECKs", () => {
    let batchId: string;
    beforeAll(async () => {
      batchId = await draftBatch();
    });

    it.each([
      ['an amount of zero', { amount: 0 }],
      ['a negative amount', { amount: -5 }],
      ['a currency other than LBP', { currency: 'USD' }],
      ['a year out of range', { year: 1850 }],
      ['a DROP with no reason', { decision: 'DROP' as const, dropReason: null }],
      ['a DROP with a blank reason', { decision: 'DROP' as const, dropReason: '  ' }],
      ['a KEEP with a reason', { decision: 'KEEP' as const, dropReason: 'لا' }],
      ['no citizen and no name', { citizenId: null, sourceName: null }],
      ['no citizen and a blank name', { citizenId: null, sourceName: ' ' }],
      ['«رسم آخر» with no description', { feeType: 'OTHER', feeTypeNote: null }],
      ['a blank رقم العقار', { propertyNumber: '  ' }],
      ['a unit with no code', { unitId: 'UNIT', unitCode: null }],
    ] as [string, Line][])('refuses %s', async (_label, line) => {
      const resolved: Line = { ...line, unitId: line.unitId === 'UNIT' ? unitId : line.unitId };
      expect(await lineRefusal(batchId, resolved)).toBe(CHECK_VIOLATION);
    });

    it('accepts each of those lines once it is put right', async () => {
      for (const line of [
        { year: 1900, propertyNumber: '801' },
        { decision: 'DROP' as const, dropReason: 'وحدة مهدّمة', propertyNumber: '802' },
        { citizenId: null, sourceName: 'محمد حسن', propertyNumber: '803' },
        { feeType: 'OTHER', feeTypeNote: 'رسم ترخيص', propertyNumber: '804' },
        { unitId, unitCode: '0001', propertyNumber: '805' },
      ] satisfies Line[]) {
        expect(await lineRefusal(batchId, line)).toBeNull();
      }
    });
  });

  describe("a batch's life", () => {
    it('starts as a DRAFT, and moves only along the arrows', async () => {
      expect(await refusal(`INSERT INTO arrears_batches ("preparedById", "status") VALUES ($1, 'SUBMITTED')`, [accountantId]))
        .toBe(CHECK_VIOLATION);

      const batchId = await draftBatch();
      // DRAFT → APPROVED skips the submission.
      expect(await refusal(
        `UPDATE arrears_batches SET "status" = 'APPROVED', "approvedAt" = now(), "approvedById" = $2 WHERE "id" = $1`,
        [batchId, adminId],
      )).toBe(CHECK_VIOLATION);
      // Submitted with no control total.
      expect(await refusal(
        `UPDATE arrears_batches SET "status" = 'SUBMITTED', "submittedAt" = now(), "submittedById" = $2 WHERE "id" = $1`,
        [batchId, accountantId],
      )).toBe(CHECK_VIOLATION);

      await submit(batchId);
      // A submitted batch's figures stay as the manager is judging them.
      expect(await refusal(`UPDATE arrears_batches SET "controlTotal" = 5 WHERE "id" = $1`, [batchId])).toBe(CHECK_VIOLATION);
      // Returned: back to DRAFT, its submission cleared, with a note.
      expect(await refusal(
        `UPDATE arrears_batches SET "status" = 'DRAFT', "returnNote" = 'ناقص صفحة' WHERE "id" = $1`,
        [batchId],
      )).toBe(CHECK_VIOLATION);
      expect(await refusal(
        `UPDATE arrears_batches SET "status" = 'DRAFT', "submittedAt" = NULL, "submittedById" = NULL, "returnNote" = 'ناقص صفحة' WHERE "id" = $1`,
        [batchId],
      )).toBeNull();

      await approve(batchId);
      expect(await refusal(`UPDATE arrears_batches SET "sourceNote" = 'دفتر 3' WHERE "id" = $1`, [batchId])).toBe(CHECK_VIOLATION);
      expect(await refusal(
        `UPDATE arrears_batches SET "status" = 'DISCARDED', "discardedAt" = now(), "discardedById" = $2 WHERE "id" = $1`,
        [batchId, adminId],
      )).toBe(CHECK_VIOLATION);
      expect(await refusal(`DELETE FROM arrears_batches WHERE "id" = $1`, [batchId])).toBe(CHECK_VIOLATION);
    });

    it('never deletes a draft either: it is discarded', async () => {
      const batchId = await draftBatch();
      expect(await refusal(`DELETE FROM arrears_batches WHERE "id" = $1`, [batchId])).toBe(CHECK_VIOLATION);
    });
  });

  describe("an approved batch's lines", () => {
    let batchId: string;
    let lineId: string;
    let waitingId: string;
    let unitLineId: string;

    beforeAll(async () => {
      batchId = await draftBatch();
      lineId = await addLine(batchId, { propertyNumber: '901' });
      waitingId = await addLine(batchId, { propertyNumber: '902', citizenId: null, sourceName: 'سمير خليل' });
      const unit = await db.unit.create({
        data: { buildingId: (await db.unit.findUniqueOrThrow({ where: { id: unitId } })).buildingId, unitCode: '0002', floor: 0, sequence: 2, unitType: 'OFFICE' as never },
      });
      unitLineId = await addLine(batchId, { propertyNumber: '903', unitId: unit.id, unitCode: '0002' });
      await submit(batchId);
      await approve(batchId);
    });

    it('takes no new line and loses none', async () => {
      expect(await lineRefusal(batchId, { propertyNumber: '904' })).toBe(CHECK_VIOLATION);
      expect(await refusal(`DELETE FROM arrears_lines WHERE "id" = $1`, [lineId])).toBe(CHECK_VIOLATION);
    });

    it('keeps every figure', async () => {
      for (const set of [`"amount" = 1`, `"year" = 2020`, `"decision" = 'DROP', "dropReason" = 'لا'`, `"propertyNumber" = '1'`]) {
        expect(await refusal(`UPDATE arrears_lines SET ${set} WHERE "id" = $1`, [lineId])).toBe(CHECK_VIOLATION);
      }
    });

    it('links a waiting line once, with who and when, and never unlinks it', async () => {
      expect(await refusal(`UPDATE arrears_lines SET "citizenId" = $2 WHERE "id" = $1`, [waitingId, citizenId]))
        .toBe(CHECK_VIOLATION);
      await run(
        `UPDATE arrears_lines SET "citizenId" = $2, "linkedAt" = now(), "linkedById" = $3 WHERE "id" = $1`,
        [waitingId, citizenId, accountantId],
      );
      expect(await refusal(`UPDATE arrears_lines SET "linkedAt" = now() WHERE "id" = $1`, [waitingId])).toBe(CHECK_VIOLATION);
      expect(await refusal(`UPDATE arrears_lines SET "citizenId" = NULL, "linkedAt" = NULL, "linkedById" = NULL WHERE "id" = $1`, [waitingId]))
        .toBe(CHECK_VIOLATION);
    });

    it('moves with a merge, from one file to another', async () => {
      expect(await refusal(`UPDATE arrears_lines SET "citizenId" = $2 WHERE "id" = $1`, [lineId, otherCitizenId])).toBeNull();
    });

    it("lets the unit's deletion clear its unit, and keeps the code", async () => {
      const { rows } = await run(`SELECT "unitId" FROM arrears_lines WHERE "id" = $1`, [unitLineId]);
      await run(`DELETE FROM units WHERE "id" = $1`, [rows[0].unitId]);
      const after = await run(`SELECT "unitId", "unitCode" FROM arrears_lines WHERE "id" = $1`, [unitLineId]);
      expect(after.rows[0]).toEqual({ unitId: null, unitCode: '0002' });
      expect(await refusal(`UPDATE arrears_lines SET "unitId" = $2 WHERE "id" = $1`, [unitLineId, unitId])).toBe(CHECK_VIOLATION);
    });

    it('is not linked while its batch is only submitted', async () => {
      const submitted = await draftBatch();
      const waiting = await addLine(submitted, { propertyNumber: '905', citizenId: null, sourceName: 'وليد' });
      await submit(submitted);
      expect(await refusal(
        `UPDATE arrears_lines SET "citizenId" = $2, "linkedAt" = now(), "linkedById" = $3 WHERE "id" = $1`,
        [waiting, citizenId, accountantId],
      )).toBe(CHECK_VIOLATION);
    });
  });

  describe("a batch's citizen set", () => {
    it('is written into a draft, never loses anyone, and moves only with a merge', async () => {
      const batchId = await draftBatch();
      const { rows } = await run(
        `INSERT INTO arrears_batch_citizens ("batchId", "citizenId", "rowKey") VALUES ($1, $2, 1) RETURNING "id"`,
        [batchId, citizenId],
      );
      const memberId = rows[0].id as string;
      expect(await refusal(
        `INSERT INTO arrears_batch_citizens ("batchId", "citizenId", "rowKey") VALUES ($1, $2, 1)`,
        [batchId, otherCitizenId],
      )).toBe(UNIQUE_VIOLATION);
      expect(await refusal(
        `INSERT INTO arrears_batch_citizens ("batchId", "citizenId", "rowKey") VALUES ($1, $2, 0)`,
        [batchId, otherCitizenId],
      )).toBe(CHECK_VIOLATION);
      expect(await refusal(`DELETE FROM arrears_batch_citizens WHERE "id" = $1`, [memberId])).toBe(CHECK_VIOLATION);
      expect(await refusal(`UPDATE arrears_batch_citizens SET "rowKey" = 2 WHERE "id" = $1`, [memberId])).toBe(CHECK_VIOLATION);
      expect(await refusal(`UPDATE arrears_batch_citizens SET "citizenId" = $2 WHERE "id" = $1`, [memberId, otherCitizenId])).toBeNull();

      await submit(batchId);
      expect(await refusal(
        `INSERT INTO arrears_batch_citizens ("batchId", "citizenId", "rowKey") VALUES ($1, $2, 2)`,
        [batchId, otherCitizenId],
      )).toBe(CHECK_VIOLATION);
    });
  });

  describe('«شطب» on a bill', () => {
    let billId: string;
    beforeAll(async () => {
      const bill = await db.citizenPayment.create({
        data: { citizenId, title: 'متأخرات 2023', amount: 100_000, paidAmount: 40_000, dueDate: new Date('2023-12-31') },
      });
      billId = bill.id;
    });

    const writeOff = (fields: Record<string, unknown>) => {
      const row = {
        paymentStatus: 'WRITTEN_OFF',
        writtenOffAt: new Date(),
        writtenOffById: adminId,
        writeOffAmount: 60_000,
        writeOffReason: 'عفو',
        writeOffDecisionRef: 'قرار 12/2026',
        writeOffDecisionDate: '2026-11-01',
        ...fields,
      };
      return refusal(
        `UPDATE citizen_payments SET "paymentStatus" = $2::"PaymentStatus", "writtenOffAt" = $3, "writtenOffById" = $4,
            "writeOffAmount" = $5, "writeOffReason" = $6, "writeOffDecisionRef" = $7, "writeOffDecisionDate" = $8
          WHERE "id" = $1`,
        [billId, row.paymentStatus, row.writtenOffAt, row.writtenOffById, row.writeOffAmount, row.writeOffReason,
          row.writeOffDecisionRef, row.writeOffDecisionDate],
      );
    };

    it('writes off exactly what was left, with who, when, why and the decision', async () => {
      expect(await writeOff({})).toBeNull();
    });

    it.each([
      ['the status without the stamp', { writtenOffAt: null, writtenOffById: null, writeOffAmount: null, writeOffReason: null, writeOffDecisionRef: null, writeOffDecisionDate: null }],
      ['the stamp without the status', { paymentStatus: 'UNPAID' }],
      ['the stamp without a decision number', { writeOffDecisionRef: null }],
      ['a blank reason', { writeOffReason: '  ' }],
      ['a blank decision number', { writeOffDecisionRef: ' ' }],
      ['less than was left', { writeOffAmount: 50_000 }],
      ['more than was left', { writeOffAmount: 70_000 }],
    ])('refuses %s', async (_label, fields) => {
      expect(await writeOff(fields)).toBe(CHECK_VIOLATION);
    });
  });

  it("keeps a bill's old-debt line unique and real", async () => {
    const batchId = await draftBatch();
    const lineId = await addLine(batchId, { propertyNumber: '1001' });
    const insertBill = (line: string) =>
      refusal(
        `INSERT INTO citizen_payments ("id", "citizenId", "title", "amount", "dueDate", "arrearsLineId", "updatedAt")
         VALUES (gen_random_uuid(), $1, 'متأخرات', 100000, '2023-12-31', $2, now())`,
        [citizenId, line],
      );
    await run(
      `INSERT INTO citizen_payments ("id", "citizenId", "title", "amount", "dueDate", "arrearsLineId", "updatedAt")
       VALUES (gen_random_uuid(), $1, 'متأخرات', 100000, '2023-12-31', $2, now())`,
      [citizenId, lineId],
    );
    expect(await insertBill(lineId)).toBe(UNIQUE_VIOLATION);
    expect(await insertBill(randomUUID())).toBe('23503');
  });

  it('holds the cutoff year to a real year', async () => {
    await run(`INSERT INTO system_settings ("id", "updatedAt") VALUES (gen_random_uuid(), now()) ON CONFLICT DO NOTHING`);
    expect(await refusal(`UPDATE system_settings SET "arrearsCutoffYear" = 26`)).toBe(CHECK_VIOLATION);
    expect(await refusal(`UPDATE system_settings SET "arrearsCutoffYear" = 2026`)).toBeNull();
  });

  it.each(['arrears_batches', 'arrears_lines', 'arrears_batch_citizens'])('refuses TRUNCATE on %s', async (table) => {
    // 0103's `reject_append_only_truncate` raises a plain exception.
    expect(await refusal(`TRUNCATE ${table} CASCADE`)).toBe('P0001');
  });
});

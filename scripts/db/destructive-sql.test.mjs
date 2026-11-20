/**
 * The scanner that decides which migrations may run unattended. Run with
 * `pnpm db:test`.
 *
 * Every push to main migrates production without anyone watching, so the
 * question each case answers is: would this statement have run on its own?
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanSql } from './destructive-sql.mjs';
import { ROOT } from './targets.mjs';

const levels = (sql) => scanSql('m', sql).map((f) => f.level);
const blocks = (sql) => levels(sql).includes('blocking');

describe('blocks everything that loses data', () => {
  for (const sql of [
    'DROP TABLE "units";',
    'ALTER TABLE "users" DROP COLUMN "phone";',
    'DROP SCHEMA "tenant_x" CASCADE;',
    'TRUNCATE "audit_log_entries";',
    'TRUNCATE TABLE "treasury_day_closures" CASCADE;',
    'truncate only "payment_transactions";',
    'CREATE FUNCTION f() RETURNS trigger AS $ BEGIN TRUNCATE "audit_log_entries"; RETURN NULL; END $ LANGUAGE plpgsql;',
    'SELECT 1; TRUNCATE "inspector_payouts", "expense_vouchers";',
    // A TRUNCATE run as dynamic SQL empties the table all the same.
    `DO $$ BEGIN EXECUTE 'TRUNCATE "audit_log_entries" CASCADE'; END $$;`,
    `DO $$ BEGIN EXECUTE format('TRUNCATE %I CASCADE', 'citizen_payments'); END $$;`,
    `DO $$ BEGIN EXECUTE 'TRUNCATE' || ' "buildings"'; END $$;`,
    'ALTER TABLE "units" ALTER COLUMN "area" TYPE integer;',
    'ALTER TABLE "users" RENAME COLUMN "phone" TO "mobile";',
    'ALTER TABLE "units" RENAME TO "flats";',
    'DELETE FROM "unit_occupancies" AS dup USING x WHERE dup.id = x.id;',
    'delete   from users;',
    // The shapes an end-to-end run slipped past the previous version:
    'ALTER TABLE "units"\n  ALTER COLUMN "area"\n  TYPE integer;',
    'ALTER TABLE "units" ALTER "area" TYPE integer;',
    'ALTER TABLE "units" ALTER COLUMN "area" SET DATA TYPE integer;',
    'DROP TYPE "UnitType" CASCADE;',
    'DROP SEQUENCE "payment_receipt_seq";',
    'DROP VIEW "occupancy_view" CASCADE;',
    "SELECT '--'; ALTER TABLE \"units\" DROP COLUMN \"note\";",
    "SELECT 'it''s -- fine'; DROP TABLE \"units\";",
    'CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN DELETE FROM "audit"; RETURN NULL; END $$ LANGUAGE plpgsql;',
  ]) {
    test(sql, () => assert.equal(blocks(sql), true));
  }
});

describe('lets additive and harmless statements through', () => {
  for (const sql of [
    'ALTER TABLE "units" ADD COLUMN "note" TEXT;',
    'CREATE TABLE "sms_log" ("id" uuid PRIMARY KEY);',
    'ALTER TABLE "a" ADD CONSTRAINT "a_b_fkey" FOREIGN KEY ("b") REFERENCES "b"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    'CREATE TRIGGER t BEFORE DELETE ON "audit_log_entries" FOR EACH ROW EXECUTE FUNCTION f();',
    // 0103's guards: TRUNCATE as a trigger event, and as the value of TG_OP.
    'CREATE TRIGGER t BEFORE TRUNCATE ON "audit_log_entries" FOR EACH STATEMENT EXECUTE FUNCTION f();',
    'CREATE TRIGGER t BEFORE UPDATE OR DELETE OR TRUNCATE ON "x" FOR EACH STATEMENT EXECUTE FUNCTION f();',
    "DO $ BEGIN EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION f()', 'a', 'b'); END $;",
    "CREATE FUNCTION f() RETURNS trigger AS $ BEGIN IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'no'; END IF; RETURN NULL; END $ LANGUAGE plpgsql;",
    "CREATE FUNCTION f() RETURNS trigger AS $ BEGIN IF TG_OP <> 'TRUNCATE' THEN RETURN NEW; END IF; RETURN NULL; END $ LANGUAGE plpgsql;",
    'SELECT 1 FROM "units" FOR UPDATE;',
    '-- DROP TABLE "units"; kept for reference',
    '/* DELETE FROM users; */ SELECT 1;',
    'ALTER TYPE "UnitType" ADD VALUE \'PILOTIS\';',
    'ALTER TABLE "a" DROP CONSTRAINT "a_b_fkey", ADD CONSTRAINT "a_b_fkey" FOREIGN KEY ("b") REFERENCES "b"("id") ON DELETE CASCADE;',
    'CREATE FUNCTION f() RETURNS trigger AS $body$ BEGIN -- never DROP TABLE here\n RETURN NEW; END $body$ LANGUAGE plpgsql;',
    'COMMENT ON COLUMN "units"."area" IS \'square metres\';',
  ]) {
    test(sql, () => assert.equal(blocks(sql), false));
  }
});

test('an UPDATE that rewrites rows is a warning, not a block: backfills are routine', () => {
  assert.deepEqual(levels('UPDATE "units" AS u SET "status" = \'VACANT\' WHERE u.x;'), ['warning']);
  assert.deepEqual(levels('UPDATE buildings SET a = 1;'), ['warning']);
});

test('a finding names the migration and the statement', () => {
  const [finding] = scanSql('tenant/0058_x', 'DELETE FROM "users";');
  assert.deepEqual(finding, {
    migration: 'tenant/0058_x',
    level: 'blocking',
    what: 'DELETE FROM (removes rows)',
  });
});

test('0103, the TRUNCATE guards on the append-only tables, runs unattended: it names TRUNCATE as a trigger event only', () => {
  const sql = readFileSync(
    join(ROOT, 'apps/backend/src/infrastructure/prisma/tenant/migrations/0103_append_only_no_truncate/migration.sql'),
    'utf8',
  );
  assert.ok(/BEFORE TRUNCATE/.test(sql));
  assert.equal(blocks(sql), false);
});

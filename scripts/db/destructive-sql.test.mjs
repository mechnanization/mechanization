/**
 * The scanner that decides which migrations may run unattended. Run with
 * `pnpm db:test`.
 *
 * Every push to main migrates production without anyone watching, so the
 * question each case answers is: would this statement have run on its own?
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scanSql } from './destructive-sql.mjs';

const levels = (sql) => scanSql('m', sql).map((f) => f.level);
const blocks = (sql) => levels(sql).includes('blocking');

describe('blocks everything that loses data', () => {
  for (const sql of [
    'DROP TABLE "units";',
    'ALTER TABLE "users" DROP COLUMN "phone";',
    'DROP SCHEMA "tenant_x" CASCADE;',
    'TRUNCATE "audit_log_entries";',
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

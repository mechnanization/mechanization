-- 0103: refuse TRUNCATE on the append-only and written-once tables.
--
-- Every table below refuses UPDATE and DELETE row by row (0001, 0017, 0073,
-- 0082, 0083, 0085, 0087, 0089). A row trigger does not fire on TRUNCATE, so
-- `TRUNCATE treasury_day_closures CASCADE` passed them all and reopened every
-- closed day (reproduced on Postgres 17, review of 2026-10-11; docs/security.md,
-- known gaps; task S19 of 2026-11-14). A statement trigger BEFORE TRUNCATE
-- closes it, and it fires for a table reached through CASCADE too.
--
-- What it guards against is an accident: a cleanup script, a seed reset run
-- against the wrong database. The role that owns these tables can still drop a
-- trigger or set `session_replication_role`; doing either to get past this is
-- circumventing a control (docs/database.md), not a way through.
--
-- Additive: one function and one trigger per table, created only where missing
-- (guards scoped to CURRENT_SCHEMA(), as every tenant guard is). No data is
-- read or written. CREATE TRIGGER takes a brief SHARE ROW EXCLUSIVE lock on each
-- table, which waits for open writes and blocks new ones for that moment.
-- A build from before this file ignores the triggers: none of it TRUNCATEs these
-- tables, so rolling the code back needs nothing.
--
-- `scripts/db/destructive-sql.mjs` refused the word itself until this file, so
-- its rule was narrowed to the statement in the same change.

CREATE OR REPLACE FUNCTION reject_append_only_truncate() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is refused', TG_TABLE_NAME, TG_OP
    USING HINT = 'docs/database.md: append-only and written-once tables';
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'audit_log_entries',
    'payment_transactions',
    'payment_settlements',
    'treasury_entries',
    'treasury_day_closures',
    'treasury_counts',
    'expense_vouchers',
    'expense_requests',
    'income_vouchers',
    'treasury_transfers',
    'inspector_payouts'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger tg
        JOIN pg_class c ON c.oid = tg.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE tg.tgname = tbl || '_no_truncate' AND c.relname = tbl AND n.nspname = CURRENT_SCHEMA()
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_truncate()',
        tbl || '_no_truncate', tbl
      );
    END IF;
  END LOOP;
END
$$;

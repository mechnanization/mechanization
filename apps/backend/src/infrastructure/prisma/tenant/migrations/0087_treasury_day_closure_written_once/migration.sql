-- 0087_treasury_day_closure_written_once
--
-- A closed day's closure, and the counts it locked, are written once — the
-- rule 0083 gave every other treasury document, which 0082 did not give the
-- day closing (PR #106 review, 2026-10-10; docs/finance.md §7.3).
--
-- == Why ==================================================================
--
-- 0082 refuses deleting a closure, and refuses any write on or before a CLOSED
-- day. It did not stop an UPDATE of the closure itself. Probed on a fresh
-- schema (0001 → 0083): with 2026-10-05 CLOSED,
--
--   * `UPDATE treasury_day_closures SET "businessDate" = '2026-10-01'` went
--     through, and from then on the 5th took new entries and its count was
--     changed — the day was silently open again, with no reopening on record;
--   * `closedById` / `closedAt` could be rewritten, changing who signed the
--     day off;
--   * `UPDATE treasury_counts SET "closureId" = <the 5th's closure>` on a count
--     of the 6th went through: `reject_closed_day_count` lets a link to the
--     wrong day fall through to the closed-day check, which passes while the
--     count's own day is open.
--
-- No application path does either; this holds the rule against a stray UPDATE
-- in a future code path or a manual repair, as 0083 does for the vouchers.
--
-- == The rules ============================================================
--
--   * `treasury_day_closures_written_once` — a closure's `id`, `businessDate`
--     and `createdAt` never change. Its status moves only CLOSED → REOPENED
--     (the manager's reopening: the close it reopens stays as it was, and the
--     CHECK requires who, when and why) and REOPENED → CLOSED (closing again:
--     a new close, stamped anew, and the CHECK clears the reopening; the audit
--     log keeps every reopening). Any other change to a row is refused.
--   * `treasury_counts_link_own_day` — a count is linked only to its own day's
--     closure, and a link, once made, is never moved or removed.
--
-- Both refusals are `check_violation`s whose messages do not start «treasury
-- day … is closed», so `closedTreasuryDay` never mistakes them for the closed-
-- day lock. TRUNCATE is not covered, as on every append-only and written-once
-- table in this schema (docs/database.md); `TRUNCATE treasury_day_closures
-- CASCADE` also empties `treasury_counts`. A later migration that backfills a
-- new column on `treasury_day_closures` disables the trigger around its UPDATE
-- in the same file, as 0083 says for the vouchers. A user id never changes, so
-- the users foreign keys' ON UPDATE CASCADE never reaches the closure trigger.
--
-- == Safety ===============================================================
--
-- Additive: two functions and two triggers, no column, no row written. The
-- triggers refuse nothing the application does: closing writes new closures
-- and turns a REOPENED one CLOSED, reopening turns the latest CLOSED one
-- REOPENED, and the close links each of the day's unlinked counts to that
-- day's closure. CREATE TRIGGER takes a brief SHARE ROW EXCLUSIVE lock on the
-- two 0082 tables, which hold one row per day and per wallet per day.
-- Idempotent; written unqualified (the migrator sets `search_path`); every
-- catalog guard filters on CURRENT_SCHEMA() (see 0050); the function that
-- reads a table is pinned to its own schema (see 0030, 0082), the other to
-- pg_catalog (see 0083). Needs 0082.
--
-- Numbered 0087: 0082 is PR #106's day closing and 0083 PR #104's controls; no
-- local or remote-tracking branch held an 0087 or later on 2026-10-10 (`git log
-- --all`, without a fresh fetch). Check again before the PR.

-- ════════════════════════  a closure is written once  ═════════════════════════
--
-- Reads only its own row, so `search_path` is pg_catalog: the status literals
-- resolve against the column's enum, which is found by type, not by name.

CREATE OR REPLACE FUNCTION reject_day_closure_rewrite() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."businessDate" IS DISTINCT FROM OLD."businessDate"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'treasury_day_closures %: the day a closure covers never changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Reopening: the close being reopened stays on the row as it was.
  IF OLD."status" = 'CLOSED' AND NEW."status" = 'REOPENED' THEN
    IF NEW."closedAt" IS DISTINCT FROM OLD."closedAt"
       OR NEW."closedById" IS DISTINCT FROM OLD."closedById"
       OR NEW."autoClosed" IS DISTINCT FROM OLD."autoClosed" THEN
      RAISE EXCEPTION 'treasury_day_closures %: reopening a day does not rewrite who closed it', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Closing again: a new close, stamped by whoever makes it.
  IF OLD."status" = 'REOPENED' AND NEW."status" = 'CLOSED' THEN
    RETURN NEW;
  END IF;

  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'treasury_day_closures %: a % day changes only by being reopened or closed again',
      OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql SET search_path = pg_catalog;

-- ══════════════════════  a count is linked to its own day  ═══════════════════════

CREATE OR REPLACE FUNCTION reject_count_link_elsewhere() RETURNS TRIGGER AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."closureId" IS NOT NULL
     AND NEW."closureId" IS DISTINCT FROM OLD."closureId" THEN
    RAISE EXCEPTION 'treasury_counts %: a count''s closure is never moved or removed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."closureId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "treasury_day_closures" c
     WHERE c."id" = NEW."closureId" AND c."businessDate" = NEW."businessDate"
  ) THEN
    RAISE EXCEPTION 'treasury_counts %: a count is linked only to the closure of its own day, %',
      NEW."id", to_char(NEW."businessDate", 'YYYY-MM-DD')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

-- Reads `treasury_day_closures`, so it is pinned to the schema it belongs to:
-- a link is judged by this municipality's closures whatever the caller's
-- `search_path` (0082's reasoning).
DO $$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.reject_count_link_elsewhere() SET search_path = %I, pg_catalog',
    CURRENT_SCHEMA(), CURRENT_SCHEMA()
  );
END
$$;

-- ═════════════════════════════════  triggers  ══════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE tg.tgname = 'treasury_day_closures_written_once' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TRIGGER treasury_day_closures_written_once
      BEFORE UPDATE ON "treasury_day_closures"
      FOR EACH ROW EXECUTE FUNCTION reject_day_closure_rewrite();
  END IF;

  -- Sorts before `treasury_counts_respect_closed_days`, so a link to the wrong
  -- day is refused for what it is before the closed-day check runs.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE tg.tgname = 'treasury_counts_link_own_day' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TRIGGER treasury_counts_link_own_day
      BEFORE INSERT OR UPDATE ON "treasury_counts"
      FOR EACH ROW EXECUTE FUNCTION reject_count_link_elsewhere();
  END IF;
END
$$;

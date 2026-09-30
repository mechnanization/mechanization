-- 0061_citizen_merges
--
-- «دمج ملفين» — one person filed twice, folded into one file by an
-- administrator, and undone by one while nothing has moved since.
--
-- == Why a table, and not a column on `users` ===============================
--
-- A merge is not a state of one row; it is an act with a before and an after,
-- and the undo has to know exactly which rows it moved. So each merge is a row
-- here carrying its footprint — every registration, card, spell, bill and link
-- it re-pointed, and what each held before — and the absorbed citizen is
-- simply deactivated. `users` is not altered.
--
-- The footprint names row ids and the column values the merge replaced. It
-- carries no personal field values: a field the kept file was missing is
-- *filled* from the absorbed one, so what the undo restores there is a blank,
-- and the absorbed row keeps its own values untouched.
--
-- == Why `property_entries.filedRegistrationId` =============================
--
-- Billing and the edit form read a person's newest registration only, and the
-- census sync ends every spell the newest one does not claim. So a merge has to
-- put every current card on one registration. But an officer is paid through
-- `registrations.createdById`, and moving a card to a registration another
-- officer filed would move the dollar with it (user decision, 2026-09-28: it
-- stays with the officer who filed the card). This column remembers the
-- registration a card was filed on when it now sits on another. Null — every
-- card until a merge moves one — means the card's own `registrationId`.
--
-- == Deploy order ==========================================================
--
-- Additive: one table, one nullable column, five foreign keys, two indexes —
-- both on the new table, so nothing already live is locked while they build.
-- Apply BEFORE the code, which reads the column in the pay query.
--
-- Written unqualified: the migrator sets `search_path` to the tenant schema and
-- wraps the file in one transaction. Idempotent throughout.

-- ═══════════════════════════════  citizen_merges  ══════════════════════════════

CREATE TABLE IF NOT EXISTS "citizen_merges" (
  "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
  -- The file that stays.
  "survivorId"   UUID         NOT NULL,
  -- The file folded into it, deactivated by the merge.
  "absorbedId"   UUID         NOT NULL,
  -- Why the administrator decided these are one person. Required.
  "reason"       TEXT         NOT NULL,
  -- What the merge moved and what each row held before — see the header.
  "footprint"    JSONB        NOT NULL,
  "mergedById"   UUID,
  "mergedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "undoneAt"     TIMESTAMP(3),
  "undoneById"   UUID,
  "undoReason"   TEXT,

  CONSTRAINT "citizen_merges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "citizen_merges_reason_present" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "citizen_merges_distinct" CHECK ("survivorId" <> "absorbedId"),
  -- An undo says why, like the merge did.
  CONSTRAINT "citizen_merges_undo_reason" CHECK (
    "undoneAt" IS NULL OR ("undoReason" IS NOT NULL AND length(btrim("undoReason")) > 0)
  )
);

-- ════════════════════════════  property_entries  ═══════════════════════════════

ALTER TABLE "property_entries" ADD COLUMN IF NOT EXISTS "filedRegistrationId" UUID;

-- ═══════════════════════════════  foreign keys  ═══════════════════════════════
--
-- The two citizens cascade: a merge row describes those two people and nothing
-- else, and a citizen who is deleted outright has no file left to undo into.
-- The staff columns set null — a deleted account must not take the record of
-- what it did with it. `filedRegistrationId` sets null too: the card then
-- credits the registration it sits on, which is the rule before any merge.

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('citizen_merges', 'citizen_merges_survivorId_fkey', 'survivorId', 'users', 'CASCADE'),
      ('citizen_merges', 'citizen_merges_absorbedId_fkey', 'absorbedId', 'users', 'CASCADE'),
      ('citizen_merges', 'citizen_merges_mergedById_fkey', 'mergedById', 'users', 'SET NULL'),
      ('citizen_merges', 'citizen_merges_undoneById_fkey', 'undoneById', 'users', 'SET NULL'),
      ('property_entries', 'property_entries_filedRegistrationId_fkey', 'filedRegistrationId', 'registrations', 'SET NULL')
    ) AS t(tbl, name, col, ref, on_delete)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = fk.name AND n.nspname = CURRENT_SCHEMA()
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I("id") ON DELETE %s ON UPDATE CASCADE',
        fk.tbl, fk.name, fk.col, fk.ref, fk.on_delete
      );
    END IF;
  END LOOP;
END
$$;

-- ═════════════════════════════════  indexes  ═════════════════════════════════

-- A file is folded into one other file at a time. An undone merge frees it.
CREATE UNIQUE INDEX IF NOT EXISTS "citizen_merges_absorbedId_live_key"
  ON "citizen_merges" ("absorbedId") WHERE "undoneAt" IS NULL;

-- «ملفات دُمجت في هذا الملف» on the kept file's page.
CREATE INDEX IF NOT EXISTS "citizen_merges_survivorId_idx"
  ON "citizen_merges" ("survivorId");

-- No index on `property_entries."filedRegistrationId"`, deliberately. It would
-- be built on a live table inside the migrator's transaction, so without
-- CONCURRENTLY — a write lock on every citizen's cards for its duration
-- (AGENTS.md §3). The pay query that reads the column scans a few thousand
-- cards; if that ever matters, the index gets its own CONCURRENTLY migration.

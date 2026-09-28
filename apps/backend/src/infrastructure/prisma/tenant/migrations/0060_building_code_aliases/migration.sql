-- 0060_building_code_aliases
--
-- One row per building code retired by «تصحيح رقم العقار» — the code a building
-- carried while it was filed under the wrong parcel.
--
-- == Why ===================================================================
--
-- A building's code is `ZONE-PARCEL-SUFFIX`, and the suffix is allocated per
-- parcel (`buildings_parcelNumber_codeSuffix_key`). Correcting a building's
-- parcel therefore changes its code: Z-1-45-A on the wrong parcel becomes
-- Z-1-46-B on the right one. The old code does not stop existing in the world —
-- it is painted on paper forms, quoted on notices, written in officers'
-- notebooks — so two things have to stay true after a correction:
--
--   · the old code still finds the building (search reads this table);
--   · the old code is never handed to another building. Suffix allocation on a
--     parcel skips every suffix retired here, so a new building on parcel 45
--     can never become the Z-1-45-A a resident's old receipt names.
--
-- The UK's property reference numbers work the same way: retired, never reused.
--
-- == What is deliberately left alone ======================================
--
-- `buildings` is not altered. The code, suffix and parcel columns keep their
-- meaning; a correction writes new values into them in the same transaction
-- that writes the row here.
--
-- == Deploy order ==========================================================
--
-- Additive: one table, two foreign keys, three indexes. Apply BEFORE the code,
-- which inserts into it and reads it on every building creation.
--
-- Written unqualified: the migrator sets `search_path` to the tenant schema and
-- wraps the file in one transaction. Idempotent throughout.

-- ════════════════════════════  building_code_aliases  ═══════════════════════════

CREATE TABLE IF NOT EXISTS "building_code_aliases" (
  "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
  -- Nullable, and set null rather than cascaded: a building deleted later must
  -- not free its retired codes for reuse. The row outlives it as a tombstone.
  "buildingId"   UUID,
  -- The code exactly as it was displayed when it was retired. A snapshot, not
  -- derived: a later zone rename rewrites live codes, never retired ones.
  "code"         TEXT         NOT NULL,
  -- The pair allocation skips. Stored apart from `code` because `code` carries
  -- a zone prefix that can be renamed, and the pair is what uniqueness is on.
  "parcelNumber" TEXT         NOT NULL,
  "codeSuffix"   TEXT         NOT NULL,
  -- Why the parcel was corrected — required by the action, kept with the code.
  "reason"       TEXT         NOT NULL,
  "retiredById"  UUID,
  "retiredAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "building_code_aliases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "building_code_aliases_reason_present" CHECK (length(btrim("reason")) > 0)
);

-- ═══════════════════════════════  foreign keys  ═══════════════════════════════

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('building_code_aliases', 'building_code_aliases_buildingId_fkey', 'buildingId', 'buildings'),
      ('building_code_aliases', 'building_code_aliases_retiredById_fkey', 'retiredById', 'users')
    ) AS t(tbl, name, col, ref)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = fk.name AND n.nspname = CURRENT_SCHEMA()
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I("id") ON DELETE SET NULL ON UPDATE CASCADE',
        fk.tbl, fk.name, fk.col, fk.ref
      );
    END IF;
  END LOOP;
END
$$;

-- ═════════════════════════════════  indexes  ═════════════════════════════════

-- A retired pair is retired once. Also what allocation reads: "which suffixes
-- on parcel 45 may never be given out again".
CREATE UNIQUE INDEX IF NOT EXISTS "building_code_aliases_parcelNumber_codeSuffix_key"
  ON "building_code_aliases" ("parcelNumber", "codeSuffix");

-- "Every code this building has had" — for its page and its audit trail.
CREATE INDEX IF NOT EXISTS "building_code_aliases_buildingId_idx"
  ON "building_code_aliases" ("buildingId");

-- Search by an old code.
CREATE INDEX IF NOT EXISTS "building_code_aliases_code_idx"
  ON "building_code_aliases" ("code");

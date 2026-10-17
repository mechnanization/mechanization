-- 0095_unit_levels
--
-- «دوبلكس» and «تريبلكس» — one home on several levels — and what a roof of
-- one costs.
--
-- == What it is for ======================================================
--
-- The municipality charges per roof («لكل سقف»). A duplex, one home on two
-- levels, pays less than two flats stacked one above the other: 1,800,000 LBP
-- where two flats pay 2,000,000 (the user's decision, 2026-10-17, D28 in
-- docs/building-census-plan.md, replacing D27). Until now a census unit had
-- exactly one `floor`, and a duplex was recorded either as two flats or as one
-- flat with a «دوبلكس» note — neither of which a biller can read.
--
--   units."levels"                 how many levels this one unit spans, from
--                                  its `floor` (the entrance) upward. 1 for
--                                  every unit there is today.
--   system_settings."levelFactors" what a multi-level FLAT weighs under a
--                                  per-unit notice, per level count:
--                                  {"2": 1.8} — a duplex is 1.8 roofs. A level
--                                  count with no factor here is not billed by
--                                  guess: the citizen is reported unassessable.
--
-- A house (INDEPENDENT_HOUSE) on N storeys pays N full roofs (same decision),
-- so the table is read for APARTMENT only; the code says so, not this file.
--
-- == The rules, in the database ==========================================
--
--   units_levels_range          1 to 6 levels. A sanity bound, not a policy:
--                               raise it in a later migration if needed.
--   units_levels_dwelling_only  only a dwelling (شقة, منزل مستقل) spans levels.
--                               A shop with a mezzanine stays one level.
--
-- == Safety ==============================================================
--
-- Additive: two columns with constant defaults (metadata-only on Postgres 11+,
-- no table rewrite) and two CHECKs every existing row passes — every unit gets
-- `levels = 1`. No row is rewritten and no index is added: `levels` is read
-- with the unit, never searched by.
--
-- The build serving production when this lands never reads or writes these
-- columns, so it keeps working unchanged. A rollback is a redeploy.
--
-- Catalog guards filter on CURRENT_SCHEMA() (see 0050). Idempotent.
--
-- Written unqualified: the migrator sets `search_path` to the tenant schema.

ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "levels" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "system_settings"
  ADD COLUMN IF NOT EXISTS "levelFactors" JSONB NOT NULL DEFAULT '{"2": 1.8}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'units_levels_range' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "units"
      ADD CONSTRAINT "units_levels_range"
      CHECK ("levels" BETWEEN 1 AND 6);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'units_levels_dwelling_only' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "units"
      ADD CONSTRAINT "units_levels_dwelling_only"
      CHECK ("levels" = 1 OR "unitType" IN ('APARTMENT', 'INDEPENDENT_HOUSE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'system_settings_level_factors_object' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    -- The shape is validated in full by `levelFactorsSchema`; this only stops
    -- a scalar or an array from ever reaching the biller.
    ALTER TABLE "system_settings"
      ADD CONSTRAINT "system_settings_level_factors_object"
      CHECK (jsonb_typeof("levelFactors") = 'object');
  END IF;
END
$$;

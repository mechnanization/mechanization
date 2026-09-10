-- 0033_building_lifecycle
--
-- P5-T2: where a structure is in its own life.
--
-- == The gap this closes ===================================================
--
-- The census had two axes and needed three. `StructureType` says *what kind of
-- thing* stands on the parcel; `DamageLevel` says *what has happened to it*.
-- Neither can say that the thing is a poured foundation, a roofless shell, or a
-- permit nobody ever built against — and those are ordinary sights on a parcel
-- in this municipality, not edge cases.
--
-- Without this column an officer standing in front of a half-built block had
-- two options, and both corrupt the register:
--
--   * invent a `RESIDENTIAL_BUILDING` with a fictional unit matrix, whose flats
--     then sit at `NOT_SURVEYED` for ever, hold the coverage percentage down,
--     and reappear on every dispatch list as work nobody can do; or
--   * record nothing, leaving the parcel indistinguishable from one nobody has
--     visited.
--
-- == Why these six values ==================================================
--
-- The Dutch BAG's `pand` lifecycle, minus the states that exist only because
-- their register is driven by permit paperwork this municipality does not
-- receive (`pand in gebruik (niet ingemeten)`, `verbouwing pand`,
-- `sloopvergunning verleend`). What is left is what a surveyor can establish by
-- standing in front of the thing and looking at it. `NOT_REALISED` is BAG's
-- `niet gerealiseerd pand` verbatim: permitted, then abandoned or revoked.
--
-- == Why not a damage level ================================================
--
-- D5 already refused `UNDER_CONSTRUCTION` as a damage level, for the reason
-- that it is a lifecycle state. This is that decision honoured rather than
-- worked around: a building going up has no damage history to overwrite, and a
-- building taken down on purpose (`DEMOLISHED`) is a different fact from one
-- that fell down (`TOTAL_COLLAPSE`). Both remain recordable, separately, and a
-- structure can legitimately be `DEMOLISHED` with a `TOTAL_COLLAPSE` assessment
-- behind it explaining why.
--
-- == The default is the true answer, not a convenience =====================
--
-- Every building already in the table was entered through a UI that had no way
-- to express anything but a standing, used structure, so `IN_USE` is not a
-- guess about legacy rows — it is what each of them means. Adding the column
-- with any other default would retroactively reclassify the whole census.
--
-- Written unqualified: the migrator sets `search_path` to the target tenant
-- schema before running this. Idempotent throughout, since a schema that failed
-- part-way must be safe to re-run.

-- ═══════════════════════════  BuildingLifecycle  ═══════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'BuildingLifecycle' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "BuildingLifecycle" AS ENUM (
      'PERMITTED',
      'UNDER_CONSTRUCTION',
      'IN_USE',
      'DERELICT',
      'DEMOLISHED',
      'NOT_REALISED'
    );
  END IF;
END
$$;

-- ══════════════════════════  buildings.lifecycleStatus  ══════════════════════

ALTER TABLE "buildings"
  ADD COLUMN IF NOT EXISTS "lifecycleStatus" "BuildingLifecycle" NOT NULL DEFAULT 'IN_USE';

-- The ledger filters on it and the map dims by it, both across the whole
-- municipality at once. Cheap to maintain — the column changes about as often
-- as a building is demolished.
CREATE INDEX IF NOT EXISTS "buildings_lifecycleStatus_idx"
  ON "buildings" ("lifecycleStatus");

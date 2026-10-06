-- 0071_damage_habitable
--
-- «صالحة للسكن؟» — habitability as its own answer on a damage reading, beside
-- the UN-Habitat level, and never as a level of its own.
--
-- == What it is for ======================================================
--
-- 0067 added a sixth damage level, 'UNINHABITABLE' «غير قابلة للسكن», for a
-- unit standing and safe to enter but not fit to live in. The need was real;
-- the shape broke decision D4 (docs/building-census-plan.md): the scale is
-- UN-Habitat's, verbatim, so the municipality's figures add up with the
-- national reconstruction datasets. On 2026-10-05 the user decided to keep the
-- five-level structural scale intact and record habitability as a separate
-- yes/no — the model post-disaster practice uses (ATC-20 placards, FEMA
-- P-2055's habitability evaluation on top of the structural one).
--
--   habitable   true «صالحة للسكن», false «غير صالحة للسكن», NULL on a reading
--               recorded before the question existed. The level prefills it
--               (`habitabilityFor` in packages/shared-schemas): a collapse or an
--               evacuation is never habitable, no or minor damage starts at
--               habitable, restricted use must be answered.
--
-- A unit whose current reading says nobody can live in it has its occupancy
-- fee held until a re-inspection says otherwise (decision, 2026-10-05), and
-- 0068's "reinspectAt" now belongs to such a reading.
--
-- == The retired level ===================================================
--
-- 'UNINHABITABLE' stays in the enum: removing a stored enum value is a type
-- rewrite (destructive DDL, a contract step for a later release, if ever).
-- What this migration does instead:
--
--  1. Converts every reading recorded at that level to what it meant on the
--     two axes — 'RESTRICTED_USE' (the level 0067's own comment mapped it to)
--     with "habitable" = false. Its "reinspectAt" is kept: it was set for
--     exactly this kind of reading. Production never ran the code that wrote
--     the level (it reaches main with this migration, ahead of the code that
--     stops offering it), so there the UPDATE matches no row; on staging it
--     converts the test readings 0067's branch left behind. Readings are
--     append-only by rule (D3), not by trigger: this is a one-time conversion
--     of a value that never shipped, not an edit of history.
--  2. Refuses the level from now on (CHECK below), so nothing can write it
--     again — the API's vocabulary no longer has it either.
--
-- == The rules, in the database ==========================================
--
--   damage_assessments_level_not_retired        the retired level, refused.
--   damage_assessments_habitable_matches_level  a collapse or an evacuation
--                                               cannot be marked habitable.
--   damage_assessments_reinspect_needs_uninhabitable
--                                               a re-inspection day belongs
--                                               to a reading that says the
--                                               target cannot be lived in.
--
-- The same rules are in `createDamageAssessmentSchema`; these make them true
-- of the table rather than of one writer (docs/database.md: CHECKs live in the
-- database).
--
-- == Safety ==============================================================
--
-- Additive: one nullable column with no default (no table rewrite). The
-- UPDATE touches no citizen row and, on production, no row at all. Every
-- existing row passes all three CHECKs once step 1 has run: before 0071 no
-- row has "habitable" set, and "reinspectAt" could only be written on the
-- retired level, which step 1 has just turned into "habitable" = false.
-- damage_assessments is small (one row per observation) and the CHECKs'
-- validating scan lasts as long as reading it. The build serving production
-- keeps working against this schema: it predates 0067, so it never writes the
-- retired level, "habitable" or "reinspectAt", and NULL passes every CHECK.
-- A rollback is a redeploy.
--
-- 0067 added the enum value in its own transaction, so using it here is safe.
-- The CHECK guards filter on CURRENT_SCHEMA() (see 0050). Idempotent.
--
-- Written unqualified: the migrator sets `search_path` to the tenant schema.

ALTER TABLE "damage_assessments" ADD COLUMN IF NOT EXISTS "habitable" BOOLEAN;

UPDATE "damage_assessments"
   SET "level" = 'RESTRICTED_USE',
       "habitable" = false
 WHERE "level" = 'UNINHABITABLE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE c.conname = 'damage_assessments_level_not_retired'
       AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "damage_assessments"
      ADD CONSTRAINT "damage_assessments_level_not_retired"
      CHECK ("level" <> 'UNINHABITABLE');
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE c.conname = 'damage_assessments_habitable_matches_level'
       AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "damage_assessments"
      ADD CONSTRAINT "damage_assessments_habitable_matches_level"
      CHECK (NOT ("habitable" IS TRUE AND "level" IN ('UNSAFE_EVACUATE', 'TOTAL_COLLAPSE')));
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE c.conname = 'damage_assessments_reinspect_needs_uninhabitable'
       AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "damage_assessments"
      ADD CONSTRAINT "damage_assessments_reinspect_needs_uninhabitable"
      CHECK ("reinspectAt" IS NULL OR "habitable" IS FALSE);
  END IF;
END
$$;

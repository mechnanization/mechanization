-- Add the constraints that every municipality after the first never received.
--
-- == What was wrong =========================================================
--
-- `pg_constraint` is database-wide; a constraint *name* is per-schema. Seven
-- migrations guard their `ADD CONSTRAINT` like this:
--
--     IF NOT EXISTS (SELECT 1 FROM pg_constraint
--                    WHERE conname = 'units_buildingId_fkey') THEN
--
-- With one municipality that reads as intended. With two it does not: the row
-- the guard finds belongs to the *first* schema, so the second municipality's
-- `ALTER TABLE` is skipped — silently, with no error, and `IF NOT EXISTS`
-- reading like ordinary idempotence. 0032, 0043 and 0049 got it right by
-- joining `pg_namespace` and filtering on `CURRENT_SCHEMA()`; the rest did not.
--
-- Measured, not reasoned about: migrating two schemas into one empty database
-- and comparing their catalogs gives the first 86 constraints and the second
-- 64. The 22 below are the difference. Tables, columns, indexes, triggers,
-- enums and functions come out identical — only constraints are affected,
-- because only they are guarded this way.
--
-- What those 22 hold up is not decorative:
--
--   * `unit_occupancies_citizenId_fkey`, `unit_occupancies_unitId_fkey` —
--     deleting a citizen or a unit leaves occupancy rows pointing at nothing,
--     and occupancy is what billing reads.
--   * `inspector_payouts_inspectorId_fkey` — a payout outliving the inspector
--     it belongs to.
--   * `damage_assessments_target_check` — an assessment attached to a building
--     *and* a unit, counted twice in the war-damage rollup.
--   * `users_household_members_check` — actual household members above the
--     registered total.
--
-- None of them fails loudly. They let a row exist that the application assumes
-- cannot, which surfaces later as a number that is wrong rather than an error.
--
-- == Why staging looks fine =================================================
--
-- `tenant_albazourieh` is the only tenant schema there, and the first schema is
-- the one that gets everything. The defect arrives with municipality two — that
-- is, on the day this system does the thing it was built to do.
--
-- == The fix ================================================================
--
-- Fix forward, as §3 requires: the seven migrations have run and are immutable,
-- so this file adds what they skipped. Every guard here is scoped with
-- `CURRENT_SCHEMA()`, so it is a no-op on the first municipality and a repair
-- on every later one. Purely additive — no DROP, no TRUNCATE, no type change.
--
-- **Before deploying, check for orphans.** These constraints are added
-- validated, so a schema that has already accumulated a row they forbid will
-- stop this migration rather than accept it. That is the intended behaviour —
-- an orphan is a human question, not something a migration should delete — but
-- it is better found in advance than at deploy time. Per tenant schema:
--
--     SET search_path TO "tenant_<slug>";
--     SELECT 'unit_occupancies.citizenId' AS what, count(*) FROM unit_occupancies o
--       LEFT JOIN users u ON u.id = o."citizenId" WHERE u.id IS NULL
--     UNION ALL SELECT 'unit_occupancies.unitId', count(*) FROM unit_occupancies o
--       LEFT JOIN units t ON t.id = o."unitId" WHERE t.id IS NULL
--     UNION ALL SELECT 'inspector_payouts.inspectorId', count(*) FROM inspector_payouts p
--       LEFT JOIN users u ON u.id = p."inspectorId" WHERE u.id IS NULL;
--
-- (`LEFT JOIN … IS NULL`, not `NOT IN` — a NULL in the subquery makes `NOT IN`
--  return no rows at all, which reads as a clean bill of health.)

-- ═════════════════════  the twenty foreign keys  ═════════════════════
--
-- Table, constraint, column, referenced table, referenced column, ON DELETE —
-- copied from the migration that first declared each one, unchanged. The loop
-- is here so the schema filter is written once and cannot be forgotten on the
-- nineteenth repetition.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      -- 0014_collector_identity
      ('citizen_payments', 'citizen_payments_collectedById_fkey', 'collectedById', 'users', 'id', 'SET NULL'),
      -- 0025_inspector_commission_and_payouts
      ('registrations', 'registrations_createdById_fkey', 'createdById', 'users', 'id', 'SET NULL'),
      ('inspector_payouts', 'inspector_payouts_inspectorId_fkey', 'inspectorId', 'users', 'id', 'CASCADE'),
      ('inspector_payouts', 'inspector_payouts_recordedById_fkey', 'recordedById', 'users', 'id', 'SET NULL'),
      -- 0027_cases
      ('cases', 'cases_createdById_fkey', 'createdById', 'users', 'id', 'SET NULL'),
      -- 0029_case_resolution_link
      ('cases', 'cases_resolvedCitizenId_fkey', 'resolvedCitizenId', 'users', 'id', 'SET NULL'),
      -- 0030_building_census
      ('buildings', 'buildings_createdById_fkey', 'createdById', 'users', 'id', 'SET NULL'),
      ('units', 'units_buildingId_fkey', 'buildingId', 'buildings', 'id', 'CASCADE'),
      ('unit_occupancies', 'unit_occupancies_unitId_fkey', 'unitId', 'units', 'id', 'CASCADE'),
      ('unit_occupancies', 'unit_occupancies_citizenId_fkey', 'citizenId', 'users', 'id', 'CASCADE'),
      ('unit_occupancies', 'unit_occupancies_registrationId_fkey', 'registrationId', 'registrations', 'id', 'SET NULL'),
      ('damage_assessments', 'damage_assessments_buildingId_fkey', 'buildingId', 'buildings', 'id', 'CASCADE'),
      ('damage_assessments', 'damage_assessments_unitId_fkey', 'unitId', 'units', 'id', 'CASCADE'),
      ('damage_assessments', 'damage_assessments_assessedById_fkey', 'assessedById', 'users', 'id', 'SET NULL'),
      ('property_entries', 'property_entries_buildingId_fkey', 'buildingId', 'buildings', 'id', 'SET NULL'),
      ('building_units', 'building_units_unitId_fkey', 'unitId', 'units', 'id', 'SET NULL'),
      ('cases', 'cases_buildingId_fkey', 'buildingId', 'buildings', 'id', 'SET NULL'),
      ('cases', 'cases_unitId_fkey', 'unitId', 'units', 'id', 'SET NULL'),
      ('cases', 'cases_damageAssessmentId_fkey', 'damageAssessmentId', 'damage_assessments', 'id', 'SET NULL'),
      -- 0037_landlord_link
      ('property_entries', 'property_entries_landlordCitizenId_fkey', 'landlordCitizenId', 'users', 'id', 'SET NULL')
    ) AS t(table_name, name, column_name, ref_table, ref_column, on_delete)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE c.conname = fk.name AND n.nspname = CURRENT_SCHEMA()
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(%I) ON DELETE %s ON UPDATE CASCADE',
        fk.table_name, fk.name, fk.column_name, fk.ref_table, fk.ref_column, fk.on_delete
      );
    END IF;
  END LOOP;
END $$;

-- ═════════════════════════  the two checks  ═════════════════════════
--
-- Spelled out rather than looped: a CHECK is an expression, and an expression
-- passed through a VALUES list is one quoting mistake away from meaning
-- something else.
DO $$
BEGIN
  -- 0026_household_member_split
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE c.conname = 'users_household_members_check' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_household_members_check"
      CHECK (
        "actualHouseholdMembers" IS NULL
        OR "totalRegisteredMembers" IS NULL
        OR "actualHouseholdMembers" <= "totalRegisteredMembers"
      );
  END IF;

  -- 0030_building_census — exactly one target, building or unit, never both.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE c.conname = 'damage_assessments_target_check' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "damage_assessments"
      ADD CONSTRAINT "damage_assessments_target_check"
      CHECK (("buildingId" IS NULL) <> ("unitId" IS NULL));
  END IF;
END $$;

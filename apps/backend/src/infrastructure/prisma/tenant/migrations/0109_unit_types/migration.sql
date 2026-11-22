-- 0109_unit_types
--
-- «أنواع الوحدات» — the unit types a municipality picks from, the ones it adds
-- itself (مدرسة, شركة كهرباء, شركة مياه, …) beside one per premises `UnitType`.
--
-- == What it is for ======================================================
--
-- The user's request of 2026-11-21: the manager of a municipality adds unit
-- types as he adds building types (0106). Fees, area brackets, the dwelling
-- rules and the census all read `UnitType`, a Postgres enum, and a name typed
-- into a form would carry none of that. So the list does not replace the enum
-- (the same decision as 0106): every type takes the behaviour of one base
-- `UnitType` value, and a unit keeps `units.unitType`, set by the server from
-- the chosen type and read everywhere exactly as before.
--
--   unit_types            "nameAr" (unique), "nameEn", the "baseType" whose
--                         behaviour it takes, "isSystem", "isActive",
--                         "sortOrder", who created it and when.
--   units."unitTypeId"    the type a unit was filed as.
--
-- One **system** row per premises value of `UnitType`, inserted here into every
-- tenant schema, named as `labels.ts` has always named it. A system row's
-- `baseType` never changes (`unit_types_system_rewrite`); renaming any row
-- changes its label only. A type is deactivated, never deleted (the building
-- types and the expense categories are the model): the code refuses an
-- inactive type on a new unit and keeps it on the units that have it.
--
-- A custom type bills as its base type. A fee of its own for a custom type is
-- a later phase, set on the fee notice, and needs nothing from this file.
--
-- == What is not here ====================================================
--
-- `PILOTIS` and `EMPTY_FLOOR` describe a floor, not premises: no system row
-- and no custom type may take them as a base (`unit_types_base_not_structural`),
-- and a unit of either kind keeps `unitTypeId` NULL.
--
-- `building_units` and `property_entries` (a citizen's card) keep their own
-- `unitType` and gain no key: billing reads the base value on all three.
--
-- == The rules, in the database ==========================================
--
--   unit_types_nameAr_key             a name is used once.
--   unit_types_system_base_key        one system row per base type.
--   unit_types_names_trimmed          names are trimmed and not empty.
--   unit_types_base_not_structural    never PILOTIS or EMPTY_FLOOR.
--   unit_types_system_has_no_author   a system row was made by this file.
--   unit_types_system_rewrite         (trigger) a system row keeps its
--                                     baseType and stays a system row; a
--                                     custom row never becomes one.
--   units_unitTypeId_fkey             RESTRICT: a type a unit uses is never
--                                     deleted under it.
--
-- == Backfill ============================================================
--
-- Every premises unit gets the system row of its own `unitType`. Only rows
-- with no type yet are touched, so a replayed file changes nothing. The
-- `units_sync_building_counts` trigger fires on UPDATE OF "buildingId",
-- "surveyStatus", "unitType" and not on the new column, so the backfill
-- recounts nothing.
--
-- == Safety ==============================================================
--
-- Expand, backfill, contract (docs/database.md): `unitTypeId` stays nullable
-- in this release. A unit created by the build before this one, after it
-- runs, has no type until the code that writes it ships; that code fills a
-- missing type from `unitType` when it next saves the unit, and a later
-- release may read the column as set once nothing is missing.
--
-- Locks, held to this file's commit (docs/database.md, "How tenant migrations
-- run"): ACCESS EXCLUSIVE on `units` for the ADD COLUMN, the foreign key and
-- the index; the backfill's UPDATE rewrites every premises unit row once.
-- `units` holds some thousands of rows per municipality, so the file runs in
-- about a second. `unit_types` is new and holds seven rows. No row of a
-- citizen is read or written.
--
-- The build serving production when this lands never reads the table or the
-- column and keeps working; the backfill sets a column it does not select. A
-- rollback is a redeploy. Deleting a unit or a building still works: the key
-- points from `units` to the type, not the other way.
--
-- The trigger's function reads only its row and is pinned to `pg_catalog`.
-- Catalog guards filter on CURRENT_SCHEMA() (see 0050). Idempotent. Written
-- unqualified: the migrator sets `search_path` to the tenant schema.

-- ═══════════════════════════════  table  ══════════════════════════════════

CREATE TABLE IF NOT EXISTS "unit_types" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "nameAr"      TEXT         NOT NULL,
  "nameEn"      TEXT,
  "baseType"    "UnitType"   NOT NULL,
  "isSystem"    BOOLEAN      NOT NULL DEFAULT false,
  "isActive"    BOOLEAN      NOT NULL DEFAULT true,
  "sortOrder"   INTEGER      NOT NULL DEFAULT 100,
  "createdById" UUID,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "unit_types_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "unitTypeId" UUID;

-- ═════════════════════════  keys and checks  ══════════════════════════════

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('unit_types', 'unit_types_createdById_fkey',
         'FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE'),
      ('units', 'units_unitTypeId_fkey',
         'FOREIGN KEY ("unitTypeId") REFERENCES "unit_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('unit_types', 'unit_types_names_trimmed',
         $c$CHECK ("nameAr" = btrim("nameAr") AND "nameAr" <> ''
                AND ("nameEn" IS NULL OR ("nameEn" = btrim("nameEn") AND "nameEn" <> '')))$c$),
      ('unit_types', 'unit_types_base_not_structural',
         $c$CHECK ("baseType" NOT IN ('PILOTIS', 'EMPTY_FLOOR'))$c$),
      ('unit_types', 'unit_types_system_has_no_author',
         $c$CHECK (NOT "isSystem" OR "createdById" IS NULL)$c$)
    ) AS t(tbl, name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
      WHERE k.conname = c.name AND n.nspname = CURRENT_SCHEMA()
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', c.tbl, c.name, c.definition);
    END IF;
  END LOOP;
END
$$;

-- ══════════════════════════════  indexes  ═════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS "unit_types_nameAr_key" ON "unit_types" ("nameAr");
-- One system row per base type. Not expressible in Prisma 5; the model says so.
CREATE UNIQUE INDEX IF NOT EXISTS "unit_types_system_base_key"
  ON "unit_types" ("baseType") WHERE "isSystem";
CREATE INDEX IF NOT EXISTS "unit_types_createdById_idx" ON "unit_types" ("createdById");
-- The key's RESTRICT check, and the reports grouped by type.
CREATE INDEX IF NOT EXISTS "units_unitTypeId_idx" ON "units" ("unitTypeId");

-- ══════════════════════════════  trigger  ═════════════════════════════════

CREATE OR REPLACE FUNCTION reject_system_unit_type_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."isSystem" AND (NEW."baseType" IS DISTINCT FROM OLD."baseType" OR NOT NEW."isSystem") THEN
    RAISE EXCEPTION 'unit type %: a system type keeps its base type', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT OLD."isSystem" AND NEW."isSystem" THEN
    RAISE EXCEPTION 'unit type %: a custom type never becomes a system type', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
ALTER FUNCTION reject_system_unit_type_rewrite() SET search_path = pg_catalog;

DROP TRIGGER IF EXISTS "unit_types_system_rewrite" ON "unit_types";
CREATE TRIGGER "unit_types_system_rewrite"
  BEFORE UPDATE ON "unit_types"
  FOR EACH ROW EXECUTE FUNCTION reject_system_unit_type_rewrite();

-- ═══════════════════════════  system rows  ════════════════════════════════

-- Named as `labels.ts` names each value (`unitType`, ar and en), in the order
-- the matrix has always offered them.
INSERT INTO "unit_types" ("nameAr", "nameEn", "baseType", "isSystem", "sortOrder")
SELECT v."nameAr", v."nameEn", v."baseType"::"UnitType", true, v."sortOrder"
FROM (VALUES
  ('شقة',        'Apartment',         'APARTMENT',         10),
  ('منزل مستقل', 'Independent House', 'INDEPENDENT_HOUSE', 20),
  ('عيادة',      'Clinic',            'CLINIC',            30),
  ('مكتب',       'Office',            'OFFICE',            40),
  ('محل تجاري',  'Commercial Shop',   'SHOP',              50),
  ('مستودع',     'Warehouse',         'WAREHOUSE',         60),
  ('كراج',       'Garage',            'GARAGE',            70)
) AS v("nameAr", "nameEn", "baseType", "sortOrder")
WHERE NOT EXISTS (
  SELECT 1 FROM "unit_types" t
  WHERE t."isSystem" AND t."baseType" = v."baseType"::"UnitType"
);

-- ══════════════════════════════  backfill  ════════════════════════════════

UPDATE "units" u
SET "unitTypeId" = t."id"
FROM "unit_types" t
WHERE t."isSystem"
  AND t."baseType" = u."unitType"
  AND u."unitTypeId" IS NULL;

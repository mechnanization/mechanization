-- 0106_building_types
--
-- «أنواع المباني» — the building types a municipality picks from, the ones it
-- adds itself (مدرسة, مستوصف, مبنى بلدي, …) beside one per `StructureType`.
--
-- == What it is for ======================================================
--
-- The user's request of 2026-11-16, decision 5: each municipality keeps its
-- own list, so it is a tenant table.
--
-- `StructureType` drives behaviour — `STRUCTURE_TYPE_MAP`, the default unit,
-- the estate and house rules, what the census counts — and a type typed into
-- a form would carry none of it. So the list does not replace the enum: every
-- type takes the behaviour of one `StructureType` value, and a building keeps
-- `buildings.structureType`, set by the server from the chosen type and read
-- everywhere exactly as before.
--
--   building_types               "nameAr" (unique), "nameEn", the
--                                "structureType" whose behaviour it takes, the
--                                "defaultUnitType" its units start as,
--                                "isSystem", "isActive", "sortOrder", who
--                                created it and when.
--   buildings."buildingTypeId"   the type a building was filed as.
--
-- One **system** row per `StructureType` value, inserted here into every
-- tenant schema, named as the census has always labelled it. A system row's
-- `structureType` never changes (`building_types_system_rewrite`); renaming any
-- row changes its label only. A type is deactivated, never deleted (the
-- expense categories are the model): the code refuses an inactive type on a
-- new building and keeps it on the buildings that have it.
--
-- A building's type changes no fee: units keep their `UnitType`, and fees
-- read that.
--
-- == The rules, in the database ==========================================
--
--   building_types_nameAr_key             a name is used once.
--   building_types_system_structure_key   one system row per StructureType.
--   building_types_names_trimmed          names are trimmed and not empty.
--   building_types_unit_not_structural    a type's units are premises: never
--                                         PILOTIS or EMPTY_FLOOR.
--   building_types_system_has_no_author   a system row was made by this file.
--   building_types_system_rewrite         (trigger) a system row keeps its
--                                         structureType and stays a system
--                                         row; a custom row never becomes one.
--   buildings_buildingTypeId_fkey         RESTRICT: a type a building uses is
--                                         never deleted under it.
--
-- == Backfill ============================================================
--
-- Every building gets the system row of its own `structureType`. Only rows
-- with no type yet are touched, so a replayed file changes nothing.
--
-- == Safety ==============================================================
--
-- Expand, backfill, contract (docs/database.md): `buildingTypeId` stays
-- nullable in this release. A building created by the build before this one,
-- after it runs, has no type until the code that writes it ships; that code
-- fills a missing type from `structureType` when it next saves the building,
-- and a later release may make the column NOT NULL once nothing is missing.
--
-- Needs 0105: the system row of `PUBLIC_INSTITUTION` names the value it added,
-- which only a later transaction may do. No building holds that value until
-- the feature ships.
--
-- Locks, held to this file's commit (docs/database.md, "How tenant migrations
-- run"): ACCESS EXCLUSIVE on `buildings` for the ADD COLUMN, the foreign key
-- and the index; the backfill's UPDATE rewrites every building row once.
-- `buildings` holds a few thousand rows per municipality, so the file runs in
-- about a second. `building_types` is new and holds seven rows.
--
-- The build serving production when this lands never reads the table or the
-- column and keeps working; the backfill sets a column it does not select. A
-- rollback is a redeploy. Deleting a building still works: the key points
-- from `buildings` to the type, not the other way.
--
-- The trigger's function reads only its row and is pinned to `pg_catalog`.
-- Catalog guards filter on CURRENT_SCHEMA() (see 0050). Idempotent. Written
-- unqualified: the migrator sets `search_path` to the tenant schema.

-- ═══════════════════════════════  table  ══════════════════════════════════

CREATE TABLE IF NOT EXISTS "building_types" (
  "id"              UUID            NOT NULL DEFAULT gen_random_uuid(),
  "nameAr"          TEXT            NOT NULL,
  "nameEn"          TEXT,
  "structureType"   "StructureType" NOT NULL,
  "defaultUnitType" "UnitType"      NOT NULL,
  "isSystem"        BOOLEAN         NOT NULL DEFAULT false,
  "isActive"        BOOLEAN         NOT NULL DEFAULT true,
  "sortOrder"       INTEGER         NOT NULL DEFAULT 100,
  "createdById"     UUID,
  "createdAt"       TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "building_types_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "buildings" ADD COLUMN IF NOT EXISTS "buildingTypeId" UUID;

-- ═════════════════════════  keys and checks  ══════════════════════════════

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('building_types', 'building_types_createdById_fkey',
         'FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE'),
      ('buildings', 'buildings_buildingTypeId_fkey',
         'FOREIGN KEY ("buildingTypeId") REFERENCES "building_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('building_types', 'building_types_names_trimmed',
         $c$CHECK ("nameAr" = btrim("nameAr") AND "nameAr" <> ''
                AND ("nameEn" IS NULL OR ("nameEn" = btrim("nameEn") AND "nameEn" <> '')))$c$),
      ('building_types', 'building_types_unit_not_structural',
         $c$CHECK ("defaultUnitType" NOT IN ('PILOTIS', 'EMPTY_FLOOR'))$c$),
      ('building_types', 'building_types_system_has_no_author',
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

CREATE UNIQUE INDEX IF NOT EXISTS "building_types_nameAr_key" ON "building_types" ("nameAr");
-- One system row per StructureType. Not expressible in Prisma 5; the model says so.
CREATE UNIQUE INDEX IF NOT EXISTS "building_types_system_structure_key"
  ON "building_types" ("structureType") WHERE "isSystem";
CREATE INDEX IF NOT EXISTS "building_types_createdById_idx" ON "building_types" ("createdById");
-- The key's RESTRICT check, and the reports grouped by type.
CREATE INDEX IF NOT EXISTS "buildings_buildingTypeId_idx" ON "buildings" ("buildingTypeId");

-- ══════════════════════════════  trigger  ═════════════════════════════════

CREATE OR REPLACE FUNCTION reject_system_building_type_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."isSystem" AND (NEW."structureType" IS DISTINCT FROM OLD."structureType" OR NOT NEW."isSystem") THEN
    RAISE EXCEPTION 'building type %: a system type keeps its structure type', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT OLD."isSystem" AND NEW."isSystem" THEN
    RAISE EXCEPTION 'building type %: a custom type never becomes a system type', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
ALTER FUNCTION reject_system_building_type_rewrite() SET search_path = pg_catalog;

DROP TRIGGER IF EXISTS "building_types_system_rewrite" ON "building_types";
CREATE TRIGGER "building_types_system_rewrite"
  BEFORE UPDATE ON "building_types"
  FOR EACH ROW EXECUTE FUNCTION reject_system_building_type_rewrite();

-- ═══════════════════════════  system rows  ════════════════════════════════

-- Named as `labels.ts` names each value; the unit each starts as is
-- `STRUCTURE_TYPE_MAP`'s `defaultUnitType`.
INSERT INTO "building_types" ("nameAr", "nameEn", "structureType", "defaultUnitType", "isSystem", "sortOrder")
SELECT v."nameAr", v."nameEn", v."structureType"::"StructureType", v."defaultUnitType"::"UnitType", true, v."sortOrder"
FROM (VALUES
  ('مبنى سكني',            'Residential Building',       'RESIDENTIAL_BUILDING', 'APARTMENT',         10),
  ('منزل مستقل',           'Independent House',          'INDEPENDENT_HOUSE',    'INDEPENDENT_HOUSE', 20),
  ('مجمع تجاري',           'Commercial Centre',          'COMMERCIAL_CENTER',    'SHOP',              30),
  ('مستودع / هنغار',       'Warehouse / Hangar',         'WAREHOUSE_HANGAR',     'WAREHOUSE',         40),
  ('سكني - تجاري',         'Mixed Use',                  'MIXED_USE',            'APARTMENT',         50),
  ('تجمّع خيم / مأوى',     'Tent Settlement / Shelter',  'TENT_SHELTER',         'INDEPENDENT_HOUSE', 60),
  ('منشأة عامة / خدماتية', 'Public or Service Facility', 'PUBLIC_INSTITUTION',   'OFFICE',            70)
) AS v("nameAr", "nameEn", "structureType", "defaultUnitType", "sortOrder")
WHERE NOT EXISTS (
  SELECT 1 FROM "building_types" t
  WHERE t."isSystem" AND t."structureType" = v."structureType"::"StructureType"
);

-- ══════════════════════════════  backfill  ════════════════════════════════

UPDATE "buildings" b
SET "buildingTypeId" = t."id"
FROM "building_types" t
WHERE t."isSystem"
  AND t."structureType" = b."structureType"
  AND b."buildingTypeId" IS NULL;

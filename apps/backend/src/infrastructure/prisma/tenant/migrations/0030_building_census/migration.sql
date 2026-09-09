-- 0030_building_census
--
-- A building had no existence in this schema.
--
-- The chain was `building_units → property_entries → registrations → users`,
-- cascading the whole way down, which means a building was a free-text
-- `buildingName` on one citizen's property card. An apartment nobody had
-- surveyed was therefore not a row at all — and you cannot colour, count or
-- filter an absence, so "which flats in this town have we still not reached"
-- was a question with no query behind it.
--
-- These four tables are the missing half: the *structure's* record, created
-- before anyone is surveyed and independent of every registration.
-- `property_entries` stays the *citizen's* record of what they filed. Both
-- remain, linked by nullable FKs and not merged — and until Phase 2 flips the
-- authority rule, `property_entries`/`building_units` are still what billing
-- reads. See docs/building-census-plan.md.
--
-- Written unqualified: the migrator sets `search_path` to the target tenant
-- schema before running this, so one file builds every municipality. Idempotent
-- throughout, since a schema that failed part-way must be safe to re-run.

-- ══════════════════════════════  Enums  ══════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'StructureType' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "StructureType" AS ENUM (
      'RESIDENTIAL_BUILDING', 'INDEPENDENT_HOUSE', 'COMMERCIAL_CENTER',
      'WAREHOUSE_HANGAR', 'MIXED_USE', 'TENT_SHELTER'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'SurveyStatus' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "SurveyStatus" AS ENUM (
      'NOT_SURVEYED', 'VISITED_NO_ANSWER', 'PARTIAL', 'COMPLETE',
      'REFUSED', 'INACCESSIBLE', 'VACANT_CONFIRMED', 'DEMOLISHED'
    );
  END IF;

  -- UN-Habitat's rapid building-level scale, verbatim. Do not reorder or
  -- rename: these values are what makes a municipality's figures aggregate
  -- with the national reconstruction datasets.
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'DamageLevel' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "DamageLevel" AS ENUM (
      'NOT_AFFECTED', 'SAFE_MINOR_DAMAGE', 'RESTRICTED_USE',
      'UNSAFE_EVACUATE', 'TOTAL_COLLAPSE', 'UNCLASSIFIED'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'DamageSource' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "DamageSource" AS ENUM (
      'FIELD_VISIT', 'SATELLITE', 'SELF_REPORTED', 'OFFICIAL_REPORT'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'CaseType' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "CaseType" AS ENUM (
      'UNIT_UNREACHABLE', 'ACCESS_REFUSED', 'VACANT_UNCONFIRMED',
      'OWNERSHIP_DISPUTE', 'GENERAL_NOTE'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'OccupancyRole' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "OccupancyRole" AS ENUM ('OWNER', 'TENANT', 'FREE_OCCUPANT');
  END IF;
END
$$;

-- A revisit date has been agreed. Neither open work waiting to be picked up nor
-- settled — without it every dispatch list re-proposed a visit that was already
-- arranged.
--
-- A plain top-level statement, following 0022: `ADD VALUE IF NOT EXISTS` is
-- idempotent on its own and is the form Postgres permits inside the transaction
-- a migration runs in. The other half of that rule is that nothing in this file
-- may *use* the new label, and nothing does.
--
-- The value lands *after* RESOLVED in the type's own sort order, which is not
-- the order the work moves in. Deliberately not corrected with `BEFORE
-- 'RESOLVED'`: nothing sorts cases by status (`case.repository.ts` orders by
-- `createdAt`), the UI takes its order from `CASE_STATUS` in shared-schemas,
-- and forcing a position here after the migration has already been applied
-- somewhere would leave two municipalities with two different enum orders —
-- a real divergence traded for a cosmetic one.
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'SCHEDULED';

-- ═════════════════════════════  buildings  ═════════════════════════════

CREATE TABLE IF NOT EXISTS "buildings" (
    "id"            UUID            NOT NULL DEFAULT gen_random_uuid(),
    -- رقم العقار, as a string and not an FK — `cadastre:import` rebuilds the
    -- parcel table wholesale, and a routine survey correction must not cascade
    -- a municipality's buildings away. Same reasoning as `zones.parcelNumbers`.
    "parcelNumber"  TEXT            NOT NULL,
    -- The durable half of the code. Never changes once assigned.
    "codeSuffix"    TEXT            NOT NULL,
    -- Denormalised `ZONE-PARCEL-SUFFIX`. Derived, recomputed when a zone
    -- changes; the id above is the identity.
    "code"          TEXT            NOT NULL,
    "name"          TEXT,
    "postedNumber"  TEXT,
    "structureType" "StructureType" NOT NULL,
    "latitude"      DOUBLE PRECISION,
    "longitude"     DOUBLE PRECISION,
    "floorsCount"   INTEGER         NOT NULL DEFAULT 1,
    -- Maintained by `sync_building_unit_counts` below and by nothing else.
    "unitsTotal"    INTEGER         NOT NULL DEFAULT 0,
    "unitsSurveyed" INTEGER         NOT NULL DEFAULT 0,
    "notes"         TEXT,
    "createdById"   UUID,
    "createdAt"     TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buildings_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'buildings_createdById_fkey') THEN
    ALTER TABLE "buildings"
      ADD CONSTRAINT "buildings_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "buildings_code_key" ON "buildings"("code");
-- The constraint the offline suffix allocation is written against: two officers
-- in one parcel both minting "A" collide here, on the server, inside the
-- transaction that takes the parcel's row lock — rather than producing two
-- buildings that claim the same address.
CREATE UNIQUE INDEX IF NOT EXISTS "buildings_parcelNumber_codeSuffix_key"
  ON "buildings"("parcelNumber", "codeSuffix");
CREATE INDEX IF NOT EXISTS "buildings_parcelNumber_idx" ON "buildings"("parcelNumber");
CREATE INDEX IF NOT EXISTS "buildings_latitude_longitude_idx"
  ON "buildings"("latitude", "longitude");

-- ═══════════════════════════════  units  ═══════════════════════════════

CREATE TABLE IF NOT EXISTS "units" (
    "id"           UUID           NOT NULL DEFAULT gen_random_uuid(),
    "buildingId"   UUID           NOT NULL,
    -- Signed: basement negative, ground 0, first floor 1. An INTEGER, unlike
    -- the legacy `building_units.floor` TEXT, which holds «الأرضي», «ground»,
    -- «G» and «0» for one floor and can be neither sorted nor counted.
    "floor"        INTEGER        NOT NULL,
    "sequence"     INTEGER        NOT NULL,
    "unitCode"     TEXT           NOT NULL,
    "postedNumber" TEXT,
    "unitType"     "UnitType"     NOT NULL,
    "side"         TEXT,
    "unitArea"     DECIMAL(12,2),
    -- Null is "nobody was asked", and is billed. See isUnoccupied().
    "unitStatus"   "UnitStatus",
    "surveyStatus" "SurveyStatus" NOT NULL DEFAULT 'NOT_SURVEYED',
    "notes"        TEXT,
    "createdAt"    TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'units_buildingId_fkey') THEN
    ALTER TABLE "units"
      ADD CONSTRAINT "units_buildingId_fkey"
      FOREIGN KEY ("buildingId") REFERENCES "buildings"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "units_buildingId_floor_sequence_key"
  ON "units"("buildingId", "floor", "sequence");
CREATE INDEX IF NOT EXISTS "units_buildingId_idx" ON "units"("buildingId");
CREATE INDEX IF NOT EXISTS "units_surveyStatus_idx" ON "units"("surveyStatus");

-- ═════════════════════════  unit_occupancies  ═════════════════════════

CREATE TABLE IF NOT EXISTS "unit_occupancies" (
    "id"             UUID            NOT NULL DEFAULT gen_random_uuid(),
    "unitId"         UUID            NOT NULL,
    "citizenId"      UUID            NOT NULL,
    "role"           "OccupancyRole" NOT NULL,
    -- أسهم out of 2400, OWNER rows only.
    "shares"         INTEGER,
    "fromDate"       TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Null means current. A superseded occupancy keeps its dates rather than
    -- being deleted: a previous tenant is information, not history to overwrite.
    "toDate"         TIMESTAMP(3),
    "registrationId" UUID,
    "createdAt"      TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_occupancies_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unit_occupancies_unitId_fkey') THEN
    ALTER TABLE "unit_occupancies"
      ADD CONSTRAINT "unit_occupancies_unitId_fkey"
      FOREIGN KEY ("unitId") REFERENCES "units"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unit_occupancies_citizenId_fkey') THEN
    ALTER TABLE "unit_occupancies"
      ADD CONSTRAINT "unit_occupancies_citizenId_fkey"
      FOREIGN KEY ("citizenId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  -- SetNull, not Cascade: an occupancy established by a registration that is
  -- later deleted is still a fact about the unit that somebody observed.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unit_occupancies_registrationId_fkey') THEN
    ALTER TABLE "unit_occupancies"
      ADD CONSTRAINT "unit_occupancies_registrationId_fkey"
      FOREIGN KEY ("registrationId") REFERENCES "registrations"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "unit_occupancies_unitId_idx" ON "unit_occupancies"("unitId");
CREATE INDEX IF NOT EXISTS "unit_occupancies_citizenId_idx" ON "unit_occupancies"("citizenId");
-- "who is in this unit *now*" — the query the unit matrix runs per cell.
CREATE INDEX IF NOT EXISTS "unit_occupancies_unitId_toDate_idx"
  ON "unit_occupancies"("unitId", "toDate");

-- ═══════════════════════  damage_assessments  ═══════════════════════

CREATE TABLE IF NOT EXISTS "damage_assessments" (
    "id"           UUID           NOT NULL DEFAULT gen_random_uuid(),
    "buildingId"   UUID,
    "unitId"       UUID,
    "level"        "DamageLevel"  NOT NULL,
    "source"       "DamageSource" NOT NULL DEFAULT 'FIELD_VISIT',
    "observations" TEXT,
    "assessedAt"   TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assessedById" UUID,
    "createdAt"    TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "damage_assessments_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'damage_assessments_buildingId_fkey') THEN
    ALTER TABLE "damage_assessments"
      ADD CONSTRAINT "damage_assessments_buildingId_fkey"
      FOREIGN KEY ("buildingId") REFERENCES "buildings"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'damage_assessments_unitId_fkey') THEN
    ALTER TABLE "damage_assessments"
      ADD CONSTRAINT "damage_assessments_unitId_fkey"
      FOREIGN KEY ("unitId") REFERENCES "units"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'damage_assessments_assessedById_fkey') THEN
    ALTER TABLE "damage_assessments"
      ADD CONSTRAINT "damage_assessments_assessedById_fkey"
      FOREIGN KEY ("assessedById") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  -- Exactly one target, which Prisma's schema language cannot say.
  --
  -- An assessment attached to neither is an observation of nothing; attached to
  -- both, the building rollup and the unit's own reading would double-count the
  -- same visit. Both are silent corruptions of a damage figure, so the database
  -- refuses them rather than trusting every future caller to remember.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'damage_assessments_target_check') THEN
    ALTER TABLE "damage_assessments"
      ADD CONSTRAINT "damage_assessments_target_check"
      CHECK (("buildingId" IS NULL) <> ("unitId" IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "damage_assessments_buildingId_assessedAt_idx"
  ON "damage_assessments"("buildingId", "assessedAt");
CREATE INDEX IF NOT EXISTS "damage_assessments_unitId_assessedAt_idx"
  ON "damage_assessments"("unitId", "assessedAt");
CREATE INDEX IF NOT EXISTS "damage_assessments_level_idx" ON "damage_assessments"("level");

-- ══════════════════  Links from the existing tables  ══════════════════

-- Nullable on both sides of the transition and after it. A LAND or TENT card
-- has no building and never gets one; a card filed before its parcel was
-- surveyed has nothing to point at yet.
ALTER TABLE "property_entries" ADD COLUMN IF NOT EXISTS "buildingId" UUID;
ALTER TABLE "building_units"   ADD COLUMN IF NOT EXISTS "unitId"     UUID;

DO $$
BEGIN
  -- SetNull, never Cascade: deleting a building must not delete a citizen's own
  -- record of what they filed.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_entries_buildingId_fkey') THEN
    ALTER TABLE "property_entries"
      ADD CONSTRAINT "property_entries_buildingId_fkey"
      FOREIGN KEY ("buildingId") REFERENCES "buildings"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'building_units_unitId_fkey') THEN
    ALTER TABLE "building_units"
      ADD CONSTRAINT "building_units_unitId_fkey"
      FOREIGN KEY ("unitId") REFERENCES "units"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "property_entries_buildingId_idx" ON "property_entries"("buildingId");
CREATE INDEX IF NOT EXISTS "building_units_unitId_idx" ON "building_units"("unitId");

-- ── cases ───────────────────────────────────────────────────────────────
--
-- The free-text `buildingName`/`floor` columns stay exactly as they are: they
-- are what the officer actually wrote at the door, and on a parcel with no
-- surveyed buildings they are all there is. The columns below are the resolved
-- form, set once a case can be attached to a row.
--
-- `caseType` defaults to GENERAL_NOTE so every case logged before this column
-- existed keeps meaning what it did — a note from the doorstep — rather than
-- being retroactively classified as something nobody wrote down.
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "caseType" "CaseType" NOT NULL DEFAULT 'GENERAL_NOTE';
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "buildingId" UUID;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "unitId" UUID;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "damageAssessmentId" UUID;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "scheduledRevisitAt" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cases_buildingId_fkey') THEN
    ALTER TABLE "cases"
      ADD CONSTRAINT "cases_buildingId_fkey"
      FOREIGN KEY ("buildingId") REFERENCES "buildings"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cases_unitId_fkey') THEN
    ALTER TABLE "cases"
      ADD CONSTRAINT "cases_unitId_fkey"
      FOREIGN KEY ("unitId") REFERENCES "units"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  -- A reference, not ownership: resolving a case says nothing about the damage,
  -- and the assessment outlives it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cases_damageAssessmentId_fkey') THEN
    ALTER TABLE "cases"
      ADD CONSTRAINT "cases_damageAssessmentId_fkey"
      FOREIGN KEY ("damageAssessmentId") REFERENCES "damage_assessments"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "cases_caseType_idx" ON "cases"("caseType");
CREATE INDEX IF NOT EXISTS "cases_buildingId_idx" ON "cases"("buildingId");
CREATE INDEX IF NOT EXISTS "cases_unitId_idx" ON "cases"("unitId");

-- ── parcels ─────────────────────────────────────────────────────────────
--
-- The parcel outline as a GeoJSON geometry, copied from the
-- `parcel-polygons.geojson` the cadastre import already derives by face-tracing
-- the survey's line layers.
--
-- Stored here as well as in the static asset because the two answer different
-- questions. The asset is cartography the browser draws; this is what lets the
-- *server* answer "is this pin inside this parcel?" when an officer drops a
-- building's entrance, without shipping 1,700 polygons to it to find out.
--
-- Null for the parcels face-tracing could not close. Null means "we do not know
-- this outline", never "this parcel has no area".
ALTER TABLE "parcels" ADD COLUMN IF NOT EXISTS "boundary" JSONB;

-- ── registrations ───────────────────────────────────────────────────────
--
-- «سبب عام لنقص البيانات» — one reason the officer states once, used to fill in
-- each field flag's reason where they did not write a specific one. A default
-- applied field by field, never a replacement for the per-field flags: one
-- sentence attached to a record with thirty gaps leaves the reviewer nothing to
-- act on.
ALTER TABLE "registrations" ADD COLUMN IF NOT EXISTS "blanketFlagReason" TEXT;

-- ═══════════════════  Unit-count maintenance trigger  ═══════════════════
--
-- `buildings.unitsTotal` / `unitsSurveyed` are a cache, and the trigger is what
-- makes it a cache rather than a second source of truth. The map draws a pin
-- per building and styles it off the survey ratio; recomputing that with a
-- correlated count per pin is the N+1 that makes a census map unusable at a
-- thousand buildings, and maintaining it from application code means every
-- future writer — a service, a script, a manual fix at the SQL prompt — has to
-- remember. The database remembers instead.
--
-- Row-level rather than a statement-level trigger with transition tables: a
-- building holds tens of units, not thousands, so the per-row recount is a
-- cheap indexed aggregate, and the single-event restriction on transition
-- tables would mean three triggers and three copies of this logic.

CREATE OR REPLACE FUNCTION sync_building_unit_counts() RETURNS TRIGGER AS $fn$
DECLARE
  -- Both, because an UPDATE can move a unit between buildings and the one it
  -- left is as wrong afterwards as the one it joined. Read into locals under
  -- IF guards because referencing OLD on an INSERT (or NEW on a DELETE) is an
  -- unassigned-record error in PL/pgSQL, not a null.
  old_building UUID := NULL;
  new_building UUID := NULL;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_building := OLD."buildingId"; END IF;
  IF TG_OP <> 'DELETE' THEN new_building := NEW."buildingId"; END IF;

  UPDATE "buildings" b
     SET "unitsTotal"    = c.total,
         "unitsSurveyed" = c.surveyed
    FROM (
      SELECT bb."id",
             count(u."id") AS total,
             -- Mirrors SURVEYED_STATUS in packages/shared-schemas/src/enums.ts.
             -- Narrower than "the visit is over" on purpose: REFUSED and
             -- INACCESSIBLE end a visit without producing any of the data the
             -- census collects, and counting them would let a coverage figure
             -- climb while the register stayed empty. Change this list and that
             -- one together, or the map's colours and the ledger's percentages
             -- will quietly disagree.
             count(u."id") FILTER (
               WHERE u."surveyStatus" IN ('COMPLETE', 'VACANT_CONFIRMED', 'DEMOLISHED')
             ) AS surveyed
        FROM "buildings" bb
        LEFT JOIN "units" u ON u."buildingId" = bb."id"
       -- A NULL local simply matches no row, which is the wanted behaviour for
       -- the half of an INSERT or DELETE that has no counterpart.
       WHERE bb."id" IN (old_building, new_building)
       GROUP BY bb."id"
    ) c
   WHERE b."id" = c."id"
     -- No-op writes skipped: they would take a row lock on the building for
     -- every unit touched by a bulk insert, for no change.
     AND (b."unitsTotal" IS DISTINCT FROM c.total
       OR b."unitsSurveyed" IS DISTINCT FROM c.surveyed);

  RETURN NULL;
END
$fn$ LANGUAGE plpgsql;

-- PL/pgSQL resolves table names at *run* time against the caller's
-- `search_path`, not against the schema the function was created in. Every
-- tenant schema gets its own copy of this function, and each copy must reach
-- its own `buildings` and `units` however the calling connection happens to be
-- configured — so the search_path is pinned to the schema the function belongs
-- to. Without this, a connection opened on a different schema would silently
-- update the wrong municipality's counts.
DO $$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.sync_building_unit_counts() SET search_path = %I, pg_catalog',
    CURRENT_SCHEMA(), CURRENT_SCHEMA()
  );
END $$;

DROP TRIGGER IF EXISTS "units_sync_building_counts" ON "units";
CREATE TRIGGER "units_sync_building_counts"
  AFTER INSERT OR DELETE OR UPDATE OF "buildingId", "surveyStatus" ON "units"
  FOR EACH ROW EXECUTE FUNCTION sync_building_unit_counts();

-- Reconciles anything the trigger was not present for. A no-op on a fresh
-- schema and on every ordinary run; it earns its place if this migration is
-- ever re-applied to a schema where the tables exist but the trigger was
-- dropped, which is exactly the state a half-failed run leaves behind.
UPDATE "buildings" b
   SET "unitsTotal"    = c.total,
       "unitsSurveyed" = c.surveyed
  FROM (
    SELECT bb."id",
           count(u."id") AS total,
           count(u."id") FILTER (
             WHERE u."surveyStatus" IN ('COMPLETE', 'VACANT_CONFIRMED', 'DEMOLISHED')
           ) AS surveyed
      FROM "buildings" bb
      LEFT JOIN "units" u ON u."buildingId" = bb."id"
     GROUP BY bb."id"
  ) c
 WHERE b."id" = c."id"
   AND (b."unitsTotal" IS DISTINCT FROM c.total
     OR b."unitsSurveyed" IS DISTINCT FROM c.surveyed);

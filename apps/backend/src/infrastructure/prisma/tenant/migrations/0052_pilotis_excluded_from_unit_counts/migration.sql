-- 0052_pilotis_excluded_from_unit_counts
--
-- Keeps «طابق أعمدة» out of `buildings.unitsTotal` and `unitsSurveyed`.
--
-- == Why ================================================================
--
-- Those two columns are the census's denominator and numerator. The map styles
-- every pin off their ratio, «الوحدات غير المسحوبة» on the buildings screen is
-- their difference, and both are read as statements about how much of the town
-- has been surveyed.
--
-- A pilotis counted in them is a permanent lie in both directions at once. It
-- can never be surveyed — there is nobody to answer and nothing to record — so
-- it sits in the numerator's complement for ever, and a fully surveyed block
-- with a column floor reports 4/5 until somebody invents a reason to mark the
-- columns «مكتملة». It also inflates «عدد الوحدات» on a building whose owner
-- would say, correctly, that it has four flats.
--
-- The fix is in the trigger rather than in the readers because there are many
-- readers and one writer. That is the whole argument 0030 made for having this
-- trigger at all: «every future writer has to remember; the database remembers
-- instead». A filter applied in `BuildingsService` would leave the column
-- itself wrong, and the column is what the map reads.
--
-- == The trigger's event list widens too ================================
--
-- It fired on INSERT, DELETE, and UPDATE OF ("buildingId", "surveyStatus").
-- That was exhaustive while every unit counted the same. It is not any more:
-- retyping a مستودع to «طابق أعمدة» — which is precisely the correction an
-- officer will make on buildings already in the register, since مستودع was the
-- least-wrong answer available before today — changes `total` without touching
-- either watched column, and the counts would have silently kept the old value
-- until some unrelated edit happened to move the row.
--
-- `unitType` is therefore added to the watched list. Still `UPDATE OF` rather
-- than a bare `UPDATE`: an area correction or a posted-number fix must not take
-- a row lock on the building for a recount that cannot change.
--
-- == On re-running ======================================================
--
-- `CREATE OR REPLACE FUNCTION` and a dropped-and-recreated trigger are both
-- idempotent, and the reconciling UPDATE at the foot is what makes this correct
-- rather than merely forward-correct: schemas that already hold units get their
-- counts restated under the new rule in the same transaction. On every schema
-- alive today that is a no-op, because no pilotis exists yet — 0051 only added
-- the value and no client could produce it. It earns its place the second time
-- this is applied, and on any schema restored from a dump taken later.
--
-- Written unqualified: the migrator sets `search_path` to the target tenant
-- schema before running this.

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
             -- Mirrors STRUCTURAL_UNIT_TYPE in packages/shared-schemas/src/enums.ts.
             -- A structural row draws a level of the building; it is not a space
             -- anyone holds, cannot be surveyed, and must not reach either
             -- figure. Compared as text so this body carries no dependency on
             -- the enum's members beyond the name.
             count(u."id") FILTER (
               WHERE u."unitType"::text <> 'PILOTIS'
             ) AS total,
             -- Mirrors SURVEYED_STATUS in packages/shared-schemas/src/enums.ts.
             -- Narrower than "the visit is over" on purpose: REFUSED and
             -- INACCESSIBLE end a visit without producing any of the data the
             -- census collects, and counting them would let a coverage figure
             -- climb while the register stayed empty. Change this list and that
             -- one together, or the map's colours and the ledger's percentages
             -- will quietly disagree.
             count(u."id") FILTER (
               WHERE u."surveyStatus" IN ('COMPLETE', 'VACANT_CONFIRMED', 'DEMOLISHED')
                 AND u."unitType"::text <> 'PILOTIS'
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

-- Re-pinned because CREATE OR REPLACE keeps the existing settings only if the
-- function already existed with them; restating it costs nothing and makes this
-- file correct on a schema where 0030's DO block never ran. See 0030 for why a
-- per-tenant copy must resolve its own `buildings` and `units`.
DO $$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.sync_building_unit_counts() SET search_path = %I, pg_catalog',
    CURRENT_SCHEMA(), CURRENT_SCHEMA()
  );
END $$;

DROP TRIGGER IF EXISTS "units_sync_building_counts" ON "units";
CREATE TRIGGER "units_sync_building_counts"
  AFTER INSERT OR DELETE OR UPDATE OF "buildingId", "surveyStatus", "unitType" ON "units"
  FOR EACH ROW EXECUTE FUNCTION sync_building_unit_counts();

-- Restates every building's counts under the new rule. See the note above on
-- why this is a no-op today and why it is here anyway.
UPDATE "buildings" b
   SET "unitsTotal"    = c.total,
       "unitsSurveyed" = c.surveyed
  FROM (
    SELECT bb."id",
           count(u."id") FILTER (
             WHERE u."unitType"::text <> 'PILOTIS'
           ) AS total,
           count(u."id") FILTER (
             WHERE u."surveyStatus" IN ('COMPLETE', 'VACANT_CONFIRMED', 'DEMOLISHED')
               AND u."unitType"::text <> 'PILOTIS'
           ) AS surveyed
      FROM "buildings" bb
      LEFT JOIN "units" u ON u."buildingId" = bb."id"
     GROUP BY bb."id"
  ) c
 WHERE b."id" = c."id"
   AND (b."unitsTotal" IS DISTINCT FROM c.total
     OR b."unitsSurveyed" IS DISTINCT FROM c.surveyed);

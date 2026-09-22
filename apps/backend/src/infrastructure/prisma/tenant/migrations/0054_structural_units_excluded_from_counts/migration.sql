-- 0054_structural_units_excluded_from_counts
--
-- Widens 0052's filter from «PILOTIS» to every structural unit type.
--
-- == Why this exists ====================================================
--
-- 0052 taught `sync_building_unit_counts` to leave طوابق الأعمدة out of
-- `buildings.unitsTotal` and `unitsSurveyed`, and it named the value literally
-- because SQL cannot read `STRUCTURAL_UNIT_TYPE` out of shared-schemas. 0053
-- adds «طابق فارغ» to that set, so without this the new type would inflate the
-- census denominator exactly the way مستودع used to — a floor with no unit on
-- it counted as a unit, permanently unsurveyable, dragging every coverage
-- percentage down and never reaching 100%.
--
-- 0052 cannot be edited: it ran on staging at 17:07 UTC on 2026-09-20, and the
-- tenant migrator tracks by folder name, so an edit would never re-run and
-- staging would silently diverge from production (AGENTS.md §3).
--
-- == The list is now a set, and that is the point =======================
--
-- `NOT IN ('PILOTIS', 'EMPTY_FLOOR')` rather than a second `<>` chained onto
-- the first. The predicate mirrors `STRUCTURAL_UNIT_TYPE`, which is a set in
-- shared-schemas for the same reason — the question «is this a part of the
-- building rather than a space in it» keeps getting new answers, and a roof
-- plant room or a shared stairwell block would be the next. Whoever adds the
-- third one edits one array there and this one list here.
--
-- Compared as text, as 0052 did, so this body carries no dependency on the
-- enum's members beyond their names.
--
-- == The trigger's event list is unchanged ==============================
--
-- 0052 already widened it to fire on `UPDATE OF ("buildingId", "surveyStatus",
-- "unitType")`. That third column is what makes the commonest edit on an empty
-- floor correct: retyping the block into شقق — the ordinary end of an empty
-- floor's life — has to put those units back into the count on the spot.
-- Restated below anyway, because a `CREATE OR REPLACE FUNCTION` does not touch
-- the trigger and this file must be correct on a schema that somehow has 0052's
-- function without 0052's trigger.
--
-- == On re-running ======================================================
--
-- Idempotent, and the reconciling UPDATE at the foot is what makes it correct
-- rather than merely forward-correct: any schema that already holds units gets
-- its counts restated under the new rule in the same transaction. On every
-- schema alive today that is a no-op for `EMPTY_FLOOR` (0053 only added the
-- value; no client can have produced one yet) and re-asserts 0052's result for
-- `PILOTIS`.
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
             -- figure. Change that array and this list together.
             count(u."id") FILTER (
               WHERE u."unitType"::text NOT IN ('PILOTIS', 'EMPTY_FLOOR')
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
                 AND u."unitType"::text NOT IN ('PILOTIS', 'EMPTY_FLOOR')
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

-- See 0030 for why a per-tenant copy must resolve its own `buildings` and
-- `units` against its own schema rather than the caller's search_path.
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

-- Restates every building's counts under the widened rule. See the note above
-- on why this is a no-op today and why it is here anyway.
UPDATE "buildings" b
   SET "unitsTotal"    = c.total,
       "unitsSurveyed" = c.surveyed
  FROM (
    SELECT bb."id",
           count(u."id") FILTER (
             WHERE u."unitType"::text NOT IN ('PILOTIS', 'EMPTY_FLOOR')
           ) AS total,
           count(u."id") FILTER (
             WHERE u."surveyStatus" IN ('COMPLETE', 'VACANT_CONFIRMED', 'DEMOLISHED')
               AND u."unitType"::text NOT IN ('PILOTIS', 'EMPTY_FLOOR')
           ) AS surveyed
      FROM "buildings" bb
      LEFT JOIN "units" u ON u."buildingId" = bb."id"
     GROUP BY bb."id"
  ) c
 WHERE b."id" = c."id"
   AND (b."unitsTotal" IS DISTINCT FROM c.total
     OR b."unitsSurveyed" IS DISTINCT FROM c.surveyed);

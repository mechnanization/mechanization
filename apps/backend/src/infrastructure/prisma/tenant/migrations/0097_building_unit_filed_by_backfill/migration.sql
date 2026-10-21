-- 0097_building_unit_filed_by_backfill
--
-- == What it is for ==
--
-- Fills `building_units.filedById` (0096) for the lines already on file, where
-- the record names a staff member other than the officer of the registration the
-- card was filed on. Every other line is left NULL, which reads exactly as it did
-- before 0096: credited to that registration's officer.
--
-- No column has ever recorded who created a line, so the filer is recovered
-- from what was written beside it, in this order:
--
-- 1. The audit trail. Recording an occupancy (`OCCUPANCY_RECORDED`, the matrix
--    and the registration form's census sync) and an owner link
--    (`LANDLORD_LINKED`, `LANDLORD_LINK_UPDATED`) each write their audit row in
--    the request that writes the line, about 15 ms apart. A line takes the actor
--    of the audit rows within 400 ms of its `createdAt` only when exactly one
--    staff member is among them; two officers working the same instant name
--    nobody here.
-- 2. The owner link's receipt. `landlordLinkFootprint.actorId` on the tenant's
--    card names who linked, and `units[].row` names the owner card and flat the
--    link wrote a line on. Used where the trail named nobody.
--
-- And two kinds of line keep the registration's officer whatever the trail says:
--
-- - one created within two minutes of its registration's `submittedAt`: it was
--   written with the file, by whoever filed it;
-- - one created while the named staff member was saving the citizen's file
--   (`CITIZEN_UPDATED` by them within 5 s). Until rows were kept by identity the
--   edit form deleted and re-created every line on each save, and it still
--   re-stamps `createdAt` to keep the form's order, so a re-save can put any old
--   line beside the saver's own audit rows. A flat genuinely added on another
--   officer's file this way stays with that file's officer; from 0096's release
--   on, the form records the saver on the lines it creates.
--
-- Measured on production 2026-10-21 (dry run against the read-only views): 191
-- lines assigned (186 from the trail, 5 from receipts), 18 held back by the two
-- rules above, none on a file without an officer.
--
-- == Safety ==
--
-- Fills a column nothing has written yet. No line changes owner, card, flat or
-- status; `updatedAt` is application-maintained (Prisma `@updatedAt`) and is not
-- touched, so the correction tool's fingerprints and the edit form's staleness
-- checks see the same rows. No trigger fires on `building_units`. Needs 0096
-- (the column), 0045 (`landlordLinkFootprint`) and 0061 (`filedRegistrationId`).
--
-- Idempotent: only lines with `filedById` NULL are considered, and a replay
-- recomputes the same answer from the same trail. A filer must be an existing
-- STAFF user (the foreign key; a citizen never files).
--
-- The scanner warns on `UPDATE … SET`, and continues: this is the backfill step
-- of 0096's expand. Locks: ROW EXCLUSIVE on `building_units` for one UPDATE of
-- under 200 lines; readers are not blocked. Each line's trail lookup reads
-- `audit_log_entries` through its `createdAt` index.
--
-- Unqualified (the migrator sets `search_path`). The receipt's ids are text in
-- JSON; they are matched against the uuid shape before any is cast, so one
-- malformed receipt is skipped rather than failing the file.

WITH lines AS (
  SELECT bu."id",
         bu."createdAt" AS "at",
         bu."unitId",
         bu."propertyEntryId",
         reg."createdById" AS "fileOfficerId",
         reg."submittedAt" AS "submittedAt"
  FROM "building_units" bu
  JOIN "property_entries" pe ON pe."id" = bu."propertyEntryId"
  JOIN "registrations" reg ON reg."id" = COALESCE(pe."filedRegistrationId", pe."registrationId")
  WHERE bu."filedById" IS NULL
),
trail AS (
  SELECT l."id",
         (SELECT CASE WHEN count(DISTINCT a."actorId") = 1 THEN (array_agg(DISTINCT a."actorId"))[1] END
            FROM "audit_log_entries" a
           WHERE a."action" IN ('OCCUPANCY_RECORDED', 'LANDLORD_LINKED', 'LANDLORD_LINK_UPDATED')
             AND a."actorId" IS NOT NULL
             AND a."createdAt" BETWEEN l."at" - INTERVAL '400 milliseconds'
                                   AND l."at" + INTERVAL '400 milliseconds') AS "actorId"
  FROM lines l
),
-- Text first, filtered, and MATERIALIZED so no `::uuid` below can meet a value
-- the filter has not passed: Postgres does not order a WHERE before a join's cast.
receipt_lines AS MATERIALIZED (
  SELECT x."linker", x."card", x."unit"
  FROM (
    SELECT pe."landlordLinkFootprint" ->> 'actorId' AS "linker",
           u -> 'row' ->> 'propertyEntryId' AS "card",
           u ->> 'unitId' AS "unit"
    FROM "property_entries" pe
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(pe."landlordLinkFootprint" -> 'units') = 'array'
           THEN pe."landlordLinkFootprint" -> 'units' ELSE '[]'::jsonb END
    ) u
    WHERE pe."landlordLinkFootprint" ->> 'v' = '1'
  ) x
  WHERE x."linker" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND x."card" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND x."unit" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
receipt AS (
  SELECT DISTINCT ON (bu."id")
         bu."id",
         rl."linker"::uuid AS "linkerId"
  FROM receipt_lines rl
  JOIN "building_units" bu
    ON bu."propertyEntryId" = rl."card"::uuid
   AND bu."unitId" = rl."unit"::uuid
  ORDER BY bu."id"
),
named AS (
  SELECT l.*, COALESCE(t."actorId", r."linkerId") AS "filerId"
  FROM lines l
  JOIN trail t ON t."id" = l."id"
  LEFT JOIN receipt r ON r."id" = l."id"
),
assigned AS (
  SELECT n."id", n."filerId"
  FROM named n
  JOIN "users" staff ON staff."id" = n."filerId" AND staff."kind" = 'STAFF'
  WHERE n."filerId" IS DISTINCT FROM n."fileOfficerId"
    AND abs(extract(EPOCH FROM (n."at" - n."submittedAt"))) >= 120
    AND NOT EXISTS (
      SELECT 1 FROM "audit_log_entries" e
       WHERE e."action" = 'CITIZEN_UPDATED'
         AND e."actorId" = n."filerId"
         AND e."createdAt" BETWEEN n."at" - INTERVAL '5 seconds' AND n."at" + INTERVAL '5 seconds'
    )
)
UPDATE "building_units" bu
   SET "filedById" = assigned."filerId"
  FROM assigned
 WHERE bu."id" = assigned."id"
   AND bu."filedById" IS NULL;

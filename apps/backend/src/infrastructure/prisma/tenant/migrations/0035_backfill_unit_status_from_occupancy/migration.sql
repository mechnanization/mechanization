-- 0035_backfill_unit_status_from_occupancy
--
-- Teach the units the census already surveyed what their occupancies imply.
--
-- == Why there is anything to backfill =====================================
--
-- Who is in a flat is recorded in `unit_occupancies`. What state the flat is in
-- is recorded in `unitStatus`, on `units` and again on `building_units`. They
-- are two statements of one fact, written by two different screens, and until
-- this release nothing connected them: `recordOccupancy` and `applyOccupancy`
-- both wrote the occupancy row, the survey status, a visit and the case
-- resolution — and never the unit's status.
--
-- So recording a مستأجر never made the flat «مؤجرة». The owner's card went on
-- saying «مشغولة من المالك», `bearsFee` read that and charged the owner the
-- occupancy fee, and the tenant's own card was charged it too. Every flat in
-- the register that has both an owner and a non-owner occupant is in that state
-- right now. This is the correction for the rows already written; the two write
-- paths are fixed for the rows still to come.
--
-- == Only from NULL ========================================================
--
-- The same rule the runtime now applies, and it is the load-bearing half. A
-- unit whose status somebody actually set is a person's answer, and a migration
-- that overwrites it is a migration that silently disagrees with the officer
-- who was standing in the room. Where an explicit status contradicts a live
-- occupancy the register keeps the contradiction — the matrix drawer surfaces
-- it, and a person resolves it.
--
-- `NULL` genuinely means "nobody was asked" here: the column has never had a
-- writer on the occupancy path, so every unit that has an occupant and a null
-- status is a row this had no way of reaching before now.
--
-- == Why TENANT wins a tie =================================================
--
-- A unit with a live مستأجر *and* a live شاغل بتسامح is not a state the app can
-- produce and not one the register should invent an answer for. It is resolved
-- toward RENTED because a عقد إيجار is the fact with legal weight and a fee
-- schedule behind it; the alternative is leaving the status null, which bills
-- the owner. Vanishingly rare either way — 0034's index does not forbid it
-- (those are two different citizens), so it is handled rather than assumed away.
--
-- Written unqualified: the migrator sets `search_path` to the target tenant
-- schema before running this.

-- ══════════════════════════  units.unitStatus  ══════════════════════════════

UPDATE "units" AS u
   SET "unitStatus" = implied."status"
  FROM (
    SELECT o."unitId",
           -- RENTED ahead of FREE_OCCUPIED: see the tie note above.
           MIN(CASE o."role"
                 WHEN 'TENANT'        THEN 1
                 WHEN 'FREE_OCCUPANT' THEN 2
               END) AS "rank",
           (CASE MIN(CASE o."role"
                       WHEN 'TENANT'        THEN 1
                       WHEN 'FREE_OCCUPANT' THEN 2
                     END)
              WHEN 1 THEN 'RENTED'
              WHEN 2 THEN 'FREE_OCCUPIED'
            END)::"UnitStatus" AS "status"
      FROM "unit_occupancies" o
     WHERE o."toDate" IS NULL
       AND o."role" IN ('TENANT', 'FREE_OCCUPANT')
     GROUP BY o."unitId"
  ) AS implied
 WHERE u."id" = implied."unitId"
   AND u."unitStatus" IS NULL
   AND implied."status" IS NOT NULL;

-- ═══════════════════════  building_units.unitStatus  ════════════════════════

-- The citizen's own card line for the same flat.
--
-- Corrected too, and only where it is null, because `preferLinked` reads the
-- canonical `units` row *first* — so a card line left null is already answered
-- correctly by the line above. What this fixes is the card a landlord files
-- while unlinked, or one whose link is later dropped: it falls back to its own
-- value, and a null there bills them.
--
-- Reached through the card's `unitId` link only. A line with no link is the
-- citizen's unaided statement about a flat the census cannot identify, and
-- nothing here knows enough to correct it.
UPDATE "building_units" AS bu
   SET "unitStatus" = u."unitStatus"
  FROM "units" u
 WHERE bu."unitId" = u."id"
   AND bu."unitStatus" IS NULL
   AND u."unitStatus" IN ('RENTED', 'FREE_OCCUPIED');

-- ═══════════════════════  property_entries.unitStatus  ══════════════════════

-- The منزل card, which is where «a family in a relative's empty house» — the
-- case `FREE_OCCUPANT` was written for — actually lands.
--
-- A HOUSE card has no units array to itemise, so `billableUnits` falls through
-- to the card's own `unitStatus`, and a null there bills the owner. It is the
-- one card shape that can carry this column at all (`PROPERTY_FIELD_MAP`
-- restricts it, and only an OWNER is ever asked).
--
-- The unit is *inferred*, and under exactly the condition `CensusSyncService`
-- infers it under: a HOUSE linked to a structure holding **exactly one** unit.
-- That is the only shape where there is nothing to infer between. A مبنى is
-- excluded even at one unit, for the reason P2-T8 reverted over — a matrix says
-- what flats exist, never how many of them one citizen holds.
UPDATE "property_entries" AS pe
   SET "unitStatus" = u."unitStatus"
  FROM "units" u
 WHERE pe."propertyType" = 'HOUSE'
   AND pe."unitStatus" IS NULL
   AND pe."buildingId" = u."buildingId"
   AND u."unitStatus" IN ('RENTED', 'FREE_OCCUPIED')
   AND (SELECT count(*) FROM "units" sibling WHERE sibling."buildingId" = pe."buildingId") = 1;

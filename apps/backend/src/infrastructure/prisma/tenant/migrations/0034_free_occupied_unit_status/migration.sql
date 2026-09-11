-- 0034_free_occupied_unit_status
--
-- «مشغولة بتسامح» as a حالة الوحدة, and one live spell per person per flat.
--
-- == The double-charge this closes =========================================
--
-- `UnitStatus` had four values and none of them could say "somebody is living
-- here without a lease". The register has always had three ways to be the
-- شاغل — `OCCUPANCY_TYPE` grew `FREE_OCCUPANT` for exactly that reason — and
-- only ever had two ways to say so from the owner's side.
--
-- So an owner whose son occupies the flat rent-free had no true answer:
--
--   * RENTED asserts a عقد إيجار that does not exist, which is wrong in law
--     and is the precise falsehood `FREE_OCCUPANT` was added to stop;
--   * VACANT denies an occupant who is standing in the room;
--   * UNDER_CONSTRUCTION is about the building, not who is in it.
--
-- They answered OWNER_OCCUPIED, or left it blank. Both read as "the owner is
-- the شاغل", and `bearsFee` exempts an owner from an occupant-borne fee
-- (النظافة, القيمة التأجيرية) only on RENTED or an unoccupied state. So the
-- owner was charged for the flat **and** the son was charged for it on his own
-- card — the same double-count RENTED ends for tenancies, left standing for
-- the one arrangement whose occupants are least placed to argue about a bill.
--
-- It was worse than a gap; it was an inverted incentive. An owner who lied and
-- said «مؤجرة» escaped the fee. An owner who answered honestly paid it.
--
-- And every such record made the register's own figures wrong in whichever
-- direction the owner guessed — a شاغل بتسامح counted as rented stock, or as
-- owner-occupied. There was no third bucket to count them in.
--
-- == Why the value is added here and used in 0035 ==========================
--
-- `tenant-migrator.ts` wraps each migration in its own BEGIN/COMMIT. Postgres
-- permits `ALTER TYPE ... ADD VALUE` inside a transaction block but **refuses
-- to let the new value be used** until that transaction commits. A backfill in
-- this file would therefore fail at run time, on every tenant, after the DDL
-- above it had already succeeded. 0035 is that backfill, one transaction later.
--
-- Positioned BEFORE 'VACANT' so the Postgres enum keeps the same order as
-- `UNIT_STATUS` in shared-schemas — occupied states first, then the empty ones.
-- Nothing depends on the ordering today; two lists that disagree eventually
-- find something that does.
--
-- == The unique index ======================================================
--
-- "A person is in a unit once, in one capacity, at a time" is a rule both write
-- paths already state in a comment and enforce with a `findFirst` — which is a
-- read followed by a write, i.e. not an enforcement at all. Two officers, or an
-- offline queue draining beside a live edit, interleave to two open spells for
-- one person in one flat, and from then on the matrix shows them twice and
-- `heldThroughOccupancy` bills them twice.
--
-- Partial, on `toDate IS NULL`, because *ended* spells are exactly what D2 says
-- to keep: somebody who moved out and back in is two rows and must stay two.
--
-- Written unqualified: the migrator sets `search_path` to the target tenant
-- schema before running this. Idempotent throughout, since a schema that failed
-- part-way must be safe to re-run.

-- ═══════════════════════════  UnitStatus.FREE_OCCUPIED  ═════════════════════

ALTER TYPE "UnitStatus" ADD VALUE IF NOT EXISTS 'FREE_OCCUPIED' BEFORE 'VACANT';

-- ══════════════════  one live spell per citizen per unit  ═══════════════════

-- Redundant *current* rows, removed before the index that would reject them.
--
-- Deleting is right here and would not be right one line further out. These are
-- copies of one spell, not two spells: `recordOccupancy` updates the role on an
-- existing open row rather than adding a second, so the only way a pair gets
-- two open rows is a race between two writers, and what a race produces is the
-- same fact twice. The spell itself survives in the row that is kept.
--
-- The earliest `fromDate` is the keeper, because that is when the person
-- actually moved in; `createdAt` and `id` only break ties. `registrationId` is
-- deliberately not preferred — a spell that already carries one is not more
-- true than the same spell recorded at a doorstep, and `endUnclaimed` can close
-- either.
--
-- Ended rows are never touched. That is the history D2 exists to protect.
DELETE FROM "unit_occupancies" AS dup
 WHERE dup."toDate" IS NULL
   AND EXISTS (
     SELECT 1 FROM "unit_occupancies" AS keep
      WHERE keep."toDate" IS NULL
        AND keep."unitId" = dup."unitId"
        AND keep."citizenId" = dup."citizenId"
        AND (keep."fromDate", keep."createdAt", keep."id")
          < (dup."fromDate", dup."createdAt", dup."id")
   );

CREATE UNIQUE INDEX IF NOT EXISTS "unit_occupancies_unitId_citizenId_current_key"
  ON "unit_occupancies" ("unitId", "citizenId")
  WHERE "toDate" IS NULL;

-- 0040_owner_records_and_occupancy_end
--
-- Four findings from the first days of field work in production, each an
-- *additive* change. Nothing here drops, renames, retypes or rewrites a row:
-- every column is new and nullable or defaulted, and every enum only gains a
-- value.
--
-- == 1. «مالك غير مقيم» — owners who do not live in the town ==============
--
-- An owner living abroad, or in Beirut, was being filed as a full household:
-- identity, blood type, marital status and household counts for a person the
-- municipality has no reason to hold them for. The rental-value fee falls on
-- the occupant (Law 60/1988, Art. 3–4); what the law needs about an owner is a
-- name on the assessment roll (Art. 17) and where they live (Art. 14).
--
-- `residence` is NOT NULL DEFAULT 'RESIDENT' rather than nullable, because the
-- one query this column exists for — excluding owner records from population
-- figures — is `<> 'NON_RESIDENT_OWNER'`, and `<>` is never true for NULL. A
-- nullable column would silently drop every existing citizen from the count.
-- Every existing row, staff included, reads as RESIDENT, which is what they are.
--
-- == 2. «مسكن موسمي» — seasonal homes =====================================
--
-- An expatriate family's flat opened for July and August is neither VACANT
-- (it is furnished and at their disposal) nor OWNER_OCCUPIED (nobody lives in
-- it most of the year). The three unit columns record the facts a council's
-- billing decision needs; nothing reads them to bill.
--
-- `ADD VALUE` runs inside the migrator's transaction. That is allowed since
-- Postgres 12; what is not allowed is *using* the value in the same
-- transaction, and nothing in this file does.
--
-- == 3. Why an occupancy ended ============================================
--
-- «إنهاء الإشغال» ended a spell with no question and was pressed by mistake.
-- The confirmation now asks why, and the answer is stored. Null for every spell
-- ended before this migration, which is the truth: nobody was asked.
--
-- Written unqualified: the migrator sets `search_path` to the target tenant
-- schema before running this.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'CitizenResidence' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "CitizenResidence" AS ENUM ('RESIDENT', 'NON_RESIDENT_OWNER');
  END IF;
END
$$;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "residence" "CitizenResidence" NOT NULL DEFAULT 'RESIDENT',
  ADD COLUMN IF NOT EXISTS "residencePlace" TEXT,
  ADD COLUMN IF NOT EXISTS "localContactName" TEXT,
  ADD COLUMN IF NOT EXISTS "localContactPhone" TEXT;

ALTER TYPE "UnitStatus" ADD VALUE IF NOT EXISTS 'SEASONAL' BEFORE 'VACANT';

ALTER TABLE "units"
  ADD COLUMN IF NOT EXISTS "presenceMonths" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN IF NOT EXISTS "ownerLastStayAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "vacancyDeclaredAt" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'OccupancyEndReason' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "OccupancyEndReason" AS ENUM (
      'MOVED_OUT',
      'OWNERSHIP_TRANSFERRED',
      'RECORDED_IN_ERROR'
    );
  END IF;
END
$$;

ALTER TABLE "unit_occupancies"
  ADD COLUMN IF NOT EXISTS "endReason" "OccupancyEndReason";

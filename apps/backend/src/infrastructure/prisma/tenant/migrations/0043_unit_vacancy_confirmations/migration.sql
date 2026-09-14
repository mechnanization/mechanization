-- 0043_unit_vacancy_confirmations
--
-- «تأكيد الشغور» becomes a record that can be lifted, instead of two columns
-- overwritten in place.
--
-- == Why a table ===========================================================
--
-- `units.unitStatus = 'VACANT'` with `surveyStatus = 'VACANT_CONFIRMED'` is the
-- state the button wrote, and it is a *bill-changing* one: `isUnoccupied` in
-- shared-schemas exempts the owner from the occupancy fee (Law 60/1988 Art. 11
-- — the fee is owed for actual occupancy). Two columns cannot say who decided
-- that, when, on what basis, or what the flat said before — so the finding
-- could not be audited by a resident disputing the exemption, and could not be
-- undone except by an officer retyping a status from memory.
--
-- This is the row behind those two columns. It is appended, closed by
-- `endedAt`, and never deleted: a vacancy that was withdrawn still records what
-- the municipality believed and for how long, exactly as `damage_assessments`
-- keeps a building's 2024 reading after its 2026 repair.
--
-- == The two snapshot columns ==============================================
--
-- `previousUnitStatus` / `previousSurveyStatus` hold what the unit said at the
-- moment of confirmation. They exist so that lifting a confirmation recorded in
-- error restores the flat rather than guessing at it — a مؤجرة flat wrongly
-- marked empty goes back to مؤجرة, not to «غير محدد».
--
-- == One live confirmation per unit ========================================
--
-- A partial unique index, which Prisma's schema language cannot express; it
-- lives here alone, as migration 0030's damage CHECK does. Two officers
-- confirming the same flat at once would otherwise produce two open rows and no
-- single thing to lift.
--
-- == The backfill ==========================================================
--
-- Every unit already sitting in the button's exact signature gets a row, so the
-- undo works on flats confirmed before this migration. `basis` and the two
-- snapshots are null on those: nobody was asked, and inventing an answer would
-- be worse than the gap — `vacancyReversal` falls back to the unit's own visit
-- history when the snapshot is missing.
--
-- Units carrying `surveyStatus = 'VACANT_CONFIRMED'` *without* `unitStatus =
-- 'VACANT'` are deliberately left alone. Those came from a visit outcome, which
-- never exempted anybody, and minting a confirmation for them here would change
-- what a municipality is owed inside a migration.
--
-- Written unqualified: the migrator sets `search_path` to the target tenant
-- schema before running this, and wraps the file in one transaction. Idempotent
-- throughout, since a schema that failed part-way must be safe to re-run.
-- `CREATE TYPE` is transaction-safe; only `ALTER TYPE ... ADD VALUE` followed by
-- *using* the value is not, and nothing here does that.

-- ═════════════════════════════  the two enums  ═════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'VacancyBasis' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "VacancyBasis" AS ENUM (
      'FIELD_INSPECTION',
      'OWNER_STATEMENT',
      'NEIGHBOUR_OR_CARETAKER',
      'DECLARATION_FILED'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'VacancyEndReason' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "VacancyEndReason" AS ENUM ('RECORDED_IN_ERROR', 'NO_LONGER_VACANT');
  END IF;
END
$$;

-- ══════════════════════  unit_vacancy_confirmations  ══════════════════════

CREATE TABLE IF NOT EXISTS "unit_vacancy_confirmations" (
  "id"                   UUID         NOT NULL DEFAULT gen_random_uuid(),
  "unitId"               UUID         NOT NULL,
  "basis"                "VacancyBasis",
  "observedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notes"                TEXT,
  "confirmedById"        UUID,
  "previousUnitStatus"   "UnitStatus",
  "previousSurveyStatus" "SurveyStatus",
  "endedAt"              TIMESTAMP(3),
  "endReason"            "VacancyEndReason",
  "endNotes"             TEXT,
  "endedById"            UUID,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "unit_vacancy_confirmations_pkey" PRIMARY KEY ("id"),
  -- A closed confirmation says why it closed, and an open one has no date.
  -- Enforced here because both halves are written by one service call and a row
  -- carrying one without the other would read as neither open nor closed.
  CONSTRAINT "unit_vacancy_confirmations_ended_pair"
    CHECK (("endedAt" IS NULL) = ("endReason" IS NULL))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'unit_vacancy_confirmations_unitId_fkey' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "unit_vacancy_confirmations"
      ADD CONSTRAINT "unit_vacancy_confirmations_unitId_fkey"
      FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  -- Both officers are `SetNull` for `UnitVisit.officer`'s reason: the finding
  -- is a thing that happened and stays true after they leave the municipality.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'unit_vacancy_confirmations_confirmedById_fkey' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "unit_vacancy_confirmations"
      ADD CONSTRAINT "unit_vacancy_confirmations_confirmedById_fkey"
      FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'unit_vacancy_confirmations_endedById_fkey' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "unit_vacancy_confirmations"
      ADD CONSTRAINT "unit_vacancy_confirmations_endedById_fkey"
      FOREIGN KEY ("endedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- Every read is "this unit's confirmations, newest first".
CREATE INDEX IF NOT EXISTS "unit_vacancy_confirmations_unitId_createdAt_idx"
  ON "unit_vacancy_confirmations" ("unitId", "createdAt");

-- At most one confirmation standing on a unit at a time. See the header.
CREATE UNIQUE INDEX IF NOT EXISTS "unit_vacancy_confirmations_active_key"
  ON "unit_vacancy_confirmations" ("unitId")
  WHERE "endedAt" IS NULL;

-- ════════════════════════════  the backfill  ════════════════════════════

INSERT INTO "unit_vacancy_confirmations" ("unitId", "observedAt", "createdAt", "updatedAt")
SELECT u."id", u."updatedAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "units" u
WHERE u."unitStatus" = 'VACANT'
  AND u."surveyStatus" = 'VACANT_CONFIRMED'
  AND NOT EXISTS (
    SELECT 1 FROM "unit_vacancy_confirmations" c
    WHERE c."unitId" = u."id" AND c."endedAt" IS NULL
  );

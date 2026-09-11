-- 0032_unit_visits
--
-- P4-T1 and P4-T4: the record of attempts, and the council decision that may
-- or may not stand behind the numbering.
--
-- == Why a table, when the unit already has a status =======================
--
-- `units.surveyStatus` answers "where does this flat stand". It cannot answer
-- "how many times has anybody gone", and D10 is explicit that the second is the
-- dispatch decision: a door knocked on three times with no answer is escalated
-- to a notice, while one nobody has walked to yet is simply assigned. Both
-- currently read `VISITED_NO_ANSWER`, so the ledger flattens them together and
-- an officer is sent back to a door two colleagues have already tried.
--
-- The status stays the current answer. This is the history behind it.
--
-- == Why `outcome` reuses SurveyStatus =====================================
--
-- Because a fourth overlapping vocabulary is the exact trap D15 was written
-- about. Every state a *visit* can produce is already in `SurveyStatus` —
-- answered, refused, unreachable, found vacant, found demolished, partially
-- recorded — and inventing `VisitOutcome` beside it would mean two enums that
-- mean the same things under different names, drifting on the first addition to
-- either.
--
-- The one value that is not a visit outcome is `NOT_SURVEYED`: it means nobody
-- went, so a *visit* carrying it is a contradiction. That is enforced in
-- `BuildingsService.logVisit` rather than by a CHECK, because the enum is
-- shared and a constraint here would be a rule about this table stated in a
-- place that reads as a rule about the type.
--
-- == The officer is nullable and SetNull ===================================
--
-- A visit is a thing that happened. It stays true after the officer who made it
-- leaves the municipality, and cascading it away would delete the municipality's
-- evidence that a door was tried — which is precisely what a resident disputing
-- a notice asks for.
--
-- Written unqualified: the migrator sets `search_path` to the target tenant
-- schema before running this. Idempotent throughout, since a schema that failed
-- part-way must be safe to re-run.

-- ══════════════════════════════  unit_visits  ══════════════════════════════

CREATE TABLE IF NOT EXISTS "unit_visits" (
  "id"        UUID         NOT NULL DEFAULT gen_random_uuid(),
  "unitId"    UUID         NOT NULL,
  "officerId" UUID,
  "visitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "outcome"   "SurveyStatus" NOT NULL,
  "notes"     TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "unit_visits_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'unit_visits_unitId_fkey' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "unit_visits"
      ADD CONSTRAINT "unit_visits_unitId_fkey"
      FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'unit_visits_officerId_fkey' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "unit_visits"
      ADD CONSTRAINT "unit_visits_officerId_fkey"
      FOREIGN KEY ("officerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- `(unitId, visitedAt)` rather than `unitId` alone: every read of this table is
-- "this unit's attempts, newest first", and the count on a matrix cell is the
-- same query truncated.
CREATE INDEX IF NOT EXISTS "unit_visits_unitId_visitedAt_idx"
  ON "unit_visits" ("unitId", "visitedAt");

CREATE INDEX IF NOT EXISTS "unit_visits_officerId_idx"
  ON "unit_visits" ("officerId");

-- ════════════════════════  council decision (§7 Q1)  ════════════════════════
--
-- Optional, and the reason it is optional is the answer to Q1: internal
-- cadastral indexing and parcel-linked building numbering is already an
-- administrative and fiscal survey power. The codes are valid without a decree.
-- Where a council has passed one, a notice that cites it carries more weight;
-- where it has not, the notice cites the municipal survey authority instead.

ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "councilDecisionRef" TEXT;

-- 0049_quality_review
--
-- The second pair of eyes: a supervisor's decision on a filed record, a sample
-- of records re-checked by a different officer, and the answer «ليست مشكلة» to
-- a data-quality finding.
--
-- == Why now ===============================================================
--
-- Every field error between 2026-09-12 and 2026-09-16 — the merged brothers,
-- three records for one building, occupants carrying their landlord's phone —
-- was found by somebody reading the database days later. `REQUIRES_REVIEW`
-- existed as a status with no owner and no way back to the officer. These three
-- tables are the smallest thing that gives it both, and a measure of how often
-- a record is right when somebody else goes and looks.
--
-- == What is deliberately NOT stored =======================================
--
-- The findings themselves. "These two citizens look like one person", "this
-- occupant's phone is their landlord's" — each is derived live from the
-- register when the screen asks, exactly as landlord-link proposals are, so a
-- finding cannot go stale and needs no job to refresh it. Only a person's
-- answer about one is stored: `data_quality_dismissals`.
--
-- Nothing here touches officer pay. `getInspectorProfile` counts registrations
-- by `createdById` and none of these tables change which rows it counts.
--
-- == Deploy order ===========================================================
--
-- Additive only: three enums, three tables, their keys and indexes. Apply this
-- BEFORE deploying the code — Prisma selects these tables.
--
-- Written unqualified: the migrator sets `search_path` to the tenant schema and
-- wraps the file in one transaction. Idempotent throughout.

-- ═════════════════════════════════  enums  ═════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'RecordReviewOutcome' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "RecordReviewOutcome" AS ENUM ('APPROVED', 'RETURNED');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'QualityCheckStatus' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "QualityCheckStatus" AS ENUM ('OPEN', 'DONE');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'QualityCheckResult' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "QualityCheckResult" AS ENUM ('MATCHES', 'DIFFERS');
  END IF;
END
$$;

-- ══════════════════════════════  record_reviews  ══════════════════════════════
--
-- One row per decision, appended. A record returned, corrected and approved is
-- three rows — the history is the point. `resolvedAt` is the only column ever
-- written after insert: it closes a return when somebody saves the record.

CREATE TABLE IF NOT EXISTS "record_reviews" (
  "id"             UUID                  NOT NULL DEFAULT gen_random_uuid(),
  "registrationId" UUID                  NOT NULL,
  "outcome"        "RecordReviewOutcome" NOT NULL,
  "reason"         TEXT,
  "fields"         TEXT[]                NOT NULL DEFAULT '{}',
  "reviewedById"   UUID,
  "resolvedAt"     TIMESTAMP(3),
  "resolvedById"   UUID,
  "createdAt"      TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "record_reviews_pkey" PRIMARY KEY ("id"),
  -- A record sent back says why; an approval needs no sentence.
  CONSTRAINT "record_reviews_returned_reason" CHECK ("outcome" <> 'RETURNED' OR "reason" IS NOT NULL),
  -- Only a return is ever resolved.
  CONSTRAINT "record_reviews_resolved_return" CHECK ("resolvedAt" IS NULL OR "outcome" = 'RETURNED')
);

-- ══════════════════════════════  quality_checks  ══════════════════════════════
--
-- A filed record picked at random to be re-checked on the ground by somebody
-- other than the officer who filed it. The result says whether what they found
-- matched; it never edits the record — a correction is an ordinary edit.

CREATE TABLE IF NOT EXISTS "quality_checks" (
  "id"                UUID                 NOT NULL DEFAULT gen_random_uuid(),
  "registrationId"    UUID                 NOT NULL,
  "originalOfficerId" UUID,
  "sampledById"       UUID,
  "assignedToId"      UUID,
  "status"            "QualityCheckStatus" NOT NULL DEFAULT 'OPEN',
  "result"            "QualityCheckResult",
  "differences"       TEXT[]               NOT NULL DEFAULT '{}',
  "notes"             TEXT,
  "checkedById"       UUID,
  "checkedAt"         TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "quality_checks_pkey" PRIMARY KEY ("id"),
  -- Done means answered, and answered means done.
  CONSTRAINT "quality_checks_done_pair"
    CHECK (("status" = 'DONE') = ("result" IS NOT NULL) AND ("status" = 'DONE') = ("checkedAt" IS NOT NULL))
);

-- ═════════════════════════  data_quality_dismissals  ═════════════════════════
--
-- «ليست مشكلة» on a derived finding, with the reason. `subjectKey` names what
-- the finding was about (sorted ids), so the same finding recomputed tomorrow
-- is recognised as already answered.

CREATE TABLE IF NOT EXISTS "data_quality_dismissals" (
  "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "kind"          TEXT         NOT NULL,
  "subjectKey"    TEXT         NOT NULL,
  "reason"        TEXT         NOT NULL,
  "dismissedById" UUID,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "data_quality_dismissals_pkey" PRIMARY KEY ("id")
);

-- ═══════════════════════════════  foreign keys  ═══════════════════════════════
--
-- The record cascades: a review or a check of a registration that was deleted
-- is about nothing. People are `SET NULL`, as `UnitVisit.officer` is — the
-- decision stays true after they leave the municipality.

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('record_reviews', 'record_reviews_registrationId_fkey', 'registrationId', 'registrations', 'CASCADE'),
      ('record_reviews', 'record_reviews_reviewedById_fkey', 'reviewedById', 'users', 'SET NULL'),
      ('record_reviews', 'record_reviews_resolvedById_fkey', 'resolvedById', 'users', 'SET NULL'),
      ('quality_checks', 'quality_checks_registrationId_fkey', 'registrationId', 'registrations', 'CASCADE'),
      ('quality_checks', 'quality_checks_originalOfficerId_fkey', 'originalOfficerId', 'users', 'SET NULL'),
      ('quality_checks', 'quality_checks_sampledById_fkey', 'sampledById', 'users', 'SET NULL'),
      ('quality_checks', 'quality_checks_assignedToId_fkey', 'assignedToId', 'users', 'SET NULL'),
      ('quality_checks', 'quality_checks_checkedById_fkey', 'checkedById', 'users', 'SET NULL'),
      ('data_quality_dismissals', 'data_quality_dismissals_dismissedById_fkey', 'dismissedById', 'users', 'SET NULL')
    ) AS t(tbl, name, col, ref, on_delete)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = fk.name AND n.nspname = CURRENT_SCHEMA()
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I("id") ON DELETE %s ON UPDATE CASCADE',
        fk.tbl, fk.name, fk.col, fk.ref, fk.on_delete
      );
    END IF;
  END LOOP;
END
$$;

-- ═════════════════════════════════  indexes  ═════════════════════════════════

-- "This record's decisions, newest first."
CREATE INDEX IF NOT EXISTS "record_reviews_registrationId_createdAt_idx"
  ON "record_reviews" ("registrationId", "createdAt");

-- At most one open return per record: a second «إعادة» on a record already
-- waiting for its officer would be two conversations about one fix.
CREATE UNIQUE INDEX IF NOT EXISTS "record_reviews_open_return_key"
  ON "record_reviews" ("registrationId")
  WHERE "outcome" = 'RETURNED' AND "resolvedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "quality_checks_status_idx" ON "quality_checks" ("status");
CREATE INDEX IF NOT EXISTS "quality_checks_originalOfficerId_idx" ON "quality_checks" ("originalOfficerId");
CREATE INDEX IF NOT EXISTS "quality_checks_assignedToId_idx" ON "quality_checks" ("assignedToId");

-- A record is in the sample once: drawing again skips it rather than asking twice.
CREATE UNIQUE INDEX IF NOT EXISTS "quality_checks_registrationId_key"
  ON "quality_checks" ("registrationId");

CREATE UNIQUE INDEX IF NOT EXISTS "data_quality_dismissals_kind_subjectKey_key"
  ON "data_quality_dismissals" ("kind", "subjectKey");

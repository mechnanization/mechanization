-- 0027_cases
-- A field visit that could not become a citizen registration (nobody home,
-- gate locked, access refused...) so whatever staff could observe about the
-- property is recorded here instead of being lost before the next visit.
-- Deliberately not linked to a Registration or a PropertyEntry: there is no
-- citizen to attach either to yet.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'CaseStatus' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "CaseStatus" AS ENUM ('OPEN', 'RESOLVED');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "cases" (
    "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
    "notes"          TEXT         NOT NULL,
    "propertyNumber" TEXT,
    "neighborhood"   TEXT,
    "propertyType"   "PropertyType",
    "buildingName"   TEXT,
    "floor"          TEXT,
    "side"           TEXT,
    "landType"       "LandType",
    "tentLocation"   TEXT,
    "status"         "CaseStatus"  NOT NULL DEFAULT 'OPEN',
    "createdById"    UUID,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cases_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cases_createdById_fkey'
  ) THEN
    ALTER TABLE "cases"
      ADD CONSTRAINT "cases_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "cases_status_idx" ON "cases"("status");
CREATE INDEX IF NOT EXISTS "cases_propertyNumber_idx" ON "cases"("propertyNumber");

-- 0029_case_resolution_link
-- The bridge from a logged case to the citizen whose eventual registration
-- resolved it — so "did this case turn into a registration" is a query
-- against the register instead of something kept in someone's memory.

ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "resolvedCitizenId" UUID;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cases_resolvedCitizenId_fkey'
  ) THEN
    ALTER TABLE "cases"
      ADD CONSTRAINT "cases_resolvedCitizenId_fkey"
      FOREIGN KEY ("resolvedCitizenId") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "cases_resolvedCitizenId_idx" ON "cases"("resolvedCitizenId");

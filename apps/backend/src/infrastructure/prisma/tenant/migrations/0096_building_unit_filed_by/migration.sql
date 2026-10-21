-- 0096_building_unit_filed_by
--
-- == What it is for ==
--
-- Who filed each unit line. An inspector is paid $1 per distinct unit he filed
-- (`creditBillableUnits`), and until now the only officer the database knew was
-- the one on the registration: `registrations.createdById`. Every line added to a
-- file later — an owner recorded on the matrix (`claimOnFile`), an owner link
-- (`LandlordLinkService.confirm`), a flat added on the edit form — was paid to
-- whoever registered that citizen first, not to the officer who did the work.
-- Measured on production 2026-10-21 (a dry run of 0097): 191 lines, moving
-- officers' totals by between −42 and +61 units. One of them: an officer recorded
-- the owner of a building, a flat and a warehouse, on 2026-10-06, and both dollars
-- went to the officer who had registered that owner as a tenant elsewhere on
-- 2026-09-25.
--
-- `building_units.filedById`: the staff member who created the line. Written by
-- every path that creates one from this release on. NULL means "the officer of
-- the registration the card was filed on", which is exactly how every line was
-- read before this column existed, so a NULL is never a lost credit.
--
-- The lines already on file are filled in by 0097, from the audit trail. This
-- file only adds the column.
--
-- == Safety ==
--
-- Additive: one nullable column with no default (no table rewrite), its index,
-- and its foreign key. Nothing reads the column until the code that ships after
-- it, and the previous build ignores it, so a rollback is a redeploy.
--
-- ON DELETE RESTRICT, as for the staff columns of 0091: a staff account is
-- soft-deleted (`users.deletedAt`, 0065), and a hard delete of somebody who filed
-- paid work must fail rather than quietly re-credit that work to someone else.
--
-- Locks, held until the file commits: ACCESS EXCLUSIVE on `building_units`
-- (2,300 lines at the largest municipality on 2026-10-15; the ADD COLUMN is
-- catalog-only, the index build and the foreign key's check of an all-NULL
-- column take well under a second), and SHARE ROW EXCLUSIVE on `users` from the
-- foreign key, so writes to `users` (a staff presence stamp included) wait for
-- the file, as with 0091. The index is built without CONCURRENTLY for that size
-- (the migrator wraps each file in a transaction; docs/database.md).
--
-- Unqualified DDL (the migrator sets `search_path`); the catalog guard filters
-- on CURRENT_SCHEMA(); idempotent.

ALTER TABLE "building_units" ADD COLUMN IF NOT EXISTS "filedById" UUID;

CREATE INDEX IF NOT EXISTS "building_units_filedById_idx" ON "building_units" ("filedById");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'building_units_filedById_fkey' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "building_units" ADD CONSTRAINT "building_units_filedById_fkey"
      FOREIGN KEY ("filedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

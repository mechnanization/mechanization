-- 0072_users_no_phone_rules
--
-- «لا يملك رقم هاتف» and «رقم للتواصل» (0069), as rules the table keeps.
--
-- == What it is for ======================================================
--
-- 0069 added the two columns and left their meaning to application code.
-- Two writers kept it (the citizen form's save and the registration
-- repository); a third did not — «دمج ملفين» refilled a relative's number into
-- `phone` on a file marked «لا يملك رقم هاتف», which put the number back in
-- the identity column the feature exists to take it out of: citizen sign-in
-- offered the father's file to the son again. That writer is fixed in the same
-- release; these make the next one unable to repeat it (docs/database.md:
-- CHECKs live in the database, not in a prior read).
--
--   users_no_phone_means_no_number   a person with no phone of their own has
--                                    no `phone` and no `whatsapp`.
--   users_contact_phone_not_own      «رقم للتواصل» is somebody else's number,
--                                    so it is never the person's own `phone`.
--
-- Both hold trivially for staff rows (`hasNoPhone` false, `contactPhone`
-- NULL).
--
-- == Safety ==============================================================
--
-- Additive: two CHECKs, no column, no row rewritten. Every existing row
-- passes them. Production reaches 0069 in the same release as this, so every
-- row there has `hasNoPhone` false and `contactPhone` NULL. Staging is
-- migrated by CI and is not the database the deployed API serves
-- (docs/database-environments.md §3), so no code that writes the two columns
-- has run against it and the same holds there. If a row did break a rule, the
-- migration would fail and roll back whole, and the deploy would stop before
-- any code shipped. The previous build never writes either column, so nothing
-- it does can be refused. A rollback is a redeploy.
--
-- Validated in place rather than NOT VALID + VALIDATE: the scan is over
-- `users`, a municipality's few thousand rows, and holds its lock for as long
-- as that read takes, inside the deploy window this migration already runs in.
--
-- The guards filter on CURRENT_SCHEMA() (see 0050). Idempotent.
--
-- Written unqualified: the migrator sets `search_path` to the tenant schema.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE c.conname = 'users_no_phone_means_no_number'
       AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_no_phone_means_no_number"
      CHECK (NOT "hasNoPhone" OR ("phone" IS NULL AND "whatsapp" IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE c.conname = 'users_contact_phone_not_own'
       AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_contact_phone_not_own"
      CHECK ("contactPhone" IS NULL OR "phone" IS NULL OR "contactPhone" <> "phone");
  END IF;
END
$$;

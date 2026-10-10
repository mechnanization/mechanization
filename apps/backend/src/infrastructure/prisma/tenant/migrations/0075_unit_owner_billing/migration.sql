-- 0075_unit_owner_billing
--
-- «توزيع الرسم على المالكين» — how a flat held by several owners is billed.
--
-- == What it is for ======================================================
--
-- A flat routinely has several owners: Lebanese inheritance makes co-heirs on
-- one deed the normal case, which is why `unit_occupancies` is a join table and
-- why its OWNER rows already carry أسهم (`shares`, out of 2400). Billing never
-- read either fact. Each co-owner's own file claims the flat, and the
-- assessment runs one citizen at a time, so every owner-borne charge — and the
-- occupancy charge when the owners themselves use the flat — was billed to
-- every co-owner in full. The production audit of 2026-10-07 found it on
-- A2-420-A/0005, a 300 m² shop four brothers own: charged four times over.
--
-- The user's decision (2026-10-07): the officer chooses, per flat, one of
--
--   EQUAL              «بالتساوي بين المالكين» — each of N owners pays 1/N;
--   BY_SHARES          «حسب الأسهم» — each owner pays their أسهم over the sum
--                      of every current owner's أسهم;
--   RESPONSIBLE_OWNER  «مالك مسؤول» — one owner, named here, pays the whole;
--                      the others are not charged for this flat.
--
-- and a co-owned flat nobody has chosen for is split equally. NULL in
-- "ownerBillingMode" is that default; a value is an officer's explicit choice,
-- kept even while the flat has one owner so it applies again if a co-owner is
-- recorded later.
--
--   "responsibleOwnerId"  the owner who pays under RESPONSIBLE_OWNER. Points at
--                         `users`, SET NULL on delete. Whether that person is a
--                         current owner of the flat is a fact about other rows,
--                         checked by the code that writes it and re-checked by
--                         billing, which falls back to the equal split if not.
--
-- == The rule, in the database ===========================================
--
--   units_responsible_owner_needs_mode  a responsible owner is named only
--                                       under RESPONSIBLE_OWNER. This
--                                       direction survives the FK's SET NULL;
--                                       the converse (RESPONSIBLE_OWNER names
--                                       someone) cannot, so it lives in the
--                                       request schema and in billing.
--
-- == Safety ==============================================================
--
-- Additive: a new type, two nullable columns with no default (no table
-- rewrite), one FK, one CHECK every existing row passes (both columns are NULL),
-- and an index on the new FK column. `units` holds one row per flat in the
-- town (≈1,400 in production on 2026-10-07); building the index locks it for
-- as long as reading it, a fraction of a second. No row is rewritten.
--
-- The build serving production when this lands never reads or writes either
-- column, so it keeps working unchanged. A rollback is a redeploy.
--
-- `CREATE TYPE` is transaction-safe and its values may be used in the same
-- transaction (only `ALTER TYPE … ADD VALUE` may not). Catalog guards filter
-- on CURRENT_SCHEMA() (see 0050). Idempotent.
--
-- Written unqualified: the migrator sets `search_path` to the tenant schema.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'OwnerBillingMode' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "OwnerBillingMode" AS ENUM ('EQUAL', 'BY_SHARES', 'RESPONSIBLE_OWNER');
  END IF;
END
$$;

ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "ownerBillingMode" "OwnerBillingMode";
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "responsibleOwnerId" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'units_responsibleOwnerId_fkey' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    -- SET NULL, as for every officer and citizen a unit row points at: the
    -- flat outlives the person, and billing falls back to the equal split.
    ALTER TABLE "units"
      ADD CONSTRAINT "units_responsibleOwnerId_fkey"
      FOREIGN KEY ("responsibleOwnerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'units_responsible_owner_needs_mode' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "units"
      ADD CONSTRAINT "units_responsible_owner_needs_mode"
      -- IS NOT DISTINCT FROM, not `=`: a CHECK passes on NULL, and
      -- `NULL = 'RESPONSIBLE_OWNER'` is NULL, so `=` would let a responsible
      -- owner stand on a flat with no method chosen.
      CHECK ("responsibleOwnerId" IS NULL OR "ownerBillingMode" IS NOT DISTINCT FROM 'RESPONSIBLE_OWNER');
  END IF;
END
$$;

-- Index lock: see Safety above (one row per flat, ≈1,400 rows).
CREATE INDEX IF NOT EXISTS "units_responsibleOwnerId_idx" ON "units" ("responsibleOwnerId");

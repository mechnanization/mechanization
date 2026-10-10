-- 0077_unit_fee_exemption
--
-- «معفاة من الرسوم» — a flat the municipality does not charge, and why.
--
-- == What it is for ======================================================
--
-- Some units in the census are not billable whoever owns or uses them: the
-- mosque itself on a waqf parcel, the municipality's own hall, a public
-- school. The user's decision (2026-10-07): the mosque is EXEMPT («معفى»),
-- while a shop the waqf rents out is billed to its tenant as usual.
--
-- So the exemption belongs to the unit, not to the owner and not to a status:
--
--   - not to the owner, because a waqf that owns a mosque and a rented shop is
--     exempt on the first and must still see its tenant billed on the second;
--   - not to `unitStatus`, which says who occupies the flat. A rented waqf
--     shop is «مؤجرة» and must stay so for the tenant to be billed, and the
--     status feeds the census, the review rule and the matrix.
--
-- Columns, all NULL on a unit that is billed normally:
--
--   "feeExemption"      why: PLACE_OF_WORSHIP «دار عبادة», PUBLIC_FACILITY
--                       «مرفق عام», OTHER «سبب آخر» (with a written reason).
--   "feeExemptionNote"  the reason in words; required under OTHER.
--   "feeExemptedById"   who granted it (SET NULL on delete: the decision
--                       stands after the person leaves).
--   "feeExemptedAt"     when.
--
-- An exempt unit is charged nothing — no occupant-borne and no owner-borne fee
-- — by any rate-based notice. Granting and lifting it are audited.
--
-- == The rules, in the database ==========================================
--
--   units_fee_exemption_fields     the reason, who and when are set together,
--                                  and nothing is left behind when it is lifted.
--   units_fee_exemption_other_note «سبب آخر» carries its reason in words.
--
-- == Safety ==============================================================
--
-- Additive: a new type, four nullable columns with no default (no table
-- rewrite), one FK, two CHECKs every existing row passes (all four columns are
-- NULL). No index on "feeExemptedById": it is read only by joining from a unit
-- the reader already has, never searched by. No row is rewritten.
--
-- The build serving production when this lands never reads or writes these
-- columns, so it keeps working unchanged. A rollback is a redeploy.
--
-- `CREATE TYPE` is transaction-safe and its values may be used in the same
-- transaction (only `ALTER TYPE … ADD VALUE` may not), which is why the CHECK
-- below may name 'OTHER'. Catalog guards filter on CURRENT_SCHEMA() (see 0050).
-- Idempotent.
--
-- Written unqualified: the migrator sets `search_path` to the tenant schema.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'FeeExemptionReason' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "FeeExemptionReason" AS ENUM ('PLACE_OF_WORSHIP', 'PUBLIC_FACILITY', 'OTHER');
  END IF;
END
$$;

ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "feeExemption" "FeeExemptionReason";
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "feeExemptionNote" TEXT;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "feeExemptedById" UUID;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "feeExemptedAt" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'units_feeExemptedById_fkey' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "units"
      ADD CONSTRAINT "units_feeExemptedById_fkey"
      FOREIGN KEY ("feeExemptedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'units_fee_exemption_fields' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    -- Granted: a reason and a date (the grantor may later be SET NULL).
    -- Lifted: nothing left behind.
    ALTER TABLE "units"
      ADD CONSTRAINT "units_fee_exemption_fields"
      CHECK (
        ("feeExemption" IS NULL) = ("feeExemptedAt" IS NULL)
        AND ("feeExemption" IS NOT NULL OR ("feeExemptionNote" IS NULL AND "feeExemptedById" IS NULL))
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'units_fee_exemption_other_note' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "units"
      ADD CONSTRAINT "units_fee_exemption_other_note"
      CHECK ("feeExemption" IS DISTINCT FROM 'OTHER' OR btrim(coalesce("feeExemptionNote", '')) <> '');
  END IF;
END
$$;

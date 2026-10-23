-- 0099_tiered_fee_matrix
--
-- The bracket table of a TIERED_AREA notice, and the shared unit bill.
--
-- == What it is for ======================================================
--
-- Decisions of 2026-10-23, docs/fees-system-rearchitecture-specification.md §1.
--
--   fee_notices."matrixBrackets"    the bracket table of a TIERED_AREA notice
--                                   (code, label, unit types, level count, area
--                                   range, amount). Validated in full by
--                                   `feeMatrixSchema` in shared-schemas; the
--                                   database only holds it to the basis and to
--                                   a non-empty array.
--
--   citizen_payments."unitId"       set on a **shared unit bill** and nowhere
--                                   else. Under TIERED_AREA, a unit the bearer
--                                   rule charges to two or more citizens (its
--                                   co-owners, or its co-tenants) is billed once,
--                                   in full, not split (D5). The bill belongs to
--                                   the unit: `citizenId` is NULL on it, and the
--                                   people who may pay it are its debtors.
--
--   citizen_payment_debtors         who may pay a shared unit bill: everyone the
--                                   bearer rule charged for the unit **when the
--                                   bill was raised**, written then, like
--                                   `assessment`. The bill shows on each of their
--                                   profiles; any of them may pay it; once paid it
--                                   is paid for all of them, and until then it
--                                   holds back براءة ذمة for all of them.
--
--   payment_transactions."paidByCitizenId"
--                                   on a shared bill, which debtor the money came
--                                   from, for the receipt. NULL on every other
--                                   transaction. Written with the row: the ledger
--                                   is append-only (0017). That it names one of
--                                   the bill's debtors is checked by the code.
--
-- Every bill that exists today is a citizen's own bill and stays exactly as it
-- is: a `citizenId`, no `unitId`, guarded against double billing by the unique
-- index it has always had (`citizen_payments_citizenId_feeNoticeId_periodKey_key`,
-- 0010). Shared bills have a NULL `citizenId`, so that index never sees them;
-- they get their own (`citizen_payments_unitId_feeNoticeId_periodKey_key`).
--
-- == The rules, in the database ==========================================
--
--   fee_notices_matrix_brackets_basis   brackets exactly when the basis is
--                                       TIERED_AREA (the value 0098 added).
--   fee_notices_matrix_brackets_array   a non-empty JSON array.
--   citizen_payments_citizen_or_unit    a bill belongs to one citizen or to one
--                                       unit: never both, never neither.
--   citizen_payments_unit_bill_notice   a shared bill comes from a notice. Notices
--                                       are never deleted, so the notice link's
--                                       ON DELETE SET NULL never meets this.
--
-- == Safety ==============================================================
--
-- Additive. New columns are nullable with no default, so no row is rewritten.
-- The one constraint relaxed is `citizen_payments."citizenId"` NOT NULL, and no
-- row has a NULL until the code that issues shared bills ships. Every existing
-- row passes the new CHECKs: no notice is TIERED_AREA and none has brackets;
-- every bill has a citizen and no unit.
--
-- Locks, held to this file's commit (docs/database.md, "How tenant migrations
-- run"): ACCESS EXCLUSIVE on `fee_notices`, `citizen_payments` and
-- `payment_transactions` for the ADD COLUMNs, the CHECKs' scan and the partial
-- unique index's build. Each holds a few thousand rows per municipality, so the
-- file runs in well under a second. The partial index covers no existing row
-- (`unitId` is NULL on all of them).
--
-- No index on `payment_transactions."paidByCitizenId"`, deliberately: it would
-- be built on the live ledger inside the migrator's transaction. The column is
-- read through its bill, never searched by; the only lookup by it is the
-- RESTRICT check when a user row is deleted, which the code never does to a
-- citizen with payments.
--
-- The build serving production when this lands never reads or writes these
-- columns or the table, so it keeps working unchanged; a rollback is a
-- redeploy. That stops being true once the code ships and writes a shared bill:
-- a build from before it has no idea a bill can lack a citizen. Roll back past
-- that release only with no shared bill issued, as for an enum value
-- (docs/gotchas.md, "The previous build cannot read a value it does not know").
--
-- Catalog guards filter on CURRENT_SCHEMA() (see 0050). Idempotent.
--
-- Written unqualified: the migrator sets `search_path` to the tenant schema.

-- ═══════════════════════════════  fee_notices  ═══════════════════════════════

ALTER TABLE "fee_notices" ADD COLUMN IF NOT EXISTS "matrixBrackets" JSONB;

-- ═════════════════════════════  citizen_payments  ═════════════════════════════

ALTER TABLE "citizen_payments" ADD COLUMN IF NOT EXISTS "unitId" UUID;

-- Idempotent as written: dropping a NOT NULL that is already gone is a no-op.
ALTER TABLE "citizen_payments" ALTER COLUMN "citizenId" DROP NOT NULL;

-- ═════════════════════════  citizen_payment_debtors  ═════════════════════════

CREATE TABLE IF NOT EXISTS "citizen_payment_debtors" (
  -- The shared bill. Its debtors go with it.
  "paymentId" UUID            NOT NULL,
  -- A citizen the bearer rule charged for the unit when the bill was raised.
  "citizenId" UUID            NOT NULL,
  -- In what capacity: OWNER, TENANT or FREE_OCCUPANT.
  "role"      "OccupancyRole" NOT NULL,
  "createdAt" TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "citizen_payment_debtors_pkey" PRIMARY KEY ("paymentId", "citizenId")
);

-- ═════════════════════════════  payment_transactions  ═════════════════════════

ALTER TABLE "payment_transactions" ADD COLUMN IF NOT EXISTS "paidByCitizenId" UUID;

-- ═══════════════════════════════  foreign keys  ═══════════════════════════════
--
-- A shared bill's unit is RESTRICT: a bill has to stay true to what it was
-- raised for. A debtor is RESTRICT: deleting a citizen must not quietly change
-- who owes a bill. The payer on a transaction is RESTRICT, as the ledger's other
-- user links are (0091). A debtor row goes with its bill (CASCADE), which the
-- append-only ledger already keeps from happening to any bill with money on it.

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('citizen_payments', 'citizen_payments_unitId_fkey', 'unitId', 'units', 'RESTRICT'),
      ('citizen_payment_debtors', 'citizen_payment_debtors_paymentId_fkey', 'paymentId', 'citizen_payments', 'CASCADE'),
      ('citizen_payment_debtors', 'citizen_payment_debtors_citizenId_fkey', 'citizenId', 'users', 'RESTRICT'),
      ('payment_transactions', 'payment_transactions_paidByCitizenId_fkey', 'paidByCitizenId', 'users', 'RESTRICT')
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

-- ═════════════════════════════════  checks  ══════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'fee_notices_matrix_brackets_basis' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "fee_notices"
      ADD CONSTRAINT "fee_notices_matrix_brackets_basis"
      CHECK (("basis" = 'TIERED_AREA') = ("matrixBrackets" IS NOT NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'fee_notices_matrix_brackets_array' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "fee_notices"
      ADD CONSTRAINT "fee_notices_matrix_brackets_array"
      CHECK (
        "matrixBrackets" IS NULL
        OR (jsonb_typeof("matrixBrackets") = 'array' AND jsonb_array_length("matrixBrackets") > 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'citizen_payments_citizen_or_unit' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "citizen_payments"
      ADD CONSTRAINT "citizen_payments_citizen_or_unit"
      CHECK (("citizenId" IS NULL) = ("unitId" IS NOT NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'citizen_payments_unit_bill_notice' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "citizen_payments"
      ADD CONSTRAINT "citizen_payments_unit_bill_notice"
      CHECK ("unitId" IS NULL OR "feeNoticeId" IS NOT NULL);
  END IF;
END
$$;

-- ═════════════════════════════════  indexes  ═════════════════════════════════

-- One shared bill per unit, per notice, per period: the double-billing guard
-- for shared bills, as the citizen index (0010) is for a citizen's own.
CREATE UNIQUE INDEX IF NOT EXISTS "citizen_payments_unitId_feeNoticeId_periodKey_key"
  ON "citizen_payments" ("unitId", "feeNoticeId", "periodKey")
  WHERE "unitId" IS NOT NULL;

-- The portal's read: the shared bills this citizen is a debtor on.
CREATE INDEX IF NOT EXISTS "citizen_payment_debtors_citizenId_idx"
  ON "citizen_payment_debtors" ("citizenId");

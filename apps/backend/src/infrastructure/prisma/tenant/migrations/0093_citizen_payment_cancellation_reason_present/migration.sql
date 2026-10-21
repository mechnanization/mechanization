-- 0093_citizen_payment_cancellation_reason_present
--
-- == What it is for ==
--
-- A bill's cancellation reason is never blank (the review of PR #119,
-- 2026-10-13). `0091_finance_audit_controls` made «سبب الإلغاء» move with the
-- rest of the cancellation stamp, but only as NOT NULL: '' or a run of spaces
-- passed. Every other reason column since 0060 refuses a blank one in the
-- database (the void reasons of 0074, 0078 and 0080, 0082's reopen and variance
-- reasons, 0083's urgent and decision reasons), and a cancelled bill stays on the
-- citizen's record with this as the only place its "why" lives.
-- `cancelBillSchema` already refuses a blank reason at the one writer
-- (`FeesService.cancelBill`); this makes the database say so too. 0091 is not
-- edited: it has been applied (docs/database.md, "Applied migrations are
-- immutable").
--
-- == Safety ==
--
-- Additive: one CHECK, no column, no rewrite. Needs `0091` (the column). Only
-- the finance audit remediation's code writes the column, and never a blank
-- value, so every existing row passes.
--
-- Locks. Adding the CHECK holds ACCESS EXCLUSIVE on `citizen_payments` while it
-- validates every row, until the file commits: one comparison per row, at most
-- tens of thousands of rows at the largest municipality today, well under a
-- second (as for 0091's two CHECKs on the same table).
--
-- Unqualified DDL (the migrator sets `search_path`); the catalog guard filters
-- on CURRENT_SCHEMA(); idempotent.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'citizen_payments_cancellation_reason_present' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "citizen_payments" ADD CONSTRAINT "citizen_payments_cancellation_reason_present"
      CHECK ("cancellationReason" IS NULL OR length(btrim("cancellationReason")) > 0);
  END IF;
END
$$;

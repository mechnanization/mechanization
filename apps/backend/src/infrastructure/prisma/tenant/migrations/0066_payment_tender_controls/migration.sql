-- 0066_payment_tender_controls
--
-- The controls a cash counter needs around 0064's tender columns.
--
-- == What it is for ======================================================
--
--   changeGiven            what was handed back, in the invoice's currency —
--                          a citizen pays a 1,500,000 ل.ل bill with $20 and
--                          gets the difference back in ليرة. `amount` stays
--                          the credit; the tender minus the change equals it.
--   officialExchangeRate   the municipality's rate (الإعدادات) at the moment of
--                          the payment, kept beside the rate actually used so
--                          an override is visible on the row itself.
--   adjustmentReason       why the rate differed from the official one, or why
--                          the payment is dated before the day it was entered.
--                          The server refuses either without one.
--   clientRequestId        one id per press of «سجّل الدفعة». A retry after a
--                          lost response finds the first row instead of
--                          booking the money twice.
--
-- == Safety ==============================================================
--
-- Additive only: four nullable columns, one unique index on a column that is
-- NULL on every existing row, one CHECK that every existing row passes (all
-- NULL). The previous build keeps working against this schema and a rollback
-- is a redeploy. Idempotent: every statement can run twice.
--
-- The index is built without CONCURRENTLY because the migrator wraps each
-- migration in a transaction. payment_transactions is small (one row per
-- receipt issued) and the lock lasts as long as the build.
--
-- The CHECK guard filters on CURRENT_SCHEMA(): a database-wide pg_constraint
-- guard silently skips every municipality after the first (see 0050).

ALTER TABLE "payment_transactions"
    ADD COLUMN IF NOT EXISTS "changeGiven"          DECIMAL(14,2),
    ADD COLUMN IF NOT EXISTS "officialExchangeRate" DECIMAL(18,6),
    ADD COLUMN IF NOT EXISTS "adjustmentReason"     TEXT,
    ADD COLUMN IF NOT EXISTS "clientRequestId"      UUID;

CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_clientRequestId_key"
    ON "payment_transactions" ("clientRequestId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE c.conname = 'payment_transactions_change_not_negative'
       AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "payment_transactions"
      ADD CONSTRAINT "payment_transactions_change_not_negative"
      CHECK ("changeGiven" IS NULL OR "changeGiven" >= 0);
  END IF;
END
$$;

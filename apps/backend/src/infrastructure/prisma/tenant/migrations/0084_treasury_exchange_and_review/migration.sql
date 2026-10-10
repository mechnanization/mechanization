-- 0084_treasury_exchange_and_review
--
-- المناقلات والمصارفة — a transfer between any two of the municipality's
-- wallets, its fee, a currency exchange, and the auditor's review of the
-- exchanges that need one. Design: docs/finance.md §6.
--
-- 0078 created `treasury_transfers` with the columns an exchange needs (the
-- rate, the official rate beside it, the reason they differ) and wired only
-- the collector handover. This adds what the rest of §6 needs.
--
-- == On `treasury_transfers` ==============================================
--
--   feeAmount         what a bank or Whish charged for the move, in the
--                     source's currency. The source loses amount + fee.
--   feeVoucherId      the «PV-» voucher under «رسوم تحويل ومصرفية» that books
--                     the fee, written in the same transaction. The fee is
--                     money spent, so it lives where spending lives: the
--                     expense register, its ledger entry and its audit row.
--                     Both set or both NULL; one voucher per transfer.
--   moneyChangerName  the صرّاف an exchange went through. Free text; an
--                     exchange only.
--   backdateReason    why a transfer is dated before the day it was written.
--                     Not `adjustmentReason`: that column (0078) is why the
--                     rate used differs from the official one, and one column
--                     with two meanings is a register nobody can read.
--   requiresReview    set when the exchange is booked, by the server: the
--                     rate strays beyond the tolerance, there was no official
--                     rate to compare it with, or the amount is large. The
--                     money moves regardless — counter work is never frozen —
--                     and the flag waits for an auditor (§6.3).
--   reviewedAt / reviewedById / reviewNote
--                     the review stamp. Only a flagged transfer takes one, and
--                     the two halves move together.
--
-- == On `system_settings` =================================================
--
--   exchangeRateTolerancePercent  how far an exchange's rate may stray from
--                                 the official one before it needs a written
--                                 reason and a review. Default 3 (§6.3).
--   largeExchangeThreshold        above this, on the side of the exchange that
--                                 is not the base currency (the dollars, in
--                                 practice), an exchange is reviewed whatever
--                                 its rate. Default 1000.
--
-- Both NOT NULL with a default: there is always a rule, and the manager
-- changes it in الإعدادات. A constant default is a catalog change only in
-- Postgres 11+, so the production row is not rewritten.
--
-- == Safety ===============================================================
--
-- Additive only: nullable columns, two NOT NULL columns with constant
-- defaults, CHECKs every existing row already satisfies (all new columns are
-- NULL or false on them), two foreign keys and their indexes. Nothing is read
-- or rewritten, and the previous build — which names none of these — keeps
-- working; a rollback is a redeploy. Idempotent throughout; catalog guards
-- filter on CURRENT_SCHEMA() (0050). `treasury_transfers` comes from 0078,
-- which has not reached production, so its indexes build on a table of a few
-- rows; `system_settings` is one row.
--
-- RESTRICT on both keys: a voucher is voided, never deleted, and a reviewer
-- stays on the record of what they reviewed.
--
-- Needs 0074 (`expense_vouchers`) and 0078. Numbered 0084: 0083 is the
-- inspector payout's, and no local or remote branch held an 0084 on
-- 2026-10-10; check again before the PR.

ALTER TABLE "treasury_transfers" ADD COLUMN IF NOT EXISTS "feeAmount" DECIMAL(14,2);
ALTER TABLE "treasury_transfers" ADD COLUMN IF NOT EXISTS "feeVoucherId" UUID;
ALTER TABLE "treasury_transfers" ADD COLUMN IF NOT EXISTS "moneyChangerName" TEXT;
ALTER TABLE "treasury_transfers" ADD COLUMN IF NOT EXISTS "backdateReason" TEXT;
ALTER TABLE "treasury_transfers" ADD COLUMN IF NOT EXISTS "requiresReview" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "treasury_transfers" ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMPTZ(3);
ALTER TABLE "treasury_transfers" ADD COLUMN IF NOT EXISTS "reviewedById" UUID;
ALTER TABLE "treasury_transfers" ADD COLUMN IF NOT EXISTS "reviewNote" TEXT;

ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "exchangeRateTolerancePercent" DECIMAL(5,2) NOT NULL DEFAULT 3;
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "largeExchangeThreshold" DECIMAL(14,2) NOT NULL DEFAULT 1000;

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('treasury_transfers', 'treasury_transfers_fee_positive',
         'CHECK ("feeAmount" IS NULL OR "feeAmount" > 0)'),
      -- The fee and the voucher that books it exist together or not at all.
      ('treasury_transfers', 'treasury_transfers_fee_iff_voucher',
         'CHECK (("feeAmount" IS NULL) = ("feeVoucherId" IS NULL))'),
      ('treasury_transfers', 'treasury_transfers_changer_only_exchange',
         'CHECK ("moneyChangerName" IS NULL OR "fromCurrency" <> "toCurrency")'),
      -- Both halves of the stamp together, only on a flagged transfer, and a note only with a stamp.
      ('treasury_transfers', 'treasury_transfers_review_stamp',
         'CHECK ((("reviewedAt" IS NULL) = ("reviewedById" IS NULL))
            AND ("reviewedAt" IS NULL OR "requiresReview")
            AND ("reviewNote" IS NULL OR "reviewedAt" IS NOT NULL))'),
      ('treasury_transfers', 'treasury_transfers_feeVoucherId_fkey',
         'FOREIGN KEY ("feeVoucherId") REFERENCES "expense_vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('treasury_transfers', 'treasury_transfers_reviewedById_fkey',
         'FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('system_settings', 'system_settings_exchange_tolerance_range',
         'CHECK ("exchangeRateTolerancePercent" >= 0 AND "exchangeRateTolerancePercent" <= 100)'),
      ('system_settings', 'system_settings_large_exchange_positive',
         'CHECK ("largeExchangeThreshold" > 0)')
    ) AS t(tbl, name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
      WHERE k.conname = c.name AND n.nspname = CURRENT_SCHEMA()
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', c.tbl, c.name, c.definition);
    END IF;
  END LOOP;
END
$$;

-- One transfer per fee voucher; also the index its foreign key needs.
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_transfers_feeVoucherId_key"
  ON "treasury_transfers" ("feeVoucherId");

CREATE INDEX IF NOT EXISTS "treasury_transfers_reviewedById_idx"
  ON "treasury_transfers" ("reviewedById");

-- «بانتظار المراجعة», newest first: the auditor's queue.
CREATE INDEX IF NOT EXISTS "treasury_transfers_review_pending_idx"
  ON "treasury_transfers" ("occurredAt" DESC)
  WHERE "requiresReview" AND "reviewedAt" IS NULL;

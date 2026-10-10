-- 0078_treasury_transfers
--
-- المناقلات — money moving between the municipality's own wallets, and the
-- first thing it is for: «تسليم صندوق الجابي», the collector handing in the
-- cash he has been carrying. Design: docs/finance.md §6.
--
-- == The gap this closes ==================================================
--
-- A citizen who pays a collector at his door has his invoice settled and the
-- money credited to that collector's `COLLECTOR_CUSTODY` wallet (0073) — in
-- his pocket, not in the safe, which is the whole reason custody exists. Until
-- now there was no way to get it out again: the cash came back to the
-- municipality at the end of the round and the books had nowhere to put it.
-- This is that step, and it is a transfer like any other.
--
-- == One table for every move between wallets =============================
--
-- A handover is a transfer from a custody wallet to the safe. A Whish cash-out,
-- a bank deposit, a float for petty cash and a currency exchange are the same
-- act with different ends, so they share this table rather than each getting
-- one. The columns the later kinds need are here and nullable: `receivedAmount`
-- differs from `amount` only across currencies, and the two rates plus
-- `adjustmentReason` are what an exchange has to show. Today only the
-- same-currency path is wired.
--
-- The money itself is not here. It is two rows in `treasury_entries`, which is
-- append-only and is what a balance is the sum of; this table is the document
-- that explains them, exactly as `expense_vouchers` is for an expense.
--
-- == Safety ===============================================================
--
-- Additive only: one sequence, one new empty table. Nothing existing is read or
-- rewritten, the previous build keeps working against this schema, and a
-- rollback is a redeploy. Idempotent throughout; every catalog guard filters on
-- CURRENT_SCHEMA() (see 0050). Needs 0073 for `treasury_accounts` and the
-- (id, currency) key the foreign keys point at.
--
-- Numbered 0078, not 0075: `chore/migration-0075-0077` holds 0075–0077. Check
-- every branch before picking, and again before the PR.

-- ═══════════════════════════════  numbering  ═══════════════════════════════
--
-- A sequence, for the reason the receipt and voucher books have one: two
-- clerks recording at the same moment would otherwise read the same maximum
-- and print one number on two different movements.
CREATE SEQUENCE IF NOT EXISTS "treasury_transfer_seq" START 1;

-- ═══════════════════════════════  transfers  ═══════════════════════════════

CREATE TABLE IF NOT EXISTS "treasury_transfers" (
  "id"             UUID           NOT NULL DEFAULT gen_random_uuid(),
  -- Printed on the «سند مناقلة».
  "transferNumber" TEXT           NOT NULL,

  -- Where it left, and what arrived. Each paired with its currency, so the
  -- foreign key itself refuses a leg drawn on a wallet of another currency.
  "fromAccountId"  UUID           NOT NULL,
  "fromCurrency"   TEXT           NOT NULL,
  "toAccountId"    UUID           NOT NULL,
  "toCurrency"     TEXT           NOT NULL,

  -- What left the source, and what reached the destination. Equal on a
  -- same-currency move; an exchange is the case where they differ.
  "amount"         DECIMAL(14,2)  NOT NULL,
  "receivedAmount" DECIMAL(14,2)  NOT NULL,

  -- An exchange's rate, the municipality's own rate beside it, and why they
  -- differ. All NULL on a same-currency transfer.
  "exchangeRate"         DECIMAL(18,6),
  "officialExchangeRate" DECIMAL(18,6),
  "adjustmentReason"     TEXT,

  -- Why the money moved: «تسليم صندوق الجابي», «سحب من Whish».
  "description"    TEXT           NOT NULL,

  "occurredAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "recordedById"   UUID,
  -- One id per press of the button, so a retry does not move the money twice.
  "clientRequestId" UUID,

  -- The cancellation stamp, as on a voucher: a transfer is never edited.
  "voidedAt"       TIMESTAMPTZ(3),
  "voidedById"     UUID,
  "voidReason"     TEXT,

  "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

  CONSTRAINT "treasury_transfers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "treasury_transfers_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "treasury_transfers_received_positive" CHECK ("receivedAmount" > 0),
  CONSTRAINT "treasury_transfers_description_present" CHECK (length(btrim("description")) > 0),
  -- Money cannot move to where it already is.
  CONSTRAINT "treasury_transfers_distinct_ends" CHECK ("fromAccountId" <> "toAccountId"),
  -- Same currency in and out means the same figure; a different one needs a rate.
  CONSTRAINT "treasury_transfers_rate_iff_exchange" CHECK (
    ("fromCurrency" = "toCurrency" AND "amount" = "receivedAmount" AND "exchangeRate" IS NULL)
    OR ("fromCurrency" <> "toCurrency" AND "exchangeRate" IS NOT NULL AND "exchangeRate" > 0)
  ),
  CONSTRAINT "treasury_transfers_void_complete" CHECK (
    ("voidedAt" IS NULL AND "voidReason" IS NULL)
    OR ("voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL AND length(btrim("voidReason")) > 0)
  )
);

-- ═══════════════════════════════  foreign keys  ════════════════════════════
--
-- RESTRICT throughout, as on the ledger and the vouchers: a wallet that has
-- moved money, and the person who moved it, cannot be erased from the record.

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('treasury_transfers', 'treasury_transfers_from_fkey',
         'FOREIGN KEY ("fromAccountId", "fromCurrency") REFERENCES "treasury_accounts"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT'),
      ('treasury_transfers', 'treasury_transfers_to_fkey',
         'FOREIGN KEY ("toAccountId", "toCurrency") REFERENCES "treasury_accounts"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT'),
      ('treasury_transfers', 'treasury_transfers_recordedById_fkey',
         'FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('treasury_transfers', 'treasury_transfers_voidedById_fkey',
         'FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE')
    ) AS t(tbl, name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = fk.name AND n.nspname = CURRENT_SCHEMA()
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', fk.tbl, fk.name, fk.definition);
    END IF;
  END LOOP;
END
$$;

-- ═════════════════════════════════  indexes  ═══════════════════════════════
--
-- All on a new, empty table, so none of them locks anything live.

CREATE UNIQUE INDEX IF NOT EXISTS "treasury_transfers_transferNumber_key"
  ON "treasury_transfers" ("transferNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_transfers_clientRequestId_key"
  ON "treasury_transfers" ("clientRequestId");

-- «ما نُقل هذا الشهر», newest first.
CREATE INDEX IF NOT EXISTS "treasury_transfers_occurredAt_idx"
  ON "treasury_transfers" ("occurredAt" DESC);
-- What a collector has handed in, and what a wallet has received.
CREATE INDEX IF NOT EXISTS "treasury_transfers_from_idx"
  ON "treasury_transfers" ("fromAccountId", "occurredAt" DESC);
CREATE INDEX IF NOT EXISTS "treasury_transfers_to_idx"
  ON "treasury_transfers" ("toAccountId", "occurredAt" DESC);
CREATE INDEX IF NOT EXISTS "treasury_transfers_recordedById_idx"
  ON "treasury_transfers" ("recordedById");

-- 0085_payment_settlements
--
-- «تسديد عدة فواتير» — one citizen settling several bills in one act at the
-- counter, and the «وصل قبض بلدي مجمّع» that says so. Design: docs/finance.md
-- §3.7.
--
-- == What it is for =======================================================
--
--   payment_settlements          one press of «تسديد الفواتير المحددة»: whose
--                                bills, how they were paid, the notes handed
--                                over and the change handed back, the master
--                                number printed on the consolidated receipt,
--                                and the retry key of the press.
--   payment_transactions         unchanged in meaning. Each bill settled still
--     ."settlementId"            gets its own row and its own «RCP-» number, so a
--                                reprint, a reversal, a collector's round and the
--                                treasury's entries keep working bill by bill. The
--                                new column says which settlement a row belongs
--                                to; NULL on every row settled one bill at a time.
--
-- Why a table and not only the column: the retry key. `payment_transactions.
-- "clientRequestId"` is unique per row, and one press settles up to fifty rows,
-- so the press's key cannot live on any of them. It lives here, once. The
-- notes handed over live here too: they paid the whole set, not any one bill.
--
-- == Append-only ==========================================================
--
-- A settlement is a record of money taken, like the ledger rows it groups, so
-- UPDATE and DELETE are refused at the database, with the ledger's own
-- reasoning (0017). A mistake is corrected by reversing a bill's row in the
-- ledger, which leaves the settlement on the record beside its correction.
-- Rows point at the settlement from the moment they are inserted: the service
-- writes the settlement first, so no row ever needs an UPDATE to join one.
--
-- Not covered: TRUNCATE (docs/database.md).
--
-- == Numbering ============================================================
--
-- «BRC-2610-0001», drawn from `document_counters` (0079) under the kind
-- 'BULK_RECEIPT'. That column is text, so the new book needs no DDL here.
--
-- == Safety ===============================================================
--
-- Additive only. One new empty table; one nullable column with no default on
-- `payment_transactions` (in production since 0017), which is a catalog change
-- and rewrites nothing; its foreign key and index. The foreign key is added NOT
-- VALID and then validated, so the check of existing rows (every one NULL) runs
-- under SHARE UPDATE EXCLUSIVE and does not block the counter. The index is
-- built without CONCURRENTLY, which the migrator cannot run (docs/database.md):
-- it holds writes on the ledger for as long as one municipality's receipts take
-- to scan, a few thousand rows today — the same judgement as 0066's index on
-- this table. Idempotent throughout. Written unqualified (the migrator sets
-- `search_path`), and every catalog guard filters on CURRENT_SCHEMA() (see 0050).
--
-- Not in `BackupService.TABLE_ORDER`, like `payment_transactions`: restore
-- already aborts for a municipality that has taken a payment (docs/database.md).
-- Not exposed by `scripts/db/setup-claude-ro.sql`, which lists its views by
-- name: the table names citizens.
--
-- Numbered 0085: the highest number on any branch was 0084
-- (`feat/treasury-transfers-and-exchange`), and 0083 is held twice — develop's
-- `0083_treasury_controls` and `feat/treasury-inspector-payouts-and-vouchers`'s
-- `0083_inspector_payout_voucher`. Checked against every remote branch after a
-- fetch on 2026-10-10; check again before the PR.

-- ═══════════════════════════════  settlements  ═════════════════════════════

CREATE TABLE IF NOT EXISTS "payment_settlements" (
  "id"                      UUID           NOT NULL DEFAULT gen_random_uuid(),
  -- Printed on the consolidated receipt. Drawn through `allocateDocumentNumbers`.
  "number"                  TEXT           NOT NULL,
  -- Whose bills. Every ledger row of the settlement belongs to a bill of this
  -- citizen; the service refuses a set that mixes two (BULK_SETTLE_CITIZEN_MISMATCH).
  "citizenId"               UUID           NOT NULL,

  "method"                  "PaymentMethod" NOT NULL,
  -- The محصّل who took the money, on a COLLECTOR settlement; NULL otherwise.
  "collectedById"           UUID,
  -- The Whish transfer's own number, on a WHISH_MONEY settlement; NULL otherwise.
  "externalRef"             TEXT,

  -- The notes handed over, on a CASH settlement: the municipality's own
  -- currency, and the second currency with the official rate they were taken at
  -- (base currency per one unit, as on the ledger). All NULL on the other two
  -- methods, which arrive as one sum per bill.
  "tenderedLocal"           DECIMAL(14,2),
  "tenderedForeign"         DECIMAL(14,2),
  "tenderedForeignCurrency" TEXT,
  "exchangeRate"            DECIMAL(18,4),
  -- Handed back to the citizen, in the municipality's own currency. The sum of
  -- the change on the settlement's ledger rows is the same figure.
  "changeGiven"             DECIMAL(14,2),

  "recordedById"            UUID,
  -- One id per press. NOT NULL: a retry after a lost response must find this
  -- settlement instead of settling the bills a second time.
  "clientRequestId"         UUID           NOT NULL,

  "occurredAt"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "createdAt"               TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

  CONSTRAINT "payment_settlements_pkey" PRIMARY KEY ("id"),
  -- The notes are the cash method's fact and nobody else's.
  CONSTRAINT "payment_settlements_tender_is_cash" CHECK (
    ("method" = 'CASH') = ("tenderedLocal" IS NOT NULL)
  ),
  CONSTRAINT "payment_settlements_tender_complete" CHECK (
    ("tenderedLocal" IS NULL AND "tenderedForeign" IS NULL AND "tenderedForeignCurrency" IS NULL
       AND "exchangeRate" IS NULL AND "changeGiven" IS NULL)
    OR ("tenderedLocal" IS NOT NULL AND "tenderedForeign" IS NOT NULL AND "changeGiven" IS NOT NULL)
  ),
  CONSTRAINT "payment_settlements_tender_not_negative" CHECK (
    "tenderedLocal" IS NULL
    OR ("tenderedLocal" >= 0 AND "tenderedForeign" >= 0 AND "changeGiven" >= 0
        AND ("tenderedLocal" > 0 OR "tenderedForeign" > 0))
  ),
  -- Foreign notes carry their currency, and none carry none.
  CONSTRAINT "payment_settlements_foreign_currency" CHECK (
    "tenderedForeign" IS NULL
    OR ("tenderedForeign" = 0) = ("tenderedForeignCurrency" IS NULL)
  ),
  CONSTRAINT "payment_settlements_rate_positive" CHECK ("exchangeRate" IS NULL OR "exchangeRate" > 0),
  -- Each method's one auditable fact, as on `settlePaymentSchema`.
  CONSTRAINT "payment_settlements_collector_named" CHECK (
    ("method" = 'COLLECTOR') = ("collectedById" IS NOT NULL)
  ),
  CONSTRAINT "payment_settlements_whish_referenced" CHECK (
    ("method" = 'WHISH_MONEY') = ("externalRef" IS NOT NULL AND length(btrim("externalRef")) > 0)
  )
);

-- ═══════════════════════════════  foreign keys  ════════════════════════════
--
-- RESTRICT throughout, as on the ledger: the citizen who paid, the collector
-- who took the money and the clerk who recorded it cannot be erased from the
-- record of it. (A citizen file is archived, never deleted.)

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('payment_settlements', 'payment_settlements_citizenId_fkey',
         'FOREIGN KEY ("citizenId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('payment_settlements', 'payment_settlements_collectedById_fkey',
         'FOREIGN KEY ("collectedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('payment_settlements', 'payment_settlements_recordedById_fkey',
         'FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE')
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
-- On a new, empty table, so none of them locks anything live.

CREATE UNIQUE INDEX IF NOT EXISTS "payment_settlements_number_key"
  ON "payment_settlements" ("number");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_settlements_clientRequestId_key"
  ON "payment_settlements" ("clientRequestId");
-- A citizen's settlements, newest first.
CREATE INDEX IF NOT EXISTS "payment_settlements_citizenId_occurredAt_idx"
  ON "payment_settlements" ("citizenId", "occurredAt" DESC);
-- Every foreign key indexed (docs/finance.md §10).
CREATE INDEX IF NOT EXISTS "payment_settlements_collectedById_idx"
  ON "payment_settlements" ("collectedById");
CREATE INDEX IF NOT EXISTS "payment_settlements_recordedById_idx"
  ON "payment_settlements" ("recordedById");

-- ═════════════════════════════  append-only  ═══════════════════════════════
--
-- Its own function rather than reusing `reject_ledger_mutation()`, whose message
-- names `payment_transactions`: the error should name the table the operation
-- was attempted against (0017's reasoning).

CREATE OR REPLACE FUNCTION reject_settlement_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'payment_settlements is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE tg.tgname = 'payment_settlements_no_update' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TRIGGER payment_settlements_no_update
      BEFORE UPDATE ON "payment_settlements"
      FOR EACH ROW EXECUTE FUNCTION reject_settlement_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE tg.tgname = 'payment_settlements_no_delete' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TRIGGER payment_settlements_no_delete
      BEFORE DELETE ON "payment_settlements"
      FOR EACH ROW EXECUTE FUNCTION reject_settlement_mutation();
  END IF;
END
$$;

-- ════════════════════════  the ledger rows' settlement  ════════════════════

ALTER TABLE "payment_transactions" ADD COLUMN IF NOT EXISTS "settlementId" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'payment_transactions_settlementId_fkey' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "payment_transactions"
      ADD CONSTRAINT "payment_transactions_settlementId_fkey"
      FOREIGN KEY ("settlementId") REFERENCES "payment_settlements"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT
      NOT VALID;
  END IF;
END
$$;

-- A no-op once validated, so a replay costs nothing.
ALTER TABLE "payment_transactions" VALIDATE CONSTRAINT "payment_transactions_settlementId_fkey";

-- The rows of one settlement — what the consolidated receipt reprints.
CREATE INDEX IF NOT EXISTS "payment_transactions_settlementId_idx"
  ON "payment_transactions" ("settlementId");

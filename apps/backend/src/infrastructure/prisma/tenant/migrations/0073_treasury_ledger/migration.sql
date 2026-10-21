-- 0073_treasury_ledger
--
-- الخزينة — where the municipality's money is held, and an append-only record of
-- every movement into and out of each place. Design: docs/finance.md.
--
-- == What it is for =======================================================
--
--   treasury_accounts   a wallet: the cash safe, a Whish account, a bank
--                       account, a petty-cash fund, or the cash a collector
--                       holds until he hands it in. One currency each. The four
--                       everyday wallets (safe and Whish, ليرة and dollars) are
--                       seeded; anything else is one more row, with no code
--                       change.
--   treasury_entries    one signed movement on one account. Never updated,
--                       never deleted: a correction is an opposing entry. A
--                       balance is the SUM of an account's entries — there is
--                       no balance column to disagree with them.
--   system_settings     treasuryGoLiveAt, stamped once when the opening
--                       balances are posted. A payment taken before it never
--                       credits a wallet, so money already counted in an
--                       opening balance is not counted twice.
--
-- == Why not `payment_transactions` =======================================
--
-- That ledger records money against a citizen's invoice (`paymentId` is
-- mandatory) and in the invoice's own currency. A wallet needs movements that
-- have no invoice (income, expenses, transfers, an opening balance) and the
-- notes that actually changed hands: a 1,500,000 ل.ل bill paid with a $20 note
-- and handed back in ليرة moves +$20 into one wallet and the change out of
-- another. Each entry here carries the `source` it came from and that
-- source's id (no foreign key: the sources live in different tables).
--
-- == What the database enforces ==========================================
--
--   * Entries are append-only (triggers, as `payment_transactions`).
--   * An entry's currency equals its account's: the foreign key is the pair
--     (accountId, currency), so no code path can post ليرة into a dollar
--     wallet.
--   * An entry reverses at most one other entry (unique reversalOfId).
--   * A zero-value entry is not an entry.
--   * At most one *primary* account per (type, currency) — the one a citizen
--     payment is routed to — and one custody account per collector per
--     currency.
--
-- Not enforced here, and enforced in the service under a row lock instead: that
-- no outflow takes an account below zero. A CHECK cannot see the SUM of other
-- rows, and a trigger summing the table on every insert would serialise every
-- writer; the service locks the account row and reads the sum.
--
-- == Safety ===============================================================
--
-- Additive only: two types, two empty tables, one nullable column, four seeded
-- rows. Nothing existing is read or rewritten, and the previous build keeps
-- working against this schema; a rollback is a redeploy. Idempotent: every
-- statement can run twice. Written unqualified (the migrator sets
-- `search_path` to the tenant schema) and every catalog guard filters on
-- CURRENT_SCHEMA() (see 0050). The `ADD COLUMN` takes a brief lock on
-- `system_settings`, a one-row table.
--
-- Both enums are CREATED here with every value they will need, rather than
-- extended later: a value added by `ALTER TYPE … ADD VALUE` cannot be used in
-- the transaction that adds it, and the later stages (income, expenses,
-- transfers, closing) should not each need a migration for one word.

-- ═══════════════════════════════════  enums  ═══════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'TreasuryAccountType' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "TreasuryAccountType" AS ENUM (
      'CASH_SAFE', 'WHISH_ACCOUNT', 'BANK_ACCOUNT', 'COLLECTOR_CUSTODY', 'PETTY_CASH'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'TreasuryEntrySource' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "TreasuryEntrySource" AS ENUM (
      'OPENING_BALANCE', 'CITIZEN_PAYMENT', 'INCOME_VOUCHER',
      'EXPENSE_VOUCHER', 'TRANSFER', 'ADJUSTMENT'
    );
  END IF;
END
$$;

-- ═══════════════════════════════  treasury_accounts  ═══════════════════════════

CREATE TABLE IF NOT EXISTS "treasury_accounts" (
  "id"        UUID                  NOT NULL DEFAULT gen_random_uuid(),
  "name"      TEXT                  NOT NULL,
  "type"      "TreasuryAccountType" NOT NULL,
  -- ISO 4217, upper case. One currency per account.
  "currency"  TEXT                  NOT NULL,
  -- The account a payment of this type and currency is routed to. At most one
  -- per (type, currency); never a collector's custody account.
  "isPrimary" BOOLEAN               NOT NULL DEFAULT false,
  "active"    BOOLEAN               NOT NULL DEFAULT true,
  -- The collector, for COLLECTOR_CUSTODY, and only then.
  "ownerId"   UUID,
  "createdAt" TIMESTAMPTZ(3)        NOT NULL DEFAULT now(),

  CONSTRAINT "treasury_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "treasury_accounts_name_present" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "treasury_accounts_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "treasury_accounts_owner_iff_custody"
    CHECK (("type" = 'COLLECTOR_CUSTODY') = ("ownerId" IS NOT NULL)),
  CONSTRAINT "treasury_accounts_custody_not_primary"
    CHECK (NOT "isPrimary" OR "type" <> 'COLLECTOR_CUSTODY'),
  -- The target of the entries' (accountId, currency) foreign key.
  CONSTRAINT "treasury_accounts_id_currency_key" UNIQUE ("id", "currency")
);

CREATE UNIQUE INDEX IF NOT EXISTS "treasury_accounts_primary_key"
  ON "treasury_accounts" ("type", "currency") WHERE "isPrimary";

CREATE UNIQUE INDEX IF NOT EXISTS "treasury_accounts_custody_key"
  ON "treasury_accounts" ("ownerId", "currency") WHERE "ownerId" IS NOT NULL;

-- ═══════════════════════════════  treasury_entries  ════════════════════════════

CREATE TABLE IF NOT EXISTS "treasury_entries" (
  "id"           UUID                  NOT NULL DEFAULT gen_random_uuid(),
  "accountId"    UUID                  NOT NULL,
  -- Always the account's own currency (composite foreign key below).
  "currency"     TEXT                  NOT NULL,
  -- Signed. Positive is money in, negative is money out; a reversal is an
  -- opposing entry.
  "amount"       DECIMAL(14,2)         NOT NULL,
  -- The municipality's rate (system_settings.exchangeRate: base currency per
  -- one unit of the secondary) when this was posted. NULL when none was set.
  -- Kept so a report in ليرة values an old dollar entry at its own day's rate
  -- and not today's.
  "exchangeRateAtPosting" DECIMAL(18,6),
  "source"       "TreasuryEntrySource" NOT NULL,
  -- The row this came from (a payment_transactions id for CITIZEN_PAYMENT, a
  -- voucher id, …). No foreign key: the sources live in different tables.
  "sourceId"     UUID,
  -- Set when this entry reverses an earlier one.
  "reversalOfId" UUID,
  -- Who posted it. NULL for the system (a Whish callback).
  "actorId"      UUID,
  "note"         TEXT,
  -- When the money moved, which is not always when the row was written.
  "occurredAt"   TIMESTAMPTZ(3)        NOT NULL DEFAULT now(),
  "createdAt"    TIMESTAMPTZ(3)        NOT NULL DEFAULT now(),

  CONSTRAINT "treasury_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "treasury_entries_amount_nonzero" CHECK ("amount" <> 0),
  CONSTRAINT "treasury_entries_rate_positive"
    CHECK ("exchangeRateAtPosting" IS NULL OR "exchangeRateAtPosting" > 0)
);

-- ═══════════════════════════════  foreign keys  ════════════════════════════════
--
-- RESTRICT everywhere, for the reason `payment_transactions` gives: SET NULL is
-- an UPDATE and this table refuses updates, and a person who moved the
-- municipality's money cannot be erased from the record of having moved it.

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('treasury_accounts', 'treasury_accounts_ownerId_fkey',
         'FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('treasury_entries', 'treasury_entries_account_currency_fkey',
         'FOREIGN KEY ("accountId", "currency") REFERENCES "treasury_accounts"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT'),
      ('treasury_entries', 'treasury_entries_actorId_fkey',
         'FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('treasury_entries', 'treasury_entries_reversalOfId_fkey',
         'FOREIGN KEY ("reversalOfId") REFERENCES "treasury_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE')
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

-- ═════════════════════════════════  indexes  ═══════════════════════════════════
--
-- All on the two new, empty tables, so none of them locks anything live.

-- An entry reverses at most one entry: a second reversal would give the money
-- back twice.
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_entries_reversalOfId_key"
  ON "treasury_entries" ("reversalOfId");

-- An account's balance and statement.
CREATE INDEX IF NOT EXISTS "treasury_entries_accountId_occurredAt_idx"
  ON "treasury_entries" ("accountId", "occurredAt");

-- "Which entries did this payment (or voucher) produce".
CREATE INDEX IF NOT EXISTS "treasury_entries_source_sourceId_idx"
  ON "treasury_entries" ("source", "sourceId");

-- The day's movements across every account.
CREATE INDEX IF NOT EXISTS "treasury_entries_occurredAt_idx"
  ON "treasury_entries" ("occurredAt");

CREATE INDEX IF NOT EXISTS "treasury_entries_actorId_idx"
  ON "treasury_entries" ("actorId");

CREATE INDEX IF NOT EXISTS "treasury_accounts_ownerId_idx"
  ON "treasury_accounts" ("ownerId");

-- ═════════════════════════════  append-only, at the database  ══════════════════
--
-- Same guarantee, and the same reasoning, as `payment_transactions` (0017): a
-- financial record the application can rewrite is worth exactly as much as the
-- application's good behaviour. Corrections are opposing entries, which this
-- permits; edits and deletes are not.
--
-- Not covered: TRUNCATE. Using it, or `session_replication_role`, to get past
-- this is circumventing a control (docs/database.md).

CREATE OR REPLACE FUNCTION reject_treasury_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'treasury_entries is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE tg.tgname = 'treasury_entries_no_update' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TRIGGER treasury_entries_no_update
      BEFORE UPDATE ON "treasury_entries"
      FOR EACH ROW EXECUTE FUNCTION reject_treasury_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE tg.tgname = 'treasury_entries_no_delete' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TRIGGER treasury_entries_no_delete
      BEFORE DELETE ON "treasury_entries"
      FOR EACH ROW EXECUTE FUNCTION reject_treasury_mutation();
  END IF;
END
$$;

-- ═══════════════════════════════  go-live stamp  ═══════════════════════════════
--
-- NULL until "activate treasury" posts the opening balances; set once, in the
-- same transaction as them. Until then nothing credits any wallet.

ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "treasuryGoLiveAt" TIMESTAMPTZ(3);

-- ═══════════════════════════════  the four wallets  ════════════════════════════
--
-- Seeded as primary accounts, so a citizen payment has somewhere to go the
-- moment the treasury is activated. No opening balance is written here: that is
-- a human's count of a real safe, entered at go-live.

INSERT INTO "treasury_accounts" ("name", "type", "currency", "isPrimary")
SELECT seed."name", seed."type"::"TreasuryAccountType", seed."currency", true
  FROM (VALUES
    ('صندوق النقد — ليرة',     'CASH_SAFE',     'LBP'),
    ('صندوق النقد — دولار',    'CASH_SAFE',     'USD'),
    ('حساب Whish — ليرة',      'WHISH_ACCOUNT', 'LBP'),
    ('حساب Whish — دولار',     'WHISH_ACCOUNT', 'USD')
  ) AS seed("name", "type", "currency")
 WHERE NOT EXISTS (
   SELECT 1 FROM "treasury_accounts" a
    WHERE a."isPrimary" AND a."type" = seed."type"::"TreasuryAccountType" AND a."currency" = seed."currency"
 );

-- 0057_whish_checkouts
--
-- One immutable row per checkout opened at the payment provider, keyed by the
-- reference the provider will quote back.
--
-- == Why ===================================================================
--
-- A Whish callback is matched by looking up `citizen_payments` on
-- `whishTransactionRef`. That column is the wrong thing to match on, for two
-- reasons that compound:
--
--   · It is **not unique**. It is indexed, and nothing stops two rows carrying
--     the same reference.
--   · It is **mutable, and cleared on settlement**. The ledger overwrites it
--     every time an invoice settles, and the failure path nulls it. So the
--     handle the provider holds can stop existing on the row it belongs to,
--     while the provider still believes it is live.
--
-- The shape that loses money: a citizen opens a checkout, abandons it, opens a
-- second. `startWhishCheckout` rewrites `whishTransactionRef` to attempt #2's
-- reference. A late *failure* callback for attempt #1 finds the invoice by that
-- column — which now names attempt #2 — and clears it. Attempt #2's own success
-- callback then arrives to a reference no row carries, is logged as unknown,
-- and the money it took is never banked.
--
-- A checkout is a fact about a moment: this invoice, this amount, this
-- reference, at this time. It does not change afterwards, and it should not
-- live in a column that the settlement path rewrites.
--
-- == Why now, with no provider wired ======================================
--
-- `whish-gateway.service.ts` throws unconditionally, and both environments hold
-- zero payments and zero transactions. That is precisely the argument for doing
-- it now: there is nothing to migrate, no reconciliation, and no money in
-- flight. After the first live checkout each of those becomes true.
--
-- == What is deliberately left alone ======================================
--
-- `citizen_payments.whishTransactionRef` is **not dropped**. Dropping a column
-- is one-way and belongs in its own later release once nothing reads it
-- (AGENTS.md §3, expand → migrate → contract). This is the expand. The column
-- keeps working exactly as it does today; the new table is what a callback is
-- matched against.
--
-- == Deploy order ==========================================================
--
-- Additive: one enum, one table, two foreign keys, indexes. Apply BEFORE the
-- code, which selects and inserts.
--
-- Written unqualified: the migrator sets `search_path` to the tenant schema and
-- wraps the file in one transaction. Idempotent throughout.

-- ═════════════════════════════════  enum  ═════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'WhishCheckoutState' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    -- OPEN until the provider says otherwise. ABANDONED is what a checkout
    -- becomes when a later one is opened on the same invoice — recorded rather
    -- than deleted, because the provider may still call back about it and the
    -- answer "we know, and we stopped waiting" is worth being able to give.
    CREATE TYPE "WhishCheckoutState" AS ENUM ('OPEN', 'SUCCEEDED', 'FAILED', 'ABANDONED');
  END IF;
END
$$;

-- ═══════════════════════════════  whish_checkouts  ═══════════════════════════

CREATE TABLE IF NOT EXISTS "whish_checkouts" (
  "id"          UUID                 NOT NULL DEFAULT gen_random_uuid(),
  -- The provider's handle, and the only thing a callback carries. Unique, so a
  -- callback resolves to exactly one checkout or to none — never to "whichever
  -- row happens to hold this string right now".
  "externalRef" TEXT                 NOT NULL,
  "paymentId"   UUID                 NOT NULL,
  "citizenId"   UUID                 NOT NULL,
  -- What was quoted to the provider, captured at the moment it was quoted. Not
  -- read back off the invoice later: by the time a callback arrives the
  -- outstanding balance may have moved, and the question a callback answers is
  -- "did they pay what we asked", not "what do they owe now".
  "amount"      DECIMAL(14, 2)       NOT NULL,
  "currency"    TEXT                 NOT NULL DEFAULT 'LBP',
  "state"       "WhishCheckoutState" NOT NULL DEFAULT 'OPEN',
  -- The provider's own transaction id, which is not the same string as
  -- `externalRef` and arrives only with the callback.
  "providerTxnRef" TEXT,
  "openedAt"    TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt"   TIMESTAMP(3),

  CONSTRAINT "whish_checkouts_pkey" PRIMARY KEY ("id"),
  -- An open checkout has not settled; a closed one has a moment it closed.
  CONSTRAINT "whish_checkouts_settled_pair"
    CHECK (("state" = 'OPEN') = ("settledAt" IS NULL)),
  CONSTRAINT "whish_checkouts_amount_positive" CHECK ("amount" > 0)
);

-- ═══════════════════════════════  foreign keys  ═══════════════════════════════
--
-- Both cascade. A checkout for an invoice that no longer exists cannot be
-- settled against anything, and keeping it would leave a row that looks like an
-- unbanked payment for ever.

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('whish_checkouts', 'whish_checkouts_paymentId_fkey', 'paymentId', 'citizen_payments', 'CASCADE'),
      ('whish_checkouts', 'whish_checkouts_citizenId_fkey', 'citizenId', 'users', 'CASCADE')
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

-- ═════════════════════════════════  indexes  ═════════════════════════════════

-- The whole point: a callback resolves by this, uniquely, for ever.
CREATE UNIQUE INDEX IF NOT EXISTS "whish_checkouts_externalRef_key"
  ON "whish_checkouts" ("externalRef");

-- "This invoice's checkouts, newest first" — for abandoning the previous one
-- when a citizen starts again, and for showing a clerk what has been attempted.
CREATE INDEX IF NOT EXISTS "whish_checkouts_paymentId_openedAt_idx"
  ON "whish_checkouts" ("paymentId", "openedAt");

-- At most one live checkout per invoice. Two open checkouts on one bill is two
-- ways to pay it and a race to bank the second.
CREATE UNIQUE INDEX IF NOT EXISTS "whish_checkouts_one_open_per_payment_key"
  ON "whish_checkouts" ("paymentId")
  WHERE "state" = 'OPEN';

-- 0080_treasury_controls
--
-- Three controls the treasury was missing, decided on the PR #104 review
-- (docs/finance.md §5.1 and §13, docs/open-decisions.md):
--
-- == 1. The payment order (أمر الصرف / حوالة) ==============================
--
-- Decree 5595/1982 (المحاسبة في البلديات) splits spending into four stages —
-- commitment, liquidation, payment order, payment (art. 21). The order is a
-- «حوالة» issued by the head of the municipality (art. 28); the cashier pays an
-- order that bears that signature (art. 33), must pay one properly issued
-- (art. 85), and answers personally for any payment made otherwise (art. 89).
-- Salaries, routine petty expenses and urgent ones may be paid first, the order
-- following (art. 35). So:
--
--   * `expense_requests` — an accountant prepares an expense and asks for the
--     order. Nothing leaves a wallet. The manager orders it (the voucher is then
--     written and paid, in that one transaction), rejects it with a reason, or
--     its author withdraws it. The decision is written once.
--   * `expense_vouchers.orderedAt / orderedById` — the order on a paid voucher.
--     The manager's own voucher carries it from the start; an accountant's
--     urgent payment (art. 35, `urgentReason`) carries it once the manager
--     regularises it.
--
-- Vouchers written before this migration were paid under the old rule, with no
-- order step at all. They are stamped as ordered by whoever recorded them, so
-- none of them appears to be waiting for an order that was never going to come.
-- A cancelled one is left as it is: it is closed, waits for nothing, and once
-- the trigger below exists the stamp would be refused, so a second run of this
-- file must not try.
--
-- == 2. Documents are written once ========================================
--
-- `treasury_entries` is append-only (0073). The documents behind the entries
-- were not: an expense voucher's amount, wallet or payee could be rewritten, a
-- cancellation undone, a row deleted — leaving entries whose `sourceId` points
-- at nothing. From here a voucher, a transfer and a request are never deleted,
-- their own fields never change, and each stamp on them (cancelled, ordered,
-- decided) is written once and then stays. A cancelled document, and a decided
-- request, is closed: nothing on it changes again. TRUNCATE is not covered, as
-- on every append-only table in this schema (docs/database.md). A later
-- migration that backfills a new column on one of these tables disables the
-- trigger around its UPDATE, or the backfill is refused like any other edit.
--
-- == 3. Index hygiene =====================================================
--
-- The cancelling staff member's foreign keys get the index every other
-- foreign key in this schema has (docs/database.md).
--
-- == Safety ===============================================================
--
-- Additive: new nullable columns, one new empty table, one function, three
-- triggers, indexes on small tables. The only row write is the backfill of the
-- new `orderedAt`/`orderedById` columns on vouchers that predate it; it fills
-- new columns and rewrites nothing that existed. Idempotent; every catalog guard
-- filters on CURRENT_SCHEMA() (see 0050). Numbered 0080: 0075–0077 are
-- develop's, 0078–0079 are PR #104's, and no open branch uses 0080 (checked
-- 2026-10-09).

-- ═══════════════════════════  the order on a voucher  ═══════════════════════════

ALTER TABLE "expense_vouchers" ADD COLUMN IF NOT EXISTS "orderedAt"    TIMESTAMPTZ(3);
ALTER TABLE "expense_vouchers" ADD COLUMN IF NOT EXISTS "orderedById"  UUID;
-- Why an accountant paid before the order (art. 35). NULL for the manager's
-- vouchers and for vouchers paid on an order.
ALTER TABLE "expense_vouchers" ADD COLUMN IF NOT EXISTS "urgentReason" TEXT;

-- Paid under the old rule: the recording was the authorisation.
UPDATE "expense_vouchers"
   SET "orderedAt" = "createdAt",
       "orderedById" = "recordedById"
 WHERE "orderedAt" IS NULL
   AND "urgentReason" IS NULL
   AND "voidedAt" IS NULL;

-- ═════════════════════════════  expense_requests  ═════════════════════════════

CREATE TABLE IF NOT EXISTS "expense_requests" (
  "id"                 UUID           NOT NULL DEFAULT gen_random_uuid(),
  "categoryId"         UUID           NOT NULL,
  -- The wallet it is to be paid from, paired with its currency as on vouchers.
  "accountId"          UUID           NOT NULL,
  "currency"           TEXT           NOT NULL,
  "amount"             DECIMAL(14,2)  NOT NULL,
  -- Free text that may name a citizen: kept out of logs, Sentry and audit rows.
  "payee"              TEXT           NOT NULL,
  "description"        TEXT           NOT NULL,
  "invoiceNumber"      TEXT,
  "hasPhysicalReceipt" BOOLEAN        NOT NULL DEFAULT false,
  "requestedById"      UUID           NOT NULL,
  "clientRequestId"    UUID,
  "createdAt"          TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  -- The decision, written once: 'ORDERED' | 'REJECTED' | 'WITHDRAWN'.
  "decision"           TEXT,
  "decidedAt"          TIMESTAMPTZ(3),
  "decidedById"        UUID,
  "decisionReason"     TEXT,
  -- The voucher the order wrote and paid.
  "voucherId"          UUID,

  CONSTRAINT "expense_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "expense_requests_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "expense_requests_payee_present" CHECK (length(btrim("payee")) > 0),
  CONSTRAINT "expense_requests_description_present" CHECK (length(btrim("description")) > 0),
  CONSTRAINT "expense_requests_decision_known"
    CHECK ("decision" IS NULL OR "decision" IN ('ORDERED', 'REJECTED', 'WITHDRAWN')),
  CONSTRAINT "expense_requests_decision_complete"
    CHECK (("decision" IS NULL) = ("decidedAt" IS NULL) AND ("decision" IS NULL) = ("decidedById" IS NULL)),
  CONSTRAINT "expense_requests_voucher_iff_ordered"
    CHECK (("decision" IS NOT DISTINCT FROM 'ORDERED') = ("voucherId" IS NOT NULL)),
  CONSTRAINT "expense_requests_rejection_has_reason"
    CHECK ("decision" IS DISTINCT FROM 'REJECTED' OR length(btrim(coalesce("decisionReason", ''))) > 0)
);

-- ═══════════════════════════════  constraints  ═══════════════════════════════
--
-- RESTRICT throughout, as on the rest of the treasury: a person who asked for,
-- ordered or refused a payment cannot be erased from the record of having done so.

DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('expense_vouchers', 'expense_vouchers_orderedById_fkey',
         'FOREIGN KEY ("orderedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('expense_vouchers', 'expense_vouchers_order_complete',
         'CHECK ("orderedById" IS NULL OR "orderedAt" IS NOT NULL)'),
      ('expense_vouchers', 'expense_vouchers_urgent_reason_present',
         'CHECK ("urgentReason" IS NULL OR length(btrim("urgentReason")) > 0)'),
      ('expense_requests', 'expense_requests_categoryId_fkey',
         'FOREIGN KEY ("categoryId") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('expense_requests', 'expense_requests_account_currency_fkey',
         'FOREIGN KEY ("accountId", "currency") REFERENCES "treasury_accounts"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT'),
      ('expense_requests', 'expense_requests_requestedById_fkey',
         'FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('expense_requests', 'expense_requests_decidedById_fkey',
         'FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('expense_requests', 'expense_requests_voucherId_fkey',
         'FOREIGN KEY ("voucherId") REFERENCES "expense_vouchers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT')
    ) AS t(tbl, name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = item.name AND n.nspname = CURRENT_SCHEMA()
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', item.tbl, item.name, item.definition);
    END IF;
  END LOOP;
END
$$;

-- ═════════════════════════════════  indexes  ═════════════════════════════════
--
-- On a new empty table, or on treasury tables that hold a few hundred rows at
-- most when this runs, so none of them holds a lock for long.

CREATE UNIQUE INDEX IF NOT EXISTS "expense_requests_clientRequestId_key"
  ON "expense_requests" ("clientRequestId");
CREATE UNIQUE INDEX IF NOT EXISTS "expense_requests_voucherId_key"
  ON "expense_requests" ("voucherId");
-- The manager's queue: what is still waiting for a decision.
CREATE INDEX IF NOT EXISTS "expense_requests_pending_idx"
  ON "expense_requests" ("createdAt") WHERE "decision" IS NULL;
CREATE INDEX IF NOT EXISTS "expense_requests_categoryId_idx" ON "expense_requests" ("categoryId");
CREATE INDEX IF NOT EXISTS "expense_requests_accountId_idx" ON "expense_requests" ("accountId");
CREATE INDEX IF NOT EXISTS "expense_requests_requestedById_idx" ON "expense_requests" ("requestedById");
CREATE INDEX IF NOT EXISTS "expense_requests_decidedById_idx" ON "expense_requests" ("decidedById");

-- Urgent payments still waiting for their order.
CREATE INDEX IF NOT EXISTS "expense_vouchers_awaiting_order_idx"
  ON "expense_vouchers" ("occurredAt") WHERE "orderedAt" IS NULL AND "voidedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "expense_vouchers_orderedById_idx" ON "expense_vouchers" ("orderedById");
CREATE INDEX IF NOT EXISTS "expense_vouchers_voidedById_idx" ON "expense_vouchers" ("voidedById");
CREATE INDEX IF NOT EXISTS "treasury_transfers_voidedById_idx" ON "treasury_transfers" ("voidedById");

-- ══════════════════════════  documents are written once  ══════════════════════════
--
-- One function for the three tables. The trigger names the row's stamps — the
-- columns that may be filled in after the row is written; every other column
-- is fixed at insert. A stamp goes from empty to a value once and then stays,
-- a cancelled row or a decided request accepts nothing further (the reason a
-- withdrawal never gave cannot be added to it later), and no row is ever deleted.
-- `search_path` is pinned: the body reads no table, only its own row.

CREATE OR REPLACE FUNCTION reject_treasury_document_mutation() RETURNS TRIGGER AS $$
DECLARE
  stamp    TEXT;
  old_row  JSONB;
  new_row  JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never removed; cancel the document instead', TG_TABLE_NAME;
  END IF;

  old_row := to_jsonb(OLD);
  new_row := to_jsonb(NEW);

  IF old_row ? 'voidedAt' AND old_row ->> 'voidedAt' IS NOT NULL THEN
    RAISE EXCEPTION '% %: a cancelled document does not change', TG_TABLE_NAME, OLD."id";
  END IF;
  IF old_row ? 'decision' AND old_row ->> 'decision' IS NOT NULL THEN
    RAISE EXCEPTION '% %: a decided request does not change', TG_TABLE_NAME, OLD."id";
  END IF;

  FOREACH stamp IN ARRAY TG_ARGV LOOP
    IF old_row ->> stamp IS NOT NULL AND (old_row -> stamp) IS DISTINCT FROM (new_row -> stamp) THEN
      RAISE EXCEPTION '% %: % is already set and does not change', TG_TABLE_NAME, OLD."id", stamp;
    END IF;
    old_row := old_row - stamp;
    new_row := new_row - stamp;
  END LOOP;

  IF old_row IS DISTINCT FROM new_row THEN
    RAISE EXCEPTION '% %: only its stamps may change after it is written', TG_TABLE_NAME, OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog;

DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('expense_vouchers', 'expense_vouchers_written_once',
         '''voidedAt'', ''voidedById'', ''voidReason'', ''orderedAt'', ''orderedById'''),
      ('treasury_transfers', 'treasury_transfers_written_once',
         '''voidedAt'', ''voidedById'', ''voidReason'''),
      ('expense_requests', 'expense_requests_written_once',
         '''decision'', ''decidedAt'', ''decidedById'', ''decisionReason'', ''voucherId''')
    ) AS t(tbl, name, stamps)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger tg
        JOIN pg_class c ON c.oid = tg.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE tg.tgname = item.name AND c.relname = item.tbl AND n.nspname = CURRENT_SCHEMA()
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_treasury_document_mutation(%s)',
        item.name, item.tbl, item.stamps
      );
    END IF;
  END LOOP;
END
$$;

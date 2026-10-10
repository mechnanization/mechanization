-- 0079_document_numbering
--
-- One numbering scheme for every document the municipality issues:
-- «INV-2610-0001», «RCP-2610-0001», «PV-2610-0001», «TR-2610-0001» — prefix,
-- then the year and month it was issued in, then a counter that restarts at
-- 0001 each month.
--
-- == Why a table and not a sequence =======================================
--
-- The four books are numbered today by four Postgres sequences (0017, 0074,
-- 0078). A sequence cannot do this: `nextval` only ever climbs, and nothing
-- resets it on the first of the month without a second mechanism racing the
-- first. So the counter moves into a row keyed by (kind, period), and a number
-- is drawn with a single atomic statement:
--
--   INSERT … VALUES (kind, period, n + 1)
--   ON CONFLICT (kind, period) DO UPDATE SET "nextValue" = … + n
--   RETURNING "nextValue" - n
--
-- which both creates the month's first row and advances an existing one, and
-- hands back the block it reserved. Two clerks settling in the same moment
-- cannot read the same number: the second waits on the row lock.
--
-- Two consequences worth stating plainly:
--
--   * **It serialises issuance within a month.** The row stays locked until the
--     caller's transaction commits, so concurrent settlements queue behind each
--     other. At a municipality's volume — a handful of clerks at a counter —
--     that is nothing, and the alternative is two residents holding the same
--     receipt number.
--   * **It gaps less than a sequence did.** A sequence keeps its advance when
--     the surrounding transaction rolls back; this counter rolls back with it.
--     Gaps are still possible (a commit that later fails elsewhere), so nothing
--     here may be read as a guarantee of a gapless book.
--
-- == The old sequences stay ================================================
--
-- `payment_receipt_seq`, `expense_voucher_seq` and `treasury_transfer_seq` are
-- left in place and simply stop being drawn from. Dropping them is destructive
-- DDL and belongs in its own later release (CLAUDE.md: expand, backfill,
-- contract) — and while they exist, a rollback to the previous build keeps
-- numbering exactly as it did.
--
-- == Numbers already issued are not touched ================================
--
-- Receipts, vouchers and transfers already printed keep their six-digit form;
-- the two shapes coexist, and nothing in the code parses or orders by either.
-- Bills issued before today stay unnumbered: `invoiceNumber` is nullable, and
-- minting a number for a document that was never issued under one would put a
-- fiction in front of an auditor.
--
-- == Safety ===============================================================
--
-- Additive only: one new empty table, one nullable column, one partial-by-
-- nature unique index (Postgres allows many NULLs). Nothing existing is read or
-- rewritten and a rollback is a redeploy. Idempotent throughout; every catalog
-- guard filters on CURRENT_SCHEMA() (see 0050).
--
-- Numbered 0079: 0073–0074 are this branch's, and 0075–0077 belong to
-- `chore/migration-0075-0077` / `feat/co-owner-billing`. Check every branch
-- before picking, and again before the PR.

-- ════════════════════════════  the counter book  ════════════════════════════

CREATE TABLE IF NOT EXISTS "document_counters" (
  -- 'INVOICE' | 'RECEIPT' | 'VOUCHER' | 'TRANSFER'. Text rather than an enum:
  -- a municipality that starts a fifth book should not need a migration to
  -- change a type, and nothing here branches on the value.
  "kind"      TEXT         NOT NULL,
  -- «YYMM» on the municipality's own calendar (Asia/Beirut), e.g. '2610'.
  -- Stored as the client computed it, so the day boundary is decided in one
  -- place (`municipalToday`) rather than by whatever zone the server runs in.
  "period"    TEXT         NOT NULL,
  -- The number the *next* document will take. Starts at 1; a draw of n leaves
  -- it n higher.
  "nextValue" INTEGER      NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "document_counters_pkey" PRIMARY KEY ("kind", "period"),
  -- A counter that has gone backwards is a bug that would reissue numbers.
  CONSTRAINT "document_counters_next_positive" CHECK ("nextValue" >= 1)
);

-- ═════════════════════════════  invoice numbers  ═════════════════════════════

-- The number on the bill the resident is handed. Nullable: every bill issued
-- before this migration has none and never will.
ALTER TABLE "citizen_payments" ADD COLUMN IF NOT EXISTS "invoiceNumber" TEXT;

-- Unique where present. Postgres treats NULLs as distinct, so the thousands of
-- unnumbered legacy bills do not collide with each other.
--
-- **Not CONCURRENTLY, deliberately.** The migrator runs each migration in a
-- transaction, where CONCURRENTLY is not allowed at all, so the choice is this
-- or a migration of its own (0061, 0069). Taken here because the column was
-- created empty two statements ago: every value in it is NULL, the btree has
-- nothing to sort, and it builds over a municipality's bills in milliseconds.
-- The write lock falls inside the deploy window the migration already runs in.
-- `pnpm db:status:*` reports it as a lock-risk statement — that report is
-- correct, and this is the answer to it.
CREATE UNIQUE INDEX IF NOT EXISTS "citizen_payments_invoiceNumber_key"
  ON "citizen_payments" ("invoiceNumber");

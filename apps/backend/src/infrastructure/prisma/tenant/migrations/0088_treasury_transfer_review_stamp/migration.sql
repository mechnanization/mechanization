-- 0088_treasury_transfer_review_stamp
--
-- «اعتماد المراجعة» is a stamp on a transfer, so the write-once rule 0083 gave
-- `treasury_transfers` must name it (PR #111 review, 2026-10-10;
-- docs/finance.md §6.4).
--
-- == Why ==================================================================
--
-- 0083 made every treasury document written once: its trigger
-- `treasury_transfers_written_once` lets only the row's stamps change after the
-- insert, and for a transfer those were `voidedAt`, `voidedById` and
-- `voidReason`. 0084 (PR #111) then added the review stamp — `reviewedAt`,
-- `reviewedById`, `reviewNote` — and `TransfersService.review` writes it with an
-- UPDATE. Probed on a fresh schema (0001 → 0087): every review of a flagged
-- exchange was refused by the 0083 trigger, «only its stamps may change after
-- it is written», and reached the auditor as a server error. No exchange
-- could ever be cleared.
--
-- == The rule now =========================================================
--
--   * `treasury_transfers_written_once` is re-created with the review stamp in
--     its list: `voidedAt`, `voidedById`, `voidReason`, `reviewedAt`,
--     `reviewedById`, `reviewNote`. Each goes from empty to a value once and
--     then stays (0083's function, unchanged); a cancelled transfer takes
--     nothing further, a review included.
--   * `treasury_transfers_review_once` — a review is one act. Once
--     `reviewedAt` is set, none of the three review columns changes: the
--     generic rule alone would let a note be added to a review made without
--     one, after the fact. 0084's CHECK already keeps the note from coming
--     before the stamp.
--
-- Both refuse with `check_violation`, as 0087 does; the messages do not start
-- «treasury day … is closed», so `closedTreasuryDay` never mistakes them.
--
-- == Safety ===============================================================
--
-- No column, no row written. The trigger is dropped and created again in one
-- transaction (the migrator wraps each file), so no UPDATE ever finds the
-- table without it; CREATE TRIGGER takes a brief SHARE ROW EXCLUSIVE lock on
-- `treasury_transfers`, which has not reached production (0078). Idempotent:
-- running it again drops and re-creates the same trigger. Written
-- unqualified (the migrator sets `search_path`); every catalog guard filters
-- on CURRENT_SCHEMA() (see 0050); the new function reads only its own row and
-- is pinned to pg_catalog (see 0083). Needs 0083 (the function) and 0084 (the
-- columns), and edits neither: 0084 may already be on staging.
--
-- == Its number ===========================================================
--
-- 0084 is PR #111's, 0085 is reserved for PR #112, 0086 and 0087 are this
-- branch's (docs/database.md). 0088 was the next free number on 2026-10-10.

DROP TRIGGER IF EXISTS treasury_transfers_written_once ON "treasury_transfers";
CREATE TRIGGER treasury_transfers_written_once
  BEFORE UPDATE OR DELETE ON "treasury_transfers"
  FOR EACH ROW EXECUTE FUNCTION reject_treasury_document_mutation(
    'voidedAt', 'voidedById', 'voidReason', 'reviewedAt', 'reviewedById', 'reviewNote'
  );

CREATE OR REPLACE FUNCTION reject_transfer_review_rewrite() RETURNS TRIGGER AS $fn$
BEGIN
  IF OLD."reviewedAt" IS NOT NULL AND (
       NEW."reviewedAt" IS DISTINCT FROM OLD."reviewedAt"
       OR NEW."reviewedById" IS DISTINCT FROM OLD."reviewedById"
       OR NEW."reviewNote" IS DISTINCT FROM OLD."reviewNote"
     ) THEN
    RAISE EXCEPTION 'treasury_transfers %: a review is written once and never changed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql SET search_path = pg_catalog;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE tg.tgname = 'treasury_transfers_review_once' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TRIGGER treasury_transfers_review_once
      BEFORE UPDATE ON "treasury_transfers"
      FOR EACH ROW EXECUTE FUNCTION reject_transfer_review_rewrite();
  END IF;
END
$$;

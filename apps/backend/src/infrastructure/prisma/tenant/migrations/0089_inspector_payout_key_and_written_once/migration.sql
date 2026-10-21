-- 0089_inspector_payout_key_and_written_once
--
-- Two holes in «صرف عمولة» that the review of the treasury stack found on
-- 2026-10-11 (docs/finance.md §5.6): a payout recorded before go-live had no
-- retry key, and a payout paid by a voucher could be rewritten at the
-- database. One file, because both are `inspector_payouts` and neither needs
-- the other's code to ship first.
--
--   inspector_payouts."clientRequestId"   the dialog's retry key, unique, NULL
--                                         on every payout written before it.
--   reject_inspector_payout_rewrite()     a payout paid by a voucher is
--   inspector_payouts_written_once        written once, as 0083 made the
--                                         vouchers, transfers and requests and
--                                         0087 the day closings.
--
-- == The retry key ========================================================
--
-- Once the treasury is live a payout writes a «PV-» voucher, and the voucher
-- keeps the press's `clientRequestId`, so a retry is answered from it. Before
-- go-live a payout is a figure and writes no voucher: the dialog sent no key,
-- the server inserted every press, and a payout whose answer was lost, pressed
-- again, was recorded twice — the inspector read as owed less than he was,
-- with no voucher to void (reproduced on Postgres 17: two rows, owed 500 → 100
-- for one $200 handover). The key now lives on the payout row, on both paths:
-- `StaffService.recordInspectorPayout` looks it up under the inspector's
-- advisory lock and answers a retry with the first payout, bound to its act
-- (inspector, amount, recorder, statement, and the wallet once live). UNIQUE,
-- so two payouts can never carry one key; NULLs do not collide, so every
-- older payout keeps its NULL. Once live the voucher still carries the key
-- too, and a payout written before this file is still found through it.
--
-- == A payout paid by a voucher is written once ===========================
--
-- What an inspector is still owed is read from these rows alone: his earnings
-- less every payout whose voucher is not voided (`StaffService.
-- getInspectorProfile`, `UserRepository.listStaff`), and «صرف عمولة» pays up
-- to that figure. Probed on a fresh schema (0001 → 0088) with a payout linked
-- to PV-2610-0011 ($19):
--
--   * `UPDATE inspector_payouts SET "expenseVoucherId" = <a voided voucher>`
--     went through: the inspector read as owed the $19 again while 0011 stayed
--     paid, so «صرف عمولة» would have paid it a second time;
--   * `SET "expenseVoucherId" = NULL` went through, and voiding 0011 afterwards
--     no longer gave the amount back to what he is owed;
--   * `SET amount = 1` went through, and so did `DELETE`.
--
-- No application path does any of these: `StaffService` only creates payouts.
-- This holds the rule against a stray UPDATE in a future code path or a manual
-- repair, as 0083 and 0087 do for the documents beside it.
--
--   * A payout linked to its voucher (`expenseVoucherId` set) never changes and
--     is never deleted. Its money is corrected by voiding the voucher, which the
--     readers already treat as unpaid.
--   * A link is made at insert or never: setting `expenseVoucherId` on a payout
--     that has none is refused, so a figure recorded before go-live cannot
--     borrow a voucher, nor a voided payout another one.
--   * A payout recorded before go-live (no voucher) is left as it was. Deleting
--     a staff account still cascades to his figure-only payouts
--     (`inspectorId` ON DELETE CASCADE), deleting the officer who recorded one
--     still clears `recordedById` (ON DELETE SET NULL), and the in-app restore
--     can still empty and rewrite them. A linked payout meets neither cascade:
--     its voucher names the same inspector as payee and the same officer as
--     recorder, both RESTRICT (0074, 0081), so neither account can be deleted
--     while it stands.
--
-- The refusal is a `check_violation` whose message does not start «treasury
-- day … is closed», so `closedTreasuryDay` never reads it as the closed-day
-- lock. TRUNCATE is not covered, as on every append-only and written-once table
-- in this schema (docs/database.md, docs/security.md known gaps). A later
-- migration that backfills a new column on `inspector_payouts` disables the
-- trigger around its UPDATE in the same file, as 0083 says for the vouchers. A
-- user id never changes, so the users foreign keys' ON UPDATE CASCADE never
-- reaches this trigger.
--
-- == Safety ===============================================================
--
-- Additive: one nullable column with no default (no table rewrite), one unique
-- index, one function and one trigger; no row is read or written. The previous
-- build never names the column and does nothing the trigger refuses — a payout
-- is inserted, linked in that same insert once the treasury is live, and never
-- touched again — so it keeps working, and a rollback is a redeploy.
--
-- Locks: `inspector_payouts` is in production (0025). The migrator commits once
-- per file, so the ACCESS EXCLUSIVE lock the ADD COLUMN takes is held to the
-- end of this file, through the index build (without CONCURRENTLY, which the
-- migrator's transaction forbids) and the CREATE TRIGGER: reads and writes of
-- the table wait for the whole file (docs/database.md, "How tenant migrations
-- run"). The table holds one row per commission handed over — tens per
-- municipality, a few hundred at most — and the new column is all NULL, so the
-- file lasts milliseconds.
--
-- Backups: `BackupService` exports this table. An older snapshot has no key,
-- which reads as NULL; the snapshot version is unchanged. The trigger adds no
-- new way for a restore to fail: it refuses deleting a linked payout, and a
-- municipality with one already holds its voucher, whose RESTRICT keys refuse
-- the restore's delete of `users` (docs/database.md).
--
-- Idempotent throughout; written unqualified (the migrator sets
-- `search_path`); the catalog guard filters on CURRENT_SCHEMA() (see 0050); the
-- function reads only its own row and is pinned to pg_catalog (see 0083,
-- 0087). Needs 0086, which adds the link, and nothing after it.
--
-- == Its number ===========================================================
--
-- The next free number on 2026-10-11, after a check of every branch, local and
-- remote, and every open PR: `feat/treasury-day-closing` holds the treasury
-- run 0082, 0084–0088 after `develop`'s 0083, and nothing anywhere holds 0089
-- or later. It touches only `inspector_payouts`, so it applies after 0086 in
-- any order with the others. Not applied to staging or production.

ALTER TABLE "inspector_payouts" ADD COLUMN IF NOT EXISTS "clientRequestId" UUID;

CREATE UNIQUE INDEX IF NOT EXISTS "inspector_payouts_clientRequestId_key"
  ON "inspector_payouts" ("clientRequestId");

CREATE OR REPLACE FUNCTION reject_inspector_payout_rewrite() RETURNS TRIGGER AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."expenseVoucherId" IS NOT NULL THEN
      RAISE EXCEPTION 'inspector_payouts %: a payout paid by a voucher is never removed; void the voucher instead', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."expenseVoucherId" IS NOT NULL THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'inspector_payouts %: a payout paid by a voucher does not change; void the voucher instead', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."expenseVoucherId" IS NOT NULL THEN
    RAISE EXCEPTION 'inspector_payouts %: a payout is linked to its voucher when it is written, or never', OLD."id"
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
    WHERE tg.tgname = 'inspector_payouts_written_once' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TRIGGER inspector_payouts_written_once
      BEFORE UPDATE OR DELETE ON "inspector_payouts"
      FOR EACH ROW EXECUTE FUNCTION reject_inspector_payout_rewrite();
  END IF;
END
$$;

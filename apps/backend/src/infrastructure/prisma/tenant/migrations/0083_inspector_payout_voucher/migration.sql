-- 0083_inspector_payout_voucher
--
-- «صرف عمولة» — the expense voucher that paid an inspector's commission, once
-- the treasury is live. Design: docs/finance.md §5.6.
--
-- == What it is for =======================================================
--
--   inspector_payouts.expenseVoucherId  the «PV-» voucher written in the same
--                                       transaction as this payout, which took
--                                       the money out of a wallet. NULL on
--                                       every payout recorded before the
--                                       treasury went live, and on any
--                                       recorded while it is not.
--
-- Until now a payout was a figure typed on the staff pages and nothing else:
-- the dollars left the safe with no ledger entry, so the daily count came up
-- short by exactly the commissions paid that day. With the link a payout is
-- one voucher in «تعويضات المسح والجباية», paid from a chosen wallet, and the
-- payout row says which.
--
-- == One payout per voucher ===============================================
--
-- UNIQUE, because the relation is one to one: the voucher is the payout's
-- movement of money, and a second payout pointing at it would count one
-- payment against the inspector twice. The unique index is also the index the
-- foreign key needs. NULLs do not collide, so every old payout keeps its NULL.
--
-- == A cancelled voucher ==================================================
--
-- Nothing here reacts to a void. A payout whose voucher has `voidedAt` set
-- stays, as the voucher does, and the readers leave it out of what was paid
-- (`StaffService.getInspectorProfile`, `UserRepository.listStaff`): the money
-- went back into the wallet, so the inspector is owed it again. Derived on
-- read, never a second stamp to keep in step with the voucher's.
--
-- == Safety ===============================================================
--
-- Additive only: one nullable column with no default (no table rewrite), one
-- foreign key, one unique index. Nothing existing is read or rewritten, every
-- payout keeps NULL, and the previous build — which never names the column —
-- keeps working; a rollback is a redeploy. Idempotent throughout. Written
-- unqualified (the migrator sets `search_path`), and the catalog guard filters
-- on CURRENT_SCHEMA() (see 0050).
--
-- `inspector_payouts` is in production (0025), so the index build matters: it
-- runs without CONCURRENTLY, which the migrator's transaction forbids, and so
-- blocks writes to the table while it builds. The table holds one row per
-- commission handed over — tens per municipality, a few hundred at most — and
-- the column is all NULL, so the build lasts milliseconds.
--
-- RESTRICT: a voucher is never deleted (it is voided), and a payout must not
-- lose the record of the money that paid it.
--
-- Backups: `BackupService` exports this table and not `expense_vouchers`. A
-- non-NULL link exists only once a voucher does, and a municipality holding
-- vouchers already cannot be restored (their `recordedById` refuses the
-- restore's delete of `users`; docs/database.md), so the column adds no new
-- way for a restore to fail. The snapshot version is unchanged: an older
-- snapshot simply has no key, which reads as NULL.
--
-- Needs 0074, which creates `expense_vouchers`. Numbered 0083: 0082 is the
-- daily count's, and no local or remote branch held an 0083 on 2026-10-10;
-- check again before the PR.

ALTER TABLE "inspector_payouts" ADD COLUMN IF NOT EXISTS "expenseVoucherId" UUID;

CREATE UNIQUE INDEX IF NOT EXISTS "inspector_payouts_expenseVoucherId_key"
  ON "inspector_payouts" ("expenseVoucherId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'inspector_payouts_expenseVoucherId_fkey' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "inspector_payouts"
      ADD CONSTRAINT "inspector_payouts_expenseVoucherId_fkey"
      FOREIGN KEY ("expenseVoucherId") REFERENCES "expense_vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

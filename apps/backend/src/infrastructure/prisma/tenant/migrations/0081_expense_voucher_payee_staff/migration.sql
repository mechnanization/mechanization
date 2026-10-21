-- 0081_expense_voucher_payee_staff
--
-- «صرف راتب» — which staff member an expense voucher paid, when it paid one.
-- Design: docs/finance.md §5.8.
--
-- == What it is for =======================================================
--
--   expense_vouchers.payeeStaffId  the staff account a salary or wage voucher
--                                  was paid to. NULL on every other voucher:
--                                  a supplier, a contractor, a fuel station.
--
-- `payee` stays the record of who was paid, as printed on the voucher, and is
-- still written for a salary: it is the name as it stood on the day, and a
-- later rename of the account must not rewrite what an old voucher says. This
-- column is the link beside it, so «ما قبضه هذا الموظف» is a query on an id
-- rather than a search on a name two people can share.
--
-- It is not a payroll. Nothing here holds a salary scale, a period or what a
-- person is owed; a salary is still one voucher in «رواتب وأجور», paid when it
-- is paid (docs/finance.md §5.5).
--
-- == The staff rule =======================================================
--
-- `users` holds staff and citizens. The foreign key can only say "a user"; that
-- the user is `kind = 'STAFF'` is checked by the one writer,
-- `ExpensesService.recordSalary`, in the WHERE of the read that resolves the
-- payee, inside the same transaction as the insert.
--
-- == Safety ===============================================================
--
-- Additive only: one nullable column with no default (no table rewrite), one
-- foreign key, one index. Nothing existing is read or rewritten, every voucher
-- already recorded keeps NULL, and the previous build — which never names the
-- column — keeps working; a rollback is a redeploy. Idempotent throughout.
-- Written unqualified (the migrator sets `search_path`), and the catalog guard
-- filters on CURRENT_SCHEMA() (see 0050).
--
-- The index is built without CONCURRENTLY, which the migrator's transaction
-- forbids. `expense_vouchers` was created by 0074, which has not reached
-- production, so on every environment the table is empty or holds a few
-- hundred vouchers at most, and the lock lasts milliseconds.
--
-- RESTRICT, as on `recordedById`: a person a voucher paid cannot be erased from
-- the record of it. Deleting a staff member is a `deletedAt` stamp (0065), so
-- the key never stands in the way of the product's own delete.
--
-- Needs 0074, which creates `expense_vouchers`. Numbered 0081: 0080 is this
-- branch's, and no local or remote branch held an 008x on 2026-10-09; check
-- again before the PR.

ALTER TABLE "expense_vouchers" ADD COLUMN IF NOT EXISTS "payeeStaffId" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'expense_vouchers_payeeStaffId_fkey' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "expense_vouchers"
      ADD CONSTRAINT "expense_vouchers_payeeStaffId_fkey"
      FOREIGN KEY ("payeeStaffId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

-- «ما قبضه هذا الموظف», newest first.
CREATE INDEX IF NOT EXISTS "expense_vouchers_payeeStaffId_occurredAt_idx"
  ON "expense_vouchers" ("payeeStaffId", "occurredAt" DESC);

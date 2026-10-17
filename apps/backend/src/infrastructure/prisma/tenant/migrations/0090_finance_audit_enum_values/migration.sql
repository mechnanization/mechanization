-- 0090_finance_audit_enum_values
--
-- == What it is for ==
--
-- Two enum values the finance audit remediation needs (2026-10-12), alone in
-- this file because a value cannot be used in the transaction that adds it
-- (docs/database.md, "Add an enum value"). `0091_finance_audit_controls` uses
-- the first in a CHECK; the code writes both.
--
--   * `PaymentStatus.CANCELLED` — «إلغاء الفاتورة»: the manager withdraws a bill
--     no money was taken on (a notice issued twice, a charge raised in error).
--     Before this a wrong bill could not be withdrawn at all: it stayed owed,
--     in every arrears list, for ever. A status rather than a flag alone, so
--     every read that asks for UNPAID or OVERDUE leaves a cancelled bill out
--     without being taught to.
--   * `WhishCheckoutState.MISMATCHED` — a Whish success callback whose amount is
--     not the amount the checkout quoted. The money moved at the provider, so
--     the checkout is neither FAILED nor SUCCEEDED; nothing is credited, and the
--     bill stays under review for a clerk to decide from the provider's record.
--
-- == Safety ==
--
-- Additive. `ADD VALUE IF NOT EXISTS` is idempotent and takes a brief lock on
-- the type only; no row is read or written. The previous release never writes
-- either value and reads both enums through Prisma, which this build's client
-- knows.

ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "WhishCheckoutState" ADD VALUE IF NOT EXISTS 'MISMATCHED';

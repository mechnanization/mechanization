-- 0102_one_off_charge_retry_key
--
-- A retry key for «تكليف مالي», the one-off charge raised on one citizen.
--
-- == What it is for ======================================================
--
--   clientRequestId   one id per press of «تكليف». A retry after a lost answer
--                     finds the bill the first press raised instead of raising
--                     a second one.
--
-- The charge sent no key and nothing deduplicated it: the only unique index on
-- the table, (citizenId, feeNoticeId, periodKey), never bites with feeNoticeId
-- NULL, so a lost answer followed by a second press billed the citizen twice
-- (docs/security.md, the Medium gap on «تكليف مالي»; task B11 of the
-- 2026-11-14 audits). A notice has had its own key since 0091, and a counter
-- payment since 0066.
--
-- == Safety ==============================================================
--
-- Additive only: one nullable column, NULL on every existing row, and one
-- unique index over it. NULLs are distinct, so every existing row passes it,
-- and so does every bill a notice raises, which carries no key. The previous
-- build never reads or writes the column; a rollback is a redeploy.
-- Idempotent: both statements can run twice.
--
-- The index is built without CONCURRENTLY because the migrator wraps each
-- migration in a transaction (docs/database.md). citizen_payments holds one
-- row per bill — a town-wide notice writes one per household, so tens of
-- thousands at the municipalities served today (not counted in production) —
-- and the build is one scan of a column that is NULL throughout, so the write
-- lock it takes lasts that scan.

ALTER TABLE "citizen_payments" ADD COLUMN IF NOT EXISTS "clientRequestId" UUID;

CREATE UNIQUE INDEX IF NOT EXISTS "citizen_payments_clientRequestId_key"
    ON "citizen_payments" ("clientRequestId");

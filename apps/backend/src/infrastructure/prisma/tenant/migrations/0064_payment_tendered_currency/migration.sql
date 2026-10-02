-- 0064_payment_tendered_currency
--
-- What was actually handed over at the counter, when it was not simply the
-- invoice's own currency.
--
-- == What it is for ======================================================
--
-- Bills are raised in LBP, and at a Lebanese counter they are paid in LBP,
-- in dollars, or in both at once — «20$ و200,000 ليرة». The ledger's `amount`
-- has to stay in the invoice's currency, because the balance is the sum of
-- those amounts. Until now that was all a cash row could say, so a payment of
-- $20 was recorded as 1,790,000 and nothing on the record said dollars changed
-- hands, or at what rate — the two things a cash-up at the end of the day, and
-- a citizen disputing their وصل, both ask first.
--
-- These columns hold the tender beside the credit:
--
--   tenderedLocal            the part handed over in the invoice's currency
--   tenderedForeign          the part handed over in another currency
--   tenderedForeignCurrency  which currency that was (USD, EUR)
--   exchangeRate             the rate it was taken at, local per one foreign
--
-- `amount` stays what was credited: tenderedLocal + tenderedForeign ×
-- exchangeRate, worked out by the server, never trusted from a client.
--
-- == Safety ==============================================================
--
-- Additive only. Every column is nullable and no existing row is touched, so
-- the previous build keeps working against this schema and a rollback is a
-- redeploy. A row written before this migration — or any non-cash row — simply
-- has all four NULL.
--
-- The CHECK keeps the foreign part whole: an amount with no currency, or a
-- currency with no rate, could not be read back as a tender at all. Adding it
-- validates the existing rows, all of which have NULL in all three, so it
-- cannot fail on data already there.

ALTER TABLE "payment_transactions"
    ADD COLUMN "tenderedLocal"           DECIMAL(14,2),
    ADD COLUMN "tenderedForeign"         DECIMAL(14,2),
    ADD COLUMN "tenderedForeignCurrency" TEXT,
    ADD COLUMN "exchangeRate"            DECIMAL(18,4);

ALTER TABLE "payment_transactions"
    ADD CONSTRAINT "payment_transactions_tendered_foreign_whole" CHECK (
        ("tenderedForeign" IS NULL) = ("tenderedForeignCurrency" IS NULL)
        AND ("tenderedForeign" IS NULL) = ("exchangeRate" IS NULL)
    );

-- 0091_finance_audit_controls
--
-- The columns the finance audit remediation needs (2026-10-12; the audit of
-- `refactor/ui-kit-adoption@68e3e55`, findings B3, B4 and A3, and the owner's
-- decisions of the same day). Needs `0090_finance_audit_enum_values`, whose
-- `CANCELLED` the CHECK below names, `0081` (`payeeStaffId`) and `0083` (the
-- urgent ceilings it mirrors).
--
-- == What it is for ==
--
-- 1. A notice is issued once (B3). `fee_notices.clientRequestId`, unique: the
--    wizard's id for one press of «إصدار». A notice bills every citizen it
--    targets, and the uniqueness of a bill is (citizen, notice, period), so a
--    retry after a lost answer created a second notice and billed the town a
--    second time. The key answers that retry with the first notice.
--
-- 2. A bill can be withdrawn (B3). `cancelledAt`, `cancelledById`,
--    `cancellationReason` on `citizen_payments`, with `paymentStatus`
--    `CANCELLED`. Only before any money is taken on it (`paidAmount` = 0): a
--    receipt is reversed first. The four move together, and a cancelled bill
--    has no money on it, by CHECK.
--
-- 3. Who raised a bill (B4). `citizen_payments.issuedById`: a one-off charge had
--    no notice and so no record at all of who raised it; a notice's bills name
--    the notice's issuer, and a recurring run's name nobody (the system). NULL on
--    every bill raised before this migration — never guessed.
--
-- 4. One salary per staff member per month (A3). `expense_vouchers.salaryPeriod`,
--    `YYYY-MM`, written only by «صرف راتب / أجر», and a partial unique index on
--    (payeeStaffId, salaryPeriod) over vouchers still standing: a cancelled
--    salary frees its month. NULL on every other voucher and on salaries paid
--    before this migration. Written once like the rest of the voucher (0083's
--    trigger compares the whole row, so the new column is covered unchanged).
--
-- 5. «سقف صرف الرواتب» (A3). `system_settings.salaryUrgentCeilingLbp` / `Usd`:
--    the most an accountant may pay one staff member as a month's salary on the
--    art. 35 path. NULL is no ceiling, which is where every municipality starts.
--    The urgent ceiling's twin (0083), CHECKed the same way.
--
-- == Safety ==
--
-- Additive: nullable columns, no default, no rewrite, no backfill. The previous
-- release writes none of them; it reads `citizen_payments` and `fee_notices`
-- through Prisma selects that name their columns, so the new ones are unseen.
--
-- Locks. The file holds ACCESS EXCLUSIVE on each table it alters until it
-- commits (docs/database.md). `citizen_payments` is the largest: one row per
-- citizen per notice per period, tens of thousands at the largest municipality
-- today. Its two CHECKs validate every row (each a single comparison) and its
-- two indexes are built without CONCURRENTLY (the migrator runs in a
-- transaction), together well under a second at that size, while the counter
-- waits. The other tables hold hundreds of rows at most.
--
-- Unqualified DDL (the migrator sets `search_path`); every catalog guard filters
-- on CURRENT_SCHEMA(); idempotent throughout.

-- ═══════════════════════════════  fee_notices  ═══════════════════════════════

ALTER TABLE "fee_notices" ADD COLUMN IF NOT EXISTS "clientRequestId" UUID;

CREATE UNIQUE INDEX IF NOT EXISTS "fee_notices_clientRequestId_key"
  ON "fee_notices" ("clientRequestId");

-- ═════════════════════════════  citizen_payments  ═════════════════════════════

ALTER TABLE "citizen_payments" ADD COLUMN IF NOT EXISTS "issuedById" UUID;
ALTER TABLE "citizen_payments" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMPTZ(3);
ALTER TABLE "citizen_payments" ADD COLUMN IF NOT EXISTS "cancelledById" UUID;
ALTER TABLE "citizen_payments" ADD COLUMN IF NOT EXISTS "cancellationReason" TEXT;

CREATE INDEX IF NOT EXISTS "citizen_payments_issuedById_idx" ON "citizen_payments" ("issuedById");
CREATE INDEX IF NOT EXISTS "citizen_payments_cancelledById_idx" ON "citizen_payments" ("cancelledById");

-- ═══════════════════════════  payment_transactions  ═══════════════════════════
--
-- 6. One Whish or bank reference, one receipt (B2). `PaymentLedgerService`
--    refuses a reference already on a receipt still standing, compared without
--    case or edge spaces; this is the index that comparison reads, over the rows
--    that carry one (Whish settlements only). Built without CONCURRENTLY on an
--    append-only table of one row per payment movement — the same order of size
--    as `citizen_payments` above.

CREATE INDEX IF NOT EXISTS "payment_transactions_externalRef_lower_idx"
  ON "payment_transactions" (lower(btrim("externalRef")))
  WHERE "externalRef" IS NOT NULL;

-- ═════════════════════════════  expense_vouchers  ═════════════════════════════

ALTER TABLE "expense_vouchers" ADD COLUMN IF NOT EXISTS "salaryPeriod" VARCHAR(7);

-- Over vouchers still standing: a cancelled salary frees its month for the right one.
CREATE UNIQUE INDEX IF NOT EXISTS "expense_vouchers_salary_period_key"
  ON "expense_vouchers" ("payeeStaffId", "salaryPeriod")
  WHERE "salaryPeriod" IS NOT NULL AND "voidedAt" IS NULL;

-- ═════════════════════════════  system_settings  ═════════════════════════════

ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "salaryUrgentCeilingLbp" DECIMAL(14,2);
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "salaryUrgentCeilingUsd" DECIMAL(14,2);

-- ═════════════════════════  foreign keys and CHECKs  ═════════════════════════

DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('citizen_payments', 'citizen_payments_issuedById_fkey',
         'FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('citizen_payments', 'citizen_payments_cancelledById_fkey',
         'FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      -- Who, when and why move together.
      ('citizen_payments', 'citizen_payments_cancellation_complete',
         'CHECK (("cancelledAt" IS NULL AND "cancelledById" IS NULL AND "cancellationReason" IS NULL)'
         || ' OR ("cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancellationReason" IS NOT NULL))'),
      -- The stamp and the status say the same thing, and a cancelled bill carries no money.
      ('citizen_payments', 'citizen_payments_cancelled_status',
         'CHECK ((("paymentStatus" = ''CANCELLED'') = ("cancelledAt" IS NOT NULL))'
         || ' AND ("cancelledAt" IS NULL OR "paidAmount" = 0))'),
      ('expense_vouchers', 'expense_vouchers_salary_period_format',
         'CHECK ("salaryPeriod" IS NULL OR "salaryPeriod" ~ ''^(19|20)[0-9]{2}-(0[1-9]|1[0-2])$'')'),
      -- A month belongs to a staff member's salary, never to a voucher without one.
      ('expense_vouchers', 'expense_vouchers_salary_period_has_payee',
         'CHECK ("salaryPeriod" IS NULL OR "payeeStaffId" IS NOT NULL)'),
      -- A ceiling of zero would refuse every accountant's salary payout; that is "no path", not a ceiling.
      ('system_settings', 'system_settings_salary_ceiling_lbp_positive',
         'CHECK ("salaryUrgentCeilingLbp" IS NULL OR "salaryUrgentCeilingLbp" > 0)'),
      ('system_settings', 'system_settings_salary_ceiling_usd_positive',
         'CHECK ("salaryUrgentCeilingUsd" IS NULL OR "salaryUrgentCeilingUsd" > 0)')
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

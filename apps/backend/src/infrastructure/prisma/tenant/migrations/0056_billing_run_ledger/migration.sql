-- 0056_billing_run_ledger
--
-- One row per notice per period the recurring biller attempted, whether it
-- worked or not.
--
-- == Why ===================================================================
--
-- `runRecurringBilling` computes only the period containing `now`. A tenant
-- whose run throws on every day of a period loses that period, and nothing
-- anywhere records that it was lost. The next run computes the next period and
-- the gap closes over: no error, no row, no number that is visibly wrong.
--
-- The per-tenant catch in `RecurringBillingJob` keeps one municipality's
-- failure from stopping the others, which is right. What it cannot do is tell
-- anyone afterwards which municipality was skipped, for which notice, or for
-- which month — it logs, and a log is not the register.
--
-- == What this is NOT ======================================================
--
-- **It does not back-bill.** A gap recorded here is a fact for a human to act
-- on, not an instruction to issue three months of invoices the next time the
-- job succeeds. That was a decision, not an omission: a citizen receiving a
-- quarter of bills at once because a pooler was down in February is a worse
-- outcome than a municipality noticing a gap and choosing what to do about it.
-- Issuing a missed period stays a deliberate act — an ordinary notice, raised
-- by somebody who decided to raise it.
--
-- **It is not a lock.** The unique key below makes a second run for the same
-- (notice, period) *record* nothing new rather than duplicating the row, but it
-- does not stop two replicas running the biller at once. What stops that is the
-- unique `(citizenId, feeNoticeId, periodKey)` triple on `citizen_payments`,
-- which `createMany({ skipDuplicates: true })` turns into `ON CONFLICT DO
-- NOTHING` — and, above that, `SCHEDULER_ENABLED`. See docs/open-decisions.md §5.
--
-- == No error text ========================================================
--
-- `failureKind` is a short classifier this codebase writes, not the driver's
-- message. A Postgres error quotes the row that caused it, and these runs touch
-- rows holding national ID numbers and residency status; a `message TEXT`
-- column here would become a citizen-data column by accident. The log holds the
-- detail, on a machine that is allowed to.
--
-- == Deploy order ==========================================================
--
-- Additive: one enum, one table, one unique index, two foreign keys. Apply
-- BEFORE the code, which inserts into it.
--
-- Written unqualified: the migrator sets `search_path` to the tenant schema and
-- wraps the file in one transaction. Idempotent throughout.

-- ═════════════════════════════════  enum  ═════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'BillingRunOutcome' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    -- SKIPPED is not a failure: a notice whose own first period is the current
    -- one, or one dated in the future, is correctly passed over. Recording it
    -- separately is what stops "no invoices" being read as "something broke".
    CREATE TYPE "BillingRunOutcome" AS ENUM ('ISSUED', 'SKIPPED', 'FAILED');
  END IF;
END
$$;

-- ═══════════════════════════  billing_run_entries  ═══════════════════════════

CREATE TABLE IF NOT EXISTS "billing_run_entries" (
  "id"          UUID                NOT NULL DEFAULT gen_random_uuid(),
  "feeNoticeId" UUID                NOT NULL,
  -- The same string `citizen_payments.periodKey` carries: '2026-02', '2026-H1',
  -- '2026'. Denormalised on purpose — the row has to survive the notice being
  -- deleted long enough to say what was missed, and it is what a human reads.
  "periodKey"   TEXT                NOT NULL,
  "outcome"     "BillingRunOutcome" NOT NULL,
  "citizensConsidered" INTEGER      NOT NULL DEFAULT 0,
  "invoicesCreated"    INTEGER      NOT NULL DEFAULT 0,
  -- A short classifier this codebase chooses, never a driver message.
  "failureKind" TEXT,
  "startedAt"   TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"  TIMESTAMP(3),

  CONSTRAINT "billing_run_entries_pkey" PRIMARY KEY ("id"),
  -- A failure says which kind; a success has nothing to explain.
  CONSTRAINT "billing_run_entries_failure_kind"
    CHECK (("outcome" = 'FAILED') = ("failureKind" IS NOT NULL)),
  -- Counts are counts.
  CONSTRAINT "billing_run_entries_counts_nonneg"
    CHECK ("citizensConsidered" >= 0 AND "invoicesCreated" >= 0),
  -- Nothing can be issued by a run that failed or was skipped.
  CONSTRAINT "billing_run_entries_issued_has_invoices"
    CHECK ("outcome" = 'ISSUED' OR "invoicesCreated" = 0)
);

-- ═══════════════════════════════  foreign keys  ═══════════════════════════════
--
-- The notice cascades: an entry about a notice that no longer exists is about
-- nothing, and keeping it would leave a row nobody can interpret.

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('billing_run_entries', 'billing_run_entries_feeNoticeId_fkey', 'feeNoticeId', 'fee_notices', 'CASCADE')
    ) AS t(tbl, name, col, ref, on_delete)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = fk.name AND n.nspname = CURRENT_SCHEMA()
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I("id") ON DELETE %s ON UPDATE CASCADE',
        fk.tbl, fk.name, fk.col, fk.ref, fk.on_delete
      );
    END IF;
  END LOOP;
END
$$;

-- ═════════════════════════════════  indexes  ═════════════════════════════════

-- One entry per notice per period. A second run in the same period updates the
-- row it already wrote rather than appending a second account of the same
-- attempt — the question this table answers is "was this period covered", and
-- two rows saying different things about one period cannot answer it.
CREATE UNIQUE INDEX IF NOT EXISTS "billing_run_entries_notice_period_key"
  ON "billing_run_entries" ("feeNoticeId", "periodKey");

-- "Which periods were missed?" — the reconciliation question, and the reason
-- the table exists. Partial: a healthy register is almost all ISSUED/SKIPPED.
CREATE INDEX IF NOT EXISTS "billing_run_entries_failed_idx"
  ON "billing_run_entries" ("startedAt")
  WHERE "outcome" = 'FAILED';

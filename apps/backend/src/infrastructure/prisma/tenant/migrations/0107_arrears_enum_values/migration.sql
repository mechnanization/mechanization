-- 0107_arrears_enum_values
--
-- == What it is for ==
--
-- The enum values old debts need («متأخرات سنوات سابقة», docs/old-debts-plan.md
-- §3.1), alone in this file because a value cannot be used in the transaction
-- that adds it (docs/database.md, "Add an enum value"). `0108_arrears` uses
-- every one of them in a table, a CHECK or a trigger.
--
--   * `PaymentStatus.WRITTEN_OFF` — «شطب»: what was left on a bill is forgiven
--     by a council decision (prescription, an amnesty, an uncollectable debt).
--     A status rather than a flag alone, for the reason 0090 gave CANCELLED: every
--     read that asks for UNPAID or OVERDUE leaves it out without being taught to.
--   * `ArrearsBatchStatus` — an import, DRAFT → SUBMITTED → APPROVED, or
--     DISCARDED.
--   * `ArrearsComponent` — a line is the principal of a year's fee, or the
--     penalty the old books charged on it (decision 6: never one the system adds).
--   * `ArrearsLineDecision` — KEEP, or DROP with a reason (prescription, war
--     damage, the accountant's call).
--
-- == Safety ==
--
-- Additive. `ADD VALUE IF NOT EXISTS` takes a brief lock on the type only and
-- reads or writes no row. The three new types are created only where missing,
-- the guard filtered on CURRENT_SCHEMA() (see 0050). Nothing in the build
-- serving production reads them, and nothing writes `WRITTEN_OFF` until the
-- «شطب» release (task 9), so that build never meets the value. A rollback is a
-- redeploy.

ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'WRITTEN_OFF';

DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('ArrearsBatchStatus', $q$('DRAFT', 'SUBMITTED', 'APPROVED', 'DISCARDED')$q$),
      ('ArrearsComponent', $q$('PRINCIPAL', 'PENALTY')$q$),
      ('ArrearsLineDecision', $q$('KEEP', 'DROP')$q$)
    ) AS t(name, labels)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname = item.name AND n.nspname = CURRENT_SCHEMA()
    ) THEN
      EXECUTE format('CREATE TYPE %I AS ENUM %s', item.name, item.labels);
    END IF;
  END LOOP;
END
$$;

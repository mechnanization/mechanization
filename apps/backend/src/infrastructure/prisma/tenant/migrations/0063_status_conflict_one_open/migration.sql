-- 0063_status_conflict_one_open
--
-- One open «تعارض في حالة الوحدة» case per flat, enforced by the database.
--
-- The code that opens one (`settleUnit`) checks for a standing case and then
-- inserts — and two saves settling the same flat at the same moment could
-- both see none and both insert, leaving the same review on the dispatch list
-- twice. The insert now goes through `ON CONFLICT DO NOTHING`; this is the
-- constraint it conflicts against. Partial, so resolved reviews — the history
-- — are untouched and any number of them may exist.
--
-- Its own migration, after 0062: the predicate names 'STATUS_CONFLICT', and an
-- enum value added by `ALTER TYPE … ADD VALUE` cannot be used in the
-- transaction that added it.
--
-- `cases` is small, and nothing has written a STATUS_CONFLICT row before this
-- ships (0062 added the value; the code that writes it ships after both), so
-- the index builds instantly and cannot find a duplicate. Not CONCURRENTLY for
-- the reason AGENTS.md §3 gives: the migrator wraps each migration in a
-- transaction.
--
-- Written unqualified: the migrator sets `search_path` to the target tenant
-- schema before running this.

CREATE UNIQUE INDEX IF NOT EXISTS "cases_status_conflict_open_unit_key"
  ON "cases" ("unitId")
  WHERE "caseType" = 'STATUS_CONFLICT' AND "status" IN ('OPEN', 'SCHEDULED');

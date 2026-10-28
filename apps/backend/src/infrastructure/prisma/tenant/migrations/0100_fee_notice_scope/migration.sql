-- 0100_fee_notice_scope
--
-- «من يشمل الإشعار» — which units and which people a fee notice reaches,
-- beyond its bearer and its target type.
--
-- == What it is for ======================================================
--
-- The user's decision of 2026-10-26. A notice could already say who bears it
-- (الشاغل or المالك) and aim at everyone, one category or one citizen. It now
-- also says, as a filter the clerk ticks:
--
--   categories            several property or unit types at once («محلات
--                         ومستودعات»), where `targetCategory` holds one.
--   unitStates            which حالة الوحدة values it charges: مشغولة من
--                         المالك، مؤجرة، مشغولة بتسامح، مسكن موسمي، شاغرة،
--                         قيد الإنجاز. A unit with no recorded status counts
--                         as مشغولة من المالك, as it always has.
--   residences            which kinds of file it reaches: مقيم في البلدة،
--                         غير مقيم في البلدة، تركة، جهة أو وقف.
--   acknowledgedWarnings  the warnings the clerk confirmed before issuing: an
--                         occupancy fee charged on an empty unit, a status or
--                         a residence kind the law charges left out.
--
-- Kept as one JSON object, validated in full by `feeNoticeScopeSchema` in
-- shared-schemas, as `matrixBrackets` (0099) is by `feeMatrixSchema`: the
-- values span three enums and a list of warnings, and nothing queries them —
-- the biller reads them back with the notice.
--
-- A missing key, or a NULL column, is the behaviour that came before: every
-- category the target type names, the statuses the bearer has always charged,
-- every kind of file. So every notice issued before this, and every recurring
-- run of one, bills exactly as it did.
--
-- == Safety ==============================================================
--
-- Additive. The column is nullable with no default, so no row is rewritten and
-- every existing row passes the CHECK. The build serving production when this
-- lands never reads or writes it; a rollback is a redeploy. A notice issued
-- with a scope and then re-run by a build from before this would be billed
-- without its filters, so roll back past the release that writes the column
-- only with no such notice active.
--
-- Locks, held to this file's commit: ACCESS EXCLUSIVE on `fee_notices` for the
-- ADD COLUMN and the CHECK's scan. A municipality has tens of notices, so the
-- file runs in well under a second.
--
-- The catalog guard filters on CURRENT_SCHEMA() (see 0050). Idempotent.
--
-- Written unqualified: the migrator sets `search_path` to the tenant schema.

ALTER TABLE "fee_notices" ADD COLUMN IF NOT EXISTS "scope" JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'fee_notices_scope_object' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "fee_notices"
      ADD CONSTRAINT "fee_notices_scope_object"
      CHECK ("scope" IS NULL OR jsonb_typeof("scope") = 'object');
  END IF;
END
$$;

-- 0068_damage_reinspect_at
--
-- «موعد إعادة الكشف» — when a unit read «غير قابلة للسكن» is to be inspected
-- again, once its repairs are done.
--
-- On the assessment, not the unit: the date belongs to the reading that asked
-- for it. Assessments stay append-only (D3) — the revisit is a new row with
-- whatever level the repaired unit now has, and the history keeps both. A unit
-- is waiting for its revisit while its latest reading is «غير قابلة للسكن».
--
-- Additive: one nullable column, no default, no rewrite of existing rows.

ALTER TABLE "damage_assessments" ADD COLUMN IF NOT EXISTS "reinspectAt" TIMESTAMP(3);

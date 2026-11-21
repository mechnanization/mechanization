-- 0111_unit_type_figures
--
-- «شكل النوع» — the drawing a unit type is given in the building elevation, for
-- the 27 default types 0110 inserted (مدرسة, مسجد, كنيسة, صيدلية, محطة وقود, …).
--
-- == What it is for ======================================================
--
-- The user's request of 2026-11-21: «implement their figures», each default type
-- drawn on its own — a dome and a minaret for a mosque, a canopy and a pump for
-- a fuel station — rather than with the plain front of its base (the glazed
-- office, the awning, the roller door). A unit keeps `units.unitType`, the base,
-- and billing reads that; this column only chooses the picture.
--
--   unit_types."figureKey"   the key of the drawing (`UNIT_FIGURE` in
--                            shared-schemas), or NULL for the base's own front.
--
-- No form sets it (the user's decision: defaults only), so it is written here
-- and nowhere else. It is plain text, not an enum: a build that does not know a
-- key draws the base's front (`knownUnitFigure`), so adding a drawing later is a
-- code change and an UPDATE, never a type change.
--
-- == Backfill ============================================================
--
-- One key per default type, matched by Arabic name and only on a row with no key
-- yet, so a replayed file changes nothing. A municipality that added a type
-- under one of these names itself gets the drawing too, which is the point of
-- the name. A system type keeps NULL: its front is the base's, as ever.
--
-- == Safety ==============================================================
--
-- Additive and idempotent: one nullable column on `unit_types`, which holds a few
-- dozen rows, and an UPDATE of at most 27 of them. The build before it never
-- reads the column. Needs 0110. Catalog guards filter on CURRENT_SCHEMA() (see
-- 0050). Written unqualified: the migrator sets `search_path` to the tenant schema.

ALTER TABLE "unit_types" ADD COLUMN IF NOT EXISTS "figureKey" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
    WHERE k.conname = 'unit_types_figure_key_shape' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    ALTER TABLE "unit_types"
      ADD CONSTRAINT "unit_types_figure_key_shape" CHECK ("figureKey" IS NULL OR "figureKey" ~ '^[A-Z][A-Z_]*$');
  END IF;
END
$$;

UPDATE "unit_types" t
SET "figureKey" = v."figureKey"
FROM (VALUES
  ('مدرسة',         'SCHOOL'),
  ('شركة كهرباء',   'ELECTRICITY'),
  ('مؤسسة مياه',    'WATER'),
  ('سرايا',         'SERAIL'),
  ('مبنى بلدي',     'MUNICIPAL'),
  ('مخفر',          'POLICE'),
  ('مركز أمني',     'SECURITY'),
  ('مسجد',          'MOSQUE'),
  ('كنيسة',         'CHURCH'),
  ('دار عبادة',     'WORSHIP'),
  ('مصرف',          'BANK'),
  ('مستوصف',        'DISPENSARY'),
  ('مركز صحي',      'HEALTH_CENTRE'),
  ('مطعم',          'RESTAURANT'),
  ('مقهى',          'CAFE'),
  ('صيدلية',        'PHARMACY'),
  ('مخبز',          'BAKERY'),
  ('فرن',           'OVEN'),
  ('محطة وقود',     'FUEL'),
  ('سوبرماركت',     'SUPERMARKET'),
  ('ملحمة',         'BUTCHER'),
  ('صالون حلاقة',   'BARBER'),
  ('صالون تجميل',   'BEAUTY'),
  ('ورشة',          'WORKSHOP'),
  ('مشغل',          'ATELIER'),
  ('معمل',          'PLANT'),
  ('مصنع',          'FACTORY')
) AS v("nameAr", "figureKey")
WHERE t."nameAr" = v."nameAr"
  AND NOT t."isSystem"
  AND t."figureKey" IS NULL;

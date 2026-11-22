-- 0110_default_unit_types
--
-- «أنواع الوحدات» every municipality starts with: the public, utility, worship,
-- health, shop and workshop types a survey meets (مدرسة, شركة كهرباء, مؤسسة
-- مياه, مستوصف, مسجد, مطعم, صيدلية, محطة وقود, ورشة, مصنع, …), beside the seven
-- system types 0109 inserted.
--
-- == What it is for ======================================================
--
-- The user's request of 2026-11-21: «add those types as default types», one
-- type per name (a pair such as «مسجد / كنيسة» is two types). The list is one
-- flat list on screen, so a default type is a row like any the manager adds.
--
-- == Not system rows =====================================================
--
-- `unit_types_system_base_key` allows one system row per base type, and every
-- type here shares a base with another. So these are ordinary rows
-- (`isSystem` false, no author): the manager may rename or switch off any of
-- them, and a type no unit uses may change base. Nothing is ever deleted.
--
-- == The base each one takes ==============================================
--
-- A unit keeps `units.unitType`, the base, and everything that draws or bills a
-- unit reads that — the elevation's picture (`property-illustrations.tsx`) and
-- the fee assessment alike. So the base is chosen for both:
--
--   OFFICE     the public and worship types and the bank: the glazed office
--              front. مدرسة, شركة كهرباء, مؤسسة مياه, سرايا, مبنى بلدي, مخفر,
--              مركز أمني, مسجد, كنيسة, دار عبادة, مصرف. Billed as an office:
--              a public building or a place of worship is exempted on
--              «قائمة الإعفاء من الرسوم», not by its type.
--   CLINIC     the clinic front with its cross. مستوصف, مركز صحي.
--   SHOP       the awning front. مطعم, مقهى, صيدلية, مخبز, فرن, محطة وقود,
--              سوبرماركت, ملحمة, صالون حلاقة, صالون تجميل.
--   WAREHOUSE  the roller door. ورشة, مشغل, معمل, مصنع.
--
-- A fee of its own for one of these is a later phase, set on the fee notice.
--
-- == Safety ==============================================================
--
-- Additive and idempotent: a row is inserted only when no type already has its
-- Arabic name, so a municipality that added «مدرسة» itself keeps its own row,
-- and a replayed file changes nothing. No unit is touched and no existing row
-- is rewritten. `unit_types` holds a few dozen rows, so there is no lock to
-- speak of; the build before this one never reads a row it did not know.
-- Needs 0109. Idempotent. Written unqualified: the migrator sets `search_path`
-- to the tenant schema.

INSERT INTO "unit_types" ("nameAr", "nameEn", "baseType", "isSystem", "sortOrder")
SELECT v."nameAr", v."nameEn", v."baseType"::"UnitType", false, 100
FROM (VALUES
  -- OFFICE: public buildings, utilities, places of worship, the bank.
  ('مدرسة',         'School',                'OFFICE'),
  ('شركة كهرباء',   'Electricity company',   'OFFICE'),
  ('مؤسسة مياه',    'Water company',         'OFFICE'),
  ('سرايا',         'Serail',                'OFFICE'),
  ('مبنى بلدي',     'Municipal building',    'OFFICE'),
  ('مخفر',          'Police station',        'OFFICE'),
  ('مركز أمني',     'Security post',         'OFFICE'),
  ('مسجد',          'Mosque',                'OFFICE'),
  ('كنيسة',         'Church',                'OFFICE'),
  ('دار عبادة',     'Place of worship',      'OFFICE'),
  ('مصرف',          'Bank',                  'OFFICE'),
  -- CLINIC: health.
  ('مستوصف',        'Dispensary',            'CLINIC'),
  ('مركز صحي',      'Health centre',         'CLINIC'),
  -- SHOP: trade and services with a shop front.
  ('مطعم',          'Restaurant',            'SHOP'),
  ('مقهى',          'Café',                  'SHOP'),
  ('صيدلية',        'Pharmacy',              'SHOP'),
  ('مخبز',          'Bakery',                'SHOP'),
  ('فرن',           'Bread oven',            'SHOP'),
  ('محطة وقود',     'Fuel station',          'SHOP'),
  ('سوبرماركت',     'Supermarket',           'SHOP'),
  ('ملحمة',         'Butcher',               'SHOP'),
  ('صالون حلاقة',   'Barber shop',           'SHOP'),
  ('صالون تجميل',   'Beauty salon',          'SHOP'),
  -- WAREHOUSE: workshops and production.
  ('ورشة',          'Workshop',              'WAREHOUSE'),
  ('مشغل',          'Craft workshop',        'WAREHOUSE'),
  ('معمل',          'Production plant',      'WAREHOUSE'),
  ('مصنع',          'Factory',               'WAREHOUSE')
) AS v("nameAr", "nameEn", "baseType")
WHERE NOT EXISTS (
  SELECT 1 FROM "unit_types" t WHERE t."nameAr" = v."nameAr"
);

-- 0115_request_form_dues_check
--
-- «يفحص مستحقات العقار» — the dues check becomes a setting of a form (open decisions §24 F13,
-- Hashem, 2026-11-22). Needs `0113_request_forms`.
--
-- Until now only the built-in براءة ذمة refused to be approved while the property owed
-- (`ParcelDuesService`, D3 of §20), keyed on the request type. With no built-in types (F1 as changed on
-- 2026-11-22) any form may ask for the same check:
--
--   request_forms."requiresNoDues"   the clerk's «جاهزة للاستلام» is refused while the property the request
--                                    names owes, and the check is kept on the request, exactly as the
--                                    clearance has always done.
--
-- The check needs a property, so a form that asks for it must require a card:
--
--   request_forms_dues_needs_property   CHECK ("requiresNoDues" => "propertyMode" = 'REQUIRED')
--
-- Additive: one NOT NULL column with a constant default (no table rewrite), and a CHECK on a table of a
-- few rows, which every existing row satisfies (the column is false). Idempotent: the column and the
-- constraint are each guarded, the constraint through the catalog of this schema.

ALTER TABLE "request_forms" ADD COLUMN IF NOT EXISTS "requiresNoDues" BOOLEAN NOT NULL DEFAULT false;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = CURRENT_SCHEMA()
       AND t.relname = 'request_forms'
       AND c.conname = 'request_forms_dues_needs_property'
  ) THEN
    ALTER TABLE "request_forms"
      ADD CONSTRAINT "request_forms_dues_needs_property"
      CHECK (NOT "requiresNoDues" OR "propertyMode" = 'REQUIRED');
  END IF;
END
$do$;

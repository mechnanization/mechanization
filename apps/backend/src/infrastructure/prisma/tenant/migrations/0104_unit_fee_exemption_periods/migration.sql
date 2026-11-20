-- 0104_unit_fee_exemption_periods
--
-- «قائمة الإعفاء من الرسوم»: the history of every unit's fee exemption, and
-- the date an exemption ends.
--
-- == What it is for ======================================================
--
-- 0077 put the exemption on the unit (`units.feeExemption*`): the live state
-- every billing reader asks. Lifting it wipes those columns, so the register
-- forgets that the unit was ever exempt, on whose decision and until when.
-- The user's decisions of 2026-11-16 (docs/fees-system-rearchitecture-
-- specification.md, "The fee whitelist"):
--
--   unit_fee_exemptions          one row per exemption **period** of a unit:
--                                why, the note, the council's decision number
--                                («رقم قرار المجلس»), the optional last day,
--                                who granted it and when, and once lifted who
--                                lifted it, when and why. At most one period
--                                per unit is open (not lifted).
--
--   units."feeExemptionValidUntil"
--                                the open period's last day, mirrored onto the
--                                unit beside the other live columns (decision
--                                1). NULL means no end date. A unit is exempt
--                                on a day D while `feeExemption` is set and
--                                (`feeExemptionValidUntil` IS NULL OR D <=
--                                `feeExemptionValidUntil`) — `isFeeExemptOn`
--                                in shared-schemas, and its SQL twin. A period
--                                that has ended is billed again; nothing lifts
--                                it automatically.
--
-- The `units.feeExemption*` columns stay the live state. The code that ships
-- after this writes them and the period row in one transaction, so no billing
-- reader has to change. The exemption still belongs to the unit, never to a
-- person: nothing here is keyed by a citizen.
--
-- == The rules, in the database ==========================================
--
--   unit_fee_exemptions_one_open_key        a partial unique index: one open
--                                           period per unit.
--   unit_fee_exemptions_other_note          «سبب آخر» carries its reason in
--                                           words, as on the unit (0077).
--   unit_fee_exemptions_text_not_blank      a note, a decision number and a
--                                           lift reason are absent or say
--                                           something.
--   unit_fee_exemptions_lift_fields         lifted means a time and a reason
--                                           (the lifter may later be SET NULL);
--                                           an open period has none of the
--                                           three.
--   unit_fee_exemptions_lifted_after_grant  a period is lifted after it began.
--   units_fee_exemption_valid_until_needs_reason
--                                           an end date only on an exempt unit,
--                                           so lifting clears it with the rest.
--
-- Keys: the unit is RESTRICT — a unit with an exemption history is not
-- deleted out from under it; the code refuses such a delete first with a coded
-- error. Grantor and lifter are SET NULL, as `units.feeExemptedById` is
-- (0077): the decision stands after the person leaves.
--
-- == Backfill ============================================================
--
-- One open period for every unit exempt today, from its own columns: reason,
-- note (blank read as none), grantor and date (`feeExemptedAt` is set on every
-- exempt unit, by 0077's CHECK). No decision number and no end date: neither
-- was ever recorded. Skipped for a unit that already has an open period, so a
-- replayed file inserts nothing.
--
-- == Safety ==============================================================
--
-- Additive: one new table, one nullable column with no default (no rewrite of
-- `units`), one CHECK every existing unit passes (the column is NULL on all of
-- them), and an INSERT into the new table. No existing row is changed.
--
-- Locks, held to this file's commit (docs/database.md, "How tenant migrations
-- run"): ACCESS EXCLUSIVE on `units` for the ADD COLUMN and the CHECK's scan.
-- `units` holds a few thousand rows per municipality, so the file runs in well
-- under a second. The indexes are built on the new table, which holds only the
-- backfilled rows (as many as there are exempt units, a handful).
--
-- The build serving production when this lands never reads the table or the
-- column, and keeps working: it still writes the unit's columns when it grants
-- or lifts, and the table simply does not hear about it. A grant made by that
-- build after this file runs has no period row, and a lift made by it leaves
-- its period open; the feature that reads the table reconciles a unit whose
-- live state and open period disagree when it next writes it. A rollback is a
-- redeploy.
--
-- One behaviour of that build changes, in the safe direction: deleting a unit
-- that holds a period (every unit exempt today, from the backfill) — a unit or
-- building delete, a «حذف تصحيحي», a «دمج كدوبلكس» — now fails on the unit
-- key instead of taking the exemption with it, and that build reports the
-- refusal as a 500 (docs/gotchas.md, "A new RESTRICT key turns an existing
-- delete into a 500"). Those paths already refuse a unit anyone has lived in,
-- so this reaches only an exempt unit with no spell, card, reading, visit or
-- vacancy on it. The feature release refuses it first, with a code.
--
-- Catalog guards filter on CURRENT_SCHEMA() (see 0050). Idempotent. Written
-- unqualified: the migrator sets `search_path` to the tenant schema.

-- ═══════════════════════════════  table  ══════════════════════════════════

CREATE TABLE IF NOT EXISTS "unit_fee_exemptions" (
  "id"          UUID                 NOT NULL DEFAULT gen_random_uuid(),
  "unitId"      UUID                 NOT NULL,
  "reason"      "FeeExemptionReason" NOT NULL,
  "note"        TEXT,
  "decisionRef" TEXT,
  "validUntil"  DATE,
  "grantedById" UUID,
  "grantedAt"   TIMESTAMP(3)         NOT NULL,
  "liftedById"  UUID,
  "liftedAt"    TIMESTAMP(3),
  "liftReason"  TEXT,
  CONSTRAINT "unit_fee_exemptions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "feeExemptionValidUntil" DATE;

-- ═════════════════════════  keys and checks  ══════════════════════════════

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('unit_fee_exemptions', 'unit_fee_exemptions_unitId_fkey',
         'FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('unit_fee_exemptions', 'unit_fee_exemptions_grantedById_fkey',
         'FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE'),
      ('unit_fee_exemptions', 'unit_fee_exemptions_liftedById_fkey',
         'FOREIGN KEY ("liftedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE'),
      ('unit_fee_exemptions', 'unit_fee_exemptions_other_note',
         $c$CHECK ("reason" <> 'OTHER' OR btrim(coalesce("note", '')) <> '')$c$),
      ('unit_fee_exemptions', 'unit_fee_exemptions_text_not_blank',
         $c$CHECK (("note" IS NULL OR btrim("note") <> '')
                AND ("decisionRef" IS NULL OR btrim("decisionRef") <> '')
                AND ("liftReason" IS NULL OR btrim("liftReason") <> ''))$c$),
      ('unit_fee_exemptions', 'unit_fee_exemptions_lift_fields',
         $c$CHECK (("liftedAt" IS NULL) = ("liftReason" IS NULL)
                AND ("liftedAt" IS NOT NULL OR "liftedById" IS NULL))$c$),
      ('unit_fee_exemptions', 'unit_fee_exemptions_lifted_after_grant',
         $c$CHECK ("liftedAt" IS NULL OR "liftedAt" >= "grantedAt")$c$),
      ('units', 'units_fee_exemption_valid_until_needs_reason',
         $c$CHECK ("feeExemptionValidUntil" IS NULL OR "feeExemption" IS NOT NULL)$c$)
    ) AS t(tbl, name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
      WHERE k.conname = c.name AND n.nspname = CURRENT_SCHEMA()
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', c.tbl, c.name, c.definition);
    END IF;
  END LOOP;
END
$$;

-- ══════════════════════════════  indexes  ═════════════════════════════════

-- One open period per unit. Not expressible in Prisma 5; the model says so.
CREATE UNIQUE INDEX IF NOT EXISTS "unit_fee_exemptions_one_open_key"
  ON "unit_fee_exemptions" ("unitId") WHERE "liftedAt" IS NULL;
-- A unit's history, newest first; also serves the unit key's RESTRICT check.
CREATE INDEX IF NOT EXISTS "unit_fee_exemptions_unitId_grantedAt_idx"
  ON "unit_fee_exemptions" ("unitId", "grantedAt");
CREATE INDEX IF NOT EXISTS "unit_fee_exemptions_grantedById_idx" ON "unit_fee_exemptions" ("grantedById");
CREATE INDEX IF NOT EXISTS "unit_fee_exemptions_liftedById_idx" ON "unit_fee_exemptions" ("liftedById");

-- ══════════════════════════════  backfill  ════════════════════════════════

INSERT INTO "unit_fee_exemptions" ("unitId", "reason", "note", "grantedById", "grantedAt")
SELECT u."id", u."feeExemption", NULLIF(btrim(u."feeExemptionNote"), ''), u."feeExemptedById", u."feeExemptedAt"
FROM "units" u
WHERE u."feeExemption" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "unit_fee_exemptions" e
    WHERE e."unitId" = u."id" AND e."liftedAt" IS NULL
  );

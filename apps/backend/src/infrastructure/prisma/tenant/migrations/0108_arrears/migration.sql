-- 0108_arrears
--
-- Old debts, «متأخرات سنوات سابقة» (docs/old-debts-plan.md §3.2): what citizens
-- owe from the municipality's old books, brought in as batches the accountant
-- prepares and the manager approves, and the «شطب» write-off of a bill. Needs
-- `0107_arrears_enum_values`, whose values every table, CHECK and trigger below
-- names.
--
-- == What it is for ======================================================
--
--   arrears_batches          one import, from the template's export to its
--                            approval. DRAFT → SUBMITTED → APPROVED;
--                            SUBMITTED → DRAFT when the manager returns it;
--                            DRAFT or SUBMITTED → DISCARDED. APPROVED and
--                            DISCARDED are final. `controlTotal` is the
--                            accountant's hand-added total of the pages copied.
--   arrears_batch_citizens   the citizens a template was exported for, each
--                            with the small `rowKey` the file carries instead of
--                            any identifier. «Checked against the old books» is
--                            counted from here, owed or not.
--   arrears_lines            one debt: citizen × رقم العقار (unit if known) ×
--                            year × fee type × principal or penalty. A NULL
--                            citizen is a line waiting in «للمطابقة», named by
--                            `sourceName` as the books wrote it.
--   arrears_control_totals   the old books' arrears total per year. Proposed,
--                            not decided (open-decisions §23.4); ships empty so
--                            the answer needs no migration.
--   system_settings."arrearsCutoffYear"
--                            old debt is a year before this one (decision 5).
--                            NULL until the manager sets it; the code refuses
--                            every import while it is NULL.
--   citizen_payments."arrearsLineId"
--                            the line an «ARR-» bill was raised for. The only
--                            link between the two: a second one on the line
--                            could disagree with it, and would need an UPDATE
--                            after the line is locked.
--   citizen_payments.writtenOff*, writeOff*
--                            «شطب»: who wrote off what was left on a bill, by
--                            which council decision, when and why.
--
-- == The rules, in the database ==========================================
--
--   arrears_lines_one_live_key   one live line per citizen × رقم العقار (Eastern
--                                digits folded, edges trimmed) × unit code ×
--                                year × fee type × component. A dropped line
--                                and a discarded batch's lines leave it, so
--                                they never block the right one. Not
--                                expressible in Prisma 5.
--   arrears_batches_guard        the moves above; a batch is never deleted; an
--                                APPROVED or DISCARDED batch never changes; a
--                                SUBMITTED one changes only by leaving that
--                                status, its figures untouched.
--   arrears_batches_discard_lines
--                                discarding a batch stamps `discardedAt` on
--                                its lines, so nothing has to remember to.
--   arrears_lines_guard          lines are written into, and removed from, a
--                                DRAFT batch only. Outside a draft a line keeps
--                                every column, except: its citizen (a link from
--                                NULL, on an APPROVED batch, with its link
--                                stamps; or a «دمج ملفين» moving it between two
--                                files), its `unitId` (cleared by the unit's
--                                SET NULL) and `discardedAt` (stamped once,
--                                on a DISCARDED batch).
--   arrears_batch_citizens_guard the set is written at export, into a DRAFT
--                                batch, and never changes after it except a
--                                merge moving its citizen.
--   CHECKs                       amounts above zero; LBP only (decision 13); a
--                                DROP carries a reason and a KEEP none; «رسم
--                                آخر» says what it was; a line names a citizen
--                                or the name in the books; stamps move in
--                                pairs and with their status.
--   citizen_payments             the six write-off columns move together and
--                                with WRITTEN_OFF; the reason and the decision
--                                number say something; what is written off is
--                                above zero and exactly what was left
--                                (`paidAmount + writeOffAmount = amount`).
--
-- Every trigger refusal starts «arrears batch» / «arrears line» / «arrears
-- batch citizen» and raises `check_violation`: each is a code path that broke a
-- rule, not a user's mistake to localise. The functions read
-- `arrears_batches`, so their `search_path` is pinned to the schema they serve
-- (as 0094 does), never left to the caller's.
--
-- Keys: people (preparer, approver, linker, citizen, writer-off) are RESTRICT,
-- as on every finance table: a citizen file is never deleted, and a staff
-- account that approved a batch is not erased from under it. A unit is SET
-- NULL — `unitCode` keeps what the line said — so deleting a unit is never
-- refused because an old debt once named it. A bill's line is RESTRICT.
--
-- == Safety ==============================================================
--
-- Additive: four new tables, nullable columns with no default on
-- `citizen_payments` and `system_settings` (no rewrite), CHECKs every existing
-- row passes (the new columns are NULL on all of them, and no bill is
-- WRITTEN_OFF), and triggers on the new tables only. No existing row is
-- changed.
--
-- Locks, held to this file's commit (docs/database.md, "How tenant migrations
-- run"): ACCESS EXCLUSIVE on `citizen_payments` for its ADD COLUMNs, the CHECKs'
-- scan and the two index builds, and on `system_settings` (one row). Bills run
-- to a few thousand rows per municipality, so the file holds them well under a
-- second. The other indexes are built on new, empty tables.
--
-- The build serving production when this lands never reads the new tables or
-- columns, and keeps working: its inserts into `citizen_payments` leave the
-- new columns NULL, which every CHECK accepts. A rollback is a redeploy.
--
-- New written-once tables get 0103's TRUNCATE guard here, in the file that
-- creates them. The local reset tools switch every `_no_truncate` guard they
-- find, so they need no change for it.
--
-- Catalog guards filter on CURRENT_SCHEMA() (see 0050). Idempotent. Written
-- unqualified: the migrator sets `search_path` to the tenant schema.

-- ═══════════════════════════════  tables  ═════════════════════════════════

CREATE TABLE IF NOT EXISTS "arrears_batches" (
  "id"              UUID                 NOT NULL DEFAULT gen_random_uuid(),
  "status"          "ArrearsBatchStatus" NOT NULL DEFAULT 'DRAFT',
  "scope"           JSONB,
  "preparedById"    UUID                 NOT NULL,
  "submittedAt"     TIMESTAMPTZ(3),
  "submittedById"   UUID,
  "approvedAt"      TIMESTAMPTZ(3),
  "approvedById"    UUID,
  "discardedAt"     TIMESTAMPTZ(3),
  "discardedById"   UUID,
  "returnNote"      TEXT,
  "controlTotal"    DECIMAL(14,2),
  "sourceNote"      TEXT,
  "clientRequestId" UUID,
  "createdAt"       TIMESTAMPTZ(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMPTZ(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "arrears_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "arrears_batch_citizens" (
  "id"        UUID           NOT NULL DEFAULT gen_random_uuid(),
  "batchId"   UUID           NOT NULL,
  "citizenId" UUID           NOT NULL,
  "rowKey"    INTEGER        NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "arrears_batch_citizens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "arrears_lines" (
  "id"             UUID                  NOT NULL DEFAULT gen_random_uuid(),
  "batchId"        UUID                  NOT NULL,
  "citizenId"      UUID,
  "sourceName"     TEXT,
  "rowKey"         INTEGER,
  "propertyNumber" TEXT                  NOT NULL,
  "unitId"         UUID,
  "unitCode"       TEXT,
  "year"           INTEGER               NOT NULL,
  "feeType"        TEXT                  NOT NULL,
  "feeTypeNote"    TEXT,
  "component"      "ArrearsComponent"    NOT NULL,
  "amount"         DECIMAL(14,2)         NOT NULL,
  "currency"       TEXT                  NOT NULL DEFAULT 'LBP',
  "dueDate"        DATE,
  "oldReference"   TEXT,
  "note"           TEXT,
  "decision"       "ArrearsLineDecision" NOT NULL DEFAULT 'KEEP',
  "dropReason"     TEXT,
  "flags"          JSONB                 NOT NULL DEFAULT '{}',
  "linkedAt"       TIMESTAMPTZ(3),
  "linkedById"     UUID,
  "discardedAt"    TIMESTAMPTZ(3),
  "createdAt"      TIMESTAMPTZ(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "arrears_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "arrears_control_totals" (
  "id"          UUID           NOT NULL DEFAULT gen_random_uuid(),
  "year"        INTEGER        NOT NULL,
  "amount"      DECIMAL(14,2)  NOT NULL,
  "currency"    TEXT           NOT NULL DEFAULT 'LBP',
  "enteredById" UUID           NOT NULL,
  "enteredAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "arrears_control_totals_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "arrearsCutoffYear" INTEGER;

ALTER TABLE "citizen_payments" ADD COLUMN IF NOT EXISTS "arrearsLineId" UUID;
ALTER TABLE "citizen_payments" ADD COLUMN IF NOT EXISTS "writtenOffAt" TIMESTAMPTZ(3);
ALTER TABLE "citizen_payments" ADD COLUMN IF NOT EXISTS "writtenOffById" UUID;
ALTER TABLE "citizen_payments" ADD COLUMN IF NOT EXISTS "writeOffAmount" DECIMAL(14,2);
ALTER TABLE "citizen_payments" ADD COLUMN IF NOT EXISTS "writeOffReason" TEXT;
ALTER TABLE "citizen_payments" ADD COLUMN IF NOT EXISTS "writeOffDecisionRef" TEXT;
ALTER TABLE "citizen_payments" ADD COLUMN IF NOT EXISTS "writeOffDecisionDate" DATE;

-- ═════════════════════════  keys and checks  ══════════════════════════════

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      -- arrears_batches
      ('arrears_batches', 'arrears_batches_preparedById_fkey',
         'FOREIGN KEY ("preparedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('arrears_batches', 'arrears_batches_submittedById_fkey',
         'FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('arrears_batches', 'arrears_batches_approvedById_fkey',
         'FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('arrears_batches', 'arrears_batches_discardedById_fkey',
         'FOREIGN KEY ("discardedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('arrears_batches', 'arrears_batches_submitted_pair',
         $c$CHECK (("submittedAt" IS NULL) = ("submittedById" IS NULL))$c$),
      -- A draft has not been submitted (a return clears it); a submitted or
      -- approved batch was, with its control total.
      ('arrears_batches', 'arrears_batches_submitted_status',
         $c$CHECK (("status" <> 'DRAFT' OR "submittedAt" IS NULL)
                AND ("status" NOT IN ('SUBMITTED', 'APPROVED') OR ("submittedAt" IS NOT NULL AND "controlTotal" IS NOT NULL)))$c$),
      ('arrears_batches', 'arrears_batches_approved_status',
         $c$CHECK ((("status" = 'APPROVED') = ("approvedAt" IS NOT NULL))
                AND (("approvedAt" IS NULL) = ("approvedById" IS NULL)))$c$),
      ('arrears_batches', 'arrears_batches_discarded_status',
         $c$CHECK ((("status" = 'DISCARDED') = ("discardedAt" IS NOT NULL))
                AND (("discardedAt" IS NULL) = ("discardedById" IS NULL)))$c$),
      ('arrears_batches', 'arrears_batches_control_total_not_negative',
         $c$CHECK ("controlTotal" IS NULL OR "controlTotal" >= 0)$c$),
      ('arrears_batches', 'arrears_batches_text_not_blank',
         $c$CHECK (("returnNote" IS NULL OR btrim("returnNote") <> '')
                AND ("sourceNote" IS NULL OR btrim("sourceNote") <> ''))$c$),
      ('arrears_batches', 'arrears_batches_scope_object',
         $c$CHECK ("scope" IS NULL OR jsonb_typeof("scope") = 'object')$c$),

      -- arrears_batch_citizens
      ('arrears_batch_citizens', 'arrears_batch_citizens_batchId_fkey',
         'FOREIGN KEY ("batchId") REFERENCES "arrears_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('arrears_batch_citizens', 'arrears_batch_citizens_citizenId_fkey',
         'FOREIGN KEY ("citizenId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('arrears_batch_citizens', 'arrears_batch_citizens_row_key_positive',
         $c$CHECK ("rowKey" > 0)$c$),

      -- arrears_lines
      ('arrears_lines', 'arrears_lines_batchId_fkey',
         'FOREIGN KEY ("batchId") REFERENCES "arrears_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('arrears_lines', 'arrears_lines_citizenId_fkey',
         'FOREIGN KEY ("citizenId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('arrears_lines', 'arrears_lines_unitId_fkey',
         'FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE'),
      ('arrears_lines', 'arrears_lines_linkedById_fkey',
         'FOREIGN KEY ("linkedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('arrears_lines', 'arrears_lines_amount_positive',
         $c$CHECK ("amount" > 0)$c$),
      ('arrears_lines', 'arrears_lines_currency_lbp',
         $c$CHECK ("currency" = 'LBP')$c$),
      ('arrears_lines', 'arrears_lines_year_range',
         $c$CHECK ("year" BETWEEN 1900 AND 2100)$c$),
      ('arrears_lines', 'arrears_lines_row_key_positive',
         $c$CHECK ("rowKey" IS NULL OR "rowKey" > 0)$c$),
      ('arrears_lines', 'arrears_lines_drop_reason',
         $c$CHECK (("decision" = 'KEEP' AND "dropReason" IS NULL)
                OR ("decision" = 'DROP' AND btrim(coalesce("dropReason", '')) <> ''))$c$),
      ('arrears_lines', 'arrears_lines_names_someone',
         $c$CHECK ("citizenId" IS NOT NULL OR btrim(coalesce("sourceName", '')) <> '')$c$),
      ('arrears_lines', 'arrears_lines_other_fee_note',
         $c$CHECK ("feeType" <> 'OTHER' OR btrim(coalesce("feeTypeNote", '')) <> '')$c$),
      ('arrears_lines', 'arrears_lines_text_not_blank',
         $c$CHECK (btrim("propertyNumber") <> '' AND btrim("feeType") <> ''
                AND ("sourceName" IS NULL OR btrim("sourceName") <> '')
                AND ("unitCode" IS NULL OR btrim("unitCode") <> '')
                AND ("feeTypeNote" IS NULL OR btrim("feeTypeNote") <> '')
                AND ("oldReference" IS NULL OR btrim("oldReference") <> '')
                AND ("note" IS NULL OR btrim("note") <> ''))$c$),
      ('arrears_lines', 'arrears_lines_unit_has_code',
         $c$CHECK ("unitId" IS NULL OR "unitCode" IS NOT NULL)$c$),
      ('arrears_lines', 'arrears_lines_flags_object',
         $c$CHECK (jsonb_typeof("flags") = 'object')$c$),
      -- Linked: when and by whom together, and only onto a citizen.
      ('arrears_lines', 'arrears_lines_link_pair',
         $c$CHECK ((("linkedAt" IS NULL) = ("linkedById" IS NULL))
                AND ("linkedAt" IS NULL OR "citizenId" IS NOT NULL))$c$),

      -- arrears_control_totals
      ('arrears_control_totals', 'arrears_control_totals_enteredById_fkey',
         'FOREIGN KEY ("enteredById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('arrears_control_totals', 'arrears_control_totals_amount_not_negative',
         $c$CHECK ("amount" >= 0)$c$),
      ('arrears_control_totals', 'arrears_control_totals_currency_lbp',
         $c$CHECK ("currency" = 'LBP')$c$),
      ('arrears_control_totals', 'arrears_control_totals_year_range',
         $c$CHECK ("year" BETWEEN 1900 AND 2100)$c$),

      -- system_settings
      ('system_settings', 'system_settings_arrears_cutoff_year_range',
         $c$CHECK ("arrearsCutoffYear" IS NULL OR "arrearsCutoffYear" BETWEEN 2000 AND 2100)$c$),

      -- citizen_payments
      ('citizen_payments', 'citizen_payments_arrearsLineId_fkey',
         'FOREIGN KEY ("arrearsLineId") REFERENCES "arrears_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('citizen_payments', 'citizen_payments_writtenOffById_fkey',
         'FOREIGN KEY ("writtenOffById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      -- Who, when, how much, why and on which decision move together.
      ('citizen_payments', 'citizen_payments_write_off_complete',
         $c$CHECK (("writtenOffAt" IS NULL AND "writtenOffById" IS NULL AND "writeOffAmount" IS NULL
                   AND "writeOffReason" IS NULL AND "writeOffDecisionRef" IS NULL AND "writeOffDecisionDate" IS NULL)
                OR ("writtenOffAt" IS NOT NULL AND "writtenOffById" IS NOT NULL AND "writeOffAmount" IS NOT NULL
                   AND "writeOffReason" IS NOT NULL AND "writeOffDecisionRef" IS NOT NULL AND "writeOffDecisionDate" IS NOT NULL))$c$),
      -- The stamp and the status say the same thing.
      ('citizen_payments', 'citizen_payments_written_off_status',
         $c$CHECK (("paymentStatus" = 'WRITTEN_OFF') = ("writtenOffAt" IS NOT NULL))$c$),
      -- What is written off is what was left, no more and no less.
      ('citizen_payments', 'citizen_payments_write_off_amount',
         $c$CHECK ("writeOffAmount" IS NULL
                OR ("writeOffAmount" > 0 AND "paidAmount" + "writeOffAmount" = "amount"))$c$),
      ('citizen_payments', 'citizen_payments_write_off_text_present',
         $c$CHECK (("writeOffReason" IS NULL OR btrim("writeOffReason") <> '')
                AND ("writeOffDecisionRef" IS NULL OR btrim("writeOffDecisionRef") <> ''))$c$)
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

CREATE UNIQUE INDEX IF NOT EXISTS "arrears_batches_clientRequestId_key" ON "arrears_batches" ("clientRequestId");
CREATE INDEX IF NOT EXISTS "arrears_batches_status_idx" ON "arrears_batches" ("status");
CREATE INDEX IF NOT EXISTS "arrears_batches_preparedById_idx" ON "arrears_batches" ("preparedById");
CREATE INDEX IF NOT EXISTS "arrears_batches_submittedById_idx" ON "arrears_batches" ("submittedById");
CREATE INDEX IF NOT EXISTS "arrears_batches_approvedById_idx" ON "arrears_batches" ("approvedById");
CREATE INDEX IF NOT EXISTS "arrears_batches_discardedById_idx" ON "arrears_batches" ("discardedById");

-- A row key means one person inside its batch. Not unique per citizen: a
-- merge can bring two of a batch's people onto one file.
CREATE UNIQUE INDEX IF NOT EXISTS "arrears_batch_citizens_batchId_rowKey_key"
  ON "arrears_batch_citizens" ("batchId", "rowKey");
CREATE INDEX IF NOT EXISTS "arrears_batch_citizens_batchId_citizenId_idx"
  ON "arrears_batch_citizens" ("batchId", "citizenId");
CREATE INDEX IF NOT EXISTS "arrears_batch_citizens_citizenId_idx" ON "arrears_batch_citizens" ("citizenId");

CREATE INDEX IF NOT EXISTS "arrears_lines_batchId_idx" ON "arrears_lines" ("batchId");
CREATE INDEX IF NOT EXISTS "arrears_lines_citizenId_idx" ON "arrears_lines" ("citizenId");
CREATE INDEX IF NOT EXISTS "arrears_lines_unitId_idx" ON "arrears_lines" ("unitId");
CREATE INDEX IF NOT EXISTS "arrears_lines_linkedById_idx" ON "arrears_lines" ("linkedById");
CREATE INDEX IF NOT EXISTS "arrears_lines_year_idx" ON "arrears_lines" ("year");

-- One live line per debt. The رقم العقار is compared as `normalizeDigits` and
-- `ParcelDuesService` compare it (Arabic-Indic and Persian digits to Latin,
-- the `EASTERN_DIGITS` of shared-schemas), the unit code without case or edge
-- spaces, a missing unit as the empty string.
CREATE UNIQUE INDEX IF NOT EXISTS "arrears_lines_one_live_key"
  ON "arrears_lines" (
    "citizenId",
    translate(btrim("propertyNumber"), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'),
    upper(btrim(coalesce("unitCode", ''))),
    "year",
    "feeType",
    "component"
  )
  WHERE "citizenId" IS NOT NULL AND "decision" = 'KEEP' AND "discardedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "arrears_control_totals_year_key" ON "arrears_control_totals" ("year");
CREATE INDEX IF NOT EXISTS "arrears_control_totals_enteredById_idx" ON "arrears_control_totals" ("enteredById");

CREATE UNIQUE INDEX IF NOT EXISTS "citizen_payments_arrearsLineId_key" ON "citizen_payments" ("arrearsLineId");
CREATE INDEX IF NOT EXISTS "citizen_payments_writtenOffById_idx" ON "citizen_payments" ("writtenOffById");

-- ═══════════════════════════  batch guard  ════════════════════════════════

CREATE OR REPLACE FUNCTION guard_arrears_batch() RETURNS TRIGGER AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'arrears batch %: a batch is never deleted; discard it instead', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'arrears batch %: a batch starts as a DRAFT', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" <> OLD."id" OR NEW."preparedById" <> OLD."preparedById"
     OR NEW."createdAt" <> OLD."createdAt"
     OR NEW."clientRequestId" IS DISTINCT FROM OLD."clientRequestId" THEN
    RAISE EXCEPTION 'arrears batch %: who prepared it, when and under which key never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" IN ('APPROVED', 'DISCARDED') THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'arrears batch %: an % batch does not change', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" IN ('SUBMITTED', 'DISCARDED'))
    OR (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('DRAFT', 'APPROVED', 'DISCARDED'))
  ) THEN
    RAISE EXCEPTION 'arrears batch %: % cannot become %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  -- A submitted batch is what the manager is judging: it changes only by
  -- leaving SUBMITTED, and never in its figures.
  IF OLD."status" = 'SUBMITTED' AND (
       (NEW."status" = 'SUBMITTED' AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt'))
    OR NEW."controlTotal" IS DISTINCT FROM OLD."controlTotal"
    OR NEW."scope" IS DISTINCT FROM OLD."scope"
    OR NEW."sourceNote" IS DISTINCT FROM OLD."sourceNote"
  ) THEN
    RAISE EXCEPTION 'arrears batch %: a submitted batch changes only by being approved, returned or discarded', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$fn$ LANGUAGE plpgsql SET search_path = pg_catalog;

-- Discarding a batch takes its lines out of the one-live-line index.
CREATE OR REPLACE FUNCTION discard_arrears_batch_lines() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW."status" = 'DISCARDED' AND OLD."status" <> 'DISCARDED' THEN
    UPDATE arrears_lines SET "discardedAt" = NEW."discardedAt"
     WHERE "batchId" = NEW."id" AND "discardedAt" IS NULL;
  END IF;
  RETURN NULL;
END
$fn$ LANGUAGE plpgsql;

-- ═══════════════════════════  line guard  ═════════════════════════════════

CREATE OR REPLACE FUNCTION guard_arrears_line() RETURNS TRIGGER AS $fn$
DECLARE
  batch_status "ArrearsBatchStatus";
  moving CONSTANT TEXT[] := ARRAY['citizenId', 'linkedAt', 'linkedById', 'unitId', 'discardedAt', 'updatedAt'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT b."status" INTO batch_status FROM arrears_batches b WHERE b."id" = NEW."batchId";
    -- No batch: the foreign key refuses it next, under its own name.
    IF batch_status IS NOT NULL AND batch_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'arrears line: lines are written into a DRAFT batch only (batch % is %)', NEW."batchId", batch_status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."linkedAt" IS NOT NULL OR NEW."discardedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'arrears line: a new line is neither linked nor discarded'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT b."status" INTO batch_status FROM arrears_batches b WHERE b."id" = OLD."batchId";

  IF TG_OP = 'DELETE' THEN
    IF batch_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'arrears line %: a line leaves a DRAFT batch only (this one is %)', OLD."id", batch_status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."id" <> OLD."id" OR NEW."batchId" <> OLD."batchId" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'arrears line %: a line never changes batch', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF batch_status = 'DRAFT' THEN
    IF NEW."linkedAt" IS NOT NULL OR NEW."discardedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'arrears line %: a draft''s line is neither linked nor discarded', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Outside a draft, only the columns that can move do.
  IF (to_jsonb(NEW) - moving) IS DISTINCT FROM (to_jsonb(OLD) - moving) THEN
    RAISE EXCEPTION 'arrears line %: a line of a % batch does not change', OLD."id", batch_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Stamped once, when its batch is discarded.
  IF NEW."discardedAt" IS DISTINCT FROM OLD."discardedAt"
     AND NOT (OLD."discardedAt" IS NULL AND batch_status = 'DISCARDED') THEN
    RAISE EXCEPTION 'arrears line %: discarded only with its batch, and once', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The unit's SET NULL, and nothing else.
  IF NEW."unitId" IS DISTINCT FROM OLD."unitId" AND NEW."unitId" IS NOT NULL THEN
    RAISE EXCEPTION 'arrears line %: its unit is only ever cleared', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."citizenId" IS DISTINCT FROM OLD."citizenId" THEN
    IF NEW."citizenId" IS NULL THEN
      RAISE EXCEPTION 'arrears line %: a line is never unlinked from its citizen', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- From nobody: the «للمطابقة» link, on an approved batch, with its stamps.
    -- From one file to another: «دمج ملفين» or its undo.
    IF OLD."citizenId" IS NULL AND (batch_status <> 'APPROVED' OR NEW."linkedAt" IS NULL) THEN
      RAISE EXCEPTION 'arrears line %: a waiting line is linked once its batch is approved, with who and when', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."linkedAt" IS DISTINCT FROM OLD."linkedAt" OR NEW."linkedById" IS DISTINCT FROM OLD."linkedById")
     AND NOT (OLD."citizenId" IS NULL AND NEW."citizenId" IS NOT NULL) THEN
    RAISE EXCEPTION 'arrears line %: the link stamps are written with the link, once', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

-- ═══════════════════════  batch citizens guard  ═══════════════════════════

CREATE OR REPLACE FUNCTION guard_arrears_batch_citizen() RETURNS TRIGGER AS $fn$
DECLARE
  batch_status "ArrearsBatchStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT b."status" INTO batch_status FROM arrears_batches b WHERE b."id" = NEW."batchId";
    IF batch_status IS NOT NULL AND batch_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'arrears batch citizen: the set is written into a DRAFT batch only (batch % is %)', NEW."batchId", batch_status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'arrears batch citizen %: a batch''s set never loses anyone; discard the batch instead', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- «دمج ملفين» moves the citizen; nothing else changes.
  IF (to_jsonb(NEW) - 'citizenId') IS DISTINCT FROM (to_jsonb(OLD) - 'citizenId') THEN
    RAISE EXCEPTION 'arrears batch citizen %: only a merge moves it, to another file', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

-- The three read `arrears_batches` / write `arrears_lines`: pin them to this
-- schema, as 0094 pins `guard_citizen_request`.
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.discard_arrears_batch_lines() SET search_path = %I, pg_catalog',
    CURRENT_SCHEMA(), CURRENT_SCHEMA());
  EXECUTE format('ALTER FUNCTION %I.guard_arrears_line() SET search_path = %I, pg_catalog',
    CURRENT_SCHEMA(), CURRENT_SCHEMA());
  EXECUTE format('ALTER FUNCTION %I.guard_arrears_batch_citizen() SET search_path = %I, pg_catalog',
    CURRENT_SCHEMA(), CURRENT_SCHEMA());
END
$$;

-- ═════════════════════════════  triggers  ═════════════════════════════════

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('arrears_batches', 'arrears_batches_guard',
         'BEFORE INSERT OR UPDATE OR DELETE ON "arrears_batches" FOR EACH ROW EXECUTE FUNCTION guard_arrears_batch()'),
      ('arrears_batches', 'arrears_batches_discard_lines',
         'AFTER UPDATE OF "status" ON "arrears_batches" FOR EACH ROW EXECUTE FUNCTION discard_arrears_batch_lines()'),
      ('arrears_lines', 'arrears_lines_guard',
         'BEFORE INSERT OR UPDATE OR DELETE ON "arrears_lines" FOR EACH ROW EXECUTE FUNCTION guard_arrears_line()'),
      ('arrears_batch_citizens', 'arrears_batch_citizens_guard',
         'BEFORE INSERT OR UPDATE OR DELETE ON "arrears_batch_citizens" FOR EACH ROW EXECUTE FUNCTION guard_arrears_batch_citizen()'),
      -- 0103's guard, in the file that creates the tables.
      ('arrears_batches', 'arrears_batches_no_truncate',
         'BEFORE TRUNCATE ON "arrears_batches" FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_truncate()'),
      ('arrears_lines', 'arrears_lines_no_truncate',
         'BEFORE TRUNCATE ON "arrears_lines" FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_truncate()'),
      ('arrears_batch_citizens', 'arrears_batch_citizens_no_truncate',
         'BEFORE TRUNCATE ON "arrears_batch_citizens" FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_truncate()')
    ) AS v(tbl, name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger tg
        JOIN pg_class c ON c.oid = tg.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE tg.tgname = t.name AND c.relname = t.tbl AND n.nspname = CURRENT_SCHEMA()
    ) THEN
      EXECUTE format('CREATE TRIGGER %I %s', t.name, t.definition);
    END IF;
  END LOOP;
END
$$;

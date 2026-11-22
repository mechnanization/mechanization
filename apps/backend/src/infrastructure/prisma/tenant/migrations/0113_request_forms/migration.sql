-- 0113_request_forms
--
-- The request form builder, the expand step (docs/request-forms-plan.md §3,
-- decisions F1–F12 in open-decisions.md §24): a form the manager defines — its
-- questions and its fee — that a citizen fills in online and a clerk at the
-- counter. Needs `0112_request_form_enums`, whose types every table, CHECK and
-- trigger below names. Additive: `0092` and `0094` are not edited.
--
-- == What it is for ======================================================
--
--   request_forms            one form: name (Arabic required, English optional,
--                            F10), its fee in whole pounds, whether it is
--                            offered, whether it names a property card and asks
--                            the applicant's capacity and purpose (F6), an
--                            optional statement template (F9), and its current
--                            published version. `systemType` is set on a form
--                            standing for one of the eight built-in request
--                            types (F1) and nowhere else.
--   request_form_versions    a form is DRAFT while the manager edits it and
--                            PUBLISHED once, then frozen (F2). A request is
--                            tied to the version it was filled against.
--   request_form_fields      the questions of a version: a stable `key`, a type
--                            from the fixed catalogue (F3), labels, help, and a
--                            `config` the shared zod schema validates per type.
--                            Every field is required (F4), so there is no
--                            «required» column. A field may be linked to a column
--                            of the citizen's file (F4).
--   citizen_request_answers  one row per answered question of a request: the
--                            value (JSONB, shaped by the field's type), and
--                            whether it was typed or copied from the file.
--                            Written once.
--   citizen_requests."formId", "formVersionId"
--                            the form and version a request was filled against.
--                            NULL on every request filed before this, until the
--                            backfill that links the built-in types (Story 9).
--   citizen_requests."applicantCapacity"
--                            loses NOT NULL: a form may not ask for it (F6).
--                            Every row keeps its value; the build serving
--                            production when this lands always writes one.
--   citizen_request_attachments."fieldId"
--                            the question a paper answers; NULL for a paper not
--                            filed for a form's question.
--
-- == The rules, in the database ==========================================
--
--   request_form_versions_guard  a version starts as a draft or published; a
--                                PUBLISHED one never changes; a DRAFT may be
--                                published once; its form, number and creator
--                                never change. A version filled by a request is
--                                never removed.
--   request_form_fields_guard    a field is written into a DRAFT version only,
--                                and never moved to another version.
--   request_forms_guard          `systemType` never changes; the current version
--                                is one of the form's own, published.
--   citizen_request_answers_guard  an answer is written, once, for a question of
--                                the version its request was filled against,
--                                before the request has a bill; never a file
--                                question (those are papers). No UPDATE, no
--                                DELETE.
--   citizen_request_attachments_field_guard
--                                a paper names a FILE question of the version
--                                its request was filled against.
--   guard_citizen_request()      0094's guard, replaced forward with its body
--                                unchanged and these added: a form's version
--                                must be PUBLISHED and the form's own when a
--                                request is filed; `formId` and `formVersionId`
--                                never change once set, except NULL to a value
--                                once, together, in any status (the backfill
--                                must be able to link a request that is already
--                                COMPLETED, which the guard otherwise refuses to
--                                touch).
--   CHECKs                       a fee is not negative and whole pounds, as
--                                `request_type_settings` holds it; names and
--                                texts are not blank and are bounded; a form is
--                                offered only once published and never when
--                                archived; a field's key has a fixed shape and
--                                its position is 0–39 (at most 40 questions); a
--                                linked source fits only the type that can hold
--                                it; a request names a form and a version
--                                together.
--
-- == The one-open-request index ==========================================
--
-- `citizen_requests_one_open_key` keys on `requestType`, so two different forms
-- (each stored as `OTHER`, as the plan says) would block each other and collide
-- with «طلب عام». It is dropped and recreated with `AND "formId" IS NULL`,
-- which is the same constraint for every existing row (all have a NULL
-- `formId`), and a second partial unique index keys on the form (F11). The
-- swap runs in this file's one transaction under an ACCESS EXCLUSIVE lock on
-- `citizen_requests`, so no write sees neither index; the drop runs only for
-- the old definition, so a replay finds the new one and does nothing.
-- `DROP INDEX` is not on the destructive scanner's list.
--
-- == Safety ==
--
-- Additive, but for the relaxation of one NOT NULL and the index swap above.
-- Locks: ACCESS EXCLUSIVE on `citizen_requests` and `citizen_request_attachments`
-- for the new columns, the CHECK (a full scan) and the keys, held to the end of
-- the file. Both tables are small: a municipality files requests by hand, a few
-- a day. The other tables are new and empty.
--
-- The build serving production when this lands never reads the new tables or
-- columns, and keeps working: its inserts into `citizen_requests` leave the new
-- columns NULL, which every CHECK and the guard accept, and its «one open
-- request» refusal is the same index under the same name for every request it
-- can file. A rollback is a redeploy.
--
-- New written-once tables get 0103's TRUNCATE guard here, in the file that
-- creates them (the versions, the fields and the answers; the forms themselves
-- are edited and not written-once). The local reset tools switch every
-- `_no_truncate` guard they find.
--
-- Catalog guards filter on CURRENT_SCHEMA() (see 0050). Idempotent. Written
-- unqualified: the migrator sets `search_path` to the tenant schema, and each
-- function is pinned to its schema (docs/database.md, "A plpgsql function body
-- resolves names when it runs").

-- ═══════════════════════════════  tables  ═════════════════════════════════

CREATE TABLE IF NOT EXISTS "request_forms" (
  "id"                UUID                  NOT NULL DEFAULT gen_random_uuid(),
  "nameAr"            TEXT                  NOT NULL,
  "nameEn"            TEXT,
  "feeAmount"         DECIMAL(14,2)         NOT NULL DEFAULT 0,
  "enabled"           BOOLEAN               NOT NULL DEFAULT false,
  "propertyMode"      "RequestPropertyMode" NOT NULL DEFAULT 'NONE',
  "askCapacity"       BOOLEAN               NOT NULL DEFAULT false,
  "askPurpose"        BOOLEAN               NOT NULL DEFAULT false,
  "statementTemplate" TEXT,
  "systemType"        "RequestType",
  "sortOrder"         INTEGER               NOT NULL DEFAULT 0,
  "archivedAt"        TIMESTAMPTZ(3),
  "archivedById"      UUID,
  "currentVersionId"  UUID,
  "createdById"       UUID,
  "updatedById"       UUID,
  "createdAt"         TIMESTAMPTZ(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMPTZ(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_forms_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "request_form_versions" (
  "id"            UUID                       NOT NULL DEFAULT gen_random_uuid(),
  "formId"        UUID                       NOT NULL,
  "versionNumber" INTEGER                    NOT NULL,
  "status"        "RequestFormVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "revision"      INTEGER                    NOT NULL DEFAULT 1,
  "publishedAt"   TIMESTAMPTZ(3),
  "publishedById" UUID,
  "createdById"   UUID,
  "createdAt"     TIMESTAMPTZ(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMPTZ(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_form_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "request_form_fields" (
  "id"           UUID                   NOT NULL DEFAULT gen_random_uuid(),
  "versionId"    UUID                   NOT NULL,
  "key"          TEXT                   NOT NULL,
  "position"     INTEGER                NOT NULL,
  "type"         "RequestFieldType"     NOT NULL,
  "labelAr"      TEXT                   NOT NULL,
  "labelEn"      TEXT,
  "helpAr"       TEXT,
  "helpEn"       TEXT,
  "config"       JSONB                  NOT NULL DEFAULT '{}',
  "linkedSource" "RequestLinkedSource",
  "createdAt"    TIMESTAMPTZ(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_form_fields_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "citizen_request_answers" (
  "id"        UUID                  NOT NULL DEFAULT gen_random_uuid(),
  "requestId" UUID                  NOT NULL,
  "fieldId"   UUID                  NOT NULL,
  "value"     JSONB                 NOT NULL,
  "origin"    "RequestAnswerOrigin" NOT NULL DEFAULT 'ANSWERED',
  "createdAt" TIMESTAMPTZ(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "citizen_request_answers_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "citizen_requests" ADD COLUMN IF NOT EXISTS "formId" UUID;
ALTER TABLE "citizen_requests" ADD COLUMN IF NOT EXISTS "formVersionId" UUID;
-- A statement with no effect on a column already nullable, so a replay is a no-op.
ALTER TABLE "citizen_requests" ALTER COLUMN "applicantCapacity" DROP NOT NULL;

ALTER TABLE "citizen_request_attachments" ADD COLUMN IF NOT EXISTS "fieldId" UUID;

-- ═════════════════════════  indexes the keys need  ═══════════════════════
-- Before the keys: the composite foreign key below needs the unique index it
-- points at.

CREATE UNIQUE INDEX IF NOT EXISTS "request_form_versions_formId_versionNumber_key"
  ON "request_form_versions" ("formId", "versionNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "request_form_versions_formId_id_key"
  ON "request_form_versions" ("formId", "id");

-- ═════════════════════════  keys and checks  ══════════════════════════════

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      -- request_forms
      ('request_forms', 'request_forms_archivedById_fkey',
         'FOREIGN KEY ("archivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('request_forms', 'request_forms_createdById_fkey',
         'FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('request_forms', 'request_forms_updatedById_fkey',
         'FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      -- SET NULL: deleting a form's last version (a form never filled) must not be blocked by the pointer to it.
      ('request_forms', 'request_forms_currentVersionId_fkey',
         'FOREIGN KEY ("currentVersionId") REFERENCES "request_form_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE'),
      ('request_forms', 'request_forms_fee_not_negative',
         $c$CHECK ("feeAmount" >= 0)$c$),
      ('request_forms', 'request_forms_fee_whole_pounds',
         $c$CHECK ("feeAmount" = trunc("feeAmount"))$c$),
      ('request_forms', 'request_forms_names_valid',
         $c$CHECK (btrim("nameAr") <> '' AND char_length("nameAr") <= 200
                AND ("nameEn" IS NULL OR (btrim("nameEn") <> '' AND char_length("nameEn") <= 200)))$c$),
      ('request_forms', 'request_forms_template_valid',
         $c$CHECK ("statementTemplate" IS NULL
                OR (btrim("statementTemplate") <> '' AND char_length("statementTemplate") <= 5000))$c$),
      ('request_forms', 'request_forms_sort_order_not_negative',
         $c$CHECK ("sortOrder" >= 0)$c$),
      ('request_forms', 'request_forms_archived_pair',
         $c$CHECK (("archivedAt" IS NULL) = ("archivedById" IS NULL))$c$),
      -- An archived form is never offered (F7), and a form is offered only once it has a published version.
      ('request_forms', 'request_forms_archived_not_enabled',
         $c$CHECK ("archivedAt" IS NULL OR NOT "enabled")$c$),
      ('request_forms', 'request_forms_enabled_needs_version',
         $c$CHECK (NOT "enabled" OR "currentVersionId" IS NOT NULL)$c$),

      -- request_form_versions
      ('request_form_versions', 'request_form_versions_formId_fkey',
         'FOREIGN KEY ("formId") REFERENCES "request_forms"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('request_form_versions', 'request_form_versions_publishedById_fkey',
         'FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('request_form_versions', 'request_form_versions_createdById_fkey',
         'FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('request_form_versions', 'request_form_versions_number_positive',
         $c$CHECK ("versionNumber" > 0)$c$),
      ('request_form_versions', 'request_form_versions_revision_positive',
         $c$CHECK ("revision" >= 1)$c$),
      -- PUBLISHED and its stamp say the same thing; whoever published it needs the stamp (a system form's has none).
      ('request_form_versions', 'request_form_versions_published_status',
         $c$CHECK ((("status" = 'PUBLISHED') = ("publishedAt" IS NOT NULL))
                AND ("publishedById" IS NULL OR "publishedAt" IS NOT NULL))$c$),

      -- request_form_fields
      ('request_form_fields', 'request_form_fields_versionId_fkey',
         'FOREIGN KEY ("versionId") REFERENCES "request_form_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('request_form_fields', 'request_form_fields_key_shape',
         $c$CHECK ("key" ~ '^[a-z][a-z0-9_]{0,39}$')$c$),
      -- Positions 0–39: at most 40 questions a version.
      ('request_form_fields', 'request_form_fields_position_range',
         $c$CHECK ("position" BETWEEN 0 AND 39)$c$),
      ('request_form_fields', 'request_form_fields_labels_valid',
         $c$CHECK (btrim("labelAr") <> '' AND char_length("labelAr") <= 200
                AND ("labelEn" IS NULL OR (btrim("labelEn") <> '' AND char_length("labelEn") <= 200)))$c$),
      ('request_form_fields', 'request_form_fields_help_valid',
         $c$CHECK (("helpAr" IS NULL OR (btrim("helpAr") <> '' AND char_length("helpAr") <= 500))
                AND ("helpEn" IS NULL OR (btrim("helpEn") <> '' AND char_length("helpEn") <= 500)))$c$),
      ('request_form_fields', 'request_form_fields_config_object',
         $c$CHECK (jsonb_typeof("config") = 'object')$c$),
      -- A linked source fits only the type that can hold it: a name part is short text, a phone a phone, a number a document number.
      ('request_form_fields', 'request_form_fields_linked_source_type',
         $c$CHECK ("linkedSource" IS NULL
                OR ("linkedSource" IN ('FIRST_NAME', 'FATHER_NAME', 'LAST_NAME', 'MOTHER_NAME') AND "type" = 'SHORT_TEXT')
                OR ("linkedSource" = 'PHONE' AND "type" = 'PHONE')
                OR ("linkedSource" IN ('IDENTITY_NUMBER', 'CIVIL_RECORD_NUMBER') AND "type" = 'DOCUMENT_NUMBER'))$c$),

      -- citizen_requests
      ('citizen_requests', 'citizen_requests_form_pair',
         $c$CHECK (("formId" IS NULL) = ("formVersionId" IS NULL))$c$),
      -- One composite key: a request points at a version of its own form. MATCH SIMPLE: both NULL is not checked.
      ('citizen_requests', 'citizen_requests_form_version_fkey',
         'FOREIGN KEY ("formId", "formVersionId") REFERENCES "request_form_versions"("formId", "id") ON DELETE RESTRICT ON UPDATE CASCADE'),

      -- citizen_request_attachments
      ('citizen_request_attachments', 'citizen_request_attachments_fieldId_fkey',
         'FOREIGN KEY ("fieldId") REFERENCES "request_form_fields"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),

      -- citizen_request_answers
      ('citizen_request_answers', 'citizen_request_answers_requestId_fkey',
         'FOREIGN KEY ("requestId") REFERENCES "citizen_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('citizen_request_answers', 'citizen_request_answers_fieldId_fkey',
         'FOREIGN KEY ("fieldId") REFERENCES "request_form_fields"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      -- An answer is a value: JSON null is no answer (every field is required).
      ('citizen_request_answers', 'citizen_request_answers_value_not_null',
         $c$CHECK (jsonb_typeof("value") <> 'null')$c$)
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

-- One system form per built-in type. NULLs never collide, so any number of custom forms.
CREATE UNIQUE INDEX IF NOT EXISTS "request_forms_systemType_key" ON "request_forms" ("systemType");
CREATE INDEX IF NOT EXISTS "request_forms_enabled_sortOrder_idx" ON "request_forms" ("enabled", "sortOrder");
CREATE INDEX IF NOT EXISTS "request_forms_currentVersionId_idx" ON "request_forms" ("currentVersionId");
CREATE INDEX IF NOT EXISTS "request_forms_archivedById_idx" ON "request_forms" ("archivedById");
CREATE INDEX IF NOT EXISTS "request_forms_createdById_idx" ON "request_forms" ("createdById");
CREATE INDEX IF NOT EXISTS "request_forms_updatedById_idx" ON "request_forms" ("updatedById");

-- At most one draft a form: the manager edits one working copy.
CREATE UNIQUE INDEX IF NOT EXISTS "request_form_versions_one_draft_key"
  ON "request_form_versions" ("formId") WHERE "status" = 'DRAFT';
CREATE INDEX IF NOT EXISTS "request_form_versions_publishedById_idx" ON "request_form_versions" ("publishedById");
CREATE INDEX IF NOT EXISTS "request_form_versions_createdById_idx" ON "request_form_versions" ("createdById");

CREATE UNIQUE INDEX IF NOT EXISTS "request_form_fields_versionId_key_key" ON "request_form_fields" ("versionId", "key");
CREATE UNIQUE INDEX IF NOT EXISTS "request_form_fields_versionId_position_key" ON "request_form_fields" ("versionId", "position");

CREATE UNIQUE INDEX IF NOT EXISTS "citizen_request_answers_requestId_fieldId_key"
  ON "citizen_request_answers" ("requestId", "fieldId");
CREATE INDEX IF NOT EXISTS "citizen_request_answers_fieldId_idx" ON "citizen_request_answers" ("fieldId");

CREATE INDEX IF NOT EXISTS "citizen_requests_formId_idx" ON "citizen_requests" ("formId");
CREATE INDEX IF NOT EXISTS "citizen_requests_formVersionId_idx" ON "citizen_requests" ("formVersionId");
CREATE INDEX IF NOT EXISTS "citizen_request_attachments_fieldId_idx" ON "citizen_request_attachments" ("fieldId");

-- The one-open-request index (see the header). Dropped only in its old shape.
-- Resolved through this schema's own name, never by scanning the catalog for the index's name:
-- `pg_indexes` would run `pg_get_indexdef` on every municipality's copy of it, and a schema
-- dropped meanwhile (the integration suites do) fails the scan with «could not open relation».
DO $$
DECLARE
  old_index REGCLASS := to_regclass(format('%I.%I', CURRENT_SCHEMA(), 'citizen_requests_one_open_key'));
BEGIN
  IF old_index IS NOT NULL AND pg_get_indexdef(old_index) NOT LIKE '%formId%' THEN
    EXECUTE format('DROP INDEX %s', old_index);
  END IF;
END
$$;

-- A request on no form: the rule 0092 gave, for the requests it can file (F11).
CREATE UNIQUE INDEX IF NOT EXISTS "citizen_requests_one_open_key" ON "citizen_requests" (
  "citizenId",
  "requestType",
  COALESCE("propertyEntryId", '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE "status" IN ('AWAITING_PAYMENT', 'IN_REVIEW', 'READY_FOR_PICKUP') AND "formId" IS NULL;

-- A request on a form: one open request per citizen, form and card (F11).
CREATE UNIQUE INDEX IF NOT EXISTS "citizen_requests_one_open_form_key" ON "citizen_requests" (
  "citizenId",
  "formId",
  COALESCE("propertyEntryId", '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE "status" IN ('AWAITING_PAYMENT', 'IN_REVIEW', 'READY_FOR_PICKUP') AND "formId" IS NOT NULL;

-- ═══════════════════════════  the request's guard  ════════════════════════
-- 0094's function with its body unchanged, and the form rules added where
-- marked «0113». `CREATE OR REPLACE` resets the function's settings, so the
-- search path is pinned again below. The trigger is 0094's and stays.

CREATE OR REPLACE FUNCTION guard_citizen_request() RETURNS TRIGGER AS $fn$
DECLARE
  form_link BOOLEAN := false;
  strip TEXT[] := ARRAY['citizenId', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'citizen request %: a request is rejected or cancelled, never removed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('AWAITING_PAYMENT', 'IN_REVIEW') THEN
      RAISE EXCEPTION 'citizen request %: a request starts AWAITING_PAYMENT or IN_REVIEW, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF num_nonnulls(
         NEW."citizenPaymentId", NEW."paidAt", NEW."readyAt", NEW."readyById", NEW."statement",
         NEW."clearanceSnapshot", NEW."completedAt", NEW."completedById", NEW."rejectedAt",
         NEW."rejectedById", NEW."rejectionReason", NEW."cancelledAt", NEW."cancelledById"
       ) > 0 THEN
      RAISE EXCEPTION 'citizen request %: a new request carries no bill and no stamp', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- 0113: a request is filed against a published version of its own form.
    IF NEW."formVersionId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "request_form_versions" v
       WHERE v."id" = NEW."formVersionId" AND v."formId" = NEW."formId" AND v."status" = 'PUBLISHED'
    ) THEN
      RAISE EXCEPTION 'citizen request %: form version % is not a published version of form %',
        NEW."id", NEW."formVersionId", NEW."formId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."propertyEntryId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "property_entries" e
        JOIN "registrations" r ON r."id" = e."registrationId"
       WHERE e."id" = NEW."propertyEntryId" AND r."citizenId" = NEW."citizenId"
    ) THEN
      RAISE EXCEPTION 'citizen request %: card % is not on the citizen''s file', NEW."id", NEW."propertyEntryId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."buildingUnitId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "building_units" u
       WHERE u."id" = NEW."buildingUnitId" AND u."propertyEntryId" = NEW."propertyEntryId"
    ) THEN
      RAISE EXCEPTION 'citizen request %: flat % is not on card %', NEW."id", NEW."buildingUnitId", NEW."propertyEntryId"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    -- 0113: the form is linked once, from NULL, both columns together, in any status.
    form_link := OLD."formId" IS NULL AND OLD."formVersionId" IS NULL
             AND NEW."formId" IS NOT NULL AND NEW."formVersionId" IS NOT NULL;
    IF form_link THEN
      strip := ARRAY['citizenId', 'updatedAt', 'formId', 'formVersionId'];
      IF NOT EXISTS (
        SELECT 1 FROM "request_form_versions" v
         WHERE v."id" = NEW."formVersionId" AND v."formId" = NEW."formId" AND v."status" = 'PUBLISHED'
      ) THEN
        RAISE EXCEPTION 'citizen request %: form version % is not a published version of form %',
          OLD."id", NEW."formVersionId", NEW."formId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    IF OLD."status" IN ('COMPLETED', 'REJECTED', 'CANCELLED') AND (
      to_jsonb(NEW) - strip IS DISTINCT FROM to_jsonb(OLD) - strip
    ) THEN
      RAISE EXCEPTION 'citizen request %: a % request changes no more', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
         (OLD."status" = 'AWAITING_PAYMENT' AND NEW."status" IN ('IN_REVIEW', 'REJECTED', 'CANCELLED'))
      OR (OLD."status" = 'IN_REVIEW' AND NEW."status" IN ('READY_FOR_PICKUP', 'REJECTED'))
      OR (OLD."status" = 'IN_REVIEW' AND NEW."status" = 'AWAITING_PAYMENT' AND OLD."citizenPaymentId" IS NOT NULL)
      OR (OLD."status" = 'READY_FOR_PICKUP' AND NEW."status" = 'COMPLETED')
    ) THEN
      RAISE EXCEPTION 'citizen request %: % cannot become %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;

    IF (OLD."citizenPaymentId" IS NOT NULL AND NEW."citizenPaymentId" IS DISTINCT FROM OLD."citizenPaymentId")
       OR (OLD."citizenPaymentId" IS NULL AND NEW."citizenPaymentId" IS NOT NULL AND OLD."status" <> 'AWAITING_PAYMENT') THEN
      RAISE EXCEPTION 'citizen request %: its bill is linked once, while it waits for payment', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."paidAt" IS DISTINCT FROM OLD."paidAt" AND NOT (
      (OLD."status", NEW."status") IN (('AWAITING_PAYMENT', 'IN_REVIEW'), ('IN_REVIEW', 'AWAITING_PAYMENT'))
    ) THEN
      RAISE EXCEPTION 'citizen request %: paidAt moves only with the payment', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    -- Each step's stamps are written by that step, and by nothing else: the paper's content only
    -- on IN_REVIEW → READY_FOR_PICKUP, the hand-over only on READY_FOR_PICKUP → COMPLETED, and so on.
    IF (NEW."readyAt", NEW."readyById", NEW."statement", NEW."clearanceSnapshot")
         IS DISTINCT FROM (OLD."readyAt", OLD."readyById", OLD."statement", OLD."clearanceSnapshot")
       AND NOT (OLD."status" = 'IN_REVIEW' AND NEW."status" = 'READY_FOR_PICKUP') THEN
      RAISE EXCEPTION 'citizen request %: the paper is written once, when it is made ready', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."completedAt", NEW."completedById") IS DISTINCT FROM (OLD."completedAt", OLD."completedById")
       AND NOT (OLD."status" = 'READY_FOR_PICKUP' AND NEW."status" = 'COMPLETED') THEN
      RAISE EXCEPTION 'citizen request %: the hand-over is stamped when it is handed over', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."rejectedAt", NEW."rejectedById", NEW."rejectionReason")
         IS DISTINCT FROM (OLD."rejectedAt", OLD."rejectedById", OLD."rejectionReason")
       AND NOT (NEW."status" = 'REJECTED' AND OLD."status" <> 'REJECTED') THEN
      RAISE EXCEPTION 'citizen request %: a rejection is stamped when it is rejected', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."cancelledAt", NEW."cancelledById") IS DISTINCT FROM (OLD."cancelledAt", OLD."cancelledById")
       AND NOT (NEW."status" = 'CANCELLED' AND OLD."status" <> 'CANCELLED') THEN
      RAISE EXCEPTION 'citizen request %: a cancellation is stamped when it is cancelled', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    -- 0113: the form never changes once set, but for the one-time link above.
    IF NOT form_link AND (
         NEW."formId" IS DISTINCT FROM OLD."formId" OR NEW."formVersionId" IS DISTINCT FROM OLD."formVersionId"
       ) THEN
      RAISE EXCEPTION 'citizen request %: its form is linked once, from none, and never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."requestNumber" IS DISTINCT FROM OLD."requestNumber"
      OR NEW."channel" IS DISTINCT FROM OLD."channel"
      OR NEW."requestType" IS DISTINCT FROM OLD."requestType"
      OR NEW."applicantCapacity" IS DISTINCT FROM OLD."applicantCapacity"
      OR NEW."propertyEntryId" IS DISTINCT FROM OLD."propertyEntryId"
      OR NEW."buildingUnitId" IS DISTINCT FROM OLD."buildingUnitId"
      OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
      OR NEW."clientRequestId" IS DISTINCT FROM OLD."clientRequestId"
      OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'citizen request %: what was asked, for what and by whom does not change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- A cancelled request has no bill, or a bill that is itself cancelled (decision of 2026-10-13).
  IF NEW."status" = 'CANCELLED' AND NEW."citizenPaymentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "citizen_payments" p
     WHERE p."id" = NEW."citizenPaymentId" AND p."paymentStatus" = 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'citizen request %: cancelled while its bill % still stands', NEW."id", NEW."citizenPaymentId"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

-- ═══════════════════════  the forms' own guards  ══════════════════════════

CREATE OR REPLACE FUNCTION guard_request_form_version() RETURNS TRIGGER AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "citizen_requests" r WHERE r."formVersionId" = OLD."id") THEN
      RAISE EXCEPTION 'request form version %: requests were filled against it, so it is never removed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- UPDATE. A no-op write changes nothing and is allowed.
  IF to_jsonb(NEW) = to_jsonb(OLD) THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'PUBLISHED' THEN
    RAISE EXCEPTION 'request form version %: a published version never changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."formId" IS DISTINCT FROM OLD."formId"
    OR NEW."versionNumber" IS DISTINCT FROM OLD."versionNumber"
    OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'request form version %: its form, number and creator do not change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revision" < OLD."revision" THEN
    RAISE EXCEPTION 'request form version %: a draft''s revision only grows', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_request_form_field() RETURNS TRIGGER AS $fn$
DECLARE
  version_id UUID;
  version_status "RequestFormVersionStatus";
BEGIN
  version_id := CASE WHEN TG_OP = 'INSERT' THEN NEW."versionId" ELSE OLD."versionId" END;
  SELECT v."status" INTO version_status FROM "request_form_versions" v WHERE v."id" = version_id;

  IF TG_OP = 'UPDATE' AND NEW."versionId" IS DISTINCT FROM OLD."versionId" THEN
    RAISE EXCEPTION 'request form field %: a field never moves to another version', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF version_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'request form field: the fields of a published version never change'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE: a draft's fields go freely; a published version's only while no request was filled against it
  -- (a form that was published and never used may still be deleted whole).
  IF version_status = 'PUBLISHED' AND EXISTS (SELECT 1 FROM "citizen_requests" r WHERE r."formVersionId" = OLD."versionId") THEN
    RAISE EXCEPTION 'request form field %: requests were filled against its version, so it is never removed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_request_form() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW."systemType" IS DISTINCT FROM OLD."systemType" THEN
    RAISE EXCEPTION 'request form %: the built-in type a system form stands for never changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'request form %: its identity does not change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."currentVersionId" IS NOT NULL AND NEW."currentVersionId" IS DISTINCT FROM OLD."currentVersionId" AND NOT EXISTS (
    SELECT 1 FROM "request_form_versions" v
     WHERE v."id" = NEW."currentVersionId" AND v."formId" = NEW."id" AND v."status" = 'PUBLISHED'
  ) THEN
    RAISE EXCEPTION 'request form %: its current version is one of its own, published', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_citizen_request_answer() RETURNS TRIGGER AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'citizen request answer %: an answer is written once and never changed or removed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- Written with the request, before it has a bill.
  IF NOT EXISTS (
    SELECT 1 FROM "citizen_requests" r
     WHERE r."id" = NEW."requestId"
       AND r."status" IN ('AWAITING_PAYMENT', 'IN_REVIEW')
       AND r."citizenPaymentId" IS NULL AND r."paidAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'citizen request answer: request % takes no more answers once it has a bill or is closed', NEW."requestId"
      USING ERRCODE = 'check_violation';
  END IF;
  -- A question of the version the request was filled against, and not a file question (those are papers).
  IF NOT EXISTS (
    SELECT 1 FROM "citizen_requests" r
      JOIN "request_form_fields" f ON f."versionId" = r."formVersionId"
     WHERE r."id" = NEW."requestId" AND f."id" = NEW."fieldId" AND f."type" <> 'FILE'
  ) THEN
    RAISE EXCEPTION 'citizen request answer: field % is not a question of the form request % was filled against, or is a file question',
      NEW."fieldId", NEW."requestId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_citizen_request_attachment_field() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW."fieldId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "citizen_requests" r
      JOIN "request_form_fields" f ON f."versionId" = r."formVersionId"
     WHERE r."id" = NEW."requestId" AND f."id" = NEW."fieldId" AND f."type" = 'FILE'
  ) THEN
    RAISE EXCEPTION 'citizen request attachment: field % is not a file question of the form request % was filled against',
      NEW."fieldId", NEW."requestId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

-- Every function reads other tables when it fires: pin each to this schema, as 0094 pinned the request's.
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_citizen_request() SET search_path = %I, pg_catalog',
    CURRENT_SCHEMA(), CURRENT_SCHEMA());
  EXECUTE format('ALTER FUNCTION %I.guard_request_form_version() SET search_path = %I, pg_catalog',
    CURRENT_SCHEMA(), CURRENT_SCHEMA());
  EXECUTE format('ALTER FUNCTION %I.guard_request_form_field() SET search_path = %I, pg_catalog',
    CURRENT_SCHEMA(), CURRENT_SCHEMA());
  EXECUTE format('ALTER FUNCTION %I.guard_request_form() SET search_path = %I, pg_catalog',
    CURRENT_SCHEMA(), CURRENT_SCHEMA());
  EXECUTE format('ALTER FUNCTION %I.guard_citizen_request_answer() SET search_path = %I, pg_catalog',
    CURRENT_SCHEMA(), CURRENT_SCHEMA());
  EXECUTE format('ALTER FUNCTION %I.guard_citizen_request_attachment_field() SET search_path = %I, pg_catalog',
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
      ('request_form_versions', 'request_form_versions_guard',
         'BEFORE INSERT OR UPDATE OR DELETE ON "request_form_versions" FOR EACH ROW EXECUTE FUNCTION guard_request_form_version()'),
      ('request_form_fields', 'request_form_fields_guard',
         'BEFORE INSERT OR UPDATE OR DELETE ON "request_form_fields" FOR EACH ROW EXECUTE FUNCTION guard_request_form_field()'),
      ('request_forms', 'request_forms_guard',
         'BEFORE UPDATE ON "request_forms" FOR EACH ROW EXECUTE FUNCTION guard_request_form()'),
      ('citizen_request_answers', 'citizen_request_answers_guard',
         'BEFORE INSERT OR UPDATE OR DELETE ON "citizen_request_answers" FOR EACH ROW EXECUTE FUNCTION guard_citizen_request_answer()'),
      ('citizen_request_attachments', 'citizen_request_attachments_field_guard',
         'BEFORE INSERT ON "citizen_request_attachments" FOR EACH ROW EXECUTE FUNCTION guard_citizen_request_attachment_field()'),
      -- 0103's guard, in the file that creates the written-once tables.
      ('request_form_versions', 'request_form_versions_no_truncate',
         'BEFORE TRUNCATE ON "request_form_versions" FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_truncate()'),
      ('request_form_fields', 'request_form_fields_no_truncate',
         'BEFORE TRUNCATE ON "request_form_fields" FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_truncate()'),
      ('citizen_request_answers', 'citizen_request_answers_no_truncate',
         'BEFORE TRUNCATE ON "citizen_request_answers" FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_truncate()')
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

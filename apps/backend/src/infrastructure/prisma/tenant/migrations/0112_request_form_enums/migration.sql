-- 0112_request_form_enums
--
-- == What it is for ==
--
-- The enum types the request form builder needs (docs/request-forms-plan.md
-- §3.1, decisions F1–F12 in open-decisions.md §24), alone in this file as
-- `0107` did for old debts: a value added to an enum cannot be used in the
-- transaction that adds it (docs/database.md, "Add an enum value"), and
-- `0113_request_forms` uses every one of them in a table, a CHECK or a trigger.
--
--   * `RequestFieldType` — what a question on a form asks (F3): short or long
--     text, a whole or decimal number, a date, a phone, a civil ID or
--     document number, a single or multiple choice, yes/no, a file. A fixed
--     catalogue: nothing here is a pattern the manager types.
--   * `RequestPropertyMode` — whether a form names one of the citizen's
--     property cards (F6, D4): not asked, optional, or required.
--   * `RequestFormVersionStatus` — a version of a form is a DRAFT the manager
--     edits, then PUBLISHED, and frozen (F2).
--   * `RequestLinkedSource` — the column of the citizen's file a linked field
--     is copied from (F4). Never a رقم مرجعي: it is the citizen's sign-in
--     credential (non-negotiable 7), so it is not a value of this type.
--   * `RequestAnswerOrigin` — an answer was typed, or copied from the file.
--
-- == Safety ==
--
-- Additive and instant. Each type is created only where it is missing, the
-- guard filtered on CURRENT_SCHEMA() (see 0050), so a replay is a no-op.
-- Nothing reads or writes these types until the code of the form builder
-- ships, and the build serving production when this lands never meets them. A
-- rollback is a redeploy.

DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('RequestFieldType', $q$(
        'SHORT_TEXT', 'LONG_TEXT', 'INTEGER', 'DECIMAL', 'DATE', 'PHONE',
        'DOCUMENT_NUMBER', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'YES_NO', 'FILE'
      )$q$),
      ('RequestPropertyMode', $q$('NONE', 'OPTIONAL', 'REQUIRED')$q$),
      ('RequestFormVersionStatus', $q$('DRAFT', 'PUBLISHED')$q$),
      ('RequestLinkedSource', $q$(
        'FIRST_NAME', 'FATHER_NAME', 'LAST_NAME', 'MOTHER_NAME', 'PHONE',
        'IDENTITY_NUMBER', 'CIVIL_RECORD_NUMBER'
      )$q$),
      ('RequestAnswerOrigin', $q$('ANSWERED', 'FROM_FILE')$q$)
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

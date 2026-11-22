-- 0114_request_system_forms
--
-- The built-in request types become forms (open decisions §24 F1, docs/request-forms-plan.md
-- §3.8 step 2): one **system form** per `RequestType`, so the manager's list of forms holds every
-- kind of request the municipality offers, and a fee and an on/off switch live in one place.
-- Needs `0113_request_forms`.
--
-- == What it writes ======================================================
--
-- For each of the eight types, in every municipality:
--
--   request_forms          one row with `systemType` the type, named as the census labels it
--                          (the bill's title «رسم <name>» reads the same as before), its `feeAmount`
--                          and `enabled` copied from `request_type_settings` (a type with no row
--                          is off and free, as the code has always read it), and what the type asked
--                          until now written as the form's own questions: a card for the types tied to
--                          a property (`REQUEST_TYPES_ON_PROPERTY`, decision D4), optional for the
--                          others, always the applicant's capacity and the purpose.
--   request_form_versions  its first version, PUBLISHED, with no questions of its own (a built-in type
--                          has none), created by nobody: `publishedById` stays NULL, which 0113's CHECK
--                          allows for exactly this.
--   request_forms          `currentVersionId` and `enabled` set once the version exists (a form is
--                          offered only with a published version).
--   citizen_requests       every request filed before this release, whatever its status, linked to the
--                          system form of its type and that version: the one NULL -> value write
--                          0113's guard allows, in any status. Nothing else on the row changes.
--
-- `request_type_settings` stays, unread by new code once the forms hold the fee and the switch, and is
-- dropped in a later release, never this one (expand, backfill, contract; CLAUDE.md non-negotiable 3).
-- The manager's «أنواع الطلبات والرسوم» keeps writing both tables for as long as it stays, so a rollback to
-- the build before this one finds the settings it expects.
--
-- == Replay ==============================================================
--
-- Every statement is guarded by what it would create or change: a second run finds the forms, the versions,
-- the links and the current versions in place and writes nothing. In particular it never copies the settings
-- over a fee the manager has since changed on the form: `enabled` and `currentVersionId` are written only to
-- a form that has no current version yet.
--
-- Additive for CLAUDE.md non-negotiable 5: new rows and one column filled where it was NULL. The scanner
-- warns of the `UPDATE`, which is what this is.
--
-- == Not here ============================================================
--
-- No question is written for a type, so `REQUEST_FORM_NOT_PUBLISHABLE`'s «at least one question» rule does not
-- apply: the migration publishes, never the API. The API refuses to edit a system form's questions
-- (`REQUEST_FORM_SYSTEM`).

INSERT INTO "request_forms" ("nameAr", "nameEn", "feeAmount", "enabled", "propertyMode", "askCapacity", "askPurpose", "systemType", "sortOrder")
SELECT v."nameAr", v."nameEn", 0, false, v."propertyMode"::"RequestPropertyMode", true, true, v."systemType"::"RequestType", v."sortOrder"
FROM (VALUES
  ('براءة ذمة بلدية', 'Municipal clearance',    'REQUIRED', 'CLEARANCE',          10),
  ('إفادة سكن',       'Residence certificate',  'OPTIONAL', 'RESIDENCY',          20),
  ('إفادة إشغال',     'Occupancy certificate',  'REQUIRED', 'OCCUPANCY',          30),
  ('إفادة شغور',      'Vacancy certificate',    'REQUIRED', 'VACANCY',            40),
  ('تسجيل عقد إيجار', 'Lease registration',     'REQUIRED', 'LEASE_REGISTRATION', 50),
  ('رخصة ترميم',      'Renovation permit',      'REQUIRED', 'RENOVATION',         60),
  ('رخصة لافتة',      'Sign permit',            'REQUIRED', 'SIGNAGE',            70),
  ('طلب عام',         'General request',        'OPTIONAL', 'OTHER',              80)
) AS v("nameAr", "nameEn", "propertyMode", "systemType", "sortOrder")
WHERE NOT EXISTS (
  SELECT 1 FROM "request_forms" f WHERE f."systemType" = v."systemType"::"RequestType"
);

INSERT INTO "request_form_versions" ("formId", "versionNumber", "status", "revision", "publishedAt")
SELECT f."id", 1, 'PUBLISHED'::"RequestFormVersionStatus", 1, now()
FROM "request_forms" f
WHERE f."systemType" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "request_form_versions" v WHERE v."formId" = f."id");

-- The fee and the switch the manager has set so far, copied once, to a form with no current version.
UPDATE "request_forms" f
   SET "currentVersionId" = v."id",
       "feeAmount"        = COALESCE(s."feeAmount", f."feeAmount"),
       "enabled"          = COALESCE(s."enabled", f."enabled")
  FROM "request_form_versions" v
  LEFT JOIN "request_type_settings" s ON s."requestType" = (SELECT f2."systemType" FROM "request_forms" f2 WHERE f2."id" = v."formId")
 WHERE v."formId" = f."id"
   AND v."versionNumber" = 1
   AND f."systemType" IS NOT NULL
   AND f."currentVersionId" IS NULL;

-- Every request filed before forms, linked to the system form of its type.
UPDATE "citizen_requests" r
   SET "formId" = f."id", "formVersionId" = f."currentVersionId"
  FROM "request_forms" f
 WHERE f."systemType" = r."requestType"
   AND f."currentVersionId" IS NOT NULL
   AND r."formId" IS NULL
   AND r."formVersionId" IS NULL;

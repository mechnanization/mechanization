-- 0092_citizen_requests
--
-- المعاملات والإفادات — a citizen asks for a paper (a براءة ذمة, a إفادة سكن, a
-- lease registered), pays its fee, and collects the stamped paper at the
-- counter. Design: docs/municipal-requests-plan.md; the decisions behind it:
-- docs/open-decisions.md §20.
--
-- == What it is for =======================================================
--
--   request_type_settings        which request types this municipality offers,
--                                and the fee of each, set by the manager. A
--                                type with no row, or switched off, is not
--                                offered. No amount is written in code (D1).
--   citizen_requests             one request: whose, of what type, in what
--                                capacity, for which of the citizen's property
--                                cards, its status, and the bill its fee was
--                                charged on once the citizen went to pay.
--   citizen_request_attachments  the papers on a request (an identity copy, a
--                                title deed, a lease…): the object's key in the
--                                private documents bucket and its sniffed type.
--
-- == Two ways in ===========================================================
--
-- A citizen files online, or a clerk files at the counter for a citizen who is
-- present (D8). `channel` says which, and a counter request names the clerk
-- (`createdById`), held by `citizen_requests_counter_names_clerk`.
--
-- == The bill =============================================================
--
-- The fee is an ordinary one-off bill on `citizen_payments`, raised when the
-- citizen goes to pay rather than when the request is filed (D10): nothing on
-- this branch can cancel a bill, so a request abandoned before payment leaves
-- no open bill behind. `citizenPaymentId` is unique: one bill per request. The
-- request does not copy the amount; the bill holds it.
--
-- == Statuses ==============================================================
--
--   AWAITING_PAYMENT → IN_REVIEW (its bill is PAID; a free type starts here)
--   IN_REVIEW → READY_FOR_PICKUP (the clerk writes what the paper certifies)
--   READY_FOR_PICKUP → COMPLETED (handed over against the original ID card)
--   AWAITING_PAYMENT or IN_REVIEW → REJECTED (with a reason)
--   AWAITING_PAYMENT, while no bill exists → CANCELLED
--
-- Each status that ends a step carries its stamp, and the CHECKs below hold the
-- pairs. They are written so a NULL cannot pass them (docs/gotchas.md "A CHECK
-- passes on NULL"): each side of `=` is a plain boolean.
--
-- == Numbering ============================================================
--
-- «REQ-2610-0001», drawn from `document_counters` (0079) under the kind
-- 'REQUEST'. That column is text, so the new book needs no DDL here.
--
-- == Safety ===============================================================
--
-- Additive only: five new enum types and three new, empty tables. Nothing
-- existing is read or rewritten; the previous build keeps working and a
-- rollback is a redeploy. Idempotent throughout. Written unqualified (the
-- migrator sets `search_path`), and every catalog guard filters on
-- CURRENT_SCHEMA() (see 0050). Needs nothing newer than 0079: it references
-- `users`, `property_entries`, `building_units` and `citizen_payments`, all far
-- older. Not in `BackupService.TABLE_ORDER` yet, and not exposed by
-- `scripts/db/setup-claude-ro.sql`: the tables hold citizens' requests and the
-- keys of their identity copies.
--
-- Numbered 0092: `chore/migration-0090-0091` and `fix/finance-audit-remediation`
-- hold 0090 and 0091. Checked against every local and remote branch on
-- 2026-10-13; check again before the PR.

-- ══════════════════════════════  enums  ═══════════════════════════════════

DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('RequestType', $q$('CLEARANCE', 'RESIDENCY', 'OCCUPANCY', 'VACANCY', 'LEASE_REGISTRATION', 'RENOVATION', 'SIGNAGE', 'OTHER')$q$),
      ('ApplicantCapacity', $q$('OWNER', 'TENANT', 'ESTATE_HEIR', 'LEGAL_AGENT', 'FREE_OCCUPANT')$q$),
      ('RequestStatus', $q$('AWAITING_PAYMENT', 'IN_REVIEW', 'READY_FOR_PICKUP', 'COMPLETED', 'REJECTED', 'CANCELLED')$q$),
      ('RequestChannel', $q$('ONLINE', 'COUNTER')$q$),
      ('RequestAttachmentType', $q$('IDENTITY', 'OWNERSHIP_PROOF', 'LEASE_CONTRACT', 'POWER_OF_ATTORNEY', 'INHERITANCE_PROOF', 'MUKHTAR_STATEMENT', 'OTHER')$q$)
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

-- ══════════════════════════  request type settings  ═══════════════════════

CREATE TABLE IF NOT EXISTS "request_type_settings" (
  "requestType" "RequestType"  NOT NULL,
  -- Offered to citizens and at the counter only when true.
  "enabled"     BOOLEAN        NOT NULL DEFAULT false,
  -- In Lebanese pounds (D1). 0 is a free type: no bill is raised.
  "feeAmount"   DECIMAL(14,2)  NOT NULL DEFAULT 0,
  "updatedAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedById" UUID,
  CONSTRAINT "request_type_settings_pkey" PRIMARY KEY ("requestType"),
  CONSTRAINT "request_type_settings_fee_not_negative" CHECK ("feeAmount" >= 0),
  -- Whole pounds: the bill it becomes is in ل.ل.
  CONSTRAINT "request_type_settings_fee_whole_pounds" CHECK ("feeAmount" = trunc("feeAmount"))
);

-- ══════════════════════════════  requests  ════════════════════════════════

CREATE TABLE IF NOT EXISTS "citizen_requests" (
  "id"                UUID                NOT NULL DEFAULT gen_random_uuid(),
  "requestNumber"     TEXT                NOT NULL,
  "citizenId"         UUID                NOT NULL,
  "channel"           "RequestChannel"    NOT NULL,
  "requestType"       "RequestType"       NOT NULL,
  "applicantCapacity" "ApplicantCapacity" NOT NULL,
  "status"            "RequestStatus"     NOT NULL DEFAULT 'AWAITING_PAYMENT',
  -- The citizen's card, and optionally one unit line on it (D4).
  "propertyEntryId"   UUID,
  "buildingUnitId"    UUID,
  -- The bill the fee was charged on, once the citizen went to pay.
  "citizenPaymentId"  UUID,
  -- What the citizen needs the paper for.
  "purpose"           TEXT,
  -- What the paper certifies, written by the clerk when it is approved (D3).
  "statement"         TEXT,
  -- For a براءة ذمة: what was owed on the property when it was approved
  -- ({ total, unlinkedTotal, propertyNumber, checkedAt }), so the paper's
  -- «حتى تاريخ» is the moment it was judged.
  "clearanceSnapshot" JSONB,
  "rejectionReason"   TEXT,
  "clientRequestId"   UUID                NOT NULL,
  -- The clerk who filed a counter request; NULL online.
  "createdById"       UUID,
  "paidAt"            TIMESTAMPTZ(3),
  "readyAt"           TIMESTAMPTZ(3),
  "readyById"         UUID,
  "completedAt"       TIMESTAMPTZ(3),
  "completedById"     UUID,
  "rejectedAt"        TIMESTAMPTZ(3),
  "rejectedById"      UUID,
  "cancelledAt"       TIMESTAMPTZ(3),
  -- The clerk who cancelled; NULL when the citizen cancelled their own.
  "cancelledById"     UUID,
  "createdAt"         TIMESTAMPTZ(3)      NOT NULL DEFAULT now(),
  "updatedAt"         TIMESTAMPTZ(3)      NOT NULL DEFAULT now(),
  CONSTRAINT "citizen_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "citizen_requests_purpose_present" CHECK ("purpose" IS NULL OR length(btrim("purpose")) > 0),
  CONSTRAINT "citizen_requests_counter_names_clerk" CHECK (("channel" = 'COUNTER') = ("createdById" IS NOT NULL)),
  CONSTRAINT "citizen_requests_unit_on_card" CHECK ("buildingUnitId" IS NULL OR "propertyEntryId" IS NOT NULL),
  CONSTRAINT "citizen_requests_paid_stamp" CHECK (
    "status" NOT IN ('IN_REVIEW', 'READY_FOR_PICKUP', 'COMPLETED')
    OR "citizenPaymentId" IS NULL
    OR "paidAt" IS NOT NULL
  ),
  CONSTRAINT "citizen_requests_ready_stamp" CHECK (
    ("status" IN ('READY_FOR_PICKUP', 'COMPLETED')) = ("readyAt" IS NOT NULL)
  ),
  CONSTRAINT "citizen_requests_ready_states" CHECK (
    "readyAt" IS NULL
    OR ("readyById" IS NOT NULL AND "statement" IS NOT NULL AND length(btrim("statement")) > 0)
  ),
  CONSTRAINT "citizen_requests_completed_stamp" CHECK (
    ("status" = 'COMPLETED') = ("completedAt" IS NOT NULL AND "completedById" IS NOT NULL)
  ),
  CONSTRAINT "citizen_requests_rejected_stamp" CHECK (
    ("status" = 'REJECTED') = COALESCE(
      "rejectedAt" IS NOT NULL AND "rejectedById" IS NOT NULL AND length(btrim("rejectionReason")) > 0,
      false
    )
  ),
  CONSTRAINT "citizen_requests_cancelled_stamp" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL)),
  -- A request with a bill is paid or waits for it; only a bill-less one is cancelled.
  CONSTRAINT "citizen_requests_cancelled_without_bill" CHECK ("status" <> 'CANCELLED' OR "citizenPaymentId" IS NULL)
);

-- ═════════════════════════════  attachments  ══════════════════════════════

CREATE TABLE IF NOT EXISTS "citizen_request_attachments" (
  "id"           UUID                    NOT NULL DEFAULT gen_random_uuid(),
  "requestId"    UUID                    NOT NULL,
  "type"         "RequestAttachmentType" NOT NULL,
  -- The object's key in the private documents bucket. Never sent to a browser.
  "storagePath"  TEXT                    NOT NULL,
  -- As sniffed from the bytes by the server, never as the browser declared it.
  "mimeType"     TEXT                    NOT NULL,
  "sizeBytes"    INTEGER                 NOT NULL,
  -- The citizen (online) or the clerk who uploaded it: `users` holds both.
  "uploadedById" UUID                    NOT NULL,
  "createdAt"    TIMESTAMPTZ(3)          NOT NULL DEFAULT now(),
  CONSTRAINT "citizen_request_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "citizen_request_attachments_mime_known" CHECK (
    "mimeType" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
  ),
  CONSTRAINT "citizen_request_attachments_size_positive" CHECK ("sizeBytes" > 0)
);

-- ═══════════════════════════════  keys  ═══════════════════════════════════

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('request_type_settings', 'request_type_settings_updatedById_fkey',
         'FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('citizen_requests', 'citizen_requests_citizenId_fkey',
         'FOREIGN KEY ("citizenId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('citizen_requests', 'citizen_requests_propertyEntryId_fkey',
         'FOREIGN KEY ("propertyEntryId") REFERENCES "property_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('citizen_requests', 'citizen_requests_buildingUnitId_fkey',
         'FOREIGN KEY ("buildingUnitId") REFERENCES "building_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('citizen_requests', 'citizen_requests_citizenPaymentId_fkey',
         'FOREIGN KEY ("citizenPaymentId") REFERENCES "citizen_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('citizen_requests', 'citizen_requests_createdById_fkey',
         'FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('citizen_requests', 'citizen_requests_readyById_fkey',
         'FOREIGN KEY ("readyById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('citizen_requests', 'citizen_requests_completedById_fkey',
         'FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('citizen_requests', 'citizen_requests_rejectedById_fkey',
         'FOREIGN KEY ("rejectedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('citizen_requests', 'citizen_requests_cancelledById_fkey',
         'FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('citizen_request_attachments', 'citizen_request_attachments_requestId_fkey',
         'FOREIGN KEY ("requestId") REFERENCES "citizen_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('citizen_request_attachments', 'citizen_request_attachments_uploadedById_fkey',
         'FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE')
    ) AS t(tbl, name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = fk.name AND n.nspname = CURRENT_SCHEMA()
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', fk.tbl, fk.name, fk.definition);
    END IF;
  END LOOP;
END
$$;

-- ══════════════════════════════  indexes  ═════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS "citizen_requests_requestNumber_key" ON "citizen_requests" ("requestNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "citizen_requests_clientRequestId_key" ON "citizen_requests" ("clientRequestId");
CREATE UNIQUE INDEX IF NOT EXISTS "citizen_requests_citizenPaymentId_key" ON "citizen_requests" ("citizenPaymentId");
-- The staff queue, newest first, by status.
CREATE INDEX IF NOT EXISTS "citizen_requests_status_createdAt_idx" ON "citizen_requests" ("status", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "citizen_requests_createdAt_idx" ON "citizen_requests" ("createdAt" DESC);
-- «طلباتي».
CREATE INDEX IF NOT EXISTS "citizen_requests_citizenId_createdAt_idx" ON "citizen_requests" ("citizenId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "citizen_requests_propertyEntryId_idx" ON "citizen_requests" ("propertyEntryId");
CREATE INDEX IF NOT EXISTS "citizen_requests_buildingUnitId_idx" ON "citizen_requests" ("buildingUnitId");
CREATE INDEX IF NOT EXISTS "citizen_requests_createdById_idx" ON "citizen_requests" ("createdById");
CREATE INDEX IF NOT EXISTS "citizen_requests_readyById_idx" ON "citizen_requests" ("readyById");
CREATE INDEX IF NOT EXISTS "citizen_requests_completedById_idx" ON "citizen_requests" ("completedById");
CREATE INDEX IF NOT EXISTS "citizen_requests_rejectedById_idx" ON "citizen_requests" ("rejectedById");
CREATE INDEX IF NOT EXISTS "citizen_requests_cancelledById_idx" ON "citizen_requests" ("cancelledById");
-- One open request per citizen, type and card (D10). A request on no card keys
-- on the nil uuid, so two open «طلب عام» of one citizen also collide.
CREATE UNIQUE INDEX IF NOT EXISTS "citizen_requests_one_open_key" ON "citizen_requests" (
  "citizenId",
  "requestType",
  COALESCE("propertyEntryId", '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE "status" IN ('AWAITING_PAYMENT', 'IN_REVIEW', 'READY_FOR_PICKUP');

CREATE UNIQUE INDEX IF NOT EXISTS "citizen_request_attachments_storagePath_key" ON "citizen_request_attachments" ("storagePath");
CREATE INDEX IF NOT EXISTS "citizen_request_attachments_requestId_idx" ON "citizen_request_attachments" ("requestId", "createdAt");
CREATE INDEX IF NOT EXISTS "citizen_request_attachments_uploadedById_idx" ON "citizen_request_attachments" ("uploadedById");
CREATE INDEX IF NOT EXISTS "request_type_settings_updatedById_idx" ON "request_type_settings" ("updatedById");

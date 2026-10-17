-- 0074_expense_vouchers
--
-- النفقات — money leaving the municipality, and the voucher that says why.
-- Design: docs/finance.md §5.
--
-- == What it is for =======================================================
--
--   expense_categories  what the municipality spends on: محروقات، رواتب،
--                       صيانة… Rows, not an enum, because a municipality adds
--                       its own and an enum value cannot be added and used in
--                       the same migration. `key` is the stable handle for the
--                       few categories code must find by name (the inspector
--                       commissions one, the transfer-fee one); it is NULL on
--                       anything a municipality adds itself.
--   expense_vouchers    one «أمر صرف»: who was paid, from which wallet, how
--                       much, on what day, and what paper backs it.
--
-- == Recording is paying ==================================================
--
-- There is no draft and no approval step (a product decision, docs/finance.md
-- §5.1): the accountant records the expense and the money leaves the wallet in
-- the same transaction. So a voucher row always has its `treasury_entries` row,
-- and the wallet balance never disagrees with the vouchers that moved it.
--
-- A mistake is corrected by voiding — `voidedAt`, `voidedById`, `voidReason`,
-- with an opposing ledger entry — and never by editing the amount. That is why
-- this table takes UPDATE while `treasury_entries` does not: the voucher is a
-- document that gets a cancellation stamp, the ledger is the money itself.
--
-- == Safety ===============================================================
--
-- Additive only: two new empty tables, one sequence, ten seeded category rows.
-- Nothing existing is read or rewritten; the previous build keeps working and a
-- rollback is a redeploy. Idempotent throughout. Written unqualified (the
-- migrator sets `search_path`), and every catalog guard filters on
-- CURRENT_SCHEMA() (see 0050). Needs 0073, which creates `treasury_accounts`
-- and the (id, currency) key this table's foreign key points at.

-- ═══════════════════════════════  numbering  ═══════════════════════════════
--
-- A sequence, not MAX(voucherNumber) + 1: two clerks recording at the same
-- moment would read the same maximum and print the same «أمر صرف» number on two
-- different payments. A sequence hands out each value once and never reuses one
-- after a rollback — a gap is a question a municipality can answer ("that one
-- was rolled back"), two vouchers with one number is not.
CREATE SEQUENCE IF NOT EXISTS "expense_voucher_seq" START 1;

-- ══════════════════════════════  categories  ═══════════════════════════════

CREATE TABLE IF NOT EXISTS "expense_categories" (
  "id"          UUID           NOT NULL DEFAULT gen_random_uuid(),
  -- The stable handle, for the categories code has to find. NULL for a
  -- municipality's own, which code never looks up by name.
  "key"         TEXT,
  "name"        TEXT           NOT NULL,
  "description" TEXT,

  -- باب وبند الموازنة — the chapter and article this category is charged to in
  -- the municipality's own budget.
  --
  -- Both NULL on every seeded row, deliberately. These codes come from the
  -- municipality's adopted budget, and this file has no way to know them;
  -- writing plausible-looking official codes into a financial record would be
  -- worse than leaving them empty, because a later reader cannot tell an
  -- invented code from a real one. The municipality fills them in, and «قطع
  -- الحساب» reads them when that report is built.
  "chapterCode" TEXT,
  "itemCode"    TEXT,

  -- Deactivated, never deleted: a voucher points here for ever, and a deleted
  -- category would take the meaning of every expense filed under it.
  "active"      BOOLEAN        NOT NULL DEFAULT true,
  "sortOrder"   INTEGER        NOT NULL DEFAULT 100,
  "createdAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

  CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "expense_categories_name_present" CHECK (length(btrim("name")) > 0),
  -- A chapter without its article, or the reverse, is a half-entered code that
  -- no report can use.
  CONSTRAINT "expense_categories_budget_code_complete" CHECK (
    ("chapterCode" IS NULL) = ("itemCode" IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "expense_categories_key_key"
  ON "expense_categories" ("key") WHERE "key" IS NOT NULL;

-- One category per budget article: two categories charged to the same article
-- would make «قطع الحساب» add the same line twice.
CREATE UNIQUE INDEX IF NOT EXISTS "expense_categories_budget_code_key"
  ON "expense_categories" ("chapterCode", "itemCode") WHERE "chapterCode" IS NOT NULL;

-- ═══════════════════════════════  vouchers  ════════════════════════════════

CREATE TABLE IF NOT EXISTS "expense_vouchers" (
  "id"                 UUID           NOT NULL DEFAULT gen_random_uuid(),
  -- Printed on the «أمر صرف». Drawn from the sequence above.
  "voucherNumber"      TEXT           NOT NULL,
  "categoryId"         UUID           NOT NULL,

  -- The wallet the money left. Paired with the currency so the foreign key
  -- itself refuses a ليرة voucher drawn on a dollar safe.
  "accountId"          UUID           NOT NULL,
  "currency"           TEXT           NOT NULL,
  -- Positive: what was paid. The ledger entry it writes is the negative one.
  "amount"             DECIMAL(14,2)  NOT NULL,

  -- Who received the money. Free text — a supplier register is a later step —
  -- and it may name a citizen, so it is personal data and stays out of logs,
  -- Sentry and audit rows (docs/finance.md §13.1).
  "payee"              TEXT           NOT NULL,
  -- What it was for. Required: an expense a later reader cannot explain is one
  -- the municipality cannot defend.
  "description"        TEXT           NOT NULL,

  -- The day the money left, which is not always the day the row was written.
  "occurredAt"         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  -- Why it is dated before today. The server requires one for any back-dating.
  "adjustmentReason"   TEXT,

  -- The supplier's invoice number, and whether the paper is in the file. Both
  -- are what an auditor asks for first; the scan itself is step 3b.
  "invoiceNumber"      TEXT,
  "hasPhysicalReceipt" BOOLEAN        NOT NULL DEFAULT false,

  "recordedById"       UUID,
  -- One id per press of «سجّل النفقة». A retry after a lost response finds the
  -- first voucher instead of paying twice.
  "clientRequestId"    UUID,

  -- The cancellation stamp. All three move together.
  "voidedAt"           TIMESTAMPTZ(3),
  "voidedById"         UUID,
  "voidReason"         TEXT,

  "createdAt"          TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

  CONSTRAINT "expense_vouchers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "expense_vouchers_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "expense_vouchers_payee_present" CHECK (length(btrim("payee")) > 0),
  CONSTRAINT "expense_vouchers_description_present" CHECK (length(btrim("description")) > 0),
  -- A void says why, and a reason without a void is a half-written cancellation.
  CONSTRAINT "expense_vouchers_void_complete" CHECK (
    ("voidedAt" IS NULL AND "voidReason" IS NULL)
    OR ("voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL AND length(btrim("voidReason")) > 0)
  )
);

-- ═══════════════════════════════  foreign keys  ════════════════════════════
--
-- RESTRICT throughout, as on the ledger: a staff member who paid money out, a
-- category money was spent under, and a wallet it left cannot be erased from
-- the record of it.

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('expense_vouchers', 'expense_vouchers_categoryId_fkey',
         'FOREIGN KEY ("categoryId") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('expense_vouchers', 'expense_vouchers_account_currency_fkey',
         'FOREIGN KEY ("accountId", "currency") REFERENCES "treasury_accounts"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT'),
      ('expense_vouchers', 'expense_vouchers_recordedById_fkey',
         'FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('expense_vouchers', 'expense_vouchers_voidedById_fkey',
         'FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE')
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

-- ═════════════════════════════════  indexes  ═══════════════════════════════
--
-- All on a new, empty table, so none of them locks anything live.

CREATE UNIQUE INDEX IF NOT EXISTS "expense_vouchers_voucherNumber_key"
  ON "expense_vouchers" ("voucherNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "expense_vouchers_clientRequestId_key"
  ON "expense_vouchers" ("clientRequestId");

-- «ما صرفناه هذا الشهر», newest first.
CREATE INDEX IF NOT EXISTS "expense_vouchers_occurredAt_idx"
  ON "expense_vouchers" ("occurredAt" DESC);
-- Spending by category, and by wallet.
CREATE INDEX IF NOT EXISTS "expense_vouchers_categoryId_occurredAt_idx"
  ON "expense_vouchers" ("categoryId", "occurredAt" DESC);
CREATE INDEX IF NOT EXISTS "expense_vouchers_accountId_occurredAt_idx"
  ON "expense_vouchers" ("accountId", "occurredAt" DESC);
CREATE INDEX IF NOT EXISTS "expense_vouchers_recordedById_idx"
  ON "expense_vouchers" ("recordedById");

-- ══════════════════════════════  the categories  ═══════════════════════════
--
-- The list agreed with the municipality (docs/finance.md §5.5). Seeded by
-- `key`, so a municipality that has renamed one keeps its own wording when this
-- file replays. A municipality adds its own through الإعدادات; nothing here
-- deletes or deactivates what it finds.

INSERT INTO "expense_categories" ("key", "name", "sortOrder")
SELECT seed."key", seed."name", seed."sortOrder"
  FROM (VALUES
    ('FUEL',               'محروقات وزيوت',             10),
    ('SALARIES',           'رواتب وأجور',                20),
    ('MAINTENANCE',        'صيانة وتصليح',               30),
    ('WASTE',              'نظافة وجمع نفايات',          40),
    ('OFFICE_SUPPLIES',    'قرطاسية ولوازم مكتبية',      50),
    ('ELECTRICITY',        'كهرباء وإنارة',              60),
    ('FIELD_COMMISSIONS',  'تعويضات المسح والجباية',     70),
    ('SOCIAL_AID',         'مساعدات اجتماعية وإغاثية',   80),
    ('TRANSFER_FEES',      'رسوم تحويل ومصرفية',         90),
    ('MISC',               'نفقات متفرقة',              100)
  ) AS seed("key", "name", "sortOrder")
 WHERE NOT EXISTS (
   SELECT 1 FROM "expense_categories" c WHERE c."key" = seed."key"
 );

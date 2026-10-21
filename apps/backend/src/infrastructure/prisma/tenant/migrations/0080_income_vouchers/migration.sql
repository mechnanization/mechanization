-- 0080_income_vouchers
--
-- الإيرادات العامة — money that reaches the municipality without a citizen's
-- bill behind it, and the «سند قبض إيرادات» that says where it came from.
-- Design: docs/finance.md §4.
--
-- == What it is for =======================================================
--
--   income_categories  where income comes from: الصندوق البلدي المستقل، رخص
--                      البناء، الإيجارات، الهبات، الغرامات… Rows, not an enum,
--                      because a municipality adds its own and an enum value
--                      cannot be added and used in the same migration. `key`
--                      is the stable handle for the seeded rows; it is NULL on
--                      anything a municipality adds itself. Each row carries
--                      an Arabic name and, where one exists, an English one.
--   income_vouchers    one «سند قبض»: who paid, into which wallet, how much, on
--                      what day, and the cheque or transfer number behind it.
--
-- Citizen fees are not income vouchers. They already credit the wallets through
-- the payment ledger (0073), and a voucher for one would count it twice.
--
-- == Recording is receiving ===============================================
--
-- The accountant records the voucher and the wallet's balance rises in the same
-- transaction (an `INCOME_VOUCHER` entry in `treasury_entries`; the enum value
-- has existed since 0073). So a voucher row always has its ledger entry, and the
-- wallet balance never disagrees with the vouchers that moved it.
--
-- A mistake is corrected by voiding — `voidedAt`, `voidedById`, `voidReason`,
-- with an opposing ledger entry — and never by editing the amount. That is why
-- this table takes UPDATE while `treasury_entries` does not: the voucher is a
-- document that gets a cancellation stamp, the ledger is the money itself.
--
-- == Numbering ============================================================
--
-- «RV-2610-0001», drawn from `document_counters` (0079) under the kind
-- 'REVENUE_VOUCHER'. That column is text, so the fifth book needs no DDL here and
-- this migration creates no sequence.
--
-- == Safety ===============================================================
--
-- Additive only: two new empty tables and seven seeded category rows. Nothing
-- existing is read or rewritten; the previous build keeps working and a rollback
-- is a redeploy. Idempotent throughout. Written unqualified (the migrator sets
-- `search_path`), and every catalog guard filters on CURRENT_SCHEMA() (see 0050).
-- Needs 0073, which creates `treasury_accounts` and the (id, currency) key this
-- table's foreign key points at.
--
-- Numbered 0080: 0073–0074 and 0078–0079 are this branch's, and 0075–0077
-- belong to `chore/migration-0075-0077`. Checked against every local and
-- remote branch on 2026-10-09; check again before the PR.

-- ══════════════════════════════  categories  ═══════════════════════════════

CREATE TABLE IF NOT EXISTS "income_categories" (
  "id"          UUID           NOT NULL DEFAULT gen_random_uuid(),
  -- The stable handle, for the seeded categories. NULL for a municipality's
  -- own, which code never looks up by name.
  "key"         TEXT,
  -- The name as the municipality reads it, and its English one where it has
  -- one. A category the municipality adds in Arabic alone has no English name,
  -- and the English screen shows the Arabic rather than an invented translation.
  "labelAr"     TEXT           NOT NULL,
  "labelEn"     TEXT,

  -- باب وبند الموازنة — the chapter and article this income is credited to in
  -- the municipality's own budget.
  --
  -- Both NULL on every seeded row, deliberately, for the reason 0074 gives: the
  -- codes come from the municipality's adopted budget, this file cannot know
  -- them, and a plausible-looking invented code in a financial record is worse
  -- than an empty one.
  "chapterCode" TEXT,
  "itemCode"    TEXT,

  -- Deactivated, never deleted: a voucher points here for ever.
  "active"      BOOLEAN        NOT NULL DEFAULT true,
  "sortOrder"   INTEGER        NOT NULL DEFAULT 100,
  "createdAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

  CONSTRAINT "income_categories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "income_categories_label_present" CHECK (length(btrim("labelAr")) > 0),
  CONSTRAINT "income_categories_label_en_present" CHECK (
    "labelEn" IS NULL OR length(btrim("labelEn")) > 0
  ),
  -- A chapter without its article, or the reverse, is a half-entered code that
  -- no report can use.
  CONSTRAINT "income_categories_budget_code_complete" CHECK (
    ("chapterCode" IS NULL) = ("itemCode" IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "income_categories_key_key"
  ON "income_categories" ("key") WHERE "key" IS NOT NULL;

-- One category per budget article: two on the same article would make «قطع
-- الحساب» add the same line twice.
CREATE UNIQUE INDEX IF NOT EXISTS "income_categories_budget_code_key"
  ON "income_categories" ("chapterCode", "itemCode") WHERE "chapterCode" IS NOT NULL;

-- ═══════════════════════════════  vouchers  ════════════════════════════════

CREATE TABLE IF NOT EXISTS "income_vouchers" (
  "id"                UUID           NOT NULL DEFAULT gen_random_uuid(),
  -- Printed on the «سند قبض». Drawn through `allocateDocumentNumbers`.
  "voucherNumber"     TEXT           NOT NULL,
  "categoryId"        UUID           NOT NULL,

  -- The wallet the money reached. Paired with the currency so the foreign key
  -- itself refuses a ليرة voucher received into a dollar safe.
  "accountId"         UUID           NOT NULL,
  "currency"          TEXT           NOT NULL,
  -- Positive: what was received. The ledger entry it writes is the same figure.
  -- (14,2), the ledger's own precision: a voucher carrying a fraction the
  -- ledger cannot hold would post a different figure from the one it prints.
  "amount"            DECIMAL(14,2)  NOT NULL,

  -- Who paid — «مصرف لبنان»، «وزارة الاتصالات»، a tenant of a municipal shop.
  -- Optional, free text, and it may name a citizen (a fine, a rent), so it is
  -- personal data and stays out of logs, Sentry and audit rows
  -- (docs/finance.md §13.1).
  "payerName"         TEXT,
  -- What the money is. Required: income a later reader cannot explain is
  -- income the municipality cannot account for.
  "description"       TEXT           NOT NULL,
  -- The cheque number, or the bank or Whish transfer number, that proves it.
  "externalReference" TEXT,

  -- The day the money arrived, which is not always the day the row was written.
  "occurredAt"        TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  -- Why it is dated before today. The server requires one for any back-dating.
  "adjustmentReason"  TEXT,

  "recordedById"      UUID,
  -- One id per press of «سجّل الإيراد». NOT NULL: every request carries one, and
  -- a retry after a lost response must find the first voucher instead of
  -- crediting the wallet a second time.
  "clientRequestId"   UUID           NOT NULL,

  -- The cancellation stamp. All three move together.
  "voidedAt"          TIMESTAMPTZ(3),
  "voidedById"        UUID,
  "voidReason"        TEXT,

  "createdAt"         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

  CONSTRAINT "income_vouchers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "income_vouchers_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "income_vouchers_description_present" CHECK (length(btrim("description")) > 0),
  CONSTRAINT "income_vouchers_payer_present" CHECK (
    "payerName" IS NULL OR length(btrim("payerName")) > 0
  ),
  -- A void says why, and a reason without a void is a half-written cancellation.
  CONSTRAINT "income_vouchers_void_complete" CHECK (
    ("voidedAt" IS NULL AND "voidReason" IS NULL)
    OR ("voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL AND length(btrim("voidReason")) > 0)
  )
);

-- ═══════════════════════════════  foreign keys  ════════════════════════════
--
-- RESTRICT throughout, as on the ledger: a staff member who received money, a
-- category it was filed under, and a wallet it reached cannot be erased from
-- the record of it.

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('income_vouchers', 'income_vouchers_categoryId_fkey',
         'FOREIGN KEY ("categoryId") REFERENCES "income_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('income_vouchers', 'income_vouchers_account_currency_fkey',
         'FOREIGN KEY ("accountId", "currency") REFERENCES "treasury_accounts"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT'),
      ('income_vouchers', 'income_vouchers_recordedById_fkey',
         'FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('income_vouchers', 'income_vouchers_voidedById_fkey',
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

CREATE UNIQUE INDEX IF NOT EXISTS "income_vouchers_voucherNumber_key"
  ON "income_vouchers" ("voucherNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "income_vouchers_clientRequestId_key"
  ON "income_vouchers" ("clientRequestId");

-- «ما دخل هذا الشهر», newest first.
CREATE INDEX IF NOT EXISTS "income_vouchers_occurredAt_idx"
  ON "income_vouchers" ("occurredAt" DESC);
-- Income by source, and by wallet.
CREATE INDEX IF NOT EXISTS "income_vouchers_categoryId_occurredAt_idx"
  ON "income_vouchers" ("categoryId", "occurredAt" DESC);
CREATE INDEX IF NOT EXISTS "income_vouchers_accountId_occurredAt_idx"
  ON "income_vouchers" ("accountId", "occurredAt" DESC);
-- Every foreign key indexed (docs/finance.md §10), the two to `users` included.
CREATE INDEX IF NOT EXISTS "income_vouchers_recordedById_idx"
  ON "income_vouchers" ("recordedById");
CREATE INDEX IF NOT EXISTS "income_vouchers_voidedById_idx"
  ON "income_vouchers" ("voidedById");

-- ══════════════════════════════  the categories  ═══════════════════════════
--
-- The seven agreed on 2026-10-09 — docs/finance.md §4.3's six, and the state's
-- share of telephone, electricity and water revenue as its own line. Seeded by
-- `key`, so a municipality that has renamed one keeps its own wording when this
-- file replays; nothing here deletes or deactivates what it finds.

INSERT INTO "income_categories" ("key", "labelAr", "labelEn", "sortOrder")
SELECT seed."key", seed."labelAr", seed."labelEn", seed."sortOrder"
  FROM (VALUES
    ('INDEPENDENT_MUNICIPAL_FUND',     'الصندوق البلدي المستقل',                   'Independent Municipal Fund',                         10),
    ('STATE_UTILITIES_FEES',           'عائدات الهاتف والكهرباء والمياه من الدولة', 'State telephone, electricity and water revenue',    20),
    ('BUILDING_PERMITS_PLANNING',      'رخص بناء وإشغال وتخطيط',                   'Building, occupancy and planning permits',           30),
    ('PROPERTY_RENTAL_INVESTMENT',     'إيجارات واستثمار أملاك البلدية',           'Rent and investment of municipal property',          40),
    ('UNCONDITIONAL_GRANTS_DONATIONS', 'هبات ومساعدات غير مشروطة',                 'Unconditional grants and donations',                 50),
    ('FINES_AND_PENALTIES',            'غرامات ومخالفات',                          'Fines and violations',                               60),
    ('MISCELLANEOUS_INCOME',           'إيرادات متفرقة',                           'Miscellaneous income',                               70)
  ) AS seed("key", "labelAr", "labelEn", "sortOrder")
 WHERE NOT EXISTS (
   SELECT 1 FROM "income_categories" c WHERE c."key" = seed."key"
 );

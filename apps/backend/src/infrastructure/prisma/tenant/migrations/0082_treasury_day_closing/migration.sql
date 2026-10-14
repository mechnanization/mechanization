-- 0082_treasury_day_closing
--
-- جرد الصندوق وإقفال اليومية — the day's count of every wallet, and the act
-- that closes a municipal business day so that nothing can be written into it
-- afterwards. Design: docs/finance.md §7.
--
-- == What it is for =======================================================
--
--   treasury_day_closures  one row per municipal business day that has been
--                          closed: by whom and when, whether it was closed by
--                          hand or swept closed because none of the counted
--                          wallets moved that day (`autoClosed`), and — while
--                          it stands open again — who reopened it and why.
--   treasury_counts        one count per wallet per day: what the books said
--                          (`expectedAmount`, the sum of the wallet's entries
--                          up to the end of that day), what was found
--                          (`countedAmount`), the difference, and why it is
--                          not zero.
--
-- A difference never changes the books. It is recorded, explained and printed
-- on the day's report; bringing a wallet into line with its count is a separate
-- act by the manager (an `ADJUSTMENT` entry, not built yet), dated on an open
-- day (docs/finance.md §7.2).
--
-- A day has three states and two of them are stored: no row is an open day;
-- CLOSED is locked; REOPENED is a day the manager opened again, which must be
-- closed again before any later day can be.
--
-- == The lock =============================================================
--
-- A closed day takes no new money. The application refuses it first, with a
-- sentence a clerk can act on; three triggers hold the same rule at the
-- database, so a writer that forgets the check still cannot get past it:
--
--   * `treasury_entries` refuses an INSERT, UPDATE or DELETE whose day — the
--     entry's `occurredAt` on Beirut's calendar — is on or before a CLOSED
--     day. UPDATE and DELETE are already refused by 0073's append-only
--     triggers, which fire first (triggers fire in name order); this one covers
--     them anyway, so the rule does not lean on the other.
--   * `treasury_counts` refuses any write to a count whose day is on or before a
--     CLOSED day, except the one write closing itself makes: linking each count
--     to its own day's closure.
--   * `treasury_day_closures` refuses DELETE. A closure is reopened, with a
--     reason, and never erased: deleting the row would unlock the day with no
--     record that it had ever been closed.
--
-- The day is computed with 'Asia/Beirut', the database's copy of
-- `MUNICIPAL_TIME_ZONE` (packages/shared-schemas, cash-policy.ts), the same
-- calendar `municipalToday` reads. Change the two together.
--
-- == Safety ===============================================================
--
-- Additive: one enum type, two new empty tables, three functions and three
-- triggers. The trigger on `treasury_entries` is new behaviour on an existing
-- table, but it refuses nothing until a closure row exists, and none can exist
-- before the code that writes one ships — so the previous build keeps working
-- against this schema and a rollback is a redeploy. CREATE TRIGGER takes a
-- brief SHARE ROW EXCLUSIVE lock on `treasury_entries`, which has not reached
-- production (0073 is not on `main`) and holds a few thousand rows at most
-- anywhere. Idempotent throughout. Written unqualified (the migrator sets
-- `search_path`); every catalog guard filters on CURRENT_SCHEMA() (see 0050);
-- every function pins its `search_path` (see 0030). Needs 0073, which creates
-- `treasury_accounts`, `treasury_entries` and the (id, currency) key.
--
-- Numbered 0082: 0073–0074 and 0078–0081 are the finance branch's, and no local
-- or remote branch held an 0082 on 2026-10-10. Check again before the PR.

-- ═══════════════════════════════════  status  ═════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'TreasuryDayStatus' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TYPE "TreasuryDayStatus" AS ENUM ('CLOSED', 'REOPENED');
  END IF;
END
$$;

-- ═════════════════════════════  treasury_day_closures  ════════════════════════

CREATE TABLE IF NOT EXISTS "treasury_day_closures" (
  "id"           UUID                NOT NULL DEFAULT gen_random_uuid(),
  -- The municipal business day, on Beirut's calendar. One row per day.
  "businessDate" DATE                NOT NULL,
  "status"       "TreasuryDayStatus" NOT NULL DEFAULT 'CLOSED',
  -- Swept closed, uncounted, when a later day was closed: none of the counted
  -- wallets moved on it, so a count could only have repeated the day before.
  "autoClosed"   BOOLEAN             NOT NULL DEFAULT false,
  "closedAt"     TIMESTAMPTZ(3)      NOT NULL DEFAULT now(),
  -- The person who closed it — for a swept day, the person whose close swept it.
  "closedById"   UUID                NOT NULL,
  -- Set while the day stands open again, and only then (CHECK below). Re-closing
  -- clears them; the audit log keeps every reopening.
  "reopenedAt"   TIMESTAMPTZ(3),
  "reopenedById" UUID,
  "reopenReason" TEXT,
  "createdAt"    TIMESTAMPTZ(3)      NOT NULL DEFAULT now(),

  CONSTRAINT "treasury_day_closures_pkey" PRIMARY KEY ("id"),
  -- A reopened day says who opened it and why; a closed one carries none of it.
  CONSTRAINT "treasury_day_closures_reopen_iff_reopened" CHECK (
    ("status" = 'CLOSED'
       AND "reopenedAt" IS NULL AND "reopenedById" IS NULL AND "reopenReason" IS NULL)
    OR ("status" = 'REOPENED'
       AND "reopenedAt" IS NOT NULL AND "reopenedById" IS NOT NULL
       AND "reopenReason" IS NOT NULL AND length(btrim("reopenReason")) > 0)
  )
);

-- ═══════════════════════════════  treasury_counts  ════════════════════════════

CREATE TABLE IF NOT EXISTS "treasury_counts" (
  "id"             UUID           NOT NULL DEFAULT gen_random_uuid(),
  -- The wallet counted, paired with its currency so the foreign key itself
  -- refuses a count recorded against a wallet of another currency.
  "accountId"      UUID           NOT NULL,
  "currency"       TEXT           NOT NULL,
  "businessDate"   DATE           NOT NULL,
  -- What the books said: the wallet's entries summed to the end of the day,
  -- computed by the server when the count was recorded. (14,2), the ledger's
  -- own precision.
  "expectedAmount" DECIMAL(14,2)  NOT NULL,
  -- What was found: the notes in the safe, or the balance read off the Whish
  -- app or the bank statement. A total, not a note-by-note breakdown (v1).
  "countedAmount"  DECIMAL(14,2)  NOT NULL,
  -- counted − expected. Positive is a surplus (فائض), negative a shortage (عجز).
  "difference"     DECIMAL(14,2)  NOT NULL,
  -- Why the count and the books disagree. Required whenever they do.
  "varianceReason" TEXT,
  "countedById"    UUID           NOT NULL,
  "countedAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  -- The closure that locked this count, set when its day is closed.
  "closureId"      UUID,
  "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

  CONSTRAINT "treasury_counts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "treasury_counts_counted_not_negative" CHECK ("countedAmount" >= 0),
  CONSTRAINT "treasury_counts_difference_consistent" CHECK (
    "difference" = "countedAmount" - "expectedAmount"
  ),
  CONSTRAINT "treasury_counts_variance_explained" CHECK (
    "difference" = 0 OR ("varianceReason" IS NOT NULL AND length(btrim("varianceReason")) > 0)
  ),
  CONSTRAINT "treasury_counts_reason_present" CHECK (
    "varianceReason" IS NULL OR length(btrim("varianceReason")) > 0
  )
);

-- ═══════════════════════════════  foreign keys  ════════════════════════════
--
-- RESTRICT throughout, as on the ledger: a wallet that was counted, the person
-- who counted it, and the person who closed or reopened a day cannot be erased
-- from the record of having done so.

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('treasury_day_closures', 'treasury_day_closures_closedById_fkey',
         'FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('treasury_day_closures', 'treasury_day_closures_reopenedById_fkey',
         'FOREIGN KEY ("reopenedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('treasury_counts', 'treasury_counts_account_currency_fkey',
         'FOREIGN KEY ("accountId", "currency") REFERENCES "treasury_accounts"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT'),
      ('treasury_counts', 'treasury_counts_countedById_fkey',
         'FOREIGN KEY ("countedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('treasury_counts', 'treasury_counts_closureId_fkey',
         'FOREIGN KEY ("closureId") REFERENCES "treasury_day_closures"("id") ON DELETE RESTRICT ON UPDATE CASCADE')
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
-- All on the two new, empty tables, so none of them locks anything live.

-- One closure per day; also what every lock check walks («is anything on or
-- after this day closed?»).
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_day_closures_businessDate_key"
  ON "treasury_day_closures" ("businessDate");
CREATE INDEX IF NOT EXISTS "treasury_day_closures_closedById_idx"
  ON "treasury_day_closures" ("closedById");
CREATE INDEX IF NOT EXISTS "treasury_day_closures_reopenedById_idx"
  ON "treasury_day_closures" ("reopenedById");

-- One count per wallet per day; a recount replaces it until the day closes.
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_counts_accountId_businessDate_key"
  ON "treasury_counts" ("accountId", "businessDate");
-- A day's counts, which the unique index above cannot serve (it leads with the wallet).
CREATE INDEX IF NOT EXISTS "treasury_counts_businessDate_idx"
  ON "treasury_counts" ("businessDate");
CREATE INDEX IF NOT EXISTS "treasury_counts_countedById_idx"
  ON "treasury_counts" ("countedById");
CREATE INDEX IF NOT EXISTS "treasury_counts_closureId_idx"
  ON "treasury_counts" ("closureId");

-- ═══════════════════════════  the lock, at the database  ═══════════════════
--
-- Each check asks one question: is there a CLOSED day on or after this one?
-- Closures run in date order from go-live with no gaps (the application closes
-- the quiet days in between when it closes a later one), so that is the same as
-- "is this day closed, or before one that is". The unique index on
-- `businessDate` answers it with a short range scan.
--
-- The message names the day in ISO form and starts «treasury day … is closed»:
-- `closedTreasuryDay` (infrastructure/prisma/check-violation.ts) reads it back
-- to turn the refusal into `CLOSED_DAY_MUTATION_BLOCKED` instead of a 500.

CREATE OR REPLACE FUNCTION reject_closed_day_entry() RETURNS TRIGGER AS $fn$
DECLARE
  entry_day DATE;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    entry_day := (NEW."occurredAt" AT TIME ZONE 'Asia/Beirut')::date;
    IF EXISTS (
      SELECT 1 FROM "treasury_day_closures" c
       WHERE c."status" = 'CLOSED' AND c."businessDate" >= entry_day
    ) THEN
      RAISE EXCEPTION 'treasury day % is closed: no entry may be written on or before a closed day',
        to_char(entry_day, 'YYYY-MM-DD')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    entry_day := (OLD."occurredAt" AT TIME ZONE 'Asia/Beirut')::date;
    IF EXISTS (
      SELECT 1 FROM "treasury_day_closures" c
       WHERE c."status" = 'CLOSED' AND c."businessDate" >= entry_day
    ) THEN
      RAISE EXCEPTION 'treasury day % is closed: no entry may be changed on or before a closed day',
        to_char(entry_day, 'YYYY-MM-DD')
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  END IF;

  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reject_closed_day_count() RETURNS TRIGGER AS $fn$
BEGIN
  /*
    The one write a closed day's count takes: closing links it to its own day's
    closure. Nothing else may change in that write — compared as the whole row
    minus the link, so a column added later is covered without editing this.
  */
  IF TG_OP = 'UPDATE'
     AND OLD."closureId" IS NULL
     AND NEW."closureId" IS NOT NULL
     AND (to_jsonb(NEW) - 'closureId') = (to_jsonb(OLD) - 'closureId')
     AND EXISTS (
       SELECT 1 FROM "treasury_day_closures" c
        WHERE c."id" = NEW."closureId" AND c."businessDate" = NEW."businessDate"
     ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'DELETE' AND EXISTS (
    SELECT 1 FROM "treasury_day_closures" c
     WHERE c."status" = 'CLOSED' AND c."businessDate" >= NEW."businessDate"
  ) THEN
    RAISE EXCEPTION 'treasury day % is closed: its counts can no longer change',
      to_char(NEW."businessDate", 'YYYY-MM-DD')
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP <> 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM "treasury_day_closures" c
       WHERE c."status" = 'CLOSED' AND c."businessDate" >= OLD."businessDate"
    ) THEN
      RAISE EXCEPTION 'treasury day % is closed: its counts can no longer change',
        to_char(OLD."businessDate", 'YYYY-MM-DD')
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  END IF;

  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reject_day_closure_delete() RETURNS TRIGGER AS $fn$
BEGIN
  RAISE EXCEPTION 'treasury_day_closures rows are never deleted: reopen the day instead';
END
$fn$ LANGUAGE plpgsql;

-- PL/pgSQL resolves table names when it runs, against the caller's
-- `search_path`. Each tenant schema has its own copy of these functions, and
-- each must read its own `treasury_day_closures` however the calling
-- connection is configured — or a write in one municipality would be judged
-- against another's closed days. Pinned to the schema they belong to.
DO $$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.reject_closed_day_entry() SET search_path = %I, pg_catalog',
    CURRENT_SCHEMA(), CURRENT_SCHEMA()
  );
  EXECUTE format(
    'ALTER FUNCTION %I.reject_closed_day_count() SET search_path = %I, pg_catalog',
    CURRENT_SCHEMA(), CURRENT_SCHEMA()
  );
  EXECUTE format(
    'ALTER FUNCTION %I.reject_day_closure_delete() SET search_path = %I, pg_catalog',
    CURRENT_SCHEMA(), CURRENT_SCHEMA()
  );
END
$$;

DO $$
BEGIN
  -- Named to sort after `treasury_entries_no_update` / `_no_delete`, so an edit
  -- or a delete is refused as append-only first, which is the truer reason.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE tg.tgname = 'treasury_entries_respect_closed_days' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TRIGGER treasury_entries_respect_closed_days
      BEFORE INSERT OR UPDATE OR DELETE ON "treasury_entries"
      FOR EACH ROW EXECUTE FUNCTION reject_closed_day_entry();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE tg.tgname = 'treasury_counts_respect_closed_days' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TRIGGER treasury_counts_respect_closed_days
      BEFORE INSERT OR UPDATE OR DELETE ON "treasury_counts"
      FOR EACH ROW EXECUTE FUNCTION reject_closed_day_count();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE tg.tgname = 'treasury_day_closures_no_delete' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TRIGGER treasury_day_closures_no_delete
      BEFORE DELETE ON "treasury_day_closures"
      FOR EACH ROW EXECUTE FUNCTION reject_day_closure_delete();
  END IF;
END
$$;

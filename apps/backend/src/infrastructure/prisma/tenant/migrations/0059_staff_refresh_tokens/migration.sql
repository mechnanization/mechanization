-- 0059_staff_refresh_tokens
--
-- One row per refresh token a staff session has been issued, stored as a keyed
-- hash and chained to the token it replaced.
--
-- == Why ===================================================================
--
-- `refreshStaffSession` exchanges a staff access token, expired or not, for a
-- fresh one. That token is the only credential it asks for, and it lives in
-- the page's storage — so anyone who can read that storage once (a script
-- injected into the portal, an extension, a shared machine) can keep the
-- session alive until its cap: eight hours, or thirty days with «تذكّرني». The
-- method's own comment has said as much since it was written: shortening that
-- window needs a second, separately-stored credential that only the refresh
-- route accepts, rotated on every use, with reuse detected.
--
-- This table is that credential's server side. The token itself travels only
-- in an httpOnly cookie the page cannot read. Each exchange marks its row used
-- and inserts a child; presenting a token after the chain has moved past it
-- ends the whole family. The access token is still sent to the refresh route,
-- but only as the binding that says which account the tab belongs to — never
-- as enough on its own.
--
-- `familyId` is the session. A staff access token carries it as `sid`, and the
-- guard refuses a token whose family's root row is revoked, so a logout or a
-- detected reuse ends the access token as well as the refresh token.
--
-- == What this is NOT ======================================================
--
-- **It does not lengthen a session.** `expiresAt` is the cap fixed at sign-in,
-- copied onto every row of a family and never moved by a rotation. A session
-- lasts exactly as long as it did before this table existed.
--
-- **It is not for citizens.** Citizen sessions have no refresh path, and this
-- adds none.
--
-- **It is not a list of active sessions.** Nothing reads it to show one. A row
-- outliving its session is expected until the daily prune removes it.
--
-- == Only a keyed hash is stored ==========================================
--
-- `tokenHash` is HMAC-SHA256 of the token under a key derived from
-- `JWT_SECRET` — never the token. The token is 256 random bits, so the hash
-- cannot be turned back into it, and a leaked table, dump or backup hands out
-- no live session. Rotating `JWT_SECRET` voids every row at once, which is
-- what rotating it has always meant for staff sessions.
--
-- The table is deliberately not in `BackupService`'s snapshot. A restore
-- replaces every user, this cascades away with them, and everyone signs in
-- again — the right outcome for a credential table.
--
-- == Deploy order ==========================================================
--
-- Additive: one table, one foreign key, five indexes. No enum, trigger or
-- function. Apply BEFORE the code, which inserts on every staff sign-in.
--
-- The foreign key takes a SHARE ROW EXCLUSIVE lock on "users" until the
-- migration commits. Reads go on; writes to "users" wait — and so does the
-- lock, behind any write transaction already open there. The migrator allows
-- it 5 s (`lock_timeout`, migrate-all-tenants.ts) before failing that
-- municipality, and a push to main runs this unattended. So merge it outside
-- office hours, when nobody is signing in or registering a household. A
-- municipality that times out rolls back whole — each migration is its own
-- transaction — and is re-run safely: nothing here is created twice.
--
-- The indexes are built without CONCURRENTLY, which the deploy scanner warns
-- about. The table is created empty in the same transaction, so there is
-- nothing to scan and nobody else can be writing to it.
--
-- Written unqualified: the migrator sets `search_path` to the tenant schema and
-- wraps the file in one transaction. Idempotent throughout.

-- ═══════════════════════════  staff_refresh_tokens  ═══════════════════════════

CREATE TABLE IF NOT EXISTS "staff_refresh_tokens" (
  "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "userId"       UUID         NOT NULL,
  -- The session: the id of the family's first (root) row, and the `sid` a
  -- staff access token carries.
  "familyId"     UUID         NOT NULL,
  -- The token this one replaced; NULL on the root. No foreign key: every row
  -- of a family shares one user and one `expiresAt`, so a family is pruned or
  -- cascaded whole, and a key between its rows would guard nothing.
  "parentId"     UUID,
  -- HMAC-SHA256 of the token (hex). Never the token.
  "tokenHash"    TEXT         NOT NULL,
  -- users."tokenVersion" when the family began. A bump since — a role or
  -- password change, a deactivation — ends the family at its next exchange.
  "tokenVersion" INTEGER      NOT NULL,
  -- «تذكّرني»: whether the cookie outlives the browser session.
  "persistent"   BOOLEAN      NOT NULL DEFAULT false,
  -- The session cap. Identical on every row of a family; never moves.
  "expiresAt"    TIMESTAMP(3) NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Exchanged (rotated). Set once, by a compare-and-set that only one of two
  -- racing requests can win.
  "usedAt"       TIMESTAMP(3),
  -- Replaced by a retry of its parent before it was ever used: the response
  -- carrying it was lost, or a racing request won. Presenting it is a retry of
  -- the parent, not a reuse.
  "supersededAt" TIMESTAMP(3),
  -- Retries served from this row as a parent. Capped in code, so a lost
  -- response costs a clerk nothing and a used token cannot be replayed without
  -- limit.
  "retryCount"   INTEGER      NOT NULL DEFAULT 0,
  -- The family ended: logout, detected reuse, or a refusal. Authoritative on
  -- the ROOT row — a child inserted by a rotation that raced the revocation is
  -- dead because its root is, whatever its own column says.
  "revokedAt"    TIMESTAMP(3),

  CONSTRAINT "staff_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- ═══════════════════════════════  foreign keys  ═══════════════════════════════
--
-- Cascades. A refresh token for an account that no longer exists is a session
-- for nobody. `StaffService.remove` hard-deletes a staff member and a restore
-- replaces every user; either way the sessions go with the account instead of
-- blocking its removal.

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('staff_refresh_tokens', 'staff_refresh_tokens_userId_fkey', 'userId', 'users', 'CASCADE')
    ) AS t(tbl, name, col, ref, on_delete)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = fk.name AND n.nspname = CURRENT_SCHEMA()
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I("id") ON DELETE %s ON UPDATE CASCADE',
        fk.tbl, fk.name, fk.col, fk.ref, fk.on_delete
      );
    END IF;
  END LOOP;
END
$$;

-- ═════════════════════════════════  indexes  ═════════════════════════════════

-- The lookup every refresh makes: a presented token resolves to exactly one
-- row or to none.
CREATE UNIQUE INDEX IF NOT EXISTS "staff_refresh_tokens_tokenHash_key"
  ON "staff_refresh_tokens" ("tokenHash");

-- Postgres does not index a foreign key's column for you. Without this, every
-- user removed — one staff member, or all of them in a restore — scans this
-- table to find what to cascade.
CREATE INDEX IF NOT EXISTS "staff_refresh_tokens_userId_idx"
  ON "staff_refresh_tokens" ("userId");

-- Ending a family (logout, reuse, refusal) marks every row in it.
CREATE INDEX IF NOT EXISTS "staff_refresh_tokens_familyId_idx"
  ON "staff_refresh_tokens" ("familyId");

-- "What did this token produce?" — asked by every retry before it mints,
-- because a used child means the chain has moved on and this is reuse.
CREATE INDEX IF NOT EXISTS "staff_refresh_tokens_parentId_idx"
  ON "staff_refresh_tokens" ("parentId");

-- The daily prune of rows past their cap.
CREATE INDEX IF NOT EXISTS "staff_refresh_tokens_expiresAt_idx"
  ON "staff_refresh_tokens" ("expiresAt");

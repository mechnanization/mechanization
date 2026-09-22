-- 0055_census_sync_marker
--
-- Two timestamps that make a failed census sync findable.
--
-- == Why ===================================================================
--
-- `CitizensService` commits the citizen's file, then calls `syncQuietly` to
-- push what it says into the census — units, occupancies, the matrix. That
-- ordering is deliberate and stays: a census failure must not be reported to
-- the officer as a failed save, because the save did succeed and sending them
-- round again would be a lie.
--
-- What it lacked was a trace. `syncQuietly` swallows the error, logs it, and
-- returns null. If it fails — or the process dies between the commit and the
-- call — the citizen's file and the census diverge permanently, and nothing in
-- the database records that they did. The only evidence is a log line on
-- whichever instance happened to handle the request.
--
-- These two columns are that evidence, in the register rather than in a log.
--
-- == What they are NOT =====================================================
--
-- Not an outbox, and not a retry queue. Nothing here re-runs a sync on its
-- own: a sync writes occupancies, and a job that silently replays one against
-- a register an officer has edited since is a worse failure than the one it
-- fixes. They record; a human, or a reconciliation screen, decides.
--
-- No error text is stored, deliberately. A Postgres error quotes the row that
-- caused it, and these rows carry national ID numbers, phone numbers and
-- residency status. A `censusSyncError TEXT` column would be a citizen-data
-- column that nobody had agreed to create. The timestamps say *that* it failed
-- and *when*; the log says what, on a machine that is allowed to know.
--
-- == The backfill ==========================================================
--
-- Every existing registration is stamped with its own `updatedAt`, not left
-- NULL.
--
-- NULL would be the honest value — nobody knows whether those syncs ran — but
-- it would also mean that the first query for "what needs reconciling" returns
-- the entire history of the register, and reconciliation is for failures from
-- here on. A one-time audit of what history actually holds is a separate piece
-- of work with a human deciding what to do about each answer; it is not
-- something this column should start by demanding.
--
-- == Deploy order ==========================================================
--
-- Additive: two nullable columns, one partial index, one backfill. Nothing is
-- dropped and nothing is rewritten. Apply BEFORE the code, which selects and
-- writes both columns.
--
-- Written unqualified: the migrator sets `search_path` to the tenant schema and
-- wraps the file in one transaction. Idempotent throughout.

-- ═════════════════════════════════  columns  ═════════════════════════════════

ALTER TABLE "registrations"
  ADD COLUMN IF NOT EXISTS "censusSyncedAt" TIMESTAMP(3);

ALTER TABLE "registrations"
  ADD COLUMN IF NOT EXISTS "censusSyncFailedAt" TIMESTAMP(3);

COMMENT ON COLUMN "registrations"."censusSyncedAt" IS
  'When this registration was last pushed into the census successfully.';

COMMENT ON COLUMN "registrations"."censusSyncFailedAt" IS
  'When a push last failed. Later than censusSyncedAt means the two disagree now.';

-- ════════════════════════════════  backfill  ════════════════════════════════
--
-- Only rows that have never been stamped, so re-running this migration on a
-- schema that has already been deployed against cannot move a real timestamp
-- backwards.

UPDATE "registrations"
   SET "censusSyncedAt" = "updatedAt"
 WHERE "censusSyncedAt" IS NULL
   AND "censusSyncFailedAt" IS NULL;

-- ═════════════════════════════════  index  ═════════════════════════════════
--
-- The reconciliation question, and the only one these columns are for:
-- "which registrations does the census disagree with?" Partial, because the
-- answer should almost always be an empty set and there is no reason to carry
-- an entry for every healthy row.
--
-- Plain CREATE INDEX, not CONCURRENTLY: the migrator wraps each migration in a
-- transaction and CONCURRENTLY cannot run inside one (AGENTS.md §3). The write
-- lock is on one table, for a partial index over the rows that failed — which
-- is none of them on the day this runs.

CREATE INDEX IF NOT EXISTS "registrations_census_out_of_sync_idx"
  ON "registrations" ("censusSyncFailedAt")
  WHERE "censusSyncFailedAt" IS NOT NULL;

-- 0044_mother_name
--
-- «اسم الأم وشهرتها» — the disambiguator that replaces the identity document.
--
-- == Why this field, and why now ============================================
--
-- On 2026-09-13 the form stopped asking a Lebanese citizen for an identity
-- document (see `personalDetailsObject.identityDocType`). Officers had been
-- told it was optional, filled it with shared or invented numbers, and because
-- citizens were matched on it every repeated number merged distinct people
-- into whoever used it first. Removing it was right. It also left the register
-- with nothing at all to tell «محمد أحمد خليل» from «محمد أحمد خليل»: three
-- name parts, a phone a household shares, and a رقم سجل shared by everyone on
-- the same قيد.
--
-- The mother's name is what a Lebanese ID card and the قيد itself carry for
-- exactly this purpose, and it is the one identifying fact at a counter that
-- nobody has a reason to invent — a person who does not know a document number
-- guesses; a person knows their mother's name or plainly does not.
--
-- Stored as **one** column rather than a given/family pair, because the
-- question asked is «اسم الأم وشهرتها» and the answer is given as one phrase.
-- Splitting it would invite a clerk to put «فاطمة» in one box and guess at the
-- other, which is the invention this field exists to avoid.
--
-- == What this column must never become ====================================
--
-- A key. Siblings share a mother, so this disambiguates people and identifies
-- nobody. Nothing here is UNIQUE and nothing upstream may match on it: it is a
-- signal shown to a human deciding whether two records are one person. Making
-- it an upsert key would rebuild the merge bug that removed the document
-- number, with a value that collides *by design* within a family.
--
-- == Nullable, and no backfill =============================================
--
-- The column is nullable and every existing row stays NULL. There are records
-- in production filed before this field existed, and both alternatives are
-- worse than a gap: NOT NULL DEFAULT '' would make "not asked" indistinguish-
-- able from "answered blank", and a backfill has nothing truthful to write.
--
-- NULL here means «لم يُسأل», and it is recoverable — the edit form asks for
-- the field on any household file that lacks it, and an officer who does not
-- know the answer marks it «غير مؤكَّد» with a reason rather than inventing one.
-- That is the same mechanism `flaggedFields` already provides for every other
-- fact the field could not establish.
--
-- Asked of household files only. A `NON_RESIDENT_OWNER` record deliberately
-- holds a name, a phone and a town (migration 0040) — the municipality has no
-- reason to hold a mother's name for an owner in Beirut or abroad, and no way
-- to ask one.
--
-- Written unqualified: the migrator sets `search_path` to the target tenant
-- schema before running this.

-- `IF NOT EXISTS` because a Prisma client generated from the updated
-- `schema.prisma` can reach a database before this migration does.
--
-- That is not hypothetical: it happened on staging while this was being
-- written. The column was created out-of-band, four households were registered
-- through it, and the migration then failed on «column "motherName" already
-- exists» — leaving the column present, its four answers unsearchable, and the
-- migration unrecorded, so every later run failed the same way. `_tenant_migrations`
-- is the only thing that decides what has run, and it still said 0043.
--
-- Idempotent here rather than repaired by hand, because the hand-repair is
-- `DROP COLUMN` on a column that already holds answers somebody typed. The
-- expression below is idempotent for free — setting a generated column to the
-- expression it already has is a no-op — so the whole file can be re-run
-- against a schema in any of these states and end in the same one.
--
-- What this deliberately does not do is check the column's *type*. Postgres
-- skips on the name alone, so a column created as something other than TEXT
-- would be adopted silently. Accepted because the only thing that creates this
-- column out-of-band is Prisma reading `motherName String?` from the same
-- schema file, which is `TEXT` by definition — and verified as `text` on
-- staging before this was written.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "motherName" TEXT;

-- == Searchable, because that is the entire point ===========================
--
-- The field earns its place only if «محمد خليل فاطمة» reaches one record where
-- «محمد خليل» reaches nine. `searchText` is `GENERATED ALWAYS AS ... STORED`
-- (migration 0018), so the column's own expression is what has to change.
--
-- == Why SET EXPRESSION and not DROP + ADD =================================
--
-- Dropping the column and re-adding it with the new expression produces an
-- identical database — a generated column stores nothing of its own, so there
-- is no data in `searchText` that a drop could lose; every byte of it is
-- recomputed from the other columns of the same row.
--
-- It is still not how this should be written, for a reason that has nothing to
-- do with Postgres. `scripts/db/deploy.mjs` refuses any migration whose SQL
-- matches `DROP COLUMN`, and that scan is deliberately a dumb text match: a
-- scanner clever enough to recognise *this* drop as harmless is the scanner
-- that eventually waves through one that is not. Spending
-- `--allow-destructive` here would train the habit of spending it, on the one
-- guard standing between a deploy and a column of citizen records.
--
-- `ALTER COLUMN ... SET EXPRESSION AS` says exactly what is happening —
-- redefine a derived column — and needs no exemption from anything. It arrived
-- in PostgreSQL 17; both projects run 17.6, and `tenant-migrator` has no other
-- floor to raise. A municipality on an older server would need the drop back,
-- and would then be spending the flag on a real difference in capability
-- rather than on a scanner's blind spot.
--
-- Either way the table is rewritten and every row recomputed, which is what
-- keeps a generated column honest.
--
-- The expression below is migration 0018's, unchanged but for the one added
-- line. It is restated rather than factored into a function because a
-- `GENERATED` expression must be immutable and self-contained, and because the
-- next migration to touch it should be reading the whole of what it computes.
--
-- Not compacted like the identifiers are: a mother's name is matched as name
-- tokens, and a space-free copy of it would only let a query match across the
-- seam between it and the reference number that follows.

ALTER TABLE "users"
  ALTER COLUMN "searchText"
  SET EXPRESSION AS (
    search_normalize(
      coalesce("firstName", '') || ' ' ||
      coalesce("middleName", '') || ' ' ||
      coalesce("lastName", '') || ' ' ||
      coalesce("motherName", '') || ' ' ||
      coalesce("email", '') || ' ' ||
      coalesce("referenceNumber", '') || ' ' ||
      coalesce("phone", '') || ' ' ||
      coalesce("whatsapp", '') || ' ' ||
      coalesce("identityDocNumber", '') || ' ' ||
      coalesce("residencyNumber", '') || ' ' ||
      coalesce("civilRecordNumber", '')
    )
    || ' ' || search_compact("referenceNumber")
    || ' ' || search_compact("phone")
    || ' ' || search_compact("whatsapp")
    || ' ' || search_compact("identityDocNumber")
    || ' ' || search_compact("residencyNumber")
    || ' ' || search_compact("civilRecordNumber")
  );

-- == The owner a tenant named, agreed to on the spot ========================
--
-- `landlordCitizenId` (migration 0037) records that a clerk confirmed the
-- owner named on a card is a particular registered citizen. It could only be
-- set *after* the card existed, from the queue at «روابط المالكين» or the
-- dialog a save raises — because the confirmation writes an `OWNER` occupancy
-- on every flat the card names, and there is no card to name flats before the
-- save.
--
-- Nothing in the schema changes for the officer to be able to answer the
-- question while the tenant is still in front of them. The intent now travels
-- with the submission and the server confirms it against the committed card,
-- through the same `LandlordLinkService.confirm` the queue calls — which
-- re-derives the match from `landlordPhone` and refuses any citizen whose
-- number does not equal it, so a client may answer the question and still
-- cannot invent one.
--
-- Recorded here only so the next reader of 0037 finds out where the second
-- caller came from. No DDL.

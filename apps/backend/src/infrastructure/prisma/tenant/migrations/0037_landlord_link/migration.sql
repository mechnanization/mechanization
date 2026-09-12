-- 0037_landlord_link
--
-- Connecting a مستأجر's named owner to the register's own citizens.
--
-- == The dead end this removes =============================================
--
-- `landlord_phone` has been on this table since the first migration. It is
-- required of every TENANT card and optional on a شاغل بتسامح's, it is
-- validated to E.164 by `internationalPhone` on the way in, it is rendered in
-- reports and redacted in the audit log — and it has never been compared
-- against anything. The register could tell you that the tenant in flat 3
-- named an owner on 03-123456, and could not tell you that 03-123456 is a
-- citizen it registered last spring.
--
-- The cost of that is not tidiness. الأرصفة and المجاري fall on the deed
-- holder (`fee_notices.bearer = 'OWNER'`), and an owner the register cannot
-- recognise is an owner nobody bills — silently, with no row anywhere saying
-- how much is going uncollected or on how many units.
--
-- == Why a column and not a table ==========================================
--
-- Because the *match* is derivable and only the *answers* are not. Any card
-- whose `landlord_phone` equals some citizen's `phone` is a candidate; that is
-- a query, and a query cannot go stale, cannot be half-migrated, and needs no
-- backfill for the thousands of cards already filed. A proposals table would
-- have to be generated, kept in step with every phone change on either side,
-- and re-generated whenever it drifted.
--
-- The two things derivation cannot reproduce are a human's answers, so those
-- are the two columns:
--
--   * `landlord_citizen_id`  — yes, this is the same person.
--   * `landlord_link_dismissed_at` — no, it is not.
--
-- Without the second, a match rejected on Monday is proposed again on Tuesday
-- and every day after, because nothing about the rejection is recorded in the
-- data the match is computed from.
--
-- == Why nothing is linked automatically ===================================
--
-- A phone is not an identity in this schema and says so in its own comment:
-- `users` is unique on the identity document, "a household commonly shares one
-- phone". Matching on the number alone attaches a father's flat to his son.
--
-- It is also the wrong risk to take silently, because this decides money. A
-- confirmed link can start billing someone الأرصفة on units they never
-- declared, on the strength of a number a *third party* typed in — and a fee
-- notice has to be defensible at a counter. So the column exists, the match is
-- computed, and a person presses the button. See `LandlordLinkService`.
--
-- == On delete ============================================================
--
-- SET NULL, never CASCADE. Deleting a citizen must not delete their tenant's
-- own record of what they filed — the name and the number stay, and the card
-- simply becomes matchable again.
--
-- Written unqualified: the migrator sets `search_path` to the target tenant
-- schema before running this.

ALTER TABLE "property_entries"
  ADD COLUMN IF NOT EXISTS "landlordCitizenId" UUID,
  ADD COLUMN IF NOT EXISTS "landlordLinkDismissedAt" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'property_entries_landlordCitizenId_fkey'
  ) THEN
    ALTER TABLE "property_entries"
      ADD CONSTRAINT "property_entries_landlordCitizenId_fkey"
      FOREIGN KEY ("landlordCitizenId") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- The index both directions of the match run on: the review queue sweeping
-- unresolved claims, and the form's inline lookup asking whether one number is
-- already named on a card. Deliberately a plain index and not a partial one on
-- `landlordCitizenId IS NULL` — the inline lookup asks about *resolved* cards
-- too, and Prisma's schema language cannot declare a partial index, so a
-- partial one here would read as drift on the next `migrate dev` and be
-- proposed for deletion.
CREATE INDEX IF NOT EXISTS "property_entries_landlordPhone_idx"
  ON "property_entries" ("landlordPhone");

CREATE INDEX IF NOT EXISTS "property_entries_landlordCitizenId_idx"
  ON "property_entries" ("landlordCitizenId");

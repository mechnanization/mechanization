-- 0045_landlord_link_footprint
--
-- What an owner link wrote, so that undoing it removes exactly that.
--
-- == The gap this closes ===================================================
--
-- Confirming that the owner a مستأجر named is a registered citizen (0037)
-- writes into *somebody else's* records: an `OWNER` occupancy on each flat the
-- tenant's card names, a unit row on the owner's card, and — where the owner
-- had filed nothing on that structure — a whole property card on their file.
-- Those are what put the flat on the owner's bill.
--
-- Nothing recorded which of those rows the link had created. So «إلغاء الربط»
-- could only clear `landlordCitizenId` and leave the rest standing: the wrong
-- brother, unlinked, went on being billed for a flat nobody claimed he owned.
-- Inferring the rows afterwards is guesswork — an owner occupancy looks the
-- same whether a link, the matrix or the owner's own registration wrote it —
-- and guessing here deletes somebody's real record.
--
-- == The three columns =====================================================
--
--   * `landlordLinkFootprint` (tenant card) — the occupancies, unit rows and
--     cards this link created, each with the values it wrote. An undo reverts
--     a row only while it still holds exactly those values; anything a person
--     has edited since is kept and reported instead of deleted.
--
--   * `landlordLinkMint` (owner card) — present only on a card a link created,
--     with the values it was created with. It survives edits to the owner's
--     file (the edit path never writes it), so a card first kept because a
--     second tenant's link still used it can still be recognised as the link's
--     own once that second link is undone too.
--
--   * `landlordLinkDismissedIds` (tenant card) — *who* «لا أحد منهم» rejected.
--     `landlordLinkDismissedAt` alone rejected the claim for everyone, forever:
--     the real owner registering a month later on the same number was never
--     offered. Rows dismissed before this migration keep their timestamp and an
--     empty list, and are read as rejecting only the citizens that existed at
--     that moment — which is exactly what the clerk was shown.
--
-- All three are nullable or defaulted, nothing is backfilled, and no existing
-- value is changed. A link confirmed before this migration has no footprint;
-- undoing one clears the link and reports the flats to check by hand rather
-- than inferring rows to delete.
--
-- == The index =============================================================
--
-- The owner match compares a card's `landlordPhone` with a citizen's `phone`
-- *or* `whatsapp`. `phone` has been indexed with `kind` since 0001; `whatsapp`
-- never was, so half of every match was a scan of the whole citizen table.
--
-- Written unqualified: the migrator sets `search_path` to the target tenant
-- schema before running this.

ALTER TABLE "property_entries"
  ADD COLUMN IF NOT EXISTS "landlordLinkFootprint" JSONB,
  ADD COLUMN IF NOT EXISTS "landlordLinkMint" JSONB,
  ADD COLUMN IF NOT EXISTS "landlordLinkDismissedIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

CREATE INDEX IF NOT EXISTS "users_kind_whatsapp_idx" ON "users" ("kind", "whatsapp");

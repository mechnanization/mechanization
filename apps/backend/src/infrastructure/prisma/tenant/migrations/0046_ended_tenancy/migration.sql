-- 0046_ended_tenancy
--
-- A tenancy that ended stays on the tenant's file as an ended tenancy.
--
-- == What was happening ====================================================
--
-- «إنهاء الإشغال» on the unit matrix ended the tenant's spell and then cleared
-- the hidden link between their card's unit row and the flat. The card itself
-- — building, floor, area, the owner they named, the lease attached to it —
-- stayed on their file reading as current. Worse, a row with no flat link still
-- bills from its own floor and area, so the ex-tenant went on being charged the
-- occupancy fee for a flat they had left, while the flat kept «مؤجرة» and its
-- owner stayed exempt. The only other way to record a departure was deleting the
-- card, which deletes its documents with it.
--
-- == The four columns ======================================================
--
-- `endedAt` / `endReason` on a unit row: this flat stopped being part of the
-- tenancy, when, and why. Kept rather than deleted, and `unitId` kept with it,
-- so the file can still say which flat was rented and until when.
--
-- The same pair on the card: every flat on it has ended (or, for a منزل, the
-- house has). An ended card is history — it bills nothing, the census sync
-- ignores it, the edit form does not load it, and nothing deletes it.
--
-- `endReason` reuses `OccupancyEndReason`, the vocabulary the unit matrix
-- already records a spell's end in, so the two records of one departure say the
-- same thing in the same words.
--
-- Nullable, not backfilled, and nothing existing changes: every card and row
-- stored today is current, which is exactly what NULL means.
--
-- Written unqualified: the migrator sets `search_path` to the target tenant
-- schema before running this.

ALTER TABLE "property_entries"
  ADD COLUMN IF NOT EXISTS "endedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "endReason" "OccupancyEndReason";

ALTER TABLE "building_units"
  ADD COLUMN IF NOT EXISTS "endedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "endReason" "OccupancyEndReason";

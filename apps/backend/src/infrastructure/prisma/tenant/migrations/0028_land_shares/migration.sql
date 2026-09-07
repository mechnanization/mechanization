-- 0028_land_shares
-- أسهم — fractional land ownership, out of the Lebanese cadastre's standard
-- 2400-share parcel. LAND only; nullable everywhere else and for every
-- existing row, which has no historical value to backfill.

ALTER TABLE "property_entries" ADD COLUMN IF NOT EXISTS "shares" INTEGER;
